/** Builds the weekly report prompt from the week's work-log entries. */

import { readFileSync } from 'node:fs'
import type { WorkLogDay } from './activity-log.ts'
import { localDateKey } from './reminders.ts'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const
const MAX_ITEMS_PER_DAY = 30
const MAX_ITEM_CHARS = 200
const REPLY_IN_TEXT = '直接用文字回复，不要操作电脑，不要打开任何程序或文件。'

/**
 * Local date keys of the week so far.
 * @param now - the current local time.
 * @returns Monday through `now`'s own date (a Sunday belongs to the week that ended on it), oldest first.
 */
export function weekDateKeys(now: Date): string[] {
  const sinceMonday = (now.getDay() + 6) % 7
  const keys: string[] = []
  for (let back = sinceMonday; back >= 0; back -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    keys.push(localDateKey(day))
  }
  return keys
}

/**
 * Read the work-log entries of some days.
 * @param file - the work log path (`{ "YYYY-MM-DD": [{ "time", "content" }] }`).
 * @param dateKeys - the days wanted.
 * @returns the days that have entries, in the order given; empty when the file is missing or damaged.
 */
export function readWorkLogDays(file: string, dateKeys: readonly string[]): WorkLogDay[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A missing or damaged log has nothing to summarize.
    return []
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
  const days: WorkLogDay[] = []
  for (const date of dateKeys) {
    const entries = (raw as Record<string, unknown>)[date]
    if (!Array.isArray(entries)) continue
    const items = entries
      .map(entry => (typeof entry === 'object' && entry !== null && typeof (entry as { content?: unknown }).content === 'string'
        ? (entry as { content: string }).content.trim()
        : ''))
      .filter(content => content !== '')
      .slice(0, MAX_ITEMS_PER_DAY)
      .map(content => content.slice(0, MAX_ITEM_CHARS))
    if (items.length > 0) days.push({ date, items })
  }
  return days
}

function dayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1)
  return `${dateKey} 周${WEEKDAYS[date.getDay()] ?? ''}`
}

/**
 * Build the prompt that asks for a weekly report draft.
 * @param days - this week's work-log days, oldest first.
 * @param now - the current local time.
 * @returns the prompt text. With no entries it asks for a blank template, so nothing is invented.
 */
export function buildWeeklyReportPrompt(days: readonly WorkLogDay[], now: Date): string {
  const keys = weekDateKeys(now)
  const range = `${keys[0] ?? ''} 至 ${keys.at(-1) ?? ''}`
  if (days.length === 0) {
    return [
      `本周（${range}）的工作日志里没有记录，没有内容可以整理。`,
      '请给我一份周报模板（本周工作、遇到的问题、下周计划），每一项留空，由我自己补充。',
      REPLY_IN_TEXT,
    ].join('\n')
  }
  return [
    `下面是我本周（${range}）每天的工作日志。请据此整理一份本周的工作周报草稿。`,
    '',
    '要求：',
    '- 把同一个客户、系统或项目的多天工作合并成一条，写清做了什么；不要按天罗列，也不要写日期。',
    '- 用词和叫法跟日志保持一致；只依据日志整理，不要编造客户名、数量或结果。日志里写了什么就写什么，不要给每条都加“进展（待补充）”；只有确实缺少关键信息、没法下笔的地方才写“（待补充）”。',
    '- 条目简洁，一条一句话，通常 5 到 10 条。',
    '- 最后一行写“下周计划：（待补充）”，由我自己填。',
    '- 只输出周报条目本身，每行一条；不要写标题、说明或总结。',
    `- ${REPLY_IN_TEXT}`,
    '',
    '本周工作日志：',
    ...days.flatMap(day => [dayLabel(day.date), ...day.items.map(item => `- ${item}`)]),
  ].join('\n')
}
