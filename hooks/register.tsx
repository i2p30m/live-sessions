import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Row, RowState } from '../types'
import {
  CLEANUP_HOURS,
  THEME,
  contextBar,
  contextColor,
  GLYPHS,
  ICONS,
  SELF_MARK,
  drawSignature,
  hiddenByProject,
  isFactKey,
  parseIsOnScreen,
  parseSession,
  parseSessions,
  staleRows,
  toFacts,
  toRows,
  toTasks,
} from './rows'
import { STRINGS, langOf } from './i18n'
import type { Lang } from './i18n'

const PANE = 'live-sessions'
// Keep equal to .claude-plugin/plugin.json: the footer shows which code the pane really runs.
const VERSION = '0.18.1'
const SERVER = 'ccd_session_mgmt'
const POLL_MS = 4000
const SEEN_WRITE_MS = 15_000
// How long a flagged session must be on screen before its flag counts as handled.
const FLAG_SETTLE_MS = 15_000
const VIEWED_WRITE_MS = 60_000
// A task click in another session's pane: `showTasks:<id>`, honoured within this long.
const SHOW_TASKS = 'showTasks'
const SHOW_TASKS_MS = 30_000
const IDLE_SHOWN = 25
// Width of an icon button's column, in cells.
const ICON_COLUMNS = 3
// A card's left column: the state icon over the context gauge.
const STATE_COLUMNS = 4
// The fold arrow's column in a project header; the project's sessions are indented by it,
// so the project name and the session titles start at the same edge.
const FOLD_COLUMNS = 2
// Larger answers (~80 KB at 200) reach the mod cut short.
const LIST_LIMIT = 80
// Docked width asked for until the person sets their own; then theirs, shared by every session.
const COLUMNS = 48
const COLUMNS_KEY = 'pref:columns'
const CLOSED_PROJECTS_KEY = 'pref:closedProjects'
const DEBUG = false

const rowsAtom = atom({ plugin: 'live-sessions', key: 'rows' } as const, [] as Row[])
const errorAtom = atom({ plugin: 'live-sessions', key: 'error' } as const, null as string | null)
// How many sessions each project shows at the bottom; 0 shows all. Kept in the store too.
const perProjectAtom = atom({ plugin: 'live-sessions', key: 'perProject' } as const, 5)
const PER_PROJECT_KEY = 'pref:perProject'
const showActiveAtom = atom({ plugin: 'live-sessions', key: 'showActiveInProjects' } as const, false)
const SHOW_ACTIVE_KEY = 'pref:showActiveInProjects'
const PER_PROJECT_CHOICES = [3, 5, 10, 20, 0]
const closedProjectsAtom = atom({ plugin: 'live-sessions', key: 'closedProjects' } as const, [] as string[])
const expandedAtom = atom({ plugin: 'live-sessions', key: 'expandedIds' } as const, [] as string[])

// Module memory: lost on reload, rebuilt by the next poll.
let selfId: string | undefined
// Follows Claude Code's `language` setting; English unless it says Polish.
let lang: Lang = 'en'
let isPolling = false
let lastSig = ''
let lastError: string | null = null
let lastSeenWrite = 0
let lastViewedWrite = 0
let lastContextPercent: number | undefined
let isAwaitingPermission = false
// Set when the person closes the pane; /sesje clears it.
let isClosedByPerson = false
// The dock width to ask for, and what this session's pane last measured (see `noteWidth`).
let wantedColumns = COLUMNS
let seenColumns = 0
let widthTimer: { cancel: () => void } | undefined
// Focus bookkeeping (see `noteFocus`).
let wasFocused = false
let focusGainedAt = 0
let lastRefocus = 0
const debugBuffer: string[] = []

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadLang($)
    await $.command.register({ name: 'sesje', description: STRINGS.pl.commandDescription })
    await $.command.register({ name: 'live-sessions', description: STRINGS.en.commandDescription })
    await loadPrefs($)
    void openUnasked($)
    $.clock.every(POLL_MS, () => void tick($))
    void tick($)

    return next(e)
  })

  on('command.run', { command: ['sesje', 'live-sessions'] }, async $ => {
    isClosedByPerson = false
    await $.ui.open({ id: PANE, title: STRINGS[lang].title, columns: wantedColumns, focus: true })
    void tick($)

    return { text: STRINGS[lang].commandOpened }
  })

  // An open the person's prompt is behind is placed at any width (an unasked one
  // waits for a wide window), so the first prompt brings the pane up if it is not.
  on('prompt.submit', async ($, e, next) => {
    if (!isClosedByPerson) {
      const panes = await $.ui.panes()
      if (!panes.some(pane => pane.id === PANE && pane.isPlaced)) {
        const opened = await $.ui.open({ id: PANE, title: STRINGS[lang].title, columns: wantedColumns })
        trace(`open on prompt ${opened.isPlaced ? 'placed' : opened.reason}`)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') isClosedByPerson = true

    return next(e)
  }).catch(($, e, next) => next(e))

  // "Needs input": a question, a plan to approve, a permission prompt, or a blocked wrap-up.
  // Watchers below: one that fails lets the watched event go on.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isAsking = tool === 'AskUserQuestion' || tool === 'ExitPlanMode'
    if (isAsking) await setInput($, true)
    const result = await next(e)
    if (isAsking || isAwaitingPermission) {
      isAwaitingPermission = false
      await setInput($, false)
    }
    if (tool === 'mcp__ccd_turn__wrap_up' && (e as unknown as { blocked?: unknown }).blocked === true) {
      await setInput($, true)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    isAwaitingPermission = true
    await setInput($, true)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await setInput($, false)

    return next(e)
  }).catch(($, e, next) => next(e))

  // Each stop reports the background work still in flight, and marks the turn done.
  on('classic.Stop', async ($, e, next) => {
    await Promise.all([saveTasks($, e.background_tasks), markDone($)])

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    await saveTasks($, e.background_tasks)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const PerProject = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Select
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const now = await $.clock.now()
    noteFocus($, e.props.isFocused, now)
    noteWidth($, e.props.placement, e.props.bodyColumns)

    const all = await read($, rowsAtom)
    const error = await read($, errorAtom)
    const expanded = await read($, expandedAtom)
    const closedProjects = await read($, closedProjectsAtom)
    const perProject = await read($, perProjectAtom)
    const rows = all.filter(row => !row.isHidden)
    const stale = staleRows(all, now)

    const S = STRINGS[lang]
    const isTerminal = e.surface === 'terminal'
    const tone = (state: RowState) => THEME[state]
    const count = (state: RowState) => rows.filter(row => row.state === state).length
    const pills: [RowState, string][] = [
      ['input', S.pill.input(count('input'))],
      ['running', S.pill.running(count('running'))],
      ['waiting', S.pill.waiting(count('waiting'))],
      ['unread', S.pill.unread(count('unread'))],
    ]

    // Icon buttons: a glyph in a fixed-width column (so + and ↑ line up), lit only on hover;
    // a Button holds text only.
    const iconButton = (key: string, glyph: string, onPress: () => void, color: string = THEME.muted) => (
      <Box
        key={`wrap:${key}`}
        flexShrink={0}
        width={ICON_COLUMNS}
        justifyContent="center"
        hover={{ backgroundColor: THEME.hover }}
      >
        <Button key={key} plain onPress={onPress}>
          <Text color={color} hover={{ color: THEME.strong }} weight="semibold">
            {glyph}
          </Text>
        </Button>
      </Box>
    )

    // The state icon; an idle session's circle is a button that flags it to come back to.
    const icon = (state: RowState, id: string) =>
      state === 'idle' ? (
        <Box key={`flag-wrap:${id}`} hover={{ backgroundColor: THEME.hover }}>
          <Button key={`flag:${id}`} plain onPress={() => onFlag($, id)}>
            <Text color={THEME.muted} hover={{ color: THEME.unread.main }} weight="semibold">
              {GLYPHS.idle}
            </Text>
          </Button>
        </Box>
      ) : Svg ? (
        <Svg source={ICONS[state]} alt={S.state[state]} width={20} height={20} />
      ) : (
        <Text color={tone(state).main}>{GLYPHS[state]}</Text>
      )

    const drawRow = (row: Row) => {
      const t = tone(row.state)
      const isOpen = expanded.includes(row.id)
      return (
        <Box
          key={`row:${row.id}`}
          flexDirection="column"
          gap={1}
          paddingX={1}
          paddingY={1}
          borderStyle="round"
          borderColor={isTerminal ? t.main : t.border}
          {...(isTerminal ? {} : { backgroundColor: t.tint })}
        >
          {/* The session this pane is in: a bar down the card's left edge, like an active tab, a row
              in from top and bottom to clear the round corners. Laid over the padding: nothing moves. */}
          {row.isSelf && (
            <Box key={`self-mark:${row.id}`} position="absolute" left={0} top={1} bottom={1} flexDirection="column">
              {Svg ? (
                <Box flexDirection="column" flexGrow={1} minHeight={0}>
                  <Svg source={SELF_MARK.top} alt={S.thisSession} width={3} height={1.5} />
                  <Box flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
                    <Svg source={SELF_MARK.body} alt="" width={3} height={2000} />
                  </Box>
                  <Svg source={SELF_MARK.bottom} alt="" width={3} height={1.5} />
                </Box>
              ) : (
                <Text color={THEME.strong}>▌</Text>
              )}
            </Box>
          )}
          <Box flexDirection="row" alignItems="center" gap={1}>
            {/* A fixed column: the state icon, and under it how full the context is,
                so the context sits in the same place on every card. */}
            <Box flexDirection="column" alignItems="center" gap={0} flexShrink={0} width={STATE_COLUMNS}>
              {icon(row.state, row.id)}
              {row.contextPercent !== undefined && (
                <Box flexDirection="column" alignItems="center" gap={0}>
                  {Svg && <Svg source={contextBar(row.contextPercent)} alt={S.context(row.contextPercent)} width={26} height={3} />}
                  <Text
                    size="caption"
                    weight="semibold"
                    color={row.contextPercent >= 75 ? contextColor(row.contextPercent) : THEME.sub}
                  >
                    {row.contextPercent}%
                  </Text>
                </Box>
              )}
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Button key={`open:${row.id}`} plain onPress={() => onOpen($, row.id, row.link)}>
                <Text weight="semibold" color={row.state === 'idle' ? THEME.text : THEME.strong} wrap="truncate">
                  {row.title}
                </Text>
              </Button>
              {/* The desktop's plain Button sits its label in by less than a cell; the `xs` step
                  matches it there. The terminal draws the label alone, flush. */}
              <Box paddingLeft={isTerminal ? 0 : 'xs'} minWidth={0}>
                <Text size="footnote" color={THEME.sub} wrap="truncate">
                  {[row.isSelf ? S.thisSession : row.project, row.isWorktree && S.worktree, row.ago].filter(Boolean).join(' · ')}
                </Text>
              </Box>
            </Box>
            <Box flexDirection="row" flexShrink={0} gap={1} alignItems="center">
              {row.state === 'unread' && iconButton(`seen:${row.id}`, '✓', () => onSeen($, row.id), THEME.unread.text)}
              {!row.isSelf && iconButton(`hide:${row.id}`, '↓', () => onHide($, [row.id]))}
            </Box>
          </Box>
          {row.tasks.length > 0 && (
            <Box flexDirection="column" gap={0} paddingLeft={4}>
              <Box flexDirection="row">
                <Box flexDirection="row" alignItems="center" gap={1} paddingX={1} {...(isTerminal ? {} : { backgroundColor: t.chip })}>
                  {/* The same hourglass as the "waiting on background work" state. */}
                  {Svg && <Svg source={ICONS.waiting} alt="" width={14} height={14} />}
                  <Button key={`tasks:${row.id}`} plain onPress={() => onToggleTasks($, row.id)}>
                    <Text size="footnote" weight="medium" color={t.text}>
                      {isOpen ? '▾' : '▸'} {S.tasks(row.tasks.length)}
                    </Text>
                  </Button>
                </Box>
              </Box>
              {isOpen &&
                row.tasks.map(task => (
                  <Box key={`task:${row.id}:${task.id}`} flexDirection="row" gap={1} paddingLeft={1}>
                    <Box flexShrink={0} paddingX={1} {...(isTerminal ? {} : { backgroundColor: THEME.hover })}>
                      <Text size="caption" mono color={THEME.muted}>
                        {task.type === 'subagent' ? 'agent' : task.type}
                      </Text>
                    </Box>
                    <Box flexShrink={1} minWidth={0} hover={{ backgroundColor: THEME.hover }}>
                      <Button key={`open-task:${row.id}:${task.id}`} plain onPress={() => onOpenTask($, row)}>
                        <Text size="footnote" color={THEME.sub} wrap="truncate">
                          {task.label}
                        </Text>
                      </Button>
                    </Box>
                  </Box>
                ))}
            </Box>
          )}
        </Box>
      )
    }

    const shownOf = <T,>(list: readonly T[]) => (perProject > 0 ? list.slice(0, perProject) : list)

    // A session in its project: one quiet line, as in the sidebar.
    const drawProjectRow = (row: Row, depth: number) => (
      <Box
        key={`hidden:${row.id}`}
        flexDirection="row"
        alignItems="center"
        gap={1}
        paddingLeft={FOLD_COLUMNS + depth * 2}
        hover={{ backgroundColor: THEME.hover }}
      >
        {depth > 0 && <Text color={THEME.faint}>└</Text>}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {/* dimColor: the one style a desktop's native Button keeps; colour, size and weight it drops. */}
          <Button key={`open-in-project:${row.id}`} plain dimColor={row.isHidden} onPress={() => onOpen($, row.id, row.link)}>
            <Text color={depth > 0 ? THEME.faint : THEME.muted} wrap="truncate">
              {row.title}
            </Text>
          </Button>
        </Box>
        <Box flexShrink={0}>
          <Text size="footnote" color={THEME.muted}>
            {row.agoShort}
          </Text>
        </Box>
        {row.isHidden ? (
          iconButton(`unhide:${row.id}`, '↑', () => onUnhide($, row.id))
        ) : (
          // A session that is also shown above: its state glyph where ↑ would be.
          <Box flexShrink={0} width={ICON_COLUMNS} justifyContent="center">
            <Text color={tone(row.state).main}>{GLYPHS[row.state]}</Text>
          </Box>
        )}
      </Box>
    )

    const groups: RowState[] = ['input', 'running', 'waiting', 'unread', 'idle']
    const showActive = await read($, showActiveAtom)
    const projects = hiddenByProject(all, lang, showActive)

    return (
      <Box flexDirection="column" gap={2} paddingX={1} paddingTop={1}>
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {pills.filter(([state]) => count(state) > 0).map(([state, label]) => (
              <Box key={`pill:${state}`} flexDirection="row" alignItems="center" gap={1} paddingX={1} borderStyle="round" borderColor={isTerminal ? tone(state).main : tone(state).chip} {...(isTerminal ? {} : { backgroundColor: tone(state).chip })}>
                <Text color={tone(state).main}>●</Text>
                <Text size="footnote" weight="semibold" color={tone(state).text}>
                  {label}
                </Text>
              </Box>
            ))}
            {pills.every(([state]) => count(state) === 0) && (
              <Text size="footnote" color={THEME.sub}>
                {S.nothingWaiting}
              </Text>
            )}
          </Box>
          {error && (
            <Text size="footnote" color="#f87171">
              {error}
            </Text>
          )}
          {stale.length > 0 && (
            <Box key="cleanup-wrap" flexDirection="row">
              <Button key="cleanup" plain onPress={() => onHide($, stale.map(row => row.id))}>
                <Text size="footnote" color={THEME.muted} hover={{ color: THEME.text }}>
                  {S.cleanup(CLEANUP_HOURS, stale.length)}
                </Text>
              </Button>
            </Box>
          )}
        </Box>

        {groups.map(state => {
          const inGroup = rows.filter(row => row.state === state)
          if (inGroup.length === 0) return null
          const shown = state === 'idle' ? inGroup.slice(0, IDLE_SHOWN) : inGroup
          return (
            <Box key={`group:${state}`} flexDirection="column" gap={1}>
              <Text size="caption" weight="semibold" color={tone(state).text}>
                {S.state[state].toLocaleUpperCase(lang)}
              </Text>
              {shown.map(drawRow)}
            </Box>
          )
        })}

        {projects.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
              <Box flexGrow={1}>
                <Text size="caption" weight="semibold" color={THEME.muted}>
                  {S.projects}
                </Text>
              </Box>
              {/* An icon toggle; hovering it reveals what it does. */}
              <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
                <Box display="none" hover={{ scope: 'show-active', display: 'flex' }}>
                  <Text size="footnote" color={THEME.sub}>
                    {showActive ? S.hideActive : S.showActive}
                  </Text>
                </Box>
                <Box
                  key="show-active-wrap"
                  flexShrink={0}
                  width={ICON_COLUMNS}
                  justifyContent="center"
                  hover={{ scope: 'show-active', backgroundColor: THEME.hover }}
                >
                  <Button key="show-active" plain dimColor={!showActive} onPress={() => onToggleShowActive($)}>
                    {showActive ? '⊖' : '⊕'}
                  </Button>
                </Box>
              </Box>
              {PerProject && (
                <PerProject
                  key="per-project"
                  value={String(perProject)}
                  options={PER_PROJECT_CHOICES.map(n => ({ value: String(n), label: n ? `${n}` : S.all }))}
                  onSelect={value => onPerProject($, Number(value))}
                />
              )}
            </Box>
            {projects.map(group => {
              const isOpen = !closedProjects.includes(group.path)
              const extra = perProject > 0 ? group.rows.length - perProject : 0
              return (
                <Box key={`project:${group.path}`} flexDirection="column" gap={0}>
                  <Box flexDirection="row" alignItems="center" gap={1}>
                    <Box flexDirection="row" alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
                      <Box flexShrink={0} width={FOLD_COLUMNS}>
                        <Button key={`project:${group.path}`} plain onPress={() => onToggleProject($, group.path)}>
                          <Text color={THEME.muted}>{isOpen ? '▾' : '▸'}</Text>
                        </Button>
                      </Box>
                      {/* Plain Text, not a Button: a Button drops its Text's colour and weight. The arrow folds. */}
                      <Box flexShrink={1} minWidth={0}>
                        <Text weight="semibold" color={THEME.strong} wrap="truncate">
                          {group.name}
                        </Text>
                      </Box>
                    </Box>
                    {group.path && iconButton(`new:${group.path}`, '+', () => onNewSession($, group.path))}
                  </Box>
                  {isOpen && shownOf(group.rows).map(({ row, depth }) => drawProjectRow(row, depth))}
                  {isOpen && extra > 0 && (
                    <Box paddingLeft={FOLD_COLUMNS + 1}>
                      <Text size="footnote" color={THEME.muted}>
                        {S.more(extra)}
                      </Text>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        )}
        <Box paddingBottom={1}>
          <Text size="footnote" color={THEME.faint}>
            {S.credit(VERSION)}
          </Text>
        </Box>
      </Box>
    )
  })
}

// --- polling -------------------------------------------------------------

async function openUnasked($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: STRINGS[lang].title, columns: wantedColumns })
  trace(`open at start ${opened.isPlaced ? 'placed' : opened.reason}`)
}

async function tick($: EngineInterface) {
  if (isPolling) return
  isPolling = true
  try {
    // The context figure is a nicety: never let it stop a refresh.
    await Promise.all([markSelfOnScreen($), reportContext($).catch(() => undefined)])
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE && pane.isPlaced)) await poll($)
    await flushDebug($)
  } catch (err) {
    await setError($, STRINGS[lang].refreshFailed(String(err)))
  } finally {
    isPolling = false
  }
}

async function poll($: EngineInterface) {
  await Promise.all([loadLang($), loadPrefs($)])
  const [listText, selfText, keys] = await Promise.all([
    callText($, 'list_sessions', { limit: LIST_LIMIT }),
    callText($, 'get_session', { session_id: 'self' }),
    $.store.keys(),
  ])
  const self = parseSession(selfText)
  if (self) selfId = self.sessionId
  const factKeys = keys.filter(isFactKey)
  const values = await Promise.all(factKeys.map(key => $.store.get(key)))
  const facts = toFacts(factKeys.map((key, i) => [key, values[i]] as const), lang)

  const listed = parseSessions(listText)
  const sessions = [...(self ? [self] : []), ...listed]
  if (listed.length === 0) {
    await setError($, STRINGS[lang].listUnreadable(listText.length, listText.slice(0, 160)))
    return
  }
  if (sessions.length === 0) {
    await setError($, STRINGS[lang].listEmpty(listText.slice(0, 200)))
    return
  }
  const rows = toRows(sessions, facts, selfId, await $.clock.now(), lang)
  await setError($, null)

  const sig = drawSignature(rows)
  if (sig === lastSig) return
  lastSig = sig
  await update($, rowsAtom, () => rows)
  trace(`redraw ${rows.length}`)
}

// While this session is on screen, everything up to now counts as seen.
// Every session reports its own context fill; the pane draws everyone's.
async function reportContext($: EngineInterface) {
  const id = await ensureSelf($)
  if (!id) return
  const percent = (await $.session.usage()).context.percent
  if (typeof percent !== 'number') return
  const rounded = Math.round(percent)
  if (rounded === lastContextPercent) return
  lastContextPercent = rounded
  await $.store.set(`ctx:${id}`, rounded)
}

async function markSelfOnScreen($: EngineInterface) {
  const id = await ensureSelf($)
  if (!id) return
  const layout = await $.mcp.call('ccd_view', 'get_layout', {})
  if (!parseIsOnScreen(textOf(layout.content))) return
  const now = await $.clock.now()
  // Another session's pane asked us to show our background tasks (see `onOpenTask`).
  const tasksAskedAt = await $.store.get(`${SHOW_TASKS}:${id}`)
  if (typeof tasksAskedAt === 'number') {
    await $.store.delete(`${SHOW_TASKS}:${id}`)
    if (now - tasksAskedAt < SHOW_TASKS_MS) await showTasksPane($)
  }
  // Back in a session flagged to come back to: once it has been on screen a while, the flag is done.
  const flaggedAt = await $.store.get(`flag:${id}`)
  if (typeof flaggedAt === 'number' && now - flaggedAt > FLAG_SETTLE_MS) await $.store.delete(`flag:${id}`)
  if (now - lastSeenWrite >= SEEN_WRITE_MS) {
    lastSeenWrite = now
    await $.store.set(`seen:${id}`, now)
  }
  if (now - lastViewedWrite >= VIEWED_WRITE_MS) {
    lastViewedWrite = now
    await $.store.set(`viewed:${id}`, now)
  }
}

async function loadLang($: EngineInterface) {
  const next = langOf(await $.settings.read({ key: 'language' }).catch(() => undefined))
  if (next === lang) return
  lang = next
  lastSig = ''
}

async function ensureSelf($: EngineInterface) {
  if (selfId) return selfId
  selfId = parseSession(await callText($, 'get_session', { session_id: 'self' }))?.sessionId

  return selfId
}

async function setInput($: EngineInterface, value: boolean) {
  const id = await ensureSelf($)
  if (!id) return
  if (value) await $.store.set(`input:${id}`, true)
  else await $.store.delete(`input:${id}`)
}

async function saveTasks($: EngineInterface, tasks: unknown) {
  const id = await ensureSelf($)
  if (id) await $.store.set(`bg:${id}`, toTasks(tasks ?? [], lang))
}

async function markDone($: EngineInterface) {
  const id = await ensureSelf($)
  if (id) await $.store.set(`done:${id}`, await $.clock.now())
}

async function setError($: EngineInterface, error: string | null) {
  if (error === lastError) return
  lastError = error
  await update($, errorAtom, () => error)
}

async function callText($: EngineInterface, tool: string, args: Record<string, unknown>) {
  const result = await $.mcp.call(SERVER, tool, args)

  return textOf(result.content)
}

function textOf(content: ReadonlyArray<{ text?: string }>) {
  return content.map(block => block.text ?? '').join('\n')
}

// --- handlers: act first, bookkeeping after -------------------------------

async function onOpen($: EngineInterface, id: string, link: string) {
  trace(`press open ${id}`)
  if (link) await $.process.run(['open', link])
  await markSeen($, id)
  await grabFocus($, `open:${id}`)
}

async function onSeen($: EngineInterface, id: string) {
  trace(`press seen ${id}`)
  await markSeen($, id)
  await grabFocus($, `open:${id}`)
}

async function markSeen($: EngineInterface, id: string) {
  const at = await $.clock.now()
  await update($, rowsAtom, rows =>
    rows.map(row => (row.id === id && row.state === 'unread' ? { ...row, state: 'idle' as const } : row)),
  )
  await $.store.set(`seen:${id}`, at)
  await $.store.delete(`flag:${id}`)
}

// Flags a session to come back to: it shows as "done, not checked" until opened or ✓.
async function onFlag($: EngineInterface, id: string) {
  trace(`press flag ${id}`)
  await update($, rowsAtom, rows => rows.map(row => (row.id === id ? { ...row, state: 'unread' as const } : row)))
  await $.store.set(`flag:${id}`, await $.clock.now())
  lastSig = ''
  await grabFocus($, `open:${id}`)
}

// Hidden from this pane only (`hidden:<id>` = when); a new turn brings it back.
async function onHide($: EngineInterface, ids: readonly string[]) {
  trace(`press hide ${ids.join(',')}`)
  await update($, rowsAtom, rows => rows.map(row => (ids.includes(row.id) ? { ...row, isHidden: true } : row)))
  const now = await $.clock.now()
  await Promise.all(ids.map(id => $.store.set(`hidden:${id}`, now)))
  lastSig = ''
  await grabFocus($, ids[0] ? `open:${ids[0]}` : 'cleanup')
}

async function onUnhide($: EngineInterface, id: string) {
  trace(`press unhide ${id}`)
  await update($, rowsAtom, rows => rows.map(row => (row.id === id ? { ...row, isHidden: false } : row)))
  await $.store.delete(`hidden:${id}`)
  lastSig = ''
  await grabFocus($, `open:${id}`)
}

async function onToggleTasks($: EngineInterface, id: string) {
  await update($, expandedAtom, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))
  await grabFocus($, `tasks:${id}`)
}

// The app's tasks pane belongs to its session and only that session can show it: our own is
// shown at once; for another, open it and leave a request its own mod honours once on screen.
async function onOpenTask($: EngineInterface, row: Row) {
  trace(`press task ${row.id}`)
  if (row.isSelf) {
    await showTasksPane($)
  } else {
    await $.store.set(`${SHOW_TASKS}:${row.id}`, await $.clock.now())
    if (row.link) await $.process.run(['open', row.link])
    await markSeen($, row.id)
  }
  await grabFocus($, `tasks:${row.id}`)
}

async function showTasksPane($: EngineInterface) {
  const result = await $.mcp.call('ccd_view', 'show_pane', { pane: 'tasks' })
  trace(`show tasks ${textOf(result.content).slice(0, 80)}`)
}

async function onPerProject($: EngineInterface, count: number) {
  await update($, perProjectAtom, () => count)
  await $.store.set(PER_PROJECT_KEY, count)
}

// Pane settings live in the store, so every session shows the pane the same way.
async function loadPrefs($: EngineInterface) {
  const [count, closed, columns, showActive] = await Promise.all([
    $.store.get(PER_PROJECT_KEY),
    $.store.get(CLOSED_PROJECTS_KEY),
    $.store.get(COLUMNS_KEY),
    $.store.get(SHOW_ACTIVE_KEY),
  ])
  if (typeof showActive === 'boolean' && showActive !== (await read($, showActiveAtom))) {
    await update($, showActiveAtom, () => showActive)
  }
  if (typeof count === 'number' && PER_PROJECT_CHOICES.includes(count) && count !== (await read($, perProjectAtom))) {
    await update($, perProjectAtom, () => count)
  }
  if (Array.isArray(closed)) {
    const paths = closed.filter((one): one is string => typeof one === 'string')
    if (JSON.stringify(paths) !== JSON.stringify(await read($, closedProjectsAtom))) await update($, closedProjectsAtom, () => paths)
  }
  if (typeof columns === 'number' && columns >= 24 && columns <= 400) wantedColumns = columns
}

// A new, empty session in the project's folder: the deep link the app's
// "New Claude Code Session Here" action opens.
async function onNewSession($: EngineInterface, path: string) {
  trace(`press new ${path}`)
  await $.process.run(['open', `claude://code/new?folder=${encodeURIComponent(path)}&source=services`])
}

async function onToggleShowActive($: EngineInterface) {
  const isShown = await update($, showActiveAtom, isShown => !isShown)
  await $.store.set(SHOW_ACTIVE_KEY, isShown)
  await grabFocus($, 'show-active')
}

async function onToggleProject($: EngineInterface, path: string) {
  const paths = await update($, closedProjectsAtom, paths =>
    paths.includes(path) ? paths.filter(one => one !== path) : [...paths, path],
  )
  await $.store.set(CLOSED_PROJECTS_KEY, paths)
  await grabFocus($, `project:${path}`)
}

// A docked pane whose width changes while open was resized by the person: keep that width
// for every session once it settles. The first width a pane reports is the app's, not theirs.
function noteWidth($: EngineInterface, placement: 'dock' | 'inline', columns: number) {
  if (placement !== 'dock' || columns <= 0 || columns === seenColumns) return
  const isFirst = seenColumns === 0
  seenColumns = columns
  if (isFirst || columns === wantedColumns) return
  widthTimer?.cancel()
  widthTimer = $.clock.after(1500, () => void saveWidth($, columns))
}

async function saveWidth($: EngineInterface, columns: number) {
  wantedColumns = columns
  await $.store.set(COLUMNS_KEY, columns)
}

// --- focus -----------------------------------------------------------------

// After a press the app moves the keyboard to the composer; take it back so the next click lands.
async function grabFocus($: EngineInterface, key: string) {
  const result = await $.ui.focus({ requestId: PANE, key }).catch(err => ({ deny: String(err) }))
  trace(`grab ${key} ${result.deny ?? 'ok'}`)
  if (result.deny) await $.ui.open({ id: PANE, title: STRINGS[lang].title, columns: wantedColumns, focus: true })
}

// On a session switch the pane gains focus and loses it ~30 ms later to the composer;
// ask for it back once when that happens (at most every 2 s).
function noteFocus($: EngineInterface, isFocused: boolean, now: number) {
  if (isFocused && !wasFocused) focusGainedAt = now
  if (!isFocused && wasFocused && now - focusGainedAt < 150 && now - lastRefocus > 2000) {
    lastRefocus = now
    trace('refocus')
    $.clock.after(0, () => void refocus($))
  }
  if (isFocused !== wasFocused) trace(`render ${isFocused ? 'focused' : 'unfocused'}`)
  wasFocused = isFocused
}

async function refocus($: EngineInterface) {
  await $.ui.open({ id: PANE, title: STRINGS[lang].title, columns: wantedColumns, focus: true })
}

// --- diagnostics (remove once single clicks are confirmed) ---------------------

function trace(line: string) {
  if (!DEBUG) return
  debugBuffer.push(`${new Date().toISOString()} ${line}`)
}

async function flushDebug($: EngineInterface) {
  if (!DEBUG || debugBuffer.length === 0 || !selfId) return
  const key = `debug:log:${selfId}`
  const old = await $.store.get(key)
  const lines = [...(Array.isArray(old) ? (old as string[]) : []), ...debugBuffer.splice(0)]
  await $.store.set(key, lines.slice(-300))
}
