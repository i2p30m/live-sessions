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
  const clock = mock.clock(on, { now: NOW })
  // The store, in memory, with a record of every write.
  const store = new Map<string, unknown>([
    ['seen:local_old', NOW - 9 * 3600_000],
    ['done:local_new', NOW - 0.5 * 3600_000],
    ['bg:local_run', [{ id: 'b1', type: 'shell', status: 'running', description: 'npm run dev' }]],
    ['ctx:local_run', 42],
  ])
  const writes: string[] = []
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.set', (_, e) => (writes.push(`set ${e.key}=${String(e.value)}`), store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (writes.push(`delete ${e.key}`), store.delete(e.key), { value: undefined }))
  const calledTools: string[] = []
  const runs: string[] = []
  on('process.run', (_, e) => (runs.push(e.argv.join(' ')), { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
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

  // The app's first width is not the person's; a later change, once it settles, is kept.
  const wide = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 72 } })
  await wide.unmount()
  await clock.advance(2000)
  expect(writes).toContain('set pref:columns=72')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // A live session that reported its context fill shows it as a bar and a number.
  const alts = (await ui.findAll({ type: 'Svg' })).map(svg => (svg.props as { alt?: string }).alt)
  expect(alts).toContain('Context 42% used')
  expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
  // Only the session the pane is in has a white border.
  expect((await ui.find({ key: 'row:local_me' }))?.props.borderColor).toBe('#ffffff')
  expect((await ui.find({ key: 'row:local_run' }))?.props.borderColor).not.toBe('#ffffff')
  // The circle of an idle session flags it to come back to.
  await ui.press({ key: 'flag:local_old' })
  expect(writes.some(write => write.startsWith('set flag:local_old='))).toBe(true)
  expect(await ui.find({ key: 'seen:local_old' })).toBeDefined()
  // Icon buttons draw their glyph, not a label.
  expect((await ui.find({ key: 'hide:local_new' }))?.text).toBe('↓')
  expect(await ui.find({ type: 'Text', text: /npm run dev/ })).toBeUndefined()
  await ui.press({ key: 'tasks:local_run' })
  expect((await ui.find({ type: 'Text', text: /npm run dev/ }))?.text).toBe('npm run dev')
  // A task of another session opens that session and asks it to show its tasks pane.
  await ui.press({ key: 'open-task:local_run:b1' })
  expect(runs).toContain('open claude://x/run')
  expect(writes.some(write => write.startsWith('set showTasks:local_run='))).toBe(true)
  await ui.press({ key: 'hide:local_new' })
  expect(await ui.find({ key: 'hide:local_new' })).toBeUndefined()
  expect(writes.some(write => write.startsWith('set hidden:local_new='))).toBe(true)
  // It sits under its project at the bottom, unfolded; folding hides it.
  expect(await ui.find({ key: 'unhide:local_new' })).toBeDefined()
  // The sessions-per-project choice sits in the PROJECTS header once there are projects.
  await ui.select({ key: 'per-project', value: '0' })
  expect(writes).toContain('set pref:perProject=0')
  // The ⊕ toggle lists the sessions shown above in their projects too, without a ↑.
  expect(await ui.find({ key: 'open-in-project:local_run' })).toBeUndefined()
  await ui.press({ key: 'show-active' })
  expect(writes).toContain('set pref:showActiveInProjects=true')
  expect(await ui.find({ key: 'open-in-project:local_run' })).toBeDefined()
  expect(await ui.find({ key: 'unhide:local_run' })).toBeUndefined()
  await ui.press({ key: 'show-active' })
  expect(await ui.find({ key: 'open-in-project:local_run' })).toBeUndefined()
  await ui.press({ key: 'project:/code/app' })
  expect(await ui.find({ key: 'unhide:local_new' })).toBeUndefined()
  // + opens a new session in the project's folder.
  await ui.press({ key: 'new:/code/app' })
  expect(runs).toContain('open claude://code/new?folder=%2Fcode%2Fapp&source=services')
  // Folding is shared by every session through the store.
  expect(writes).toContain('set pref:closedProjects=/code/app')
  await ui.press({ key: 'project:/code/app' })
  expect(await ui.find({ key: 'unhide:local_new' })).toBeDefined()
  await ui.press({ key: 'unhide:local_new' })
  expect(await ui.find({ key: 'hide:local_new' })).toBeDefined()
  expect(writes).toContain('delete hidden:local_new')
  // Nothing was ever archived: the mod only reads sessions.
  expect(calledTools.filter(tool => !['list_sessions', 'get_session', 'get_layout'].includes(tool))).toEqual([])
  await ui.unmount()
})

test('a session asked to show its tasks does so once it is on screen', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['showTasks:local_me', NOW]])
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
  on('command.register', () => ({ value: { command: 'sesje' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  let isOnScreen = false
  const shown: unknown[] = []
  on('mcp.call', (_, e) => {
    if (e.tool === 'show_pane') shown.push(e.args)
    const text =
      e.tool === 'get_session'
        ? JSON.stringify(SELF)
        : e.tool === 'get_layout'
          ? JSON.stringify({ views: isOnScreen ? [{ sessionId: 'local_me' }] : [] })
          : '{}'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(shown).toEqual([])
  isOnScreen = true
  await clock.advance(4000)
  expect(shown).toEqual([{ pane: 'tasks' }])
  expect(store.has('showTasks:local_me')).toBe(false)
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
  const store = new Map<string, unknown>([['done:local_new', NOW - 0.5 * 3600_000]])
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
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
