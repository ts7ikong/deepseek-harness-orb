import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildWeeklyReportPrompt, readWorkLogDays, weekDateKeys } from '../src/weekly-report.ts'
import { dueReminders, defaultReminderConfig } from '../src/reminders.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function logFile(content: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-weekly-'))
  roots.push(root)
  const file = join(root, 'work_log.json')
  writeFileSync(file, JSON.stringify(content))
  return file
}

describe('weekDateKeys', () => {
  it('runs from Monday to the given day', () => {
    // 2026-10-23 is a Friday.
    expect(weekDateKeys(new Date(2026, 9, 23, 9, 30))).toEqual([
      '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23',
    ])
    expect(weekDateKeys(new Date(2026, 9, 19, 8, 0))).toEqual(['2026-10-19'])
  })

  it('counts a Sunday as the end of the week that began on the Monday before', () => {
    const keys = weekDateKeys(new Date(2026, 9, 25, 12, 0))
    expect(keys[0]).toBe('2026-10-19')
    expect(keys.at(-1)).toBe('2026-10-25')
  })

  it('crosses a month boundary', () => {
    expect(weekDateKeys(new Date(2026, 10, 1, 9, 0))).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
  })
})

describe('readWorkLogDays', () => {
  it('keeps the requested days that have entries, in order, and skips blank content', () => {
    const file = logFile({
      '2026-10-19': [{ time: '18:00', content: '部署甲' }, { time: '18:01', content: '  ' }],
      '2026-10-20': [],
      '2026-10-21': [{ time: '18:00', content: '修复乙' }],
      '2026-10-10': [{ time: '18:00', content: '上上周' }],
    })
    expect(readWorkLogDays(file, ['2026-10-19', '2026-10-20', '2026-10-21'])).toEqual([
      { date: '2026-10-19', items: ['部署甲'] },
      { date: '2026-10-21', items: ['修复乙'] },
    ])
  })

  it('returns nothing for a missing or damaged log', () => {
    expect(readWorkLogDays(join(tmpdir(), 'dsh-no-such-log.json'), ['2026-10-19'])).toEqual([])
    const root = mkdtempSync(join(tmpdir(), 'dsh-weekly-'))
    roots.push(root)
    const file = join(root, 'bad.json')
    writeFileSync(file, '{oops')
    expect(readWorkLogDays(file, ['2026-10-19'])).toEqual([])
    expect(readWorkLogDays(logFile([1, 2]), ['2026-10-19'])).toEqual([])
  })
})

describe('buildWeeklyReportPrompt', () => {
  const friday = new Date(2026, 9, 23, 9, 30)

  it('lists each day\'s entries under its weekday and asks for merged, unembellished items', () => {
    const prompt = buildWeeklyReportPrompt([
      { date: '2026-10-19', items: ['部署甲系统'] },
      { date: '2026-10-21', items: ['修复乙接口'] },
    ], friday)
    expect(prompt).toContain('2026-10-19 至 2026-10-23')
    expect(prompt).toContain('2026-10-19 周一\n- 部署甲系统')
    expect(prompt).toContain('2026-10-21 周三\n- 修复乙接口')
    expect(prompt).toContain('不要编造')
    expect(prompt).toContain('不要给每条都加')
    expect(prompt).toContain('下周计划：（待补充）')
    expect(prompt).toContain('不要操作电脑')
  })

  it('asks for a blank template instead of inventing a week when there is nothing logged', () => {
    const prompt = buildWeeklyReportPrompt([], friday)
    expect(prompt).toContain('没有记录')
    expect(prompt).toContain('模板')
    expect(prompt).not.toContain('本周工作日志：')
  })
})

describe('the weekly reminder', () => {
  it('is on by default for Friday 09:30 with a weekly-report button, and not on other days', () => {
    const config = defaultReminderConfig()
    const entry = config.reminders.find(candidate => candidate.id === 'weekly-report')
    expect(entry).toMatchObject({ time: '09:30', days: [5], action: 'weekly-report', actionLabel: '生成周报草稿' })
    const fired = { date: '', ids: [] }
    expect(dueReminders(config, new Date(2026, 9, 23, 9, 31), fired).map(item => item.id)).toEqual(['weekly-report'])
    expect(dueReminders(config, new Date(2026, 9, 22, 9, 31), fired)).toEqual([])
  })
})
