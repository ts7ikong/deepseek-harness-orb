import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: vi.fn(), screen: {} }))
vi.mock('../src/floating-window.ts', () => ({ presentOverlayWindow: () => {} }))

import {
  clockState,
  defaultScheduleText,
  parseScheduleConfig,
  readScheduleConfig,
  readScheduleForm,
  saveScheduleForm,
  SCHEDULE_CONFIG_FILE,
  workProgress,
  type ScheduleConfig,
} from '../src/work-schedule.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const hours: ScheduleConfig = {
  showClock: true,
  days: [1, 2, 3, 4, 5],
  workStart: 9 * 60,
  lunchStart: 12 * 60,
  afternoonStart: 13 * 60 + 30,
  workEnd: 18 * 60,
}

// 2026-10-20 is a Tuesday; 2026-10-24 a Saturday.
const tuesday = (hour: number, minute = 0, second = 0): Date => new Date(2026, 9, 20, hour, minute, second)

describe('parseScheduleConfig', () => {
  it('reads the four times and the clock switch', () => {
    const { config, problems } = parseScheduleConfig(JSON.stringify({
      showClock: false, days: [1, 2], workStart: '09:00', lunchStart: '12:00', afternoonStart: '13:30', workEnd: '18:00',
    }))
    expect(problems).toEqual([])
    expect(config).toEqual({ ...hours, showClock: false, days: [1, 2] })
  })

  it('treats empty times as not set, and reports a malformed one without dropping the rest', () => {
    const { config, problems } = parseScheduleConfig(JSON.stringify({ workStart: '9点', lunchStart: '12:00', workEnd: '' }))
    expect(config?.workStart).toBeUndefined()
    expect(config?.lunchStart).toBe(720)
    expect(config?.workEnd).toBeUndefined()
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('workStart')
  })

  it('falls back to Monday to Friday for bad days, and rejects unusable JSON', () => {
    expect(parseScheduleConfig('{"days":[9]}').config?.days).toEqual([1, 2, 3, 4, 5])
    expect(parseScheduleConfig('{oops').config).toBeUndefined()
    expect(parseScheduleConfig('[1]').config).toBeUndefined()
  })
})

describe('readScheduleConfig', () => {
  it('writes a starter file with every time empty, so no progress shows until the user sets them', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-schedule-'))
    roots.push(root)
    const { config } = readScheduleConfig(root)
    expect(readFileSync(join(root, SCHEDULE_CONFIG_FILE), 'utf8')).toBe(defaultScheduleText())
    expect(config?.showClock).toBe(true)
    expect(workProgress(config!, tuesday(10))).toBeUndefined()
    // The user's edit is not overwritten.
    writeFileSync(join(root, SCHEDULE_CONFIG_FILE), '{"workStart":"08:00"}')
    expect(readScheduleConfig(root).config?.workStart).toBe(480)
  })
})

describe('workProgress', () => {
  it('counts only working time: 9:00-12:00 and 13:30-18:00 is 7.5 hours', () => {
    expect(workProgress(hours, tuesday(8, 30))).toEqual({ phase: 'before', percent: 0, workedMs: 0, remainingMs: 7.5 * 3_600_000 })
    expect(workProgress(hours, tuesday(10, 30))).toMatchObject({ phase: 'morning', percent: 20, workedMs: 1.5 * 3_600_000 })
    expect(workProgress(hours, tuesday(12, 45))).toMatchObject({ phase: 'lunch', percent: 40, workedMs: 3 * 3_600_000 })
    expect(workProgress(hours, tuesday(15, 45))).toMatchObject({ phase: 'afternoon', percent: 70, remainingMs: 2.25 * 3_600_000 })
    expect(workProgress(hours, tuesday(18, 0))).toMatchObject({ phase: 'after', percent: 100, remainingMs: 0 })
    expect(workProgress(hours, tuesday(21))).toMatchObject({ phase: 'after', percent: 100 })
  })

  it('shows a rest day instead of progress', () => {
    expect(workProgress(hours, new Date(2026, 9, 24, 10, 0))).toMatchObject({ phase: 'rest', percent: 0 })
  })

  it('shows nothing until all four times are set and in order', () => {
    expect(workProgress({ ...hours, lunchStart: undefined }, tuesday(10))).toBeUndefined()
    expect(workProgress({ ...hours, workEnd: 8 * 60 }, tuesday(10))).toBeUndefined()
    expect(workProgress({ ...hours, lunchStart: 14 * 60, afternoonStart: 13 * 60 }, tuesday(10))).toBeUndefined()
  })

  it('allows no lunch break by setting lunch and afternoon start to the same time', () => {
    expect(workProgress({ ...hours, lunchStart: 12 * 60, afternoonStart: 12 * 60 }, tuesday(13, 30))).toMatchObject({ phase: 'afternoon' })
  })
})

describe('clockState', () => {
  it('writes the date and the time down to the second', () => {
    expect(clockState(hours, tuesday(9, 5, 7))).toMatchObject({ date: '2026年10月20日 周二', time: '09:05:07' })
  })

  it('leaves out progress when the hours are not set', () => {
    expect('progress' in clockState({ ...hours, workStart: undefined }, tuesday(10))).toBe(false)
    expect(clockState(hours, tuesday(10)).progress?.phase).toBe('morning')
  })
})

describe('saveScheduleForm', () => {
  const form = { showClock: true, workStart: '09:00', lunchStart: '12:00', afternoonStart: '13:30', workEnd: '18:30' }
  const fresh = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-schedule-'))
    roots.push(root)
    return root
  }

  it('saves the hours, keeps the other fields, and the clock then reads them back', () => {
    const root = fresh()
    readScheduleConfig(root)
    writeFileSync(join(root, SCHEDULE_CONFIG_FILE), JSON.stringify({ help: 'keep me', days: [1, 2, 3], showClock: true }))
    expect(saveScheduleForm(root, form)).toEqual({ ok: true })
    const saved = JSON.parse(readFileSync(join(root, SCHEDULE_CONFIG_FILE), 'utf8')) as Record<string, unknown>
    expect(saved).toMatchObject({ help: 'keep me', days: [1, 2, 3], workStart: '09:00', workEnd: '18:30' })
    expect(readScheduleForm(root)).toEqual(form)
    expect(workProgress(readScheduleConfig(root).config!, tuesday(10, 30))?.phase).toBe('morning')
  })

  it('writes the file from scratch when there is none, and normalizes 9:00 to 09:00', () => {
    const root = fresh()
    expect(saveScheduleForm(root, { ...form, workStart: '9:00', showClock: false })).toEqual({ ok: true })
    expect(readScheduleForm(root)).toEqual({ ...form, showClock: false })
  })

  it('clears the hours when all four are empty', () => {
    const root = fresh()
    saveScheduleForm(root, form)
    expect(saveScheduleForm(root, { showClock: true, workStart: '', lunchStart: '', afternoonStart: '', workEnd: '' })).toEqual({ ok: true })
    expect(workProgress(readScheduleConfig(root).config!, tuesday(10))).toBeUndefined()
  })

  it('refuses some-but-not-all times, bad order, and bad text, leaving the file as it was', () => {
    const root = fresh()
    saveScheduleForm(root, form)
    const before = readFileSync(join(root, SCHEDULE_CONFIG_FILE), 'utf8')
    for (const bad of [
      { ...form, lunchStart: '' },
      { ...form, workEnd: '08:00' },
      { ...form, lunchStart: '14:00', afternoonStart: '13:00' },
      { ...form, workStart: '九点' },
      { ...form, workStart: 900 },
      'nope',
    ]) {
      expect(saveScheduleForm(root, bad)).toMatchObject({ ok: false })
    }
    expect(readFileSync(join(root, SCHEDULE_CONFIG_FILE), 'utf8')).toBe(before)
  })
})
