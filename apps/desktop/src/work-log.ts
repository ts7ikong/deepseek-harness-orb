/** The work log the user confirms daily reports into: where it lives, how reply text becomes entries, and writing back. */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandEnvironment } from './activity-log.ts'
import { localDateKey } from './reminders.ts'

/** Profile-relative work log used when the config names none. */
export const DEFAULT_WORK_LOG_FILE = 'orb-work-log.json'

/** The model is told to write this where it cannot tell what was done; the user must settle each one before confirming. */
export const PENDING_MARK = '（待补充）'

/**
 * Path of the work log.
 * @param configured - the config's `workLogFile`; `%NAME%` expands to an environment variable.
 * @param profileDir - Desktop profile directory, used when nothing is configured.
 * @returns the file to read examples from and write confirmed entries to.
 */
export function resolveWorkLogFile(configured: string, profileDir: string): string {
  return configured === '' ? join(profileDir, DEFAULT_WORK_LOG_FILE) : expandEnvironment(configured)
}

const BULLET = /^(?:[-*•·]\s+|\d+[.、)）]\s*|[（(]\d+[）)]\s*)/u
const MARKUP = /(?:\*\*|__|`)/gu
const REMARK = /^(?:(?:说明|注|备注|提示|总结|小结)[：:，,]|以上)/u
const DATE_ONLY =/^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:\s*[（(]?周[一二三四五六日天][）)]?|\s*星期[一二三四五六日天])?$/u

/**
 * Turn a model reply into one entry per line.
 * Bullets, numbering, emphasis marks, headings, section titles, and a lone date line are dropped;
 * repeated lines are kept once. The result is a starting point the user edits before confirming.
 * @param text - the reply text.
 * @returns the entries in order.
 */
export function cleanReportLines(text: string): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of text.replaceAll('\r\n', '\n').split('\n')) {
    let line = raw.trim()
    if (line === '' || line.startsWith('#') || /^[-=_*]{3,}$/u.test(line)) continue
    line = line.replace(BULLET, '').replace(MARKUP, '').trim()
    if (line === '' || DATE_ONLY.test(line)) continue
    // "今日工作：" style section titles carry no entry of their own.
    if (/[：:]$/u.test(line) && line.length <= 12) continue
    // Remarks the model adds about its own answer ("说明：以上根据……") are not work done.
    if (REMARK.test(line)) continue
    if (seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }
  return lines
}

/**
 * Entries still carrying {@link PENDING_MARK}.
 * @param lines - entries to check.
 * @returns how many need the user's attention.
 */
export function countPending(lines: readonly string[]): number {
  return lines.filter(line => line.includes(PENDING_MARK) || line.includes('(待补充)')).length
}

/** What a write-back did. */
export interface WorkLogWrite {
  /** Entries added for the day. */
  readonly added: number
  /** Entries left out because the day already had the same text. */
  readonly skipped: number
  /** Entries the day holds afterwards. */
  readonly total: number
}

/**
 * Add entries to a day of the work log (`{ "YYYY-MM-DD": [{ "time": "HH:MM", "content": "..." }] }`).
 * Other days are left exactly as they are. The previous file is kept beside it as `<file>.bak`, and the new
 * one replaces it in a single rename, so a failure cannot leave a half-written log.
 * @param file - the work log path.
 * @param dateKey - local date as `YYYY-MM-DD`.
 * @param time - local time of the confirmation, `HH:MM`.
 * @param lines - the entries to add.
 * @returns what was added.
 * @throws when the existing file is not a JSON object; it is then left untouched.
 */
export function appendWorkLogEntries(file: string, dateKey: string, time: string, lines: readonly string[]): WorkLogWrite {
  let log: Record<string, unknown> = {}
  if (existsSync(file)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`the work log is not valid JSON, so it was not changed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the work log is not a JSON object, so it was not changed')
    }
    log = parsed as Record<string, unknown>
  }
  const existing = Array.isArray(log[dateKey]) ? (log[dateKey] as unknown[]) : []
  const have = new Set(existing.map(entry => (typeof entry === 'object' && entry !== null ? (entry as { content?: unknown }).content : undefined)))
  const fresh = lines.map(line => line.trim()).filter(line => line !== '' && !have.has(line))
  const unique = [...new Set(fresh)]
  if (unique.length > 0) {
    log[dateKey] = [...existing, ...unique.map(content => ({ time, content }))]
    if (existsSync(file)) copyFileSync(file, `${file}.bak`)
    const temporary = `${file}.${String(process.pid)}.tmp`
    writeFileSync(temporary, `${JSON.stringify(log, undefined, 2)}\n`)
    renameSync(temporary, file)
  }
  return { added: unique.length, skipped: lines.filter(line => line.trim() !== '').length - unique.length, total: existing.length + unique.length }
}

/**
 * Entries from the text the user confirmed.
 * Unlike {@link cleanReportLines} this keeps every non-empty line, since the user has already edited it:
 * only bullets, numbering, and emphasis marks are removed, and repeats are kept once.
 * @param text - the edited text.
 * @returns the entries in order.
 */
export function parseConfirmedLines(text: string): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of text.replaceAll('\r\n', '\n').split('\n')) {
    const line = raw.trim().replace(BULLET, '').replace(MARKUP, '').trim()
    if (line === '' || seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }
  return lines
}

/** Outcome of confirming a report. */
export type ConfirmResult =
  | { readonly ok: true; readonly write: WorkLogWrite }
  | { readonly ok: false; readonly reason: 'empty' }
  | { readonly ok: false; readonly reason: 'pending'; readonly pending: number }
  | { readonly ok: false; readonly reason: 'error'; readonly message: string }

/**
 * Write the confirmed report into the work log.
 * Refuses an empty report, and one that still has {@link PENDING_MARK} entries, since those are guesses the user has not settled.
 * @param text - the edited report text.
 * @param file - the work log path.
 * @param now - the current local time.
 * @returns what happened.
 */
export function confirmReportText(text: string, file: string, now: Date): ConfirmResult {
  const lines = parseConfirmedLines(text)
  if (lines.length === 0) return { ok: false, reason: 'empty' }
  const pending = countPending(lines)
  if (pending > 0) return { ok: false, reason: 'pending', pending }
  const dateKey = localDateKey(now)
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  try {
    return { ok: true, write: appendWorkLogEntries(file, dateKey, time, lines) }
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * How many entries a day of the work log already holds.
 * @param file - the work log path.
 * @param dateKey - local date as `YYYY-MM-DD`.
 * @returns the count; zero when the file is missing, damaged, or has nothing for that day.
 */
export function countWorkLogEntries(file: string, dateKey: string): number {
  try {
    const log: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const day = typeof log === 'object' && log !== null ? (log as Record<string, unknown>)[dateKey] : undefined
    return Array.isArray(day) ? day.length : 0
  } catch {
    // A missing or damaged log has no entries to count.
    return 0
  }
}
