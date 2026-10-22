/** The user's working hours (a config file) and the clock text and work progress shown beside the ball. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Profile-relative JSON holding the working hours; edits apply within a few seconds. */
export const SCHEDULE_CONFIG_FILE = 'orb-schedule.json'

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/u
const WORKDAYS: readonly number[] = [1, 2, 3, 4, 5]
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

/** Working hours as minutes since midnight; each is `undefined` until the user sets it. */
export interface ScheduleConfig {
  readonly showClock: boolean
  /** `Date.getDay()` numbering: 0 is Sunday. */
  readonly days: readonly number[]
  readonly workStart: number | undefined
  readonly lunchStart: number | undefined
  readonly afternoonStart: number | undefined
  readonly workEnd: number | undefined
}

export type WorkPhase = 'before' | 'morning' | 'lunch' | 'afternoon' | 'after' | 'rest'

/** How far through the working day it is. */
export interface WorkProgress {
  readonly phase: WorkPhase
  /** Whole percent of today's working time already done. */
  readonly percent: number
  readonly workedMs: number
  readonly remainingMs: number
}

/** What the clock beside the ball shows. */
export interface ClockState {
  /** `2026年10月20日 周二`. */
  readonly date: string
  /** `18:05:42`. */
  readonly time: string
  /** Absent until all four working times are set. */
  readonly progress?: WorkProgress
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function minutesOf(value: unknown, name: string, problems: string[]): number | undefined {
  if (value === undefined || value === '') return undefined
  const match = typeof value === 'string' ? TIME_PATTERN.exec(value.trim()) : null
  if (match === null) {
    problems.push(`${name} must look like "09:00"; it is ignored`)
    return undefined
  }
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * The file a fresh profile starts with: every time empty, so no progress shows until the user fills them in.
 * @returns the JSON text.
 */
export function defaultScheduleText(): string {
  return `${JSON.stringify({
    help: '上班时间、午休开始、下午上班、下班时间都填好（24 小时制 HH:MM，如 "09:00"）后，悬浮球旁会显示今天的工作进度；'
      + '留空则只显示日期时间。days 用 0=周日 … 6=周六，默认周一到周五。showClock 设为 false 可隐藏整个时钟。改动几秒内生效，不用重启。',
    showClock: true,
    days: WORKDAYS,
    workStart: '',
    lunchStart: '',
    afternoonStart: '',
    workEnd: '',
  }, undefined, 2)}\n`
}

/**
 * Parse the config text.
 * @param text - JSON file contents.
 * @returns the config (absent when the JSON is unusable) and a message per ignored field.
 */
export function parseScheduleConfig(text: string): { config: ScheduleConfig | undefined; problems: string[] } {
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { config: undefined, problems: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!isRecord(raw)) return { config: undefined, problems: ['the top level must be an object'] }
  let days = WORKDAYS
  if (raw.days !== undefined) {
    if (Array.isArray(raw.days) && raw.days.every(day => Number.isInteger(day) && (day as number) >= 0 && (day as number) <= 6)) {
      days = raw.days as number[]
    } else {
      problems.push('days must be a list of 0-6 (0 is Sunday); the default is used')
    }
  }
  return {
    config: {
      showClock: raw.showClock !== false,
      days,
      workStart: minutesOf(raw.workStart, 'workStart', problems),
      lunchStart: minutesOf(raw.lunchStart, 'lunchStart', problems),
      afternoonStart: minutesOf(raw.afternoonStart, 'afternoonStart', problems),
      workEnd: minutesOf(raw.workEnd, 'workEnd', problems),
    },
    problems,
  }
}

/**
 * Read the config, writing the starter file first when none exists.
 * @param profileDir - Desktop profile directory.
 * @returns the parsed result; `config` is absent when the file cannot be used.
 */
export function readScheduleConfig(profileDir: string): { config: ScheduleConfig | undefined; problems: string[] } {
  const path = join(profileDir, SCHEDULE_CONFIG_FILE)
  if (!existsSync(path)) {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(path, defaultScheduleText())
  }
  return parseScheduleConfig(readFileSync(path, 'utf8'))
}

/**
 * Work progress at a moment.
 * @param config - the working hours.
 * @param now - the current local time.
 * @returns the progress; absent unless the four times are set and in order (start < lunch < afternoon < end).
 */
export function workProgress(config: ScheduleConfig, now: Date): WorkProgress | undefined {
  const { workStart, lunchStart, afternoonStart, workEnd } = config
  if (workStart === undefined || lunchStart === undefined || afternoonStart === undefined || workEnd === undefined) return undefined
  if (!(workStart < lunchStart && lunchStart <= afternoonStart && afternoonStart < workEnd)) return undefined
  const total = (lunchStart - workStart + workEnd - afternoonStart) * 60_000
  if (!config.days.includes(now.getDay())) return { phase: 'rest', percent: 0, workedMs: 0, remainingMs: 0 }
  const minute = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 60 + now.getMilliseconds() / 60_000
  const worked = Math.max(0, Math.min(minute, lunchStart) - workStart)
    + Math.max(0, Math.min(minute, workEnd) - afternoonStart)
  const workedMs = Math.round(worked * 60_000)
  const phase: WorkPhase = minute < workStart ? 'before'
    : minute < lunchStart ? 'morning'
      : minute < afternoonStart ? 'lunch'
        : minute < workEnd ? 'afternoon' : 'after'
  return {
    phase,
    percent: Math.min(100, Math.floor((workedMs / total) * 100)),
    workedMs,
    remainingMs: Math.max(0, total - workedMs),
  }
}

/**
 * What the clock shows right now.
 * @param config - the working hours.
 * @param now - the current local time.
 * @returns the date and time text, with the progress when the hours are set.
 */
export function clockState(config: ScheduleConfig, now: Date): ClockState {
  const two = (value: number): string => String(value).padStart(2, '0')
  const progress = workProgress(config, now)
  return {
    date: `${String(now.getFullYear())}年${String(now.getMonth() + 1)}月${String(now.getDate())}日 周${WEEKDAYS[now.getDay()] ?? ''}`,
    time: `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`,
    ...(progress === undefined ? {} : { progress }),
  }
}

/** The working hours as the settings form edits them: `HH:MM` text, empty when not set. */
export interface ScheduleForm {
  readonly showClock: boolean
  readonly workStart: string
  readonly lunchStart: string
  readonly afternoonStart: string
  readonly workEnd: string
}

const FORM_TIMES = ['workStart', 'lunchStart', 'afternoonStart', 'workEnd'] as const

function clockText(minutes: number | undefined): string {
  return minutes === undefined ? '' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * The saved hours, for the settings form.
 * @param profileDir - Desktop profile directory.
 * @returns the form values; empty times when nothing is set or the file is unreadable.
 */
export function readScheduleForm(profileDir: string): ScheduleForm {
  const config = readScheduleConfig(profileDir).config
  return {
    showClock: config?.showClock ?? true,
    workStart: clockText(config?.workStart),
    lunchStart: clockText(config?.lunchStart),
    afternoonStart: clockText(config?.afternoonStart),
    workEnd: clockText(config?.workEnd),
  }
}

/** Outcome of saving the settings form. */
export type ScheduleSaveResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

/**
 * Save the hours from the settings form into the config file, keeping its other fields (days, help text).
 * Either all four times are set, in the order start < lunch <= afternoon < end, or all are empty.
 * @param profileDir - Desktop profile directory.
 * @param value - the form values, as received from the settings window.
 * @returns whether it was saved, and why not when it was refused.
 */
export function saveScheduleForm(profileDir: string, value: unknown): ScheduleSaveResult {
  if (!isRecord(value)) return { ok: false, message: '设置内容不正确' }
  const problems: string[] = []
  const minutes = FORM_TIMES.map(key => minutesOf(value[key], key, problems))
  if (problems.length > 0) return { ok: false, message: '时间格式应为 09:00 这样的 24 小时制' }
  const set = minutes.filter(entry => entry !== undefined).length
  if (set !== 0 && set !== 4) return { ok: false, message: '四个时间要么都填，要么都留空' }
  if (set === 4) {
    const [start = 0, lunch = 0, afternoon = 0, end = 0] = minutes as number[]
    if (!(start < lunch && lunch <= afternoon && afternoon < end)) {
      return { ok: false, message: '时间顺序不对：上班 < 午休开始 ≤ 下午上班 < 下班' }
    }
  }
  const path = join(profileDir, SCHEDULE_CONFIG_FILE)
  readScheduleConfig(profileDir)
  let document: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isRecord(parsed)) document = parsed
  } catch {
    // A damaged file is replaced by one holding the new hours.
  }
  const next: Record<string, unknown> = { ...document, showClock: value.showClock !== false }
  FORM_TIMES.forEach((key, index) => { next[key] = clockText(minutes[index]) })
  try {
    writeFileSync(path, `${JSON.stringify(next, undefined, 2)}\n`)
  } catch (error) {
    return { ok: false, message: `没能保存：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true }
}
