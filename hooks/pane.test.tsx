import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString()

const PANE = {
  plugin: 'live-sessions',
  component: 'Pane',
  requestId: 'live-sessions',
  props: {
    title: 'Sesje na żywo',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SESSIONS = [
  { sessionId: 'local_run', title: 'Buduje', cwd: '/code/app', isRunning: true, lastActivityAt: at(0), link: 'claude://x/run' },
  { sessionId: 'local_new', title: 'Skończyła', cwd: '/code/app', isRunning: false, lastActivityAt: at(0.5), link: 'claude://x/new' },
  { sessionId: 'local_old', title: 'Stara', cwd: '/code/old', isRunning: false, lastActivityAt: at(9), link: 'claude://x/old' },
]
const SELF = { sessionId: 'local_me', title: 'Ta', cwd: '/code/me', isRunning: true, lastActivityAt: at(0) }

test('the pane shows states; hiding only hides', async ($, on) => {
  mock.clock(on, { now: NOW })
  // The store, in memory, with a record of every write.
  const store = new Map<string, unknown>([
    ['seen:local_old', NOW - 9 * 3600_000],
    ['bg:local_run', [{ id: 'b1', type: 'shell', status: 'running', description: 'npm run dev' }]],
  ])
  const writes: string[] = []
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.set', (_, e) => (writes.push(`set ${e.key}=${String(e.value)}`), store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (writes.push(`delete ${e.key}`), store.delete(e.key), { value: undefined }))
  const calledTools: string[] = []
  on('command.register', () => ({ value: { command: 'sesje' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({
    value: [{ id: 'live-sessions', title: 'Sesje na żywo', isShown: true, isFocused: false, isPlaced: true }],
  }))
  on('ui.focus', () => ({}))
  on('mcp.call', (_, e) => {
    calledTools.push(e.tool)
    const text =
      e.tool === 'list_sessions'
        ? JSON.stringify(SESSIONS)
        : e.tool === 'get_session'
          ? JSON.stringify(SELF)
          : e.tool === 'get_layout'
            ? '{"views":[]}'
            : 'unexpected'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /working$/ }))?.text).toBe('2 working')
    expect(await ui.find({ type: 'Text', text: /^WORKING$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^DONE, NOT CHECKED$/ })).toBeDefined()
    expect(await ui.find({ key: 'seen:local_me' })).toBeUndefined()
    expect(await ui.find({ key: 'hide:local_me' })).toBeUndefined()
    expect(await ui.find({ key: 'cleanup' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Icon buttons draw their glyph, not a label.
  expect((await ui.find({ key: 'hide:local_new' }))?.text).toBe('↓')
  await ui.select({ key: 'per-project', value: '0' })
  expect(writes).toContain('set pref:perProject=0')
  expect(await ui.find({ type: 'Text', text: /npm run dev/ })).toBeUndefined()
  await ui.press({ key: 'tasks:local_run' })
  expect((await ui.find({ type: 'Text', text: /npm run dev/ }))?.text).toBe('npm run dev')
  await ui.press({ key: 'hide:local_new' })
  expect(await ui.find({ key: 'hide:local_new' })).toBeUndefined()
  expect(writes).toContain(`set hidden:local_new=${NOW - 0.5 * 3600_000}`)
  // It sits under its project at the bottom, unfolded; folding hides it.
  expect(await ui.find({ key: 'unhide:local_new' })).toBeDefined()
  await ui.press({ key: 'project:/code/app' })
  expect(await ui.find({ key: 'unhide:local_new' })).toBeUndefined()
  await ui.press({ key: 'project:/code/app' })
  expect(await ui.find({ key: 'unhide:local_new' })).toBeDefined()
  await ui.press({ key: 'unhide:local_new' })
  expect(await ui.find({ key: 'hide:local_new' })).toBeDefined()
  expect(writes).toContain('delete hidden:local_new')
  // Nothing was ever archived: the mod only reads sessions.
  expect(calledTools.filter(tool => !['list_sessions', 'get_session', 'get_layout'].includes(tool))).toEqual([])
  await ui.unmount()
})

test('a prompt opens the pane when an unasked open was not placed', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const opens: string[] = []
  let isPlaced = false
  on('command.register', () => ({ value: { command: 'sesje' } }))
  on('ui.open', () => (opens.push('open'), { value: { isPlaced: false as const, reason: 'narrow' } }))
  on('ui.panes', () => ({
    value: [{ id: 'live-sessions', title: 'Sesje na żywo', isShown: false, isFocused: false, isPlaced }],
  }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '{"views":[]}' }], isError: false } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opens.length).toBe(1)
  await $.prompt.submit({ text: 'hej', wait: false, origin: { kind: 'composer' } })
  expect(opens.length).toBe(2)

})

test('with Claude Code set to Polish the pane speaks Polish', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('settings.read', () => ({ value: { language: 'polish' } }))
  on('command.register', () => ({ value: { command: 'sesje' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({
    value: [{ id: 'live-sessions', title: 'Sesje na żywo', isShown: true, isFocused: false, isPlaced: true }],
  }))
  on('mcp.call', (_, e) => {
    const text = e.tool === 'list_sessions' ? JSON.stringify(SESSIONS) : e.tool === 'get_session' ? JSON.stringify(SELF) : '{"views":[]}'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /pracuje$/ }))?.text).toBe('2 pracuje')
  expect(await ui.find({ type: 'Text', text: /^SKOŃCZONE, DO SPRAWDZENIA$/ })).toBeDefined()
  await ui.unmount()
})
