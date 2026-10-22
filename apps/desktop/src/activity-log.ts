/** The local activity log behind the daily report: config, privacy filtering, per-day storage, and totals. */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { localDateKey } from './reminders.ts'

/** Profile-relative JSON holding the recorder settings; edits apply without a restart. */
export const ACTIVITY_CONFIG_FILE = 'orb-activity.json'

/** Profile-relative folder with one `YYYY-MM-DD.jsonl` file per day. */
export const ACTIVITY_DIR = 'activity'

/** Profile-relative folder where this app's own screen descriptions are kept, in the same `YYYY-MM-DD.jsonl` form. */
export const NATIVE_VISION_DIR = 'orb-vision'

/** Title shown in place of one the privacy rules hide. */
export const HIDDEN_TITLE = '(已隐藏)'

const MAX_TITLE_CHARS = 200

export interface ActivityConfig {
  readonly enabled: boolean
  /** Seconds between samples. */
  readonly intervalSeconds: number
  /** Seconds without keyboard or mouse input after which time counts as idle. */
  readonly idleSeconds: number
  /** Days of history kept on disk. */
  readonly keepDays: number
  /** Programs that are never recorded at all (compared to the program name, ignoring case). */
  readonly ignoreApps: readonly string[]
  /** Programs recorded by name only; their window titles are dropped. */
  readonly hideTitleApps: readonly string[]
  /** A window title containing any of these (ignoring case) is dropped. */
  readonly hideTitleContains: readonly string[]
  /**
   * Past daily-report entries to show the model as examples of how to write: a JSON file of
   * `{ "YYYY-MM-DD": [{ "time": "18:20", "content": "..." }] }`. Empty means no examples.
   * `%NAME%` expands to that environment variable.
   */
  readonly workLogFile: string
  /** How many of the most recent logged days to show as examples. */
  readonly exampleDays: number
  /**
   * Folder of `YYYY-MM-DD.jsonl` files whose lines are `{ "time": "HH:MM", "description": "..." }`: one-sentence
   * descriptions of what was on screen, written by another tool. They are given to the model as extra context.
   * Empty means none. `%NAME%` expands to that environment variable.
   */
  readonly visionDir: string
}

/** One short description of what was on screen at a moment of the day. */
export interface ScreenNote {
  /** Local `HH:MM`. */
  readonly time: string
  readonly text: string
}

/** One past day of report entries. */
export interface WorkLogDay {
  readonly date: string
  readonly items: readonly string[]
}

/** One observation: what was in front at time `t` (milliseconds since the epoch). */
export interface ActivitySample {
  readonly t: number
  readonly app: string
  readonly title: string
  readonly idle: boolean
}

/** Time spent in one program, with its busiest window titles. */
export interface AppUsage {
  readonly app: string
  readonly ms: number
  readonly titles: readonly { readonly title: string; readonly ms: number }[]
}

/** One day's totals. Idle time is counted apart and never appears under an application. */
export interface DaySummary {
  readonly firstAt: number | undefined
  readonly lastAt: number | undefined
  readonly activeMs: number
  readonly idleMs: number
  readonly apps: readonly AppUsage[]
}

/**
 * The settings a fresh profile starts with.
 * @returns the default config: record every 30 seconds, hide chat window titles and obvious secrets.
 */
export function defaultActivityConfig(): ActivityConfig {
  return {
    enabled: true,
    intervalSeconds: 30,
    idleSeconds: 120,
    keepDays: 30,
    ignoreApps: ['1Password', 'KeePass', 'KeePassXC', 'Bitwarden'],
    hideTitleApps: [
      'Weixin', 'WeChat', 'WeChatAppEx', 'WXWork', 'QQ', 'DingTalk', 'Feishu', 'Lark', 'Telegram', 'Slack', 'Teams',
    ],
    hideTitleContains: ['password', '密码', '口令', '验证码', '银行', '支付', 'private', '私人'],
    workLogFile: '',
    exampleDays: 10,
    visionDir: '',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberIn(value: unknown, min: number, max: number, fallback: number, name: string, problems: string[]): number {
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) return Math.round(value)
  problems.push(`${name} must be a number from ${String(min)} to ${String(max)}; using ${String(fallback)}`)
  return fallback
}

function stringList(value: unknown, fallback: readonly string[], name: string, problems: string[]): readonly string[] {
  if (value === undefined) return fallback
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value as string[]
  problems.push(`${name} must be a list of strings; using the default`)
  return fallback
}

/**
 * Parse the config text, falling back to the default for anything missing or invalid.
 * @param text - JSON file contents.
 * @returns the config (absent when the JSON is unusable) and a message per adjusted value.
 */
export function parseActivityConfig(text: string): { config: ActivityConfig | undefined; problems: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { config: undefined, problems: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!isRecord(raw)) return { config: undefined, problems: ['the top level must be an object'] }
  const defaults = defaultActivityConfig()
  const problems: string[] = []
  return {
    config: {
      enabled: raw.enabled !== false,
      intervalSeconds: numberIn(raw.intervalSeconds, 5, 600, defaults.intervalSeconds, 'intervalSeconds', problems),
      idleSeconds: numberIn(raw.idleSeconds, 10, 7200, defaults.idleSeconds, 'idleSeconds', problems),
      keepDays: numberIn(raw.keepDays, 1, 365, defaults.keepDays, 'keepDays', problems),
      ignoreApps: stringList(raw.ignoreApps, defaults.ignoreApps, 'ignoreApps', problems),
      hideTitleApps: stringList(raw.hideTitleApps, defaults.hideTitleApps, 'hideTitleApps', problems),
      hideTitleContains: stringList(raw.hideTitleContains, defaults.hideTitleContains, 'hideTitleContains', problems),
      workLogFile: typeof raw.workLogFile === 'string' ? raw.workLogFile.trim() : defaults.workLogFile,
      exampleDays: numberIn(raw.exampleDays, 0, 60, defaults.exampleDays, 'exampleDays', problems),
      visionDir: typeof raw.visionDir === 'string' ? raw.visionDir.trim() : defaults.visionDir,
    },
    problems,
  }
}

/**
 * Read the config, writing the default file first when none exists.
 * @param profileDir - Desktop profile directory.
 * @returns the parsed result; `config` is absent when the file cannot be used.
 */
export function readActivityConfig(profileDir: string): { config: ActivityConfig | undefined; problems: string[] } {
  const path = join(profileDir, ACTIVITY_CONFIG_FILE)
  if (!existsSync(path)) {
    const defaults = defaultActivityConfig()
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(path, `${JSON.stringify({
      help: 'Records the foreground program and window title every intervalSeconds, only on this computer, to build the '
        + 'daily report. ignoreApps: never recorded. hideTitleApps: program name only, no title. hideTitleContains: '
        + 'titles with these words are hidden. workLogFile: a JSON file of your past report entries, shown to the model as '
        + 'examples of how you write (exampleDays most recent days; empty = none), and confirmed reports are written back to it. '
        + 'visionDir: a folder of YYYY-MM-DD.jsonl files with one-sentence screen descriptions, used as extra context. '
        + 'Set "enabled": false to stop recording. Changes apply within a minute.',
      ...defaults,
    }, undefined, 2)}\n`)
    return { config: defaults, problems: [] }
  }
  return parseActivityConfig(readFileSync(path, 'utf8'))
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Apply the privacy rules to one observation.
 * @param observation - the foreground program and title as read.
 * @param config - the privacy lists.
 * @returns what may be stored, or undefined when the program must not be recorded.
 */
export function filterObservation(
  observation: { readonly app: string; readonly title: string },
  config: ActivityConfig,
): { app: string; title: string } | undefined {
  const { app } = observation
  if (config.ignoreApps.some(name => sameName(name, app))) return undefined
  const title = observation.title.trim().slice(0, MAX_TITLE_CHARS)
  if (title === '') return { app, title }
  if (config.hideTitleApps.some(name => sameName(name, app))) return { app, title: HIDDEN_TITLE }
  const lower = title.toLowerCase()
  if (config.hideTitleContains.some(word => word !== '' && lower.includes(word.toLowerCase()))) {
    return { app, title: HIDDEN_TITLE }
  }
  return { app, title }
}

/**
 * Path of one day's log file.
 * @param profileDir - Desktop profile directory.
 * @param dateKey - local date as `YYYY-MM-DD`.
 * @returns the `.jsonl` path.
 */
export function activityFilePath(profileDir: string, dateKey: string): string {
  return join(profileDir, ACTIVITY_DIR, `${dateKey}.jsonl`)
}

/**
 * Append one sample to its day's file.
 * @param profileDir - Desktop profile directory.
 * @param sample - the observation.
 */
export function appendActivitySample(profileDir: string, sample: ActivitySample): void {
  mkdirSync(join(profileDir, ACTIVITY_DIR), { recursive: true })
  appendFileSync(activityFilePath(profileDir, localDateKey(new Date(sample.t))), `${JSON.stringify(sample)}\n`)
}

/**
 * Read one day's samples, skipping lines that are damaged.
 * @param profileDir - Desktop profile directory.
 * @param dateKey - local date as `YYYY-MM-DD`.
 * @returns the samples in time order.
 */
export function readActivityDay(profileDir: string, dateKey: string): ActivitySample[] {
  let text: string
  try {
    text = readFileSync(activityFilePath(profileDir, dateKey), 'utf8')
  } catch {
    // No file means nothing was recorded that day.
    return []
  }
  const samples: ActivitySample[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value) && typeof value.t === 'number' && typeof value.app === 'string'
        && typeof value.title === 'string' && typeof value.idle === 'boolean') {
        samples.push({ t: value.t, app: value.app, title: value.title, idle: value.idle })
      }
    } catch {
      // A half-written last line after a crash is not worth failing the whole day for.
    }
  }
  return samples.sort((a, b) => a.t - b.t)
}

/**
 * Delete day files older than the retention window.
 * @param profileDir - Desktop profile directory.
 * @param now - the current time.
 * @param keepDays - how many days to keep, counting today.
 * @returns the number of files removed.
 */
export function pruneActivity(profileDir: string, now: Date, keepDays: number): number {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - (keepDays - 1))
  const oldest = localDateKey(cutoff)
  let names: string[]
  try {
    names = readdirSync(join(profileDir, ACTIVITY_DIR))
  } catch {
    // No folder yet: nothing to prune.
    return 0
  }
  let removed = 0
  for (const name of names) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u.exec(name)
    if (match?.[1] === undefined || match[1] >= oldest) continue
    rmSync(join(profileDir, ACTIVITY_DIR, name), { force: true })
    removed += 1
  }
  return removed
}

/**
 * Total one day's samples. A sample covers the time until the next one, capped at two intervals so a gap
 * (computer off, app stopped) is not counted as use.
 * @param samples - the day's samples in time order.
 * @param intervalMs - the sampling interval.
 * @returns active and idle totals and per-program usage, busiest first.
 */
export function summarizeDay(samples: readonly ActivitySample[], intervalMs: number): DaySummary {
  const usage = new Map<string, { ms: number; titles: Map<string, number> }>()
  let activeMs = 0
  let idleMs = 0
  samples.forEach((sample, index) => {
    const next = samples[index + 1]
    const span = next === undefined ? intervalMs : Math.min(Math.max(next.t - sample.t, 0), intervalMs * 2)
    if (sample.idle) {
      idleMs += span
      return
    }
    activeMs += span
    const entry = usage.get(sample.app) ?? { ms: 0, titles: new Map<string, number>() }
    entry.ms += span
    entry.titles.set(sample.title, (entry.titles.get(sample.title) ?? 0) + span)
    usage.set(sample.app, entry)
  })
  const apps: AppUsage[] = [...usage.entries()]
    .map(([app, entry]) => ({
      app,
      ms: entry.ms,
      titles: [...entry.titles.entries()].map(([title, ms]) => ({ title, ms })).sort((a, b) => b.ms - a.ms),
    }))
    .sort((a, b) => b.ms - a.ms)
  const active = samples.filter(sample => !sample.idle)
  return {
    firstAt: active[0]?.t,
    lastAt: active.at(-1)?.t,
    activeMs,
    idleMs,
    apps,
  }
}

const MAX_EXAMPLE_ITEMS_PER_DAY = 10
const MAX_EXAMPLE_ITEMS = 60
const MAX_EXAMPLE_CHARS = 200

/**
 * Expand `%NAME%` to that environment variable; an unset name is left as written.
 * @param path - a path that may contain `%NAME%` parts.
 * @returns the expanded path.
 */
export function expandEnvironment(path: string): string {
  return path.replace(/%([^%]+)%/gu, (whole, name: string) => process.env[name] ?? whole)
}

/**
 * Read the most recent past days from a work-log file, to use as writing examples.
 * @param file - the config's `workLogFile`; `%NAME%` expands to an environment variable.
 * @param days - how many days to return.
 * @param today - the local date key of today; today's own entries are left out, since they are what is being written.
 * @returns the days, oldest first; empty when the file is missing, unreadable, or not in the expected shape.
 */
export function readWorkLogExamples(file: string, days: number, today: string): WorkLogDay[] {
  if (file === '' || days <= 0) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(expandEnvironment(file), 'utf8'))
  } catch {
    // A missing or damaged file just means no examples.
    return []
  }
  if (!isRecord(raw)) return []
  const picked: WorkLogDay[] = []
  for (const date of Object.keys(raw).filter(key => /^\d{4}-\d{2}-\d{2}$/u.test(key) && key < today).sort().reverse()) {
    const entries = raw[date]
    if (!Array.isArray(entries)) continue
    const items = entries
      .map(entry => (isRecord(entry) && typeof entry.content === 'string' ? entry.content.trim() : ''))
      .filter(content => content !== '')
      .slice(0, MAX_EXAMPLE_ITEMS_PER_DAY)
      .map(content => content.slice(0, MAX_EXAMPLE_CHARS))
    if (items.length > 0) picked.push({ date, items })
    if (picked.length >= days) break
  }
  const kept: WorkLogDay[] = []
  let total = 0
  for (const day of picked) {
    if (total + day.items.length > MAX_EXAMPLE_ITEMS) break
    kept.push(day)
    total += day.items.length
  }
  return kept.reverse()
}

const MAX_SCREEN_NOTES = 40
const MAX_SCREEN_NOTE_CHARS = 200

/**
 * Read one day's screen descriptions written by another tool.
 * @param dir - the config's `visionDir`; `%NAME%` expands to an environment variable.
 * @param dateKey - local date as `YYYY-MM-DD`.
 * @returns the notes in time order with repeats collapsed, at most 40 spread over the day; empty when unavailable.
 */
export function readScreenNotes(dir: string, dateKey: string): ScreenNote[] {
  if (dir === '') return []
  let text: string
  try {
    text = readFileSync(join(expandEnvironment(dir), `${dateKey}.jsonl`), 'utf8')
  } catch {
    // No file for the day means no descriptions.
    return []
  }
  const read: ScreenNote[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (!isRecord(value) || typeof value.time !== 'string' || typeof value.description !== 'string') continue
      const note = value.description.trim().slice(0, MAX_SCREEN_NOTE_CHARS)
      if (note !== '') read.push({ time: value.time.slice(0, 5), text: note })
    } catch {
      // A damaged line is skipped.
    }
  }
  read.sort((a, b) => a.time.localeCompare(b.time))
  // A description that repeats the one before it adds nothing.
  const notes = read.filter((note, index) => read[index - 1]?.text !== note.text)
  if (notes.length <= MAX_SCREEN_NOTES) return notes
  // Keep an even spread across the day rather than only its start.
  const step = notes.length / MAX_SCREEN_NOTES
  return Array.from({ length: MAX_SCREEN_NOTES }, (_, index) => notes[Math.floor(index * step)] as ScreenNote)
}

/**
 * Combine screen descriptions from two sources into one day in time order.
 * @param first - notes from one folder.
 * @param second - notes from another.
 * @returns every note, oldest first; a note whose time and text match an earlier one is kept once.
 */
export function mergeScreenNotes(first: readonly ScreenNote[], second: readonly ScreenNote[]): ScreenNote[] {
  const seen = new Set<string>()
  return [...first, ...second]
    .sort((a, b) => a.time.localeCompare(b.time))
    .filter((note) => {
      const key = `${note.time}\u0000${note.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
