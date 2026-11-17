/** Scheduled reminders: the user-editable config file and the pure "what is due now" logic. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Profile-relative JSON listing the reminders; edits apply without a restart. */
export const REMINDERS_CONFIG_FILE = 'orb-reminders.json'

/** Profile-relative JSON remembering which reminders already fired today, so a restart does not repeat them. */
export const REMINDERS_STATE_FILE = 'orb-reminders-state.json'

/** A reminder is skipped when the app only notices it this long after its time (for example a late launch). */
export const REMINDER_LATE_TOLERANCE_MS = 10 * 60 * 1000

/** Face moods a reminder may show; they are the moods `renderer/orb-face.js` knows. */
export const REMINDER_MOODS = [
  'idle', 'hello', 'thinking', 'working', 'curious', 'happy', 'error',
  'sleepy', 'surprised', 'shy', 'dizzy', 'celebrate', 'writing',
] as const

export type ReminderMood = typeof REMINDER_MOODS[number]

/** What the button on a reminder does. */
export const REMINDER_ACTIONS = ['daily-report', 'weekly-report'] as const

export type ReminderAction = typeof REMINDER_ACTIONS[number]

const DEFAULT_ACTION_LABELS: Readonly<Record<ReminderAction, string>> = {
  'daily-report': '生成日报草稿',
  'weekly-report': '生成周报草稿',
}

/** One reminder. `days` use `Date.getDay()` numbering: 0 is Sunday, 6 is Saturday. */
export interface ReminderEntry {
  readonly id: string
  /** Local 24-hour `HH:MM`. */
  readonly time: string
  readonly days: readonly number[]
  readonly mood: ReminderMood
  readonly title: string
  readonly message: string
  /** When set, the reminder shows a button labelled {@link ReminderEntry.actionLabel} that runs this action. */
  readonly action?: ReminderAction
  readonly actionLabel?: string
}

export interface ReminderConfig {
  readonly enabled: boolean
  /** Play the system beep when a reminder appears. */
  readonly sound: boolean
  readonly reminders: readonly ReminderEntry[]
}

/** Which reminders fired on which local date. */
export interface ReminderFiredState {
  readonly date: string
  readonly ids: readonly string[]
}

const WORKDAYS: readonly number[] = [1, 2, 3, 4, 5]
const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/u

/**
 * The reminders a fresh profile starts with.
 * @returns a config with the report and knocking-off reminders on workdays.
 */
export function defaultReminderConfig(): ReminderConfig {
  return {
    enabled: true,
    sound: false,
    reminders: [
      {
        id: 'daily-report',
        time: '18:20',
        days: WORKDAYS,
        mood: 'writing',
        title: '该写日报了',
        message: '趁还记得，把今天做的事记下来吧',
        action: 'daily-report',
        actionLabel: DEFAULT_ACTION_LABELS['daily-report'],
      },
      {
        id: 'off-work',
        time: '18:30',
        days: WORKDAYS,
        mood: 'celebrate',
        title: '下班啦',
        message: '今天辛苦了，收拾东西回家吧',
      },
      {
        id: 'weekly-report',
        time: '09:30',
        days: [5],
        mood: 'writing',
        title: '该交周报了',
        message: '本周的工作日志已经攒好了，整理一下发到钉钉吧',
        action: 'weekly-report',
        actionLabel: DEFAULT_ACTION_LABELS['weekly-report'],
      },
    ],
  }
}

/** The reminder that tells the user to knock off; it follows the working hours when they are set. */
export const OFF_WORK_REMINDER_ID = 'off-work'

/**
 * Make the knocking-off reminder fire at the user's own off-work time.
 * @param config - the loaded reminders.
 * @param workEnd - off-work time in minutes since midnight, when the user has set one.
 * @returns the config with that reminder's time replaced; unchanged when no time is set or it has no such reminder.
 */
export function alignOffWork(config: ReminderConfig, workEnd: number | undefined): ReminderConfig {
  if (workEnd === undefined || !config.reminders.some(entry => entry.id === OFF_WORK_REMINDER_ID)) return config
  const time = `${String(Math.floor(workEnd / 60)).padStart(2, '0')}:${String(workEnd % 60).padStart(2, '0')}`
  return {
    ...config,
    reminders: config.reminders.map(entry => (entry.id === OFF_WORK_REMINDER_ID ? { ...entry, time } : entry)),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEntry(value: unknown, index: number, problems: string[]): ReminderEntry | undefined {
  const label = `reminders[${String(index)}]`
  if (!isRecord(value)) {
    problems.push(`${label} is not an object`)
    return undefined
  }
  const { id, time, days, mood, title, message, action, actionLabel } = value
  if (typeof id !== 'string' || id === '') {
    problems.push(`${label}.id must be a non-empty string`)
    return undefined
  }
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) {
    problems.push(`${label} (${id}).time must look like "18:30"`)
    return undefined
  }
  const dayList = days === undefined
    ? WORKDAYS
    : Array.isArray(days) && days.every(day => Number.isInteger(day) && (day as number) >= 0 && (day as number) <= 6)
      ? (days as number[])
      : undefined
  if (dayList === undefined) {
    problems.push(`${label} (${id}).days must be a list of 0-6 (0 is Sunday)`)
    return undefined
  }
  const knownMood = REMINDER_MOODS.find(candidate => candidate === mood)
  if (mood !== undefined && knownMood === undefined) {
    problems.push(`${label} (${id}).mood "${String(mood)}" is unknown; using "happy"`)
  }
  const knownAction = REMINDER_ACTIONS.find(candidate => candidate === action)
  if (action !== undefined && knownAction === undefined) {
    problems.push(`${label} (${id}).action "${String(action)}" is unknown and is ignored`)
  }
  return {
    id,
    time,
    days: dayList,
    mood: knownMood ?? 'happy',
    title: typeof title === 'string' ? title : '',
    message: typeof message === 'string' ? message : '',
    ...(knownAction === undefined ? {} : {
      action: knownAction,
      actionLabel: typeof actionLabel === 'string' && actionLabel !== '' ? actionLabel : DEFAULT_ACTION_LABELS[knownAction],
    }),
  }
}

/**
 * Parse the config file text, keeping every entry that is valid.
 * @param text - JSON file contents.
 * @returns the config (absent when the JSON is unusable) and a message per ignored or adjusted entry.
 */
export function parseReminderConfig(text: string): { config: ReminderConfig | undefined; problems: string[] } {
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { config: undefined, problems: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!isRecord(raw)) return { config: undefined, problems: ['the top level must be an object'] }
  const entries = Array.isArray(raw.reminders) ? raw.reminders : []
  if (!Array.isArray(raw.reminders)) problems.push('"reminders" must be a list')
  const seen = new Set<string>()
  const reminders: ReminderEntry[] = []
  entries.forEach((value, index) => {
    const entry = parseEntry(value, index, problems)
    if (entry === undefined) return
    if (seen.has(entry.id)) {
      problems.push(`reminders[${String(index)}].id "${entry.id}" is a duplicate`)
      return
    }
    seen.add(entry.id)
    reminders.push(entry)
  })
  return {
    config: { enabled: raw.enabled !== false, sound: raw.sound === true, reminders },
    problems,
  }
}

/**
 * Read the config, writing the default file first when none exists.
 * @param profileDir - Desktop profile directory.
 * @returns the parsed result; `config` is absent when the file cannot be used.
 */
export function readReminderConfig(profileDir: string): { config: ReminderConfig | undefined; problems: string[] } {
  const path = join(profileDir, REMINDERS_CONFIG_FILE)
  if (!existsSync(path)) {
    const defaults = defaultReminderConfig()
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(defaultConfigDocument(defaults), undefined, 2)}\n`)
    return { config: defaults, problems: [] }
  }
  return parseReminderConfig(readFileSync(path, 'utf8'))
}

function defaultConfigDocument(config: ReminderConfig): Record<string, unknown> {
  return {
    help: 'time is local HH:MM; days use 0=Sunday .. 6=Saturday (default Monday to Friday); '
      + 'mood is one of: ' + REMINDER_MOODS.join(', ') + '. action (optional) adds a button: ' + REMINDER_ACTIONS.join(', ')
      + '. Changes apply within a minute, no restart needed.',
    enabled: config.enabled,
    sound: config.sound,
    reminders: config.reminders,
  }
}

/**
 * Local calendar date as `YYYY-MM-DD`.
 * @param date - the moment to format.
 * @returns the local date key used by {@link ReminderFiredState}.
 */
export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/**
 * Which reminders should appear right now.
 * @param config - the loaded config.
 * @param now - the current local time.
 * @param fired - what already fired; entries from an earlier date are ignored.
 * @returns entries scheduled for today whose time has arrived within {@link REMINDER_LATE_TOLERANCE_MS}.
 */
export function dueReminders(config: ReminderConfig, now: Date, fired: ReminderFiredState): ReminderEntry[] {
  if (!config.enabled) return []
  const done = new Set(fired.date === localDateKey(now) ? fired.ids : [])
  return config.reminders.filter((entry) => {
    if (done.has(entry.id) || !entry.days.includes(now.getDay())) return false
    const match = TIME_PATTERN.exec(entry.time)
    if (match === null) return false
    const scheduled = new Date(now)
    scheduled.setHours(Number(match[1]), Number(match[2]), 0, 0)
    const late = now.getTime() - scheduled.getTime()
    return late >= 0 && late <= REMINDER_LATE_TOLERANCE_MS
  })
}

/**
 * Record reminders as fired.
 * @param fired - the state so far.
 * @param ids - reminders that just fired.
 * @param now - the current local time.
 * @returns today's state, starting fresh when the date has changed.
 */
export function markReminderFired(fired: ReminderFiredState, ids: readonly string[], now: Date): ReminderFiredState {
  const today = localDateKey(now)
  const earlier = fired.date === today ? fired.ids : []
  return { date: today, ids: [...new Set([...earlier, ...ids])] }
}

/**
 * Load the fired-today state.
 * @param profileDir - Desktop profile directory.
 * @returns the saved state, or an empty one when missing or unreadable.
 */
export function readReminderState(profileDir: string): ReminderFiredState {
  try {
    const value: unknown = JSON.parse(readFileSync(join(profileDir, REMINDERS_STATE_FILE), 'utf8'))
    if (isRecord(value) && typeof value.date === 'string' && Array.isArray(value.ids)
      && value.ids.every(id => typeof id === 'string')) {
      return { date: value.date, ids: value.ids as string[] }
    }
  } catch {
    // A missing or damaged state file means nothing has fired yet.
  }
  return { date: '', ids: [] }
}

/**
 * Save the fired-today state.
 * @param profileDir - Desktop profile directory.
 * @param state - what has fired today.
 */
export function writeReminderState(profileDir: string, state: ReminderFiredState): void {
  writeFileSync(join(profileDir, REMINDERS_STATE_FILE), `${JSON.stringify(state)}\n`)
}

/** The next reminder to come. */
export interface UpcomingReminder {
  readonly entry: ReminderEntry
  /** When it is due. */
  readonly at: Date
}

/**
 * The next reminder due after a moment, looking up to a week ahead.
 * @param config - the loaded config (apply {@link alignOffWork} first to follow the working hours).
 * @param now - the current local time.
 * @param fired - what already fired today; those are not offered again for today.
 * @returns the earliest reminder still to come; undefined when reminders are off or none is scheduled.
 */
export function nextReminder(config: ReminderConfig, now: Date, fired: ReminderFiredState): UpcomingReminder | undefined {
  if (!config.enabled) return undefined
  const doneToday = new Set(fired.date === localDateKey(now) ? fired.ids : [])
  let best: UpcomingReminder | undefined
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead)
    for (const entry of config.reminders) {
      if (!entry.days.includes(day.getDay())) continue
      if (ahead === 0 && doneToday.has(entry.id)) continue
      const match = TIME_PATTERN.exec(entry.time)
      if (match === null) continue
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(match[1]), Number(match[2]), 0, 0)
      if (at.getTime() <= now.getTime()) continue
      if (best === undefined || at.getTime() < best.at.getTime()) best = { entry, at }
    }
    if (best !== undefined) return best
  }
  return best
}
