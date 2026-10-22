import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown
const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  writeText: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => { electron.handlers.set(channel, handler) },
    removeHandler: (channel: string) => { electron.handlers.delete(channel) },
  },
  clipboard: { writeText: electron.writeText },
  shell: { openExternal: vi.fn() },
}))

interface FakeWindow {
  readonly webContents: { readonly id: number }
  readonly closed: boolean
  close(): void
  once(event: string, listener: () => void): void
  emitClosed(): void
}

const windows: FakeWindow[] = []

vi.mock('../src/report-window.ts', () => ({
  showReportWindow: () => {
    const listeners: (() => void)[] = []
    const window: FakeWindow = {
      webContents: { id: windows.length + 1 },
      closed: false,
      close() { (window as { closed: boolean }).closed = true; window.emitClosed() },
      once(_event, listener) { listeners.push(listener) },
      emitClosed() { for (const listener of listeners.splice(0)) listener() },
    }
    windows.push(window)
    return window
  },
}))

import { DESKTOP_IPC } from '../src/ipc.ts'
import { startReportService } from '../src/report-service.ts'
import { defaultActivityConfig } from '../src/activity-log.ts'

interface ReportInitShape {
  text: string
  date: string
  existing: number
  pendingMark: string
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  electron.handlers.clear()
  electron.writeText.mockReset()
  windows.length = 0
})

function start(workLogFile = '', openDingTalk: () => Promise<boolean> = () => Promise.resolve(true)) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-report-'))
  roots.push(profileDir)
  const service = startReportService({
    profileDir,
    shellOrigin: 'dsh-app://shell',
    preload: 'preload.cjs',
    settings: () => ({ ...defaultActivityConfig(), workLogFile }),
    ballBounds: () => undefined,
    openDingTalk,
  })
  const call = (channel: string, sender: unknown, ...args: unknown[]) => {
    const handler = electron.handlers.get(channel)
    if (handler === undefined) throw new Error(`no handler for ${channel}`)
    return handler({ sender }, ...args)
  }
  return { profileDir, service, call }
}

const today = () => {
  const now = new Date()
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

describe('startReportService', () => {
  it('gives the confirmation window the cleaned draft, today\'s date, and how many entries the log already has', () => {
    const { profileDir, service, call } = start()
    writeFileSync(join(profileDir, 'orb-work-log.json'), JSON.stringify({ [today()]: [{ time: '12:00', content: '已有' }] }))
    service.showDraft('# 日报\n1. 处理甲\n- 处理乙（待补充）')
    const init = call(DESKTOP_IPC.reportInit, windows[0]?.webContents) as ReportInitShape
    expect(init).toEqual({ kind: 'daily', text: '处理甲\n处理乙（待补充）', date: today(), existing: 1, pendingMark: '（待补充）' })
  })

  it('refuses every call from a renderer other than the open confirmation window', () => {
    const { service, call } = start()
    expect(() => call(DESKTOP_IPC.reportInit, { id: 99 })).toThrow(/unowned/u)
    service.showDraft('处理甲')
    const stranger = { id: 99 }
    expect(() => call(DESKTOP_IPC.reportInit, stranger)).toThrow(/unowned/u)
    expect(() => call(DESKTOP_IPC.reportConfirm, stranger, '处理甲', 'log')).toThrow(/unowned/u)
    expect(() => call(DESKTOP_IPC.reportConfirm, stranger, '处理甲', 'copy')).toThrow(/unowned/u)
    expect(electron.writeText).not.toHaveBeenCalled()
  })

  it('writes the confirmed text into the work log under today', () => {
    const { profileDir, service, call } = start()
    service.showDraft('处理甲')
    const result = call(DESKTOP_IPC.reportConfirm, windows[0]?.webContents, '- 处理甲\n- 处理乙', 'log')
    expect(result).toEqual({ ok: true, write: { added: 2, skipped: 0, total: 2 } })
    const log = JSON.parse(readFileSync(join(profileDir, 'orb-work-log.json'), 'utf8')) as Record<string, { content: string }[]>
    expect(log[today()]?.map(entry => entry.content)).toEqual(['处理甲', '处理乙'])
  })

  it('writes to the configured work log instead of the default one', () => {
    const configured = join(mkdtempSync(join(tmpdir(), 'dsh-report-cfg-')), 'work_log.json')
    roots.push(join(configured, '..'))
    const { service, call } = start(configured)
    service.showDraft('处理甲')
    call(DESKTOP_IPC.reportConfirm, windows[0]?.webContents, '处理甲', 'log')
    expect(Object.keys(JSON.parse(readFileSync(configured, 'utf8')) as object)).toEqual([today()])
  })

  it('leaves the log alone and says so when the text is empty or still has entries to be filled in', () => {
    const { profileDir, service, call } = start()
    service.showDraft('处理甲')
    const sender = windows[0]?.webContents
    expect(call(DESKTOP_IPC.reportConfirm, sender, ' \n ', 'log')).toEqual({ ok: false, reason: 'empty' })
    expect(call(DESKTOP_IPC.reportConfirm, sender, '处理甲（待补充）', 'log')).toEqual({ ok: false, reason: 'pending', pending: 1 })
    expect(() => readFileSync(join(profileDir, 'orb-work-log.json'), 'utf8')).toThrow()
  })

  it('copies the entries to the clipboard without touching the log', () => {
    const { profileDir, service, call } = start()
    service.showDraft('处理甲')
    const sender = windows[0]?.webContents
    expect(call(DESKTOP_IPC.reportConfirm, sender, '1. 处理甲\n- 处理乙', 'copy')).toEqual({ ok: true, copied: 2 })
    expect(electron.writeText).toHaveBeenCalledWith('处理甲\n处理乙')
    expect(call(DESKTOP_IPC.reportConfirm, sender, '  ', 'copy')).toEqual({ ok: false, reason: 'empty' })
    expect(() => readFileSync(join(profileDir, 'orb-work-log.json'), 'utf8')).toThrow()
  })

  it('rejects malformed arguments from the owning window', () => {
    const { service, call } = start()
    service.showDraft('处理甲')
    const sender = windows[0]?.webContents
    expect(() => call(DESKTOP_IPC.reportConfirm, sender, 42, 'log')).toThrow(/requires/u)
    expect(() => call(DESKTOP_IPC.reportConfirm, sender, '处理甲', 'delete')).toThrow(/requires/u)
  })

  it('replaces an open draft with a new one, and stops accepting calls from a window that has closed', () => {
    const { service, call } = start()
    service.showDraft('旧的')
    service.showDraft('新的')
    expect(windows).toHaveLength(2)
    expect(windows[0]?.closed).toBe(true)
    expect(() => call(DESKTOP_IPC.reportInit, windows[0]?.webContents)).toThrow(/unowned/u)
    expect((call(DESKTOP_IPC.reportInit, windows[1]?.webContents) as { text: string }).text).toBe('新的')
    windows[1]?.emitClosed()
    expect(() => call(DESKTOP_IPC.reportInit, windows[1]?.webContents)).toThrow(/unowned/u)
  })

  it('removes its handlers and closes the window when stopped', () => {
    const { service } = start()
    service.showDraft('处理甲')
    service.stop()
    expect(windows[0]?.closed).toBe(true)
    expect(electron.handlers.has(DESKTOP_IPC.reportInit)).toBe(false)
    expect(electron.handlers.has(DESKTOP_IPC.reportConfirm)).toBe(false)
  })
})

describe('a weekly report', () => {
  it('opens as weekly, with no daily-log count', () => {
    const { service, call } = start()
    service.showDraft('处理甲', 'weekly')
    expect(call(DESKTOP_IPC.reportInit, windows[0]?.webContents)).toMatchObject({ kind: 'weekly', existing: 0, text: '处理甲' })
  })

  it('copies the confirmed text, keeps a copy in the profile, and opens DingTalk without sending anything', async () => {
    const opened = vi.fn(() => Promise.resolve(true))
    const { profileDir, service, call } = start('', opened)
    service.showDraft('处理甲', 'weekly')
    const result = await call(DESKTOP_IPC.reportConfirm, windows[0]?.webContents, '- 处理甲\n- 处理乙', 'dingtalk') as { ok: boolean; savedTo: string }
    expect(result).toMatchObject({ ok: true, copied: 2, opened: true })
    expect(electron.writeText).toHaveBeenCalledWith('处理甲\n处理乙')
    expect(readFileSync(result.savedTo, 'utf8')).toBe('处理甲\n处理乙\n')
    expect(result.savedTo.startsWith(join(profileDir, 'orb-weekly-reports'))).toBe(true)
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('still reports success with opened=false when DingTalk cannot be opened', async () => {
    const { service, call } = start('', () => Promise.resolve(false))
    service.showDraft('处理甲', 'weekly')
    expect(await call(DESKTOP_IPC.reportConfirm, windows[0]?.webContents, '处理甲', 'dingtalk')).toMatchObject({ ok: true, opened: false })
  })

  it('refuses empty text and entries still waiting to be filled in, without touching the clipboard', async () => {
    const opened = vi.fn(() => Promise.resolve(true))
    const { service, call } = start('', opened)
    service.showDraft('处理甲', 'weekly')
    const sender = windows[0]?.webContents
    expect(await call(DESKTOP_IPC.reportConfirm, sender, ' ', 'dingtalk')).toEqual({ ok: false, reason: 'empty' })
    expect(await call(DESKTOP_IPC.reportConfirm, sender, '下周计划：（待补充）', 'dingtalk')).toEqual({ ok: false, reason: 'pending', pending: 1 })
    expect(electron.writeText).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
  })

  it('cannot be written to the daily work log, and a daily draft cannot go to DingTalk', () => {
    const { service, call } = start()
    service.showDraft('处理甲', 'weekly')
    expect(() => call(DESKTOP_IPC.reportConfirm, windows[0]?.webContents, '处理甲', 'log')).toThrow(/not written/u)
    service.showDraft('处理甲')
    expect(() => call(DESKTOP_IPC.reportConfirm, windows[1]?.webContents, '处理甲', 'dingtalk')).toThrow(/only a weekly/u)
  })
})
