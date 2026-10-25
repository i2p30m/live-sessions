import type { BgTask, Row, RowState } from '../types'
import { STRINGS, agoLabel } from './i18n'
import type { Lang } from './i18n'

export const CLEANUP_HOURS = 5
const HOUR = 60 * 60 * 1000

// A session as `list_sessions` / `get_session` report it.
export type Session = {
  sessionId: string
  title?: string
  cwd?: string
  isArchived?: boolean
  isRunning?: boolean
  lastActivityAt?: string
  link?: string
  worktree?: unknown
  worktreePath?: string
  startedBy?: string
}

// What the shared store says about each session, read once per poll.
export type Facts = {
  seen: Record<string, number>
  // Context window fill, in percent, as each session last reported it.
  ctx: Record<string, number>
  // Flagged by hand to come back to (when, in ms); shown as "done, not checked".
  flag: Record<string, number>
  // When the session last finished a turn (its Stop), in ms. Its `lastActivityAt` is no use here:
  // the app moves it with no new turn (reloading a session), which kept checked sessions unread.
  done: Record<string, number>
  viewed: Record<string, number>
  hidden: Record<string, number>
  bg: Record<string, BgTask[]>
  input: Record<string, boolean>
}

export const FACT_PREFIXES = ['seen', 'viewed', 'hidden', 'bg', 'input', 'ctx', 'flag', 'done'] as const

export const emptyFacts = (): Facts => ({ seen: {}, viewed: {}, hidden: {}, bg: {}, input: {}, ctx: {}, flag: {}, done: {} })

const RANK: Record<RowState, number> = { input: 0, running: 1, waiting: 2, unread: 3, idle: 4 }

// The text of an MCP result's first JSON value (some answers lead with a line of prose).
export function parseJson(text: string): unknown {
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

// A long list can arrive cut short: keep every whole entry before the cut.
export function parseSessions(text: string): Session[] {
  let value = parseJson(text)
  if (!Array.isArray(value)) {
    const start = text.indexOf('[')
    const end = text.lastIndexOf('\n  }')
    value = start >= 0 && end > start ? parseJson(`${text.slice(start, end + 4)}\n]`) : undefined
  }
  if (!Array.isArray(value)) return []
  return value.filter(
    (one): one is Session => typeof one === 'object' && one !== null && typeof one.sessionId === 'string',
  )
}

export function parseSession(text: string): Session | undefined {
  const value = parseJson(text) as Session | undefined
  return value && typeof value.sessionId === 'string' ? value : undefined
}

// `get_layout`: is this session open in any window?
export function parseIsOnScreen(text: string): boolean {
  const value = parseJson(text) as { views?: unknown[] } | undefined
  return Array.isArray(value?.views) && value.views.length > 0
}

// Store keys `<fact>:<sessionId>` and their values, into Facts.
export function toFacts(entries: ReadonlyArray<readonly [string, unknown]>, lang: Lang = 'en'): Facts {
  const facts = emptyFacts()
  for (const [key, value] of entries) {
    const at = key.indexOf(':')
    const fact = key.slice(0, at)
    const id = key.slice(at + 1)
    if (fact === 'input') {
      if (value === true) facts.input[id] = true
    } else if (fact === 'bg') {
      facts.bg[id] = toTasks(value, lang)
    } else if ((FACT_PREFIXES as readonly string[]).includes(fact) && typeof value === 'number') {
      facts[fact as 'seen' | 'viewed' | 'hidden' | 'ctx' | 'flag' | 'done'][id] = value
    }
  }
  return facts
}

// `classic.Stop`'s `background_tasks`, kept small for the store. Older versions stored a bare count,
// monitors included; it says nothing, so it reads as none until the session's next stop.
// Monitors (a watch on an artifact, a log tail) are left out: the app does not list them either.
export function toTasks(value: unknown, lang: Lang = 'en'): BgTask[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null && one.type !== 'monitor')
    .map((one, i) => {
      const text = [one.label, one.description, one.command, one.name, one.agent_type].find(
        (part): part is string => typeof part === 'string' && part.trim() !== '',
      )
      return {
        id: typeof one.id === 'string' ? one.id : `t${i}`,
        type: typeof one.type === 'string' ? one.type : '?',
        status: typeof one.status === 'string' ? one.status : '',
        label: (text ?? STRINGS[lang].noDescription).replace(/\s+/g, ' ').slice(0, 160),
      }
    })
}

export function isFactKey(key: string): boolean {
  const at = key.indexOf(':')
  return at > 0 && (FACT_PREFIXES as readonly string[]).includes(key.slice(0, at))
}

const time = (iso: string | undefined) => {
  const at = iso ? Date.parse(iso) : NaN
  return Number.isNaN(at) ? 0 : at
}

const basename = (path: string | undefined) => (path ?? '').split('/').filter(Boolean).pop() ?? ''

// A worktree's folder belongs to the repository it was cut from.
export function projectPath(cwd: string | undefined): string {
  return (cwd ?? '').replace(/\/\.claude\/worktrees\/.*$/, '').replace(/\/+$/, '')
}

export function isWorktree(session: Session): boolean {
  return Boolean(session.worktree || session.worktreePath) || /\/(\.claude\/)?worktrees\//.test(session.cwd ?? '')
}

export function toRows(
  sessions: readonly Session[],
  facts: Facts,
  selfId: string | undefined,
  now: number,
  lang: Lang = 'en',
): Row[] {
  const byId = new Map<string, Session>()
  for (const one of sessions) if (!one.isArchived) byId.set(one.sessionId, one)

  const rows: Row[] = []
  for (const session of byId.values()) {
    const id = session.sessionId
    const isSelf = id === selfId
    const lastActivityAt = time(session.lastActivityAt)
    // Hidden from the pane only; a new turn (running, asking, or done since) brings it back.
    const hiddenAt = facts.hidden[id]
    const isHidden =
      hiddenAt !== undefined && !session.isRunning && !facts.input[id] && (facts.done[id] ?? 0) <= hiddenAt

    const seenAt = Math.max(facts.seen[id] ?? 0, facts.viewed[id] ?? 0)
    const state: RowState = facts.input[id]
      ? 'input'
      : session.isRunning
        ? 'running'
        : (facts.bg[id]?.length ?? 0) > 0
          ? 'waiting'
          : facts.flag[id] !== undefined || (!isSelf && (facts.done[id] ?? 0) > seenAt)
            ? 'unread'
            : 'idle'

    rows.push({
      id,
      title: session.title || STRINGS[lang].untitled,
      project: basename(projectPath(session.cwd)),
      projectPath: projectPath(session.cwd),
      ...(session.startedBy ? { parentId: session.startedBy } : {}),
      link: session.link ?? '',
      state,
      isSelf,
      isWorktree: isWorktree(session),
      isHidden,
      tasks: facts.bg[id] ?? [],
      ago: agoLabel(now - lastActivityAt, lang),
      agoShort: agoLabel(now - lastActivityAt, lang, true),
      lastActivityAt,
      lastViewedAt: facts.viewed[id] ?? 0,
      ...(facts.ctx[id] !== undefined ? { contextPercent: facts.ctx[id] } : {}),
    })
  }

  return rows.sort((a, b) => RANK[a.state] - RANK[b.state] || b.lastActivityAt - a.lastActivityAt)
}

// Sessions the cleanup button hides: quiet and unseen for CLEANUP_HOURS.
export function staleRows(rows: readonly Row[], now: number): Row[] {
  const limit = now - CLEANUP_HOURS * HOUR
  return rows.filter(
    row =>
      (row.state === 'idle' || row.state === 'unread') &&
      !row.isSelf &&
      !row.isHidden &&
      Math.max(row.lastActivityAt, row.lastViewedAt) < limit,
  )
}

// What the pane shows, without the values that tick on their own.
export function drawSignature(rows: readonly Row[]): string {
  return JSON.stringify(rows.map(({ lastActivityAt, lastViewedAt, ...shown }) => shown))
}

// Colors: each state has a main hue, a readable text tint, and translucent fills (#RRGGBBAA).
type Tone = { main: string; text: string; tint: string; border: string; chip: string }
export const THEME: Record<RowState, Tone> & {
  strong: string
  text: string
  sub: string
  muted: string
  faint: string
  hover: string
  line: string
} = {
  input: { main: '#f0643c', text: '#ff9a7a', tint: '#f0643c17', border: '#f0643c8c', chip: '#f0643c24' },
  running: { main: '#a78bfa', text: '#c4b5fd', tint: '#a78bfa12', border: '#a78bfa73', chip: '#a78bfa24' },
  waiting: { main: '#8b7fb8', text: '#b3a9d6', tint: '#8b7fb80f', border: '#8b7fb866', chip: '#8b7fb824' },
  unread: { main: '#f5b041', text: '#f6c46d', tint: '#f5b04112', border: '#f5b0416b', chip: '#f5b04121' },
  idle: { main: '#6b6862', text: '#a8a49c', tint: '#00000000', border: '#3a3835', chip: '#ffffff0d' },
  strong: '#ffffff',
  text: '#d6d2cb',
  sub: '#a8a49c',
  muted: '#8a8780',
  faint: '#5f5c56',
  hover: '#ffffff0f',
  line: '#2c2a28',
}

// Icons: plain SVG images (SMIL animates without `isInteractive`). Each state has its own shape.
const svg20 = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20">${body}</svg>`

// Working: three bars bouncing like an equalizer.
const bar = (x: number, values: string, begin: string) =>
  `<rect x="${x}" width="3" rx="1.5" fill="#a78bfa">` +
  `<animate attributeName="height" values="${values}" dur="0.9s" begin="${begin}" repeatCount="indefinite"/>` +
  `<animate attributeName="y" values="${values
    .split(';')
    .map(h => 16 - Number(h))
    .join(';')}" dur="0.9s" begin="${begin}" repeatCount="indefinite"/></rect>`

export const ICONS: Record<RowState, string> = {
  input: svg20(
    `<circle cx="10" cy="10" r="9" fill="#f0643c"><animate attributeName="opacity" values="1;0.5;1" dur="1.4s" repeatCount="indefinite"/></circle>` +
      `<rect x="9" y="4.5" width="2" height="7" rx="1" fill="#fff"/><circle cx="10" cy="14.5" r="1.2" fill="#fff"/>`,
  ),
  running: svg20(bar(4.5, '5;12;5', '0s') + bar(8.5, '11;4;11', '0s') + bar(12.5, '5;12;5', '0.3s')),
  waiting: svg20(
    `<path d="M6 3.5h8M6 16.5h8M7 3.5c0 3.5 6 3.5 6 6.5s-6 3-6 6.5M13 3.5c0 3.5-6 3.5-6 6.5" ` +
      `fill="none" stroke="#b3a9d6" stroke-width="1.6" stroke-linecap="round"/>`,
  ),
  unread: svg20(
    `<circle cx="10" cy="10" r="5" fill="#f5b041"><animate attributeName="opacity" values="1;0.45;1" dur="1.4s" repeatCount="indefinite"/></circle>`,
  ),
  idle: svg20(`<circle cx="10" cy="10" r="4" fill="none" stroke="#6b6862" stroke-width="1.6"/>`),
}

// Terminal fallback: one glyph per state.
export const GLYPHS: Record<RowState, string> = { input: '!', running: '≡', waiting: '⧗', unread: '●', idle: '○' }

export type ProjectGroup = {
  path: string
  name: string
  // Latest activity across ALL of the project's sessions, hidden or not.
  lastActivityAt: number
  rows: { row: Row; depth: number }[]
}

// Hidden rows by project (all rows with `includeActive`), the project worked on most recently
// first, each session followed by the ones it started (like the sidebar).
export function hiddenByProject(rows: readonly Row[], lang: Lang = 'en', includeActive = false): ProjectGroup[] {
  const latest = new Map<string, number>()
  for (const row of rows) latest.set(row.projectPath, Math.max(latest.get(row.projectPath) ?? 0, row.lastActivityAt))

  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    if (!row.isHidden && !includeActive) continue
    groups.set(row.projectPath, [...(groups.get(row.projectPath) ?? []), row])
  }

  return [...groups.entries()]
    .map(([path, inGroup]) => ({
      path,
      name: basename(path) || STRINGS[lang].noProject,
      lastActivityAt: latest.get(path) ?? 0,
      rows: nest(inGroup),
    }))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
}

function nest(rows: readonly Row[]): { row: Row; depth: number }[] {
  const ids = new Set(rows.map(row => row.id))
  const children = new Map<string, Row[]>()
  const roots: Row[] = []
  for (const row of rows) {
    if (row.parentId && ids.has(row.parentId)) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row])
    else roots.push(row)
  }
  const out: { row: Row; depth: number }[] = []
  const walk = (row: Row, depth: number) => {
    out.push({ row, depth })
    for (const child of byRecency(children.get(row.id) ?? [])) walk(child, depth + 1)
  }
  for (const root of byRecency(roots)) walk(root, 0)

  return out
}

// A section's rows in a steady order: by title, so a card stays put as its session works.
export const byTitle = (rows: readonly Row[], lang: Lang = 'en') =>
  [...rows].sort(
    (a, b) => a.title.localeCompare(b.title, lang, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id),
  )

const byRecency = (rows: readonly Row[]) => [...rows].sort((a, b) => b.lastActivityAt - a.lastActivityAt)

// Context fill as a short bar under the state icon: blue, amber from 75%, red from 90%.
export function contextColor(percent: number): string {
  return percent >= 90 ? '#f0643c' : percent >= 75 ? '#f5b041' : '#4c8dff'
}

export function contextBar(percent: number): string {
  const used = (Math.min(100, Math.max(0, percent)) / 100) * 26
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 3" width="26" height="3">` +
    `<rect width="26" height="3" rx="1.5" fill="#5f5c56" fill-opacity="0.55"/>` +
    `<rect width="${used.toFixed(1)}" height="3" rx="1.5" fill="${contextColor(percent)}"/></svg>`
  )
}

