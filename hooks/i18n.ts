import type { RowState } from '../types'

export type Lang = 'en' | 'pl'

// Claude Code's `language` setting is free text ("polish", "Polski", "pl"); English otherwise.
export function langOf(setting: unknown): Lang {
  return typeof setting === 'string' && /^\s*(pl\b|pol|polsk)/i.test(setting) ? 'pl' : 'en'
}

const plural = (n: number, one: string, few: string, many: string) =>
  n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many

export type Strings = {
  title: string
  commandDescription: string
  commandOpened: string
  state: Record<RowState, string>
  pill: Record<Exclude<RowState, 'idle'>, (n: number) => string>
  nothingWaiting: string
  perProject: string
  all: string
  cleanup: (hours: number, n: number) => string
  projects: string
  more: (n: number) => string
  thisSession: string
  credit: (version: string) => string
  context: (percent: number) => string
  worktree: string
  justNow: string
  ago: (amount: number, unit: 'min' | 'h' | 'd') => string
  tasks: (n: number) => string
  untitled: string
  noDescription: string
  detailsAfterRestart: string
  noProject: string
  refreshFailed: (error: string) => string
  listUnreadable: (length: number, text: string) => string
  listEmpty: (text: string) => string
}

export const STRINGS: Record<Lang, Strings> = {
  en: {
    title: 'Live sessions',
    commandDescription: 'Opens the “Live sessions” pane',
    commandOpened: '“Live sessions” pane opened.',
    state: {
      input: 'Needs you',
      running: 'Working',
      waiting: 'Waiting on background work',
      unread: 'Done, not checked',
      idle: 'Other',
    },
    pill: {
      input: n => `${n} waiting`,
      running: n => `${n} working`,
      waiting: n => `${n} in background`,
      unread: n => `${n} to check`,
    },
    nothingWaiting: 'Nothing is waiting for you.',
    perProject: 'Sessions per project',
    all: 'All',
    cleanup: (hours, n) => `↓ Move idle > ${hours} h to projects (${n})`,
    projects: 'PROJECTS',
    more: n => `+ ${n} more`,
    thisSession: 'this session',
    credit: version => `created by i2p30m · version ${version}`,
    context: percent => `Context ${percent}% used`,
    worktree: 'worktree',
    justNow: 'just now',
    ago: (amount, unit) => `${amount} ${unit} ago`,
    tasks: n => `${n} background ${n === 1 ? 'task' : 'tasks'}`,
    untitled: 'Untitled',
    noDescription: 'no description',
    detailsAfterRestart: 'details after the session restarts',
    noProject: 'no project',
    refreshFailed: error => `Refresh failed: ${error}`,
    listUnreadable: (length, text) => `Could not read the session list (${length} characters): ${text}`,
    listEmpty: text => `Could not fetch sessions: ${text}`,
  },
  pl: {
    title: 'Sesje na żywo',
    commandDescription: 'Otwiera panel „Sesje na żywo”',
    commandOpened: 'Panel „Sesje na żywo” otwarty.',
    state: {
      input: 'Czeka na Twoją odpowiedź',
      running: 'Pracuje',
      waiting: 'Czeka na pracę w tle',
      unread: 'Skończone, do sprawdzenia',
      idle: 'Pozostałe',
    },
    pill: {
      input: n => `${n} czeka`,
      running: n => `${n} pracuje`,
      waiting: n => `${n} w tle`,
      unread: n => `${n} do sprawdzenia`,
    },
    nothingWaiting: 'Nic nie czeka na Ciebie.',
    perProject: 'Sesji na projekt',
    all: 'Wszystkie',
    cleanup: (hours, n) => `↓ Przenieś nieaktywne > ${hours} h do projektów (${n})`,
    projects: 'PROJEKTY',
    more: n => `+ ${n} więcej`,
    thisSession: 'ta sesja',
    credit: version => `stworzone przez i2p30m · wersja ${version}`,
    context: percent => `Kontekst: ${percent}% zajęte`,
    worktree: 'worktree',
    justNow: 'przed chwilą',
    ago: (amount, unit) => `${amount} ${unit} temu`,
    tasks: n => `${n} ${plural(n, 'zadanie', 'zadania', 'zadań')} w tle`,
    untitled: 'Bez tytułu',
    noDescription: 'bez opisu',
    detailsAfterRestart: 'szczegóły po restarcie sesji',
    noProject: 'bez projektu',
    refreshFailed: error => `Błąd odświeżania: ${error}`,
    listUnreadable: (length, text) => `Nie udało się odczytać listy sesji (${length} znaków): ${text}`,
    listEmpty: text => `Nie udało się pobrać sesji: ${text}`,
  },
}

// "5 min ago"; with `isShort`, just "5 min".
export function agoLabel(ms: number, lang: Lang, isShort = false): string {
  const s = STRINGS[lang]
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  const [amount, unit] =
    minutes < 1 ? [0, 'min' as const] : minutes < 60 ? [minutes, 'min' as const] : hours < 24 ? [hours, 'h' as const] : [Math.floor(hours / 24), 'd' as const]
  if (minutes < 1) return s.justNow
  return isShort ? `${amount} ${unit}` : s.ago(amount, unit)
}
