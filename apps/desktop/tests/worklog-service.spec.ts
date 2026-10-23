import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown
const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  windows: [] as { webContents: { id: number }; closed: boolean }[],
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => { electron.handlers.set(channel, handler) },
    removeHandler: (channel: string) => { electron.handlers.delete(channel) },
  },
  shell: { openPath: vi.fn() },
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

import { defaultActivityConfig } from '../src/activity-log.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { WEEKLY_REPORTS_DIR } from '../src/report-service.ts'
import { reminderDismissMs, REMINDER_ACTION_DISMISS_MS, REMINDER_AUTO_DISMISS_MS } from '../src/reminder-window.ts'
import { readWorkLogRecent } from '../src/work-log.ts'
import { startWorkLogService } from '../src/worklog-service.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  electron.handlers.clear()
  electron.windows.length = 0
})

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worklog-'))
  roots.push(root)
  return root
}

const sample = {
  '2026-10-20': [{ time: '18:25', content: '处理甲系统' }],
  '2026-10-22': [{ time: '18:30', content: '部署乙系统' }, { time: '18:31', content: '  ' }, { time: '18:32', content: '修复丙接口' }],
  '2026-10-21': [],
  notADate: [{ time: '1', content: 'x' }],
}

describe('readWorkLogRecent', () => {
  it('lists days with entries, newest first, without blank entries or non-date keys', () => {
    const file = join(temp(), 'log.json')
    writeFileSync(file, JSON.stringify(sample))
    expect(readWorkLogRecent(file, 10)).toEqual([
      { date: '2026-10-22', entries: [{ time: '18:30', content: '部署乙系统' }, { time: '18:32', content: '修复丙接口' }] },
      { date: '2026-10-20', entries: [{ time: '18:25', content: '处理甲系统' }] },
    ])
    expect(readWorkLogRecent(file, 1)).toHaveLength(1)
  })

  it('gives nothing for a missing, damaged, or oddly shaped log', () => {
    const root = temp()
    expect(readWorkLogRecent(join(root, 'none.json'), 5)).toEqual([])
    writeFileSync(join(root, 'bad.json'), '{oops')
    expect(readWorkLogRecent(join(root, 'bad.json'), 5)).toEqual([])
    writeFileSync(join(root, 'arr.json'), '[1]')
    expect(readWorkLogRecent(join(root, 'arr.json'), 5)).toEqual([])
  })
})

describe('startWorkLogService', () => {
  function start(openPath = vi.fn(async (_path: string) => '')) {
    const profileDir = temp()
    const file = join(profileDir, 'log.json')
    writeFileSync(file, JSON.stringify(sample))
    const service = startWorkLogService({
      profileDir,
      settings: () => ({ ...defaultActivityConfig(), workLogFile: file }),
      shellOrigin: 'dsh-app://shell',
      preload: 'p.cjs',
      ballBounds: () => undefined,
      openPath,
    })
    const call = (channel: string, sender: unknown, ...args: unknown[]) => electron.handlers.get(channel)!({ sender }, ...args)
    return { profileDir, file, service, call, openPath }
  }

  it('shows the configured log to its own window only', async () => {
    const { file, service, call } = start()
    expect(() => call(DESKTOP_IPC.worklogGet, { id: 1 })).toThrow(/unowned/u)
    service.open()
    service.open()
    expect(electron.windows).toHaveLength(1)
    const view = await call(DESKTOP_IPC.worklogGet, electron.windows[0]?.webContents) as { file: string; days: unknown[] }
    expect(view.file).toBe(file)
    expect(view.days).toHaveLength(2)
    expect(() => call(DESKTOP_IPC.worklogGet, { id: 99 })).toThrow(/unowned/u)
  })

  it('opens the log file or the weekly reports folder, and nothing else', async () => {
    const { profileDir, file, service, call, openPath } = start()
    service.open()
    const sender = electron.windows[0]?.webContents
    await call(DESKTOP_IPC.worklogOpen, sender, 'log')
    await call(DESKTOP_IPC.worklogOpen, sender, 'weekly')
    expect(openPath).toHaveBeenNthCalledWith(1, file)
    expect(openPath).toHaveBeenNthCalledWith(2, join(profileDir, WEEKLY_REPORTS_DIR))
    await expect(Promise.resolve().then(() => call(DESKTOP_IPC.worklogOpen, sender, '../../etc'))).rejects.toThrow(/requires/u)
    await expect(Promise.resolve().then(() => call(DESKTOP_IPC.worklogOpen, { id: 9 }, 'log'))).rejects.toThrow(/unowned/u)
  })

  it('removes its handlers and closes the window when stopped', () => {
    const { service } = start()
    service.open()
    service.stop()
    expect(electron.windows[0]?.closed).toBe(true)
    expect(electron.handlers.size).toBe(0)
  })
})

describe('the work log page', () => {
  async function mount(view: unknown, open = vi.fn(async (_what: string) => '')) {
    const dom = new JSDOM(readFileSync(new URL('../renderer/worklog.html', import.meta.url), 'utf8'), {
      runScripts: 'outside-only',
      url: 'dsh-app://shell/worklog.html',
    })
    Object.defineProperty(dom.window, 'close', { value: vi.fn() })
    Object.defineProperty(dom.window, 'dshDesktop', { value: { worklog: { get: async () => view, open } } })
    runInContext(readFileSync(new URL('../renderer/worklog.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    return { document: dom.window.document, open }
  }

  it('lists each day with its entries and times, newest first', async () => {
    const { document } = await mount({
      file: 'C:\\x\\log.json',
      days: [
        { date: '2026-10-22', entries: [{ time: '18:30', content: '部署乙系统' }] },
        { date: '2026-10-20', entries: [{ time: '', content: '处理甲系统' }] },
      ],
    })
    await expect.poll(() => document.querySelectorAll('#list h2').length).toBe(2)
    expect([...document.querySelectorAll('#list h2')].map(node => node.textContent)).toEqual(['2026-10-22', '2026-10-20'])
    expect(document.querySelector('#list li')?.textContent).toBe('18:30部署乙系统')
    expect(document.querySelector('#path')?.textContent).toBe('C:\\x\\log.json')
    expect(document.querySelector('#count')?.textContent).toBe('最近 2 天')
  })

  it('explains where entries come from when there are none, and opens the file and folder on request', async () => {
    const { document, open } = await mount({ file: 'f', days: [] })
    await expect.poll(() => document.querySelector('#empty')?.textContent ?? '').toContain('记入工作日志')
    document.querySelector<HTMLButtonElement>('#open-log')!.click()
    document.querySelector<HTMLButtonElement>('#open-weekly')!.click()
    await expect.poll(() => open.mock.calls.length).toBe(2)
    expect(open.mock.calls.map(call => call[0])).toEqual(['log', 'weekly'])
  })
})

describe('reminder pop-up lifetime', () => {
  it('keeps one with a button much longer than a plain one, so stepping away does not lose it', () => {
    const plain = { id: 'a', time: '18:30', days: [5], mood: 'happy' as const, title: '', message: '' }
    expect(reminderDismissMs(plain)).toBe(REMINDER_AUTO_DISMISS_MS)
    expect(reminderDismissMs({ ...plain, action: 'daily-report', actionLabel: 'x' })).toBe(REMINDER_ACTION_DISMISS_MS)
    expect(REMINDER_ACTION_DISMISS_MS).toBeGreaterThan(REMINDER_AUTO_DISMISS_MS)
    expect(REMINDER_AUTO_DISMISS_MS).toBeGreaterThanOrEqual(5 * 60_000)
  })
})
