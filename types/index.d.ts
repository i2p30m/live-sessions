export type RowState = 'input' | 'running' | 'waiting' | 'unread' | 'idle'

// One piece of background work a session reported at its last stop.
export type BgTask = {
  id: string
  type: string
  status: string
  label: string
  // When it started (ms): the launch when seen, else the first stop that listed it.
  startedAt?: number
  // How long it has run, as `<1m` / `6m` / `1h 04m`; filled per poll for drawing.
  elapsed?: string
}

export type Row = {
  id: string
  title: string
  project: string
  // The project folder (a worktree counts as its repository), which groups hidden rows.
  projectPath: string
  // The session that started this one, for nesting like the sidebar.
  parentId?: string
  link: string
  state: RowState
  isSelf: boolean
  isWorktree: boolean
  // Hidden from this pane only; the session itself is untouched.
  isHidden: boolean
  tasks: BgTask[]
  // Coarse "5 min temu" label; part of the draw signature.
  ago: string
  agoShort: string
  // Ticking values, left out of the draw signature.
  lastActivityAt: number
  lastViewedAt: number
  // Context window fill in percent, when the session has reported it.
  contextPercent?: number
  // The model working on the session, as a short name (`Sonnet 5.5`), when it has reported one.
  model?: string
}

declare module 'claude-code' {
  interface PluginState {
    'live-sessions': {
      rows: Row[]
      error: string | null
      // Rows whose background tasks are unfolded (`<id>`) and whose started sessions are (`family:<id>`).
      expandedIds: string[]
      // Project groups at the bottom that are folded (all start unfolded).
      closedProjects: string[]
      // Sessions shown per project at the bottom; 0 shows all.
      perProject: number
      // Projects list the sessions shown above too, not only the hidden ones.
      showActiveInProjects: boolean
    }
  }
}
