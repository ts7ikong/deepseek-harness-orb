import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown

interface FakeWindow {
  webContents: { id: number; send: ReturnType<typeof vi.fn>; once: (event: string, listener: () => void) => void }
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  closed: boolean
}

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  windows: [] as unknown[],
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
    webContents = {
      id: electron.windows.length + 1,
      send: vi.fn(),
      setWindowOpenHandler() {},
      once: (_event: string, listener: () => void) => { listener() },
    }
    visible = false
    closed = false
    bounds: { x: number; y: number; width: number; height: number }
    constructor(options: { x: number; y: number; width: number; height: number }) {
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      electron.windows.push(this)
    }
    isDestroyed() { return this.closed }
    isVisible() { return this.visible }
    getBounds() { return this.bounds }
    setBounds(bounds: { x: number; y: number; width: number; height: number }) { this.bounds = bounds }
    showInactive() { this.visible = true }
    hide() { this.visible = false }
    close() { this.closed = true }
    setContentProtection() {}
    loadURL() { return Promise.resolve() }
  },
}))
vi.mock('../src/floating-window.ts', () => ({ presentOverlayWindow: () => {} }))

import { DESKTOP_IPC } from '../src/ipc.ts'
import {
  menuBounds,
  MENU_ACTIONS,
  MENU_WINDOW_SIZE,
  pointInRect,
  startClockService,
} from '../src/clock-service.ts'

const roots: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 26, 10, 30, 0))
})

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  electron.handlers.clear()
  electron.windows.length = 0
})

describe('menuBounds', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  const { width, height } = MENU_WINDOW_SIZE

  it('opens on the right of the ball when there is room, centered on its height', () => {
    const { bounds, side } = menuBounds({ x: 800, y: 500, width: 96, height: 96 }, area)
    expect(side).toBe('right')
    expect(bounds).toEqual({ x: 800 + 96 - 12, y: 500 + 48 - height / 2, width, height })
  })

  it('opens on the left when the ball is near the right edge', () => {
    const { bounds, side } = menuBounds({ x: 1800, y: 500, width: 96, height: 96 }, area)
    expect(side).toBe('left')
    expect(bounds.x).toBe(1800 + 12 - width)
  })

  it('stays inside the display vertically', () => {
    expect(menuBounds({ x: 800, y: 0, width: 96, height: 96 }, area).bounds.y).toBe(0)
    expect(menuBounds({ x: 800, y: 1000, width: 96, height: 96 }, area).bounds.y).toBe(1040 - height)
  })

  it('knows whether a point is inside a rectangle', () => {
    const rect = { x: 10, y: 10, width: 20, height: 20 }
    expect(pointInRect(rect, { x: 10, y: 30 })).toBe(true)
    expect(pointInRect(rect, { x: 31, y: 15 })).toBe(false)
  })
})

describe('the hover menu', () => {
  function start() {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-menu-'))
    roots.push(profileDir)
    writeFileSync(join(profileDir, 'orb-schedule.json'), JSON.stringify({
      workStart: '09:00', lunchStart: '12:00', afternoonStart: '13:30', workEnd: '18:30',
    }))
    let pointer = { x: 5000, y: 5000 }
    const ball = { x: 800, y: 500, width: 96, height: 96 }
    const onAction = vi.fn()
    const onProgress = vi.fn()
    const service = startClockService({
      profileDir,
      shellOrigin: 'dsh-app://shell',
      preload: 'p.cjs',
      ballBounds: () => ball,
      ballVisible: () => true,
      onAction,
      onProgress,
      pointer: () => pointer,
      log: () => {},
    })
    const win = (): FakeWindow => electron.windows[0] as FakeWindow
    const call = (sender: unknown, action: unknown) => electron.handlers.get(DESKTOP_IPC.menuAction)!({ sender }, action)
    return { service, win, call, onAction, onProgress, move: (x: number, y: number) => { pointer = { x, y } } }
  }

  it('stays hidden until the pointer is on the ball, then opens with the time and the side', () => {
    const { service, win, move } = start()
    vi.advanceTimersByTime(1000)
    expect(win().visible).toBe(false)
    move(848, 548)
    vi.advanceTimersByTime(300)
    expect(win().visible).toBe(true)
    expect(win().bounds.x).toBe(800 + 96 - 12)
    const sent = win().webContents.send.mock.calls.at(-1) as [string, { time: string; side: string }]
    expect(sent[0]).toBe(DESKTOP_IPC.clockState)
    expect(sent[1]).toMatchObject({ time: expect.stringMatching(/^10:30:0[0-9]$/u), side: 'right' })
    service.stop()
  })

  it('stays open while the pointer is on the menu, and closes a moment after it leaves both', () => {
    const { service, win, move } = start()
    move(848, 548)
    vi.advanceTimersByTime(300)
    move(win().bounds.x + 40, win().bounds.y + 100)
    vi.advanceTimersByTime(2000)
    expect(win().visible).toBe(true)
    move(5000, 5000)
    vi.advanceTimersByTime(300)
    expect(win().visible).toBe(true)
    vi.advanceTimersByTime(800)
    expect(win().visible).toBe(false)
    service.stop()
  })

  it('runs only the actions it knows, from its own window only, and closes at once', () => {
    const { service, win, call, onAction, move } = start()
    move(848, 548)
    vi.advanceTimersByTime(300)
    const sender = win().webContents
    expect(() => call({ id: 99 }, 'backfill')).toThrow(/unowned/u)
    expect(() => call(sender, 'format-disk')).toThrow(/unknown/u)
    expect(() => call(sender, undefined)).toThrow(/unknown/u)
    expect(onAction).not.toHaveBeenCalled()
    for (const action of MENU_ACTIONS) {
      win().visible = true
      call(sender, action)
      expect(onAction).toHaveBeenLastCalledWith(action)
      expect(win().visible).toBe(false)
    }
    expect(onAction).toHaveBeenCalledTimes(MENU_ACTIONS.length)
    service.stop()
  })

  it('gives the ball its progress every second, and removes its handler when stopped', () => {
    const { service, onProgress } = start()
    vi.advanceTimersByTime(2000)
    expect(onProgress).toHaveBeenCalled()
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'morning' })
    service.stop()
    expect(electron.handlers.has(DESKTOP_IPC.menuAction)).toBe(false)
  })
})

describe('the menu page', () => {
  function mount() {
    const dom = new JSDOM(readFileSync(new URL('../renderer/menu.html', import.meta.url), 'utf8'), {
      runScripts: 'outside-only',
      url: 'dsh-app://shell/menu.html',
    })
    let push: (state: unknown) => void = () => {}
    const act = vi.fn(async (_action: string) => undefined)
    Object.defineProperty(dom.window, 'dshDesktop', {
      value: { clock: { act, onState: (listener: (state: unknown) => void) => { push = listener; return () => {} } } },
    })
    runInContext(readFileSync(new URL('../renderer/menu.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    const text = (selector: string) => dom.window.document.querySelector<HTMLElement>(selector)
    return { dom, act, push: (state: unknown) => { push(state) }, text }
  }

  it('stays hidden until the first state arrives, then shows the date and time', () => {
    const { push, text } = mount()
    expect(text('#menu')?.hidden).toBe(true)
    push({ date: '2026年10月26日 周一', time: '10:30:00', side: 'right' })
    expect(text('#menu')?.hidden).toBe(false)
    expect(text('#time')?.textContent).toBe('10:30:00')
    expect(text('#date')?.textContent).toBe('2026年10月26日 周一')
    expect(text('#left')?.textContent).toBe('')
  })

  it('lays out for the side the menu opens on', () => {
    const { push, text } = mount()
    push({ date: 'd', time: 't', side: 'left' })
    expect(text('#menu')?.dataset.side).toBe('left')
    push({ date: 'd', time: 't', side: 'right' })
    expect(text('#menu')?.dataset.side).toBe('right')
    push({ date: 'd', time: 't', side: 'sideways' })
    expect(text('#menu')?.dataset.side).toBe('right')
  })

  it('says how long is left, or that work is over', () => {
    const { push, text } = mount()
    push({ date: 'd', time: 't', progress: { phase: 'afternoon', percent: 70, workedMs: 0, remainingMs: 2.25 * 3_600_000 } })
    expect(text('#left')?.textContent).toBe('距离下班 2 小时 15 分钟')
    push({ date: 'd', time: 't', progress: { phase: 'after', percent: 100, workedMs: 0, remainingMs: 0 } })
    expect(text('#left')?.textContent).toBe('已下班')
    push({ date: 'd', time: 't', progress: { phase: 'rest', percent: 0, workedMs: 0, remainingMs: 0 } })
    expect(text('#left')?.textContent).toBe('今天休息')
  })

  it('has one button per action the main process knows, and sends the one that is clicked', () => {
    const { dom, act } = mount()
    const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.item')]
    expect(buttons.map(button => button.dataset.action)).toEqual([...MENU_ACTIONS])
    buttons[2]?.click()
    expect(act).toHaveBeenCalledWith('worklog')
  })

  it('ignores malformed state', () => {
    const { push, text } = mount()
    push(undefined)
    push({ time: 5 })
    expect(text('#menu')?.hidden).toBe(true)
  })
})
