import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

import { DESKTOP_IPC } from '../src/ipc.ts'
import { startScheduleService } from '../src/schedule-service.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  electron.handlers.clear()
  electron.windows.length = 0
})

function start() {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-schedule-svc-'))
  roots.push(profileDir)
  const service = startScheduleService({ profileDir, shellOrigin: 'dsh-app://shell', preload: 'p.cjs', ballBounds: () => undefined })
  const call = (channel: string, sender: unknown, ...args: unknown[]) => electron.handlers.get(channel)!({ sender }, ...args)
  return { service, call }
}

const form = { showClock: true, workStart: '09:00', lunchStart: '12:00', afternoonStart: '13:30', workEnd: '18:30' }

describe('startScheduleService', () => {
  it('serves the form only to the window it opened', () => {
    const { service, call } = start()
    expect(() => call(DESKTOP_IPC.scheduleGet, { id: 1 })).toThrow(/unowned/u)
    service.open()
    const sender = electron.windows[0]?.webContents
    expect(call(DESKTOP_IPC.scheduleGet, sender)).toMatchObject({ showClock: true, workStart: '' })
    expect(() => call(DESKTOP_IPC.scheduleGet, { id: 99 })).toThrow(/unowned/u)
    expect(() => call(DESKTOP_IPC.scheduleSet, { id: 99 }, {})).toThrow(/unowned/u)
  })

  it('saves what the window sends, and opens one window at a time', () => {
    const { service, call } = start()
    service.open()
    service.open()
    expect(electron.windows).toHaveLength(1)
    const sender = electron.windows[0]?.webContents
    expect(call(DESKTOP_IPC.scheduleSet, sender, form)).toEqual({ ok: true })
    expect(call(DESKTOP_IPC.scheduleGet, sender)).toEqual(form)
    expect(call(DESKTOP_IPC.scheduleSet, sender, { ...form, workEnd: '08:00' })).toMatchObject({ ok: false })
  })

  it('removes its handlers and closes the window when stopped', () => {
    const { service } = start()
    service.open()
    service.stop()
    expect(electron.windows[0]?.closed).toBe(true)
    expect(electron.handlers.size).toBe(0)
  })
})

describe('the settings page', () => {
  async function mount(get: () => Promise<unknown>, set = vi.fn(async (_form: unknown) => ({ ok: true, message: '' }))) {
    const dom = new JSDOM(readFileSync(new URL('../renderer/schedule.html', import.meta.url), 'utf8'), {
      runScripts: 'outside-only',
      url: 'dsh-app://shell/schedule.html',
    })
    Object.defineProperty(dom.window, 'close', { value: vi.fn() })
    Object.defineProperty(dom.window, 'dshDesktop', { value: { schedule: { get, set } } })
    runInContext(readFileSync(new URL('../renderer/schedule.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    return { document: dom.window.document, set }
  }
  const input = (document: Document, id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!

  it('fills the form from the saved hours and sends the edited values on save', async () => {
    const { document, set } = await mount(async () => ({ showClock: true, workStart: '09:00', lunchStart: '12:00', afternoonStart: '', workEnd: '' }))
    await expect.poll(() => input(document, 'workStart').value).toBe('09:00')
    input(document, 'afternoonStart').value = '13:30'
    input(document, 'workEnd').value = '18:30'
    input(document, 'showClock').checked = false
    document.querySelector<HTMLButtonElement>('#save')!.click()
    await expect.poll(() => set.mock.calls.length).toBe(1)
    expect(set).toHaveBeenCalledWith({ ...form, showClock: false })
    await expect.poll(() => document.querySelector('#status')?.textContent).toContain('已保存')
  })

  it('shows the reason when the main process refuses, and lets the user try again', async () => {
    const { document } = await mount(
      async () => ({ showClock: true, workStart: '', lunchStart: '', afternoonStart: '', workEnd: '' }),
      vi.fn(async () => ({ ok: false, message: '四个时间要么都填，要么都留空' })),
    )
    await expect.poll(() => input(document, 'workStart').value).toBe('')
    document.querySelector<HTMLButtonElement>('#save')!.click()
    await expect.poll(() => document.querySelector('#status')?.textContent).toContain('要么都填')
    expect(document.querySelector<HTMLButtonElement>('#save')!.disabled).toBe(false)
  })
})
