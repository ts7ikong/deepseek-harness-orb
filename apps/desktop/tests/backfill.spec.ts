import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown
const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  windows: [] as { webContents: { id: number }; closed: boolean }[],
  writeText: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => { electron.handlers.set(channel, handler) },
    removeHandler: (channel: string) => { electron.handlers.delete(channel) },
  },
  clipboard: { writeText: electron.writeText },
  shell: { openExternal: vi.fn() },
  screen: {
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  BrowserWindow: class {
    webContents = { id: electron.windows.length + 1, setWindowOpenHandler() {} }
    closed = false
    constructor() { electron.windows.push(this) }
    isDestroyed() { return this.closed }
    show() {}
    focus() {}
    setContentProtection() {}
    once() {}
    close() { this.closed = true }
    loadURL() { return Promise.resolve() }
  },
}))
vi.mock('../src/floating-window.ts', () => ({ presentOverlayWindow: () => {} }))
vi.mock('../src/report-window.ts', () => ({
  showReportWindow: () => {
    const window = { webContents: { id: 500 + electron.windows.length }, closed: false, close() { window.closed = true }, once() {} }
    electron.windows.push(window)
    return window
  },
}))

import { defaultActivityConfig } from '../src/activity-log.ts'
import { backfillView, BACKFILL_DAYS, startBackfillService } from '../src/backfill-service.ts'
import { buildDailyReportPrompt } from '../src/daily-report.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { startReportService } from '../src/report-service.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  electron.handlers.clear()
  electron.windows.length = 0
})

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-backfill-'))
  roots.push(root)
  return root
}

// 2026-10-23 is a Friday.
const now = new Date(2026, 9, 23, 10, 0, 0)

function writeActivity(profileDir: string, dateKey: string, samples: number): void {
  mkdirSync(join(profileDir, 'activity'), { recursive: true })
  const [year = 0, month = 1, day = 1] = dateKey.split('-').map(Number)
  const base = new Date(year, month - 1, day, 9, 0, 0).getTime()
  const lines = Array.from({ length: samples }, (_unused, index) => JSON.stringify({ t: base + index * 30_000, app: 'idea64', title: 'App.java', idle: false }))
  writeFileSync(join(profileDir, 'activity', `${dateKey}.jsonl`), `${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`)
}

describe('backfillView', () => {
  it('offers the last two weeks before today, newest first, with weekday, log entries, and recorded minutes', () => {
    const profileDir = temp()
    const file = join(profileDir, 'log.json')
    writeFileSync(file, JSON.stringify({ '2026-10-21': [{ time: '18:30', content: '处理甲' }] }))
    writeActivity(profileDir, '2026-10-22', 240)
    writeActivity(profileDir, '2026-10-21', 120)
    const view = backfillView({ profileDir, workLogFile: file, intervalSeconds: 30, now })
    expect(view.days).toHaveLength(BACKFILL_DAYS)
    expect(view.days[0]).toEqual({ date: '2026-10-22', weekday: '周四', entries: 0, activeMinutes: 120 })
    expect(view.days[1]).toEqual({ date: '2026-10-21', weekday: '周三', entries: 1, activeMinutes: 60 })
    expect(view.days.at(-1)?.date).toBe('2026-10-09')
  })

  it('preselects the newest day that has activity but no report, and falls back to the newest day', () => {
    const profileDir = temp()
    const file = join(profileDir, 'log.json')
    writeFileSync(file, JSON.stringify({ '2026-10-22': [{ time: '18:30', content: '处理甲' }] }))
    writeActivity(profileDir, '2026-10-22', 200)
    writeActivity(profileDir, '2026-10-20', 200)
    expect(backfillView({ profileDir, workLogFile: file, intervalSeconds: 30, now }).defaultDate).toBe('2026-10-20')
    expect(backfillView({ profileDir: temp(), workLogFile: file, intervalSeconds: 30, now }).defaultDate).toBe('2026-10-22')
  })
})

describe('startBackfillService', () => {
  function start(onGenerate = vi.fn()) {
    const profileDir = temp()
    writeActivity(profileDir, '2026-10-22', 200)
    const service = startBackfillService({
      profileDir,
      settings: () => defaultActivityConfig(),
      shellOrigin: 'dsh-app://shell',
      preload: 'p.cjs',
      ballBounds: () => undefined,
      onGenerate,
    })
    const call = (channel: string, sender: unknown, ...args: unknown[]) => electron.handlers.get(channel)!({ sender }, ...args)
    return { service, call, onGenerate }
  }

  it('serves the days to its own window only', () => {
    const { service, call } = start()
    expect(() => call(DESKTOP_IPC.backfillGet, { id: 1 })).toThrow(/unowned/u)
    service.open()
    service.open()
    expect(electron.windows).toHaveLength(1)
    const view = call(DESKTOP_IPC.backfillGet, electron.windows[0]?.webContents) as { days: unknown[] }
    expect(view.days).toHaveLength(BACKFILL_DAYS)
  })

  it('asks for the chosen day and closes, but refuses a day that was not offered', () => {
    const { service, call, onGenerate } = start()
    service.open()
    const sender = electron.windows[0]?.webContents
    const offered = (call(DESKTOP_IPC.backfillGet, sender) as { days: { date: string }[] }).days[2]!.date
    expect(() => call(DESKTOP_IPC.backfillGo, sender, '2020-01-01')).toThrow(/offered/u)
    expect(() => call(DESKTOP_IPC.backfillGo, sender, 5)).toThrow(/offered/u)
    expect(() => call(DESKTOP_IPC.backfillGo, { id: 9 }, offered)).toThrow(/unowned/u)
    call(DESKTOP_IPC.backfillGo, sender, offered)
    expect(onGenerate).toHaveBeenCalledWith(offered)
    expect(electron.windows[0]?.closed).toBe(true)
  })

  it('removes its handlers when stopped', () => {
    const { service } = start()
    service.stop()
    expect(electron.handlers.size).toBe(0)
  })
})

describe('the draft for an earlier day', () => {
  const summary = { activeMs: 3_600_000, idleMs: 0, firstAt: undefined, lastAt: undefined, apps: [] }

  it('says "that day" instead of "today" for a past date, and keeps "today" for today', () => {
    const past = buildDailyReportPrompt(summary, new Date(2026, 9, 22), [], [])
    expect(past).toContain('我当天在电脑上的使用记录')
    expect(past).toContain('整理一份当天的工作日报草稿')
    expect(past).toContain('2026年10月22日 周四')
    const today = buildDailyReportPrompt(summary, new Date(), [], [])
    expect(today).toContain('我今天在电脑上的使用记录')
  })

  it('is written back under that day, not under today, when confirmed', () => {
    const profileDir = temp()
    const service = startReportService({
      profileDir,
      shellOrigin: 'dsh-app://shell',
      preload: 'p.cjs',
      settings: () => defaultActivityConfig(),
      ballBounds: () => undefined,
    })
    service.showDraft('处理甲\n处理乙', 'daily', '2026-10-22')
    const sender = electron.windows.at(-1)?.webContents
    const call = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)!({ sender }, ...args)
    expect(call(DESKTOP_IPC.reportInit)).toMatchObject({ kind: 'daily', date: '2026-10-22', today: false, existing: 0 })
    expect(call(DESKTOP_IPC.reportConfirm, '处理甲\n处理乙', 'log')).toMatchObject({ ok: true, write: { added: 2 } })
    const log = JSON.parse(readFileSync(join(profileDir, 'orb-work-log.json'), 'utf8')) as Record<string, { content: string }[]>
    expect(Object.keys(log)).toEqual(['2026-10-22'])
    expect(log['2026-10-22']?.map(entry => entry.content)).toEqual(['处理甲', '处理乙'])
    service.stop()
  })
})

describe('the picker page', () => {
  async function mount(view: unknown, go = vi.fn(async (_date: string) => undefined)) {
    const dom = new JSDOM(readFileSync(new URL('../renderer/backfill.html', import.meta.url), 'utf8'), {
      runScripts: 'outside-only',
      url: 'dsh-app://shell/backfill.html',
    })
    Object.defineProperty(dom.window, 'close', { value: vi.fn() })
    Object.defineProperty(dom.window, 'dshDesktop', { value: { backfill: { get: async () => view, go } } })
    runInContext(readFileSync(new URL('../renderer/backfill.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    return { document: dom.window.document, go }
  }

  const view = {
    defaultDate: '2026-10-22',
    days: [
      { date: '2026-10-22', weekday: '周四', entries: 0, activeMinutes: 125 },
      { date: '2026-10-21', weekday: '周三', entries: 3, activeMinutes: 0 },
    ],
  }

  it('lists the days, marks the missing one, and preselects the default', async () => {
    const { document } = await mount(view)
    await expect.poll(() => document.querySelectorAll('.day').length).toBe(2)
    const rows = [...document.querySelectorAll<HTMLElement>('.day')]
    expect(rows[0]?.textContent).toContain('没有日报 · 电脑使用 2 小时 5 分钟')
    expect(rows[0]?.classList.contains('missing')).toBe(true)
    expect(rows[1]?.textContent).toContain('已有 3 条日报 · 没有使用记录')
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector<HTMLButtonElement>('#go')?.disabled).toBe(false)
  })

  it('asks for the day the user picks', async () => {
    const { document, go } = await mount(view)
    await expect.poll(() => document.querySelectorAll('.day').length).toBe(2)
    document.querySelectorAll<HTMLElement>('.day')[1]?.click()
    document.querySelector<HTMLButtonElement>('#go')?.click()
    await expect.poll(() => go.mock.calls.length).toBe(1)
    expect(go).toHaveBeenCalledWith('2026-10-21')
  })

  it('shows the reason when the request fails, and lets the user try again', async () => {
    const { document } = await mount(view, vi.fn(async () => { throw new Error('boom') }))
    await expect.poll(() => document.querySelectorAll('.day').length).toBe(2)
    document.querySelector<HTMLButtonElement>('#go')?.click()
    await expect.poll(() => document.querySelector('#status')?.textContent).toContain('boom')
    expect(document.querySelector<HTMLButtonElement>('#go')?.disabled).toBe(false)
  })
})
