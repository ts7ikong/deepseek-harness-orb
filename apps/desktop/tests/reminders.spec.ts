import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultReminderConfig,
  dueReminders,
  localDateKey,
  markReminderFired,
  parseReminderConfig,
  readReminderConfig,
  readReminderState,
  REMINDER_LATE_TOLERANCE_MS,
  REMINDERS_CONFIG_FILE,
  writeReminderState,
  type ReminderConfig,
} from '../src/reminders.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempProfile(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reminders-'))
  roots.push(root)
  return root
}

// 2026-10-19 is a Monday; 2026-10-24 is a Saturday.
const monday = (hours: number, minutes: number, seconds = 0) => new Date(2026, 9, 19, hours, minutes, seconds)
const saturday = (hours: number, minutes: number) => new Date(2026, 9, 24, hours, minutes)
const nothingFired = { date: '', ids: [] as string[] }

describe('dueReminders', () => {
  const config = defaultReminderConfig()

  it('is silent before the time and fires from the minute it arrives', () => {
    expect(dueReminders(config, monday(18, 19, 59), nothingFired)).toEqual([])
    expect(dueReminders(config, monday(18, 20), nothingFired).map(entry => entry.id)).toEqual(['daily-report'])
    expect(dueReminders(config, monday(18, 25), nothingFired).map(entry => entry.id)).toEqual(['daily-report'])
  })

  it('returns every reminder that is due together', () => {
    const both: ReminderConfig = {
      ...config,
      reminders: config.reminders.map(entry => ({ ...entry, time: '18:30' })),
    }
    expect(dueReminders(both, monday(18, 30), nothingFired)).toHaveLength(2)
  })

  it('skips weekends by default', () => {
    expect(dueReminders(config, saturday(18, 30), nothingFired)).toEqual([])
  })

  it('honors an explicit day list', () => {
    const weekend: ReminderConfig = {
      ...config,
      reminders: [{ ...config.reminders[1]!, days: [6] }],
    }
    expect(dueReminders(weekend, saturday(18, 30), nothingFired)).toHaveLength(1)
    expect(dueReminders(weekend, monday(18, 30), nothingFired)).toEqual([])
  })

  it('skips a reminder noticed too late, such as after a late launch', () => {
    const justInside = new Date(monday(18, 30).getTime() + REMINDER_LATE_TOLERANCE_MS)
    const justOutside = new Date(justInside.getTime() + 1000)
    expect(dueReminders(config, justInside, nothingFired).map(entry => entry.id)).toContain('off-work')
    expect(dueReminders(config, justOutside, nothingFired).map(entry => entry.id)).not.toContain('off-work')
    expect(dueReminders(config, monday(21, 0), nothingFired)).toEqual([])
  })

  it('does not repeat a reminder that already fired today, but fires again the next day', () => {
    const fired = markReminderFired(nothingFired, ['off-work'], monday(18, 30))
    expect(dueReminders(config, monday(18, 31), fired).map(entry => entry.id)).toEqual([])
    // Yesterday's state does not suppress today; at 18:30 the 18:20 reminder is still inside the late tolerance.
    const tuesday = new Date(2026, 9, 20, 18, 30)
    expect(dueReminders(config, tuesday, fired).map(entry => entry.id)).toEqual(['daily-report', 'off-work'])
  })

  it('returns nothing when the config is switched off', () => {
    expect(dueReminders({ ...config, enabled: false }, monday(18, 30), nothingFired)).toEqual([])
  })
})

describe('markReminderFired', () => {
  it('accumulates ids within a day and starts over on a new day', () => {
    const first = markReminderFired(nothingFired, ['a'], monday(9, 0))
    const second = markReminderFired(first, ['b', 'a'], monday(9, 5))
    expect(second).toEqual({ date: localDateKey(monday(9, 0)), ids: ['a', 'b'] })
    const nextDay = markReminderFired(second, ['c'], new Date(2026, 9, 20, 9, 0))
    expect(nextDay.ids).toEqual(['c'])
  })
})

describe('parseReminderConfig', () => {
  it('keeps valid entries and reports the ones it ignores', () => {
    const { config, problems } = parseReminderConfig(JSON.stringify({
      reminders: [
        { id: 'ok', time: '9:05', mood: 'happy', title: 't', message: 'm' },
        { id: 'bad-time', time: '25:00' },
        { time: '10:00' },
        { id: 'ok', time: '11:00' },
        { id: 'bad-days', time: '12:00', days: [7] },
        'nonsense',
      ],
    }))
    expect(config?.reminders.map(entry => entry.id)).toEqual(['ok'])
    expect(problems).toHaveLength(5)
  })

  it('defaults days to the workdays and an unknown mood to happy', () => {
    const { config, problems } = parseReminderConfig(JSON.stringify({
      reminders: [{ id: 'x', time: '08:00', mood: 'angry' }],
    }))
    expect(config?.reminders[0]).toMatchObject({ days: [1, 2, 3, 4, 5], mood: 'happy', title: '', message: '' })
    expect(problems).toEqual([expect.stringContaining('"angry" is unknown')])
  })

  it('reads an action and gives it a default label, and ignores an unknown one', () => {
    const { config, problems } = parseReminderConfig(JSON.stringify({
      reminders: [
        { id: 'a', time: '18:20', action: 'daily-report' },
        { id: 'b', time: '18:21', action: 'daily-report', actionLabel: '写日报' },
        { id: 'c', time: '18:22', action: 'launch-missiles' },
      ],
    }))
    expect(config?.reminders[0]).toMatchObject({ action: 'daily-report', actionLabel: '生成日报草稿' })
    expect(config?.reminders[1]).toMatchObject({ action: 'daily-report', actionLabel: '写日报' })
    expect(config?.reminders[2]).not.toHaveProperty('action')
    expect(problems).toEqual([expect.stringContaining('"launch-missiles" is unknown')])
  })

  it('gives only the daily-report reminder a button by default', () => {
    const [report, offWork] = defaultReminderConfig().reminders
    expect(report).toMatchObject({ id: 'daily-report', action: 'daily-report' })
    expect(offWork).not.toHaveProperty('action')
  })

  it('reads the on and sound switches', () => {
    expect(parseReminderConfig('{"reminders":[]}').config).toMatchObject({ enabled: true, sound: false })
    expect(parseReminderConfig('{"enabled":false,"sound":true,"reminders":[]}').config)
      .toMatchObject({ enabled: false, sound: true })
  })

  it('refuses unusable text so the caller can keep its last good config', () => {
    expect(parseReminderConfig('{ not json').config).toBeUndefined()
    expect(parseReminderConfig('[]').config).toBeUndefined()
  })
})

describe('config and state files', () => {
  it('writes the default config on first read and reads edits back', () => {
    const profile = tempProfile()
    const first = readReminderConfig(profile)
    expect(first.config).toEqual(defaultReminderConfig())
    const path = join(profile, REMINDERS_CONFIG_FILE)
    const written = JSON.parse(readFileSync(path, 'utf8')) as { reminders: { time: string }[] }
    expect(written.reminders.map(entry => entry.time)).toEqual(['18:20', '18:30', '09:30'])
    writeFileSync(path, JSON.stringify({ reminders: [{ id: 'edited', time: '07:45' }] }))
    expect(readReminderConfig(profile).config?.reminders.map(entry => entry.id)).toEqual(['edited'])
  })

  it('round-trips the fired state and treats damage as empty', () => {
    const profile = tempProfile()
    expect(readReminderState(profile)).toEqual({ date: '', ids: [] })
    writeReminderState(profile, { date: '2026-10-19', ids: ['a'] })
    expect(readReminderState(profile)).toEqual({ date: '2026-10-19', ids: ['a'] })
    writeFileSync(join(profile, 'orb-reminders-state.json'), '{"date": 5}')
    expect(readReminderState(profile)).toEqual({ date: '', ids: [] })
  })
})

describe('alignOffWork', () => {
  it('moves only the knocking-off reminder to the user\'s off-work time', async () => {
    const { alignOffWork, defaultReminderConfig } = await import('../src/reminders.ts')
    const config = defaultReminderConfig()
    const aligned = alignOffWork(config, 17 * 60 + 5)
    expect(aligned.reminders.find(entry => entry.id === 'off-work')?.time).toBe('17:05')
    expect(aligned.reminders.find(entry => entry.id === 'daily-report')?.time).toBe('18:20')
  })

  it('leaves the reminders alone when no off-work time is set or there is no such reminder', async () => {
    const { alignOffWork, defaultReminderConfig } = await import('../src/reminders.ts')
    const config = defaultReminderConfig()
    expect(alignOffWork(config, undefined)).toBe(config)
    const without = { ...config, reminders: config.reminders.filter(entry => entry.id !== 'off-work') }
    expect(alignOffWork(without, 600)).toBe(without)
  })
})
