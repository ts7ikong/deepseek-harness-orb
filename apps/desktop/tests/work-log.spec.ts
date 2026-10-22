import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendWorkLogEntries,
  cleanReportLines,
  confirmReportText,
  countPending,
  DEFAULT_WORK_LOG_FILE,
  parseConfirmedLines,
  PENDING_MARK,
  resolveWorkLogFile,
} from '../src/work-log.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worklog-'))
  roots.push(root)
  return root
}

describe('resolveWorkLogFile', () => {
  it('uses the profile file when nothing is configured and expands %NAME% otherwise', () => {
    expect(resolveWorkLogFile('', '/profile')).toBe(join('/profile', DEFAULT_WORK_LOG_FILE))
    process.env.DSH_TEST_LOG_DIR = '/data'
    try {
      expect(resolveWorkLogFile('%DSH_TEST_LOG_DIR%/log.json', '/profile')).toBe('/data/log.json')
    } finally {
      delete process.env.DSH_TEST_LOG_DIR
    }
  })
})

describe('cleanReportLines', () => {
  it('turns a markdown reply into one entry per line', () => {
    const reply = [
      '# 2026年10月20日 周二 日报',
      '',
      '**今日工作：**',
      '1. 处理静善生物人员定位系统问题',
      '2. 修复烟花爆竹预警系统喊话功能的BUG',
      '- 部署创普达人员定位系统并调试上线',
      '• 编写**数据规范**文档',
      '（1）排查 `磁盘占满` 问题',
      '---',
      '2026-10-20',
    ].join('\n')
    expect(cleanReportLines(reply)).toEqual([
      '处理静善生物人员定位系统问题',
      '修复烟花爆竹预警系统喊话功能的BUG',
      '部署创普达人员定位系统并调试上线',
      '编写数据规范文档',
      '排查 磁盘占满 问题',
    ])
  })

  it('drops the remarks a model adds about its own answer', () => {
    const reply = [
      '处理上甲电子人员定位系统问题',
      '说明：以上根据窗口记录合并，客户名无法确认，已留「待补充」；娱乐内容未写入。',
      '备注：仅供参考',
      '注，这是推测',
      '以上为今日工作',
    ].join('\n')
    expect(cleanReportLines(reply)).toEqual(['处理上甲电子人员定位系统问题'])
    // A work entry that merely mentions such a word is kept.
    expect(cleanReportLines('说明书编写：完成第二章')).toEqual(['说明书编写：完成第二章'])
  })

  it('handles Windows line endings and drops repeated lines', () => {
    expect(cleanReportLines('- 甲\r\n- 乙\r\n- 甲')).toEqual(['甲', '乙'])
  })

  it('keeps a long line that merely ends with a colon, and finds nothing in an empty reply', () => {
    expect(cleanReportLines('处理上甲电子相关运维及人员定位系统业务，包括证书更新与后续跟进工作：')).toHaveLength(1)
    expect(cleanReportLines('  \n\n')).toEqual([])
  })
})

describe('countPending', () => {
  it('counts entries still marked as to-be-filled, in either bracket style', () => {
    expect(countPending(['处理系统问题', `部署${PENDING_MARK}`, '修复(待补充)'])).toBe(2)
    expect(countPending([])).toBe(0)
  })
})

describe('parseConfirmedLines', () => {
  it('keeps every non-empty line the user left, minus bullets and emphasis', () => {
    expect(parseConfirmedLines('1. 处理甲：\n\n- **乙**\n处理甲：')).toEqual(['处理甲：', '乙'])
  })
})

describe('appendWorkLogEntries', () => {
  const original = {
    '2026-10-19': [{ time: '18:23', content: '处理静善生物、海西斯的人员定位系统问题' }],
  }

  function writeLog(content: unknown): string {
    const file = join(tempDir(), 'work_log.json')
    writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, undefined, 2)}\n`)
    return file
  }

  it('adds a new day after the existing ones and leaves them exactly as they were', () => {
    const file = writeLog(original)
    expect(appendWorkLogEntries(file, '2026-10-20', '18:25', ['甲', '乙'])).toEqual({ added: 2, skipped: 0, total: 2 })
    const log = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(log)).toEqual(['2026-10-19', '2026-10-20'])
    expect(log['2026-10-19']).toEqual(original['2026-10-19'])
    expect(log['2026-10-20']).toEqual([{ time: '18:25', content: '甲' }, { time: '18:25', content: '乙' }])
  })

  it('appends to a day that already has entries and skips text it already holds', () => {
    const file = writeLog({ '2026-10-20': [{ time: '12:00', content: '甲' }] })
    expect(appendWorkLogEntries(file, '2026-10-20', '18:25', ['甲', '乙', '乙'])).toEqual({ added: 1, skipped: 2, total: 2 })
    const log = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { time: string; content: string }[]>
    expect(log['2026-10-20']).toEqual([{ time: '12:00', content: '甲' }, { time: '18:25', content: '乙' }])
  })

  it('keeps the previous file as .bak and leaves no temporary file behind', () => {
    const file = writeLog(original)
    const before = readFileSync(file, 'utf8')
    appendWorkLogEntries(file, '2026-10-20', '18:25', ['甲'])
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe(before)
    expect(readdirSync(join(file, '..')).sort()).toEqual(['work_log.json', 'work_log.json.bak'])
  })

  it('creates the file when there is none, without a backup', () => {
    const file = join(tempDir(), 'new.json')
    expect(appendWorkLogEntries(file, '2026-10-20', '09:00', ['甲'])).toMatchObject({ added: 1 })
    expect(existsSync(`${file}.bak`)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ '2026-10-20': [{ time: '09:00', content: '甲' }] })
  })

  it('refuses to touch a log it cannot understand', () => {
    for (const bad of ['{ broken', '[1, 2]', '"text"']) {
      const file = writeLog(bad)
      expect(() => appendWorkLogEntries(file, '2026-10-20', '18:25', ['甲'])).toThrow(/not/u)
      expect(readFileSync(file, 'utf8')).toBe(bad)
      expect(existsSync(`${file}.bak`)).toBe(false)
    }
  })

  it('writes nothing when every entry is already there', () => {
    const file = writeLog({ '2026-10-20': [{ time: '12:00', content: '甲' }] })
    const before = readFileSync(file, 'utf8')
    expect(appendWorkLogEntries(file, '2026-10-20', '18:25', ['甲'])).toEqual({ added: 0, skipped: 1, total: 1 })
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(`${file}.bak`)).toBe(false)
  })
})

describe('confirmReportText', () => {
  const now = new Date(2026, 9, 20, 18, 25)

  it('writes the edited text under today with the confirmation time', () => {
    const file = join(tempDir(), 'log.json')
    const result = confirmReportText('- 处理甲\n- 处理乙', file, now)
    expect(result).toEqual({ ok: true, write: { added: 2, skipped: 0, total: 2 } })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      '2026-10-20': [{ time: '18:25', content: '处理甲' }, { time: '18:25', content: '处理乙' }],
    })
  })

  it('refuses an empty report and one with entries still to be filled in, without writing', () => {
    const file = join(tempDir(), 'log.json')
    expect(confirmReportText('  \n ', file, now)).toEqual({ ok: false, reason: 'empty' })
    expect(confirmReportText(`处理甲\n部署乙${PENDING_MARK}`, file, now)).toEqual({ ok: false, reason: 'pending', pending: 1 })
    expect(existsSync(file)).toBe(false)
  })

  it('reports a damaged log as an error instead of throwing', () => {
    const file = join(tempDir(), 'log.json')
    writeFileSync(file, '{ broken')
    const result = confirmReportText('处理甲', file, now)
    expect(result).toMatchObject({ ok: false, reason: 'error' })
    expect(readFileSync(file, 'utf8')).toBe('{ broken')
  })
})
