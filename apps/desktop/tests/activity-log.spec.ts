import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACTIVITY_DIR,
  activityFilePath,
  appendActivitySample,
  defaultActivityConfig,
  filterObservation,
  HIDDEN_TITLE,
  parseActivityConfig,
  pruneActivity,
  readActivityConfig,
  readActivityDay,
  readScreenNotes,
  readWorkLogExamples,
  summarizeDay,
  type ActivitySample,
} from '../src/activity-log.ts'
import { localDateKey } from '../src/reminders.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempProfile(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-activity-'))
  roots.push(root)
  return root
}

const MINUTE = 60_000
const at = (hours: number, minutes: number, seconds = 0) => new Date(2026, 9, 20, hours, minutes, seconds).getTime()
const sample = (t: number, app: string, title: string, idle = false): ActivitySample => ({ t, app, title, idle })

describe('filterObservation', () => {
  const config = defaultActivityConfig()

  it('keeps an ordinary program and title, trimmed', () => {
    expect(filterObservation({ app: 'Code', title: '  main.ts - project  ' }, config))
      .toEqual({ app: 'Code', title: 'main.ts - project' })
  })

  it('never records an ignored program, whatever the letter case', () => {
    expect(filterObservation({ app: 'keepassxc', title: 'Passwords' }, config)).toBeUndefined()
    expect(filterObservation({ app: '1password', title: 'Vault' }, config)).toBeUndefined()
  })

  it('keeps the program but drops the title for chat apps, including WeChat helper processes', () => {
    for (const app of ['Weixin', 'WeChatAppEx', 'dingtalk']) {
      expect(filterObservation({ app, title: '张三' }, config)).toEqual({ app, title: HIDDEN_TITLE })
    }
  })

  it('hides a title that contains a sensitive word', () => {
    expect(filterObservation({ app: 'chrome', title: 'My Bank Password reset - Google Chrome' }, config))
      .toEqual({ app: 'chrome', title: HIDDEN_TITLE })
    expect(filterObservation({ app: 'chrome', title: '网上银行登录' }, config))
      .toEqual({ app: 'chrome', title: HIDDEN_TITLE })
  })

  it('leaves an empty title empty and truncates a very long one', () => {
    expect(filterObservation({ app: 'explorer', title: '' }, config)).toEqual({ app: 'explorer', title: '' })
    expect(filterObservation({ app: 'x', title: 'a'.repeat(500) }, config)?.title).toHaveLength(200)
  })

  it('ignores empty words so they cannot hide every title', () => {
    expect(filterObservation({ app: 'x', title: 'plain' }, { ...config, hideTitleContains: [''] }))
      .toEqual({ app: 'x', title: 'plain' })
  })
})

describe('parseActivityConfig', () => {
  it('uses the defaults for what is missing', () => {
    expect(parseActivityConfig('{}').config).toEqual(defaultActivityConfig())
  })

  it('reads valid values and the on switch', () => {
    const { config } = parseActivityConfig(JSON.stringify({
      enabled: false, intervalSeconds: 60, idleSeconds: 300, keepDays: 7, ignoreApps: ['x'],
    }))
    expect(config).toMatchObject({ enabled: false, intervalSeconds: 60, idleSeconds: 300, keepDays: 7, ignoreApps: ['x'] })
  })

  it('falls back and reports a value out of range or of the wrong type', () => {
    const { config, problems } = parseActivityConfig(JSON.stringify({ intervalSeconds: 1, hideTitleApps: 'Weixin' }))
    expect(config?.intervalSeconds).toBe(30)
    expect(config?.hideTitleApps).toEqual(defaultActivityConfig().hideTitleApps)
    expect(problems).toHaveLength(2)
  })

  it('refuses unusable text', () => {
    expect(parseActivityConfig('nope').config).toBeUndefined()
    expect(parseActivityConfig('[]').config).toBeUndefined()
  })

  it('writes the default file on first read', () => {
    const profile = tempProfile()
    expect(readActivityConfig(profile).config).toEqual(defaultActivityConfig())
    expect(readActivityConfig(profile).config).toEqual(defaultActivityConfig())
  })
})

describe('day storage', () => {
  it('appends samples to their own day and reads them back in time order', () => {
    const profile = tempProfile()
    appendActivitySample(profile, sample(at(10, 0), 'b', 'second'))
    appendActivitySample(profile, sample(at(9, 0), 'a', 'first'))
    const day = readActivityDay(profile, localDateKey(new Date(at(9, 0))))
    expect(day.map(entry => entry.title)).toEqual(['first', 'second'])
    expect(readActivityDay(profile, '2026-01-01')).toEqual([])
  })

  it('skips damaged and malformed lines', () => {
    const profile = tempProfile()
    mkdirSync(join(profile, ACTIVITY_DIR), { recursive: true })
    const key = localDateKey(new Date(at(9, 0)))
    writeFileSync(activityFilePath(profile, key), [
      JSON.stringify(sample(at(9, 0), 'a', 't')),
      '{"t": 1, "app"',
      JSON.stringify({ t: 'x', app: 'a', title: 't', idle: false }),
      '',
      JSON.stringify(sample(at(9, 1), 'a', 't2')),
    ].join('\n'))
    expect(readActivityDay(profile, key).map(entry => entry.title)).toEqual(['t', 't2'])
  })

  it('prunes day files older than the retention window and leaves other files alone', () => {
    const profile = tempProfile()
    const dir = join(profile, ACTIVITY_DIR)
    mkdirSync(dir, { recursive: true })
    for (const name of ['2026-10-20.jsonl', '2026-10-14.jsonl', '2026-10-13.jsonl', '2026-09-01.jsonl', 'notes.txt']) {
      writeFileSync(join(dir, name), '')
    }
    // Keeping 7 days counting today keeps 10-14 through 10-20.
    expect(pruneActivity(profile, new Date(at(12, 0)), 7)).toBe(2)
    expect(readdirSync(dir).sort()).toEqual(['2026-10-14.jsonl', '2026-10-20.jsonl', 'notes.txt'])
    expect(pruneActivity(tempProfile(), new Date(at(12, 0)), 7)).toBe(0)
  })
})

describe('summarizeDay', () => {
  const interval = 30_000

  it('credits each sample with the time until the next and sorts programs by time', () => {
    const summary = summarizeDay([
      sample(at(9, 0), 'Code', 'a.ts'),
      sample(at(9, 0, 30), 'Code', 'a.ts'),
      sample(at(9, 1), 'chrome', 'docs'),
      sample(at(9, 1, 30), 'Code', 'b.ts'),
      sample(at(9, 2), 'Code', 'b.ts'),
    ], interval)
    expect(summary.activeMs).toBe(2.5 * MINUTE)
    expect(summary.apps.map(app => [app.app, app.ms])).toEqual([['Code', 2 * MINUTE], ['chrome', 0.5 * MINUTE]])
    expect(summary.apps[0]?.titles).toEqual([{ title: 'a.ts', ms: MINUTE }, { title: 'b.ts', ms: MINUTE }])
    expect(summary.firstAt).toBe(at(9, 0))
    expect(summary.lastAt).toBe(at(9, 2))
  })

  it('counts idle time apart and never under a program', () => {
    const summary = summarizeDay([
      sample(at(9, 0), 'Code', 'a'),
      sample(at(9, 1), 'Code', 'a', true),
      sample(at(9, 2), 'Code', 'a'),
    ], 60_000)
    expect(summary.activeMs).toBe(2 * MINUTE)
    expect(summary.idleMs).toBe(MINUTE)
    expect(summary.apps[0]?.ms).toBe(2 * MINUTE)
  })

  it('does not count a long gap as use', () => {
    const summary = summarizeDay([
      sample(at(9, 0), 'Code', 'a'),
      sample(at(15, 0), 'Code', 'a'),
    ], interval)
    // 9:00 is capped at two intervals, and the last sample counts one interval.
    expect(summary.activeMs).toBe(3 * interval)
  })

  it('handles a day with nothing recorded', () => {
    expect(summarizeDay([], interval)).toEqual({ firstAt: undefined, lastAt: undefined, activeMs: 0, idleMs: 0, apps: [] })
  })
})

describe('readWorkLogExamples', () => {
  function writeLog(content: unknown): string {
    const profile = tempProfile()
    const file = join(profile, 'work_log.json')
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
    return file
  }

  const log = {
    '2026-10-14': [{ time: '18:21', content: '部署创普达人员定位系统' }, { time: '18:21', content: '修复龙冉人员定位无法处理SOS报警问题' }],
    '2026-10-15': [{ time: '18:23', content: '  处理江川化工人员定位的证书问题  ' }],
    '2026-10-16': [{ time: '18:20', content: '处理同辉气体的人员定位系统问题' }],
    '2026-10-20': [{ time: '12:00', content: '今天已经写的一条' }],
    'not-a-date': [{ time: '1', content: 'ignored' }],
  }

  it('returns the most recent past days, oldest first, with tidy text', () => {
    const days = readWorkLogExamples(writeLog(log), 2, '2026-10-20')
    expect(days).toEqual([
      { date: '2026-10-15', items: ['处理江川化工人员定位的证书问题'] },
      { date: '2026-10-16', items: ['处理同辉气体的人员定位系统问题'] },
    ])
  })

  it('leaves out today, which is what is being written, and any key that is not a date', () => {
    const dates = readWorkLogExamples(writeLog(log), 10, '2026-10-20').map(day => day.date)
    expect(dates).toEqual(['2026-10-14', '2026-10-15', '2026-10-16'])
  })

  it('skips days with nothing usable and entries without text', () => {
    const file = writeLog({
      '2026-10-10': [{ time: '1', content: '' }, { time: '2' }, 'junk'],
      '2026-10-11': 'not a list',
      '2026-10-12': [{ time: '3', content: '有内容' }],
    })
    expect(readWorkLogExamples(file, 5, '2026-10-20')).toEqual([{ date: '2026-10-12', items: ['有内容'] }])
  })

  it('caps the entries per day, the length of each, and the total', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ time: '1', content: `事项${String(index)}${'长'.repeat(300)}` }))
    const day = readWorkLogExamples(writeLog({ '2026-10-10': many }), 5, '2026-10-20')[0]
    expect(day?.items).toHaveLength(10)
    expect(day?.items[0]).toHaveLength(200)
    const busy: Record<string, unknown> = {}
    for (let index = 1; index <= 9; index += 1) {
      busy[`2026-10-${String(index).padStart(2, '0')}`] = Array.from({ length: 10 }, () => ({ time: '1', content: 'x' }))
    }
    const total = readWorkLogExamples(writeLog(busy), 60, '2026-10-20').reduce((sum, entry) => sum + entry.items.length, 0)
    expect(total).toBeLessThanOrEqual(60)
  })

  it('returns nothing when the file is unset, disabled, missing, or in the wrong shape', () => {
    expect(readWorkLogExamples('', 10, '2026-10-20')).toEqual([])
    expect(readWorkLogExamples(writeLog(log), 0, '2026-10-20')).toEqual([])
    expect(readWorkLogExamples(join(tempProfile(), 'missing.json'), 10, '2026-10-20')).toEqual([])
    expect(readWorkLogExamples(writeLog('{ broken'), 10, '2026-10-20')).toEqual([])
    expect(readWorkLogExamples(writeLog([1, 2]), 10, '2026-10-20')).toEqual([])
  })

  it('expands %NAME% in the path from the environment', () => {
    const file = writeLog(log)
    const dir = file.slice(0, file.lastIndexOf('work_log.json') - 1)
    process.env.DSH_TEST_WORKLOG_DIR = dir
    try {
      expect(readWorkLogExamples('%DSH_TEST_WORKLOG_DIR%/work_log.json', 1, '2026-10-20')).toHaveLength(1)
    } finally {
      delete process.env.DSH_TEST_WORKLOG_DIR
    }
  })

  it('reads the two new settings from the config', () => {
    expect(parseActivityConfig('{}').config).toMatchObject({ workLogFile: '', exampleDays: 10 })
    expect(parseActivityConfig('{"workLogFile":"  C:/x/log.json ","exampleDays":3}').config)
      .toMatchObject({ workLogFile: 'C:/x/log.json', exampleDays: 3 })
    expect(parseActivityConfig('{"exampleDays":999}').problems).toHaveLength(1)
  })
})

describe('readScreenNotes', () => {
  function writeNotes(dateKey: string, lines: string[]): string {
    const dir = tempProfile()
    writeFileSync(join(dir, `${dateKey}.jsonl`), lines.join('\n'))
    return dir
  }

  it('reads one day in time order, trims, and collapses repeats', () => {
    const dir = writeNotes('2026-10-19', [
      JSON.stringify({ time: '10:07', description: '  编写Maven项目代码，右侧显示运维系统  ' }),
      JSON.stringify({ time: '09:50', description: '调试脚本，同时处理日报' }),
      JSON.stringify({ time: '10:20', description: '编写Maven项目代码，右侧显示运维系统' }),
      JSON.stringify({ time: '10:21', description: '编写Maven项目代码，右侧显示运维系统' }),
    ])
    expect(readScreenNotes(dir, '2026-10-19')).toEqual([
      { time: '09:50', text: '调试脚本，同时处理日报' },
      { time: '10:07', text: '编写Maven项目代码，右侧显示运维系统' },
    ])
  })

  it('skips damaged lines and entries without text', () => {
    const dir = writeNotes('2026-10-19', [
      '{ broken',
      JSON.stringify({ time: '09:00' }),
      JSON.stringify({ time: '09:10', description: '   ' }),
      JSON.stringify({ time: '09:20', description: '有内容' }),
    ])
    expect(readScreenNotes(dir, '2026-10-19')).toEqual([{ time: '09:20', text: '有内容' }])
  })

  it('keeps an even spread of at most 40 notes, from the start to near the end of the day', () => {
    const lines = Array.from({ length: 200 }, (_, index) => JSON.stringify({
      time: `${String(8 + Math.floor(index / 20)).padStart(2, '0')}:${String((index % 20) * 3).padStart(2, '0')}`,
      description: `第${String(index)}条`,
    }))
    const notes = readScreenNotes(writeNotes('2026-10-19', lines), '2026-10-19')
    expect(notes).toHaveLength(40)
    expect(notes[0]?.text).toBe('第0条')
    expect(Number(notes.at(-1)?.text.replace(/\D/gu, ''))).toBeGreaterThan(150)
  })

  it('returns nothing when unset, missing, or the day has no file', () => {
    expect(readScreenNotes('', '2026-10-19')).toEqual([])
    expect(readScreenNotes(tempProfile(), '2026-10-19')).toEqual([])
  })

  it('reads the setting from the config', () => {
    expect(parseActivityConfig('{}').config?.visionDir).toBe('')
    expect(parseActivityConfig('{"visionDir":" %APPDATA%/x "}').config?.visionDir).toBe('%APPDATA%/x')
  })
})
