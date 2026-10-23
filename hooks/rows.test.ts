import { expect, test } from 'claude-code/testing'

import {
  drawSignature,
  hiddenByProject,
  projectPath,
  emptyFacts,
  isFactKey,
  parseIsOnScreen,
  parseSessions,
  toTasks,
  staleRows,
  toFacts,
  toRows,
} from './rows'
import { STRINGS, agoLabel, langOf } from './i18n'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString()

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  sessionId: id,
  title: id,
  cwd: `/code/${id}`,
  isRunning: false,
  lastActivityAt: at(1),
  link: `claude://x/${id}`,
  ...extra,
})

test('states are ordered input, running, waiting, unread, idle', async () => {
  const facts = toFacts([
    ['input:a', true],
    ['bg:c', 2],
    ['seen:e', NOW],
  ])
  const rows = toRows(
    [session('e'), session('d'), session('c'), session('b', { isRunning: true }), session('a', { isRunning: true })],
    facts,
    undefined,
    NOW,
  )
  expect(rows.map(row => `${row.id}:${row.state}`)).toEqual(['a:input', 'b:running', 'c:waiting', 'd:unread', 'e:idle'])
})

test('the current session is never unread', async () => {
  const [row] = toRows([session('me')], emptyFacts(), 'me', NOW)
  expect(row?.state).toBe('idle')
  expect(row?.isSelf).toBe(true)
})

test('viewing counts as seeing', async () => {
  const [row] = toRows([session('a')], toFacts([['viewed:a', NOW]]), undefined, NOW)
  expect(row?.state).toBe('idle')
})

test('a hidden row is flagged, and returns on new activity', async () => {
  const hiddenAt = NOW - 2 * 3600_000
  const [quiet] = toRows([session('a', { lastActivityAt: at(3) })], toFacts([['hidden:a', hiddenAt]]), undefined, NOW)
  expect(quiet?.isHidden).toBe(true)
  const [active] = toRows([session('a', { lastActivityAt: at(1) })], toFacts([['hidden:a', hiddenAt]]), undefined, NOW)
  expect(active?.isHidden).toBe(false)
})

test('archived sessions and duplicates are dropped', async () => {
  const rows = toRows([session('a'), session('a'), session('b', { isArchived: true })], emptyFacts(), undefined, NOW)
  expect(rows.map(row => row.id)).toEqual(['a'])
})

test('cleanup skips self, hidden, busy and recently viewed sessions', async () => {
  const old = { lastActivityAt: at(8) }
  const rows = toRows(
    [
      session('old', old),
      session('me', old),
      session('wt', { ...old, cwd: '/code/x/.claude/worktrees/feature' }),
      session('gone', old),
      session('busy', { ...old, isRunning: true }),
      session('looked', old),
      session('fresh'),
    ],
    toFacts([
      ['viewed:looked', NOW - 3600_000],
      ['hidden:gone', NOW],
    ]),
    'me',
    NOW,
  )
  expect(staleRows(rows, NOW).map(row => row.id)).toEqual(['old', 'wt'])
})

test('the draw signature ignores ticking times', async () => {
  const one = toRows([session('a')], emptyFacts(), undefined, NOW)
  const two = one.map(row => ({ ...row, lastActivityAt: row.lastActivityAt + 1000, lastViewedAt: 5 }))
  expect(drawSignature(two)).toBe(drawSignature(one))
  expect(drawSignature(one.map(row => ({ ...row, state: 'running' as const })))).not.toBe(drawSignature(one))
})

test('parsers read MCP text, prose first or not', async () => {
  expect(parseSessions('[{"sessionId":"a"},{"nope":1}]').map(s => s.sessionId)).toEqual(['a'])
  expect(parseSessions('not json')).toEqual([])
  const full = JSON.stringify([{ sessionId: 'a', group: { id: 'g' } }, { sessionId: 'b' }, { sessionId: 'c' }], null, 2)
  const cut = full.slice(0, full.indexOf('"c"'))
  expect(parseSessions(cut).map(one => one.sessionId)).toEqual(['a', 'b'])
  expect(parseIsOnScreen('This session is not open.\n{"views":[],"open_panes":[]}')).toBe(false)
  expect(parseIsOnScreen('{"views":[{"window":"main"}]}')).toBe(true)
})

test('store keys become facts; others are ignored', async () => {
  expect(isFactKey('seen:a')).toBe(true)
  expect(isFactKey('debug:log:a')).toBe(false)
  const facts = toFacts([
    ['bg:a', 0],
    ['input:a', false],
    ['seen:a', 'x'],
  ])
  expect(facts.bg.a).toEqual([])
  expect(facts.input.a).toBeUndefined()
  expect(facts.seen.a).toBeUndefined()
})

test('ago labels are coarse', async () => {
  expect(agoLabel(10_000, 'pl')).toBe('przed chwilą')
  expect(agoLabel(5 * 60_000, 'pl')).toBe('5 min temu')
  expect(agoLabel(3 * 3600_000, 'pl')).toBe('3 h temu')
  expect(agoLabel(50 * 3600_000, 'pl')).toBe('2 d temu')
  expect(agoLabel(5 * 60_000, 'en')).toBe('5 min ago')
  expect(agoLabel(3 * 3600_000, 'en', true)).toBe('3 h')
})

test('background tasks keep a short label; old counts still show', async () => {
  const [task] = toTasks([{ id: 'b1', type: 'shell', status: 'running', description: '', command: 'npm   run dev' }])
  expect(task).toEqual({ id: 'b1', type: 'shell', status: 'running', label: 'npm run dev' })
  expect(toTasks(2).length).toBe(2)
  expect(toTasks('junk')).toEqual([])
  const [row] = toRows([session('a')], toFacts([['bg:a', [{ id: 'x', type: 'subagent', status: 'running', description: 'Explore' }]]]), undefined, NOW)
  expect(row?.state).toBe('waiting')
  expect(row?.tasks.map(one => one.label)).toEqual(['Explore'])
  expect([1, 3, 5, 22, 12].map(STRINGS.pl.tasks)).toEqual([
    '1 zadanie w tle',
    '3 zadania w tle',
    '5 zadań w tle',
    '22 zadania w tle',
    '12 zadań w tle',
  ])
})

test('hidden rows group by project, most recently worked-on project first, children nested', async () => {
  const facts = toFacts([
    ['hidden:a1', NOW],
    ['hidden:a2', NOW],
    ['hidden:b1', NOW],
  ])
  const rows = toRows(
    [
      session('a1', { cwd: '/code/alpha', lastActivityAt: at(30) }),
      session('a2', { cwd: '/code/alpha/.claude/worktrees/fix', lastActivityAt: at(20), startedBy: 'a1' }),
      session('b1', { cwd: '/code/beta', lastActivityAt: at(10) }),
      // Not hidden, but alpha was worked on most recently.
      session('a3', { cwd: '/code/alpha', lastActivityAt: at(0.1) }),
    ],
    facts,
    undefined,
    NOW,
  )
  const groups = hiddenByProject(rows)
  expect(groups.map(group => group.name)).toEqual(['alpha', 'beta'])
  expect(groups[0]?.rows.map(({ row, depth }) => `${row.id}:${depth}`)).toEqual(['a1:0', 'a2:1'])
  expect(projectPath('/code/alpha/.claude/worktrees/fix')).toBe('/code/alpha')
})

test('the language follows Claude Code, English unless it says Polish', async () => {
  expect(['polish', 'Polski', 'pl', ' PL-pl'].map(langOf)).toEqual(['pl', 'pl', 'pl', 'pl'])
  expect(['english', 'japanese', '', undefined, 3].map(langOf)).toEqual(['en', 'en', 'en', 'en', 'en'])
  expect([1, 2].map(STRINGS.en.tasks)).toEqual(['1 background task', '2 background tasks'])
})

test('monitors are not background work; a flag marks a session to come back to', async () => {
  expect(toTasks([{ id: 'm', type: 'monitor', status: 'running', description: 'live updates' }])).toEqual([])
  const [quiet] = toRows([session('a')], toFacts([['bg:a', [{ id: 'm', type: 'monitor', status: 'running' }]], ['seen:a', NOW]]), undefined, NOW)
  expect(quiet?.state).toBe('idle')
  const [flagged] = toRows([session('a')], toFacts([['seen:a', NOW], ['flag:a', NOW]]), undefined, NOW)
  expect(flagged?.state).toBe('unread')
})
