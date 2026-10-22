/** A small click-through window under the floating ball showing the date, the time, and today's work progress. */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import { presentOverlayWindow } from './floating-window.ts'
import { clockState, readScheduleConfig, SCHEDULE_CONFIG_FILE, type ScheduleConfig } from './work-schedule.ts'

/** Window size in DIPs. */
export const CLOCK_WINDOW_SIZE = { width: 196, height: 100 } as const

/** The collapsed ball window is 96 DIPs square; anything clearly larger is the open conversation panel. */
export const COLLAPSED_BALL_MAX = 120

/** The ball is drawn this far inside its window, so the clock may overlap that margin. */
const BALL_INSET = 12

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where the clock sits: centered under the ball, or above it when there is no room below.
 * @param ball - bounds of the ball window.
 * @param workArea - work area of the display holding the ball.
 * @returns the clock window bounds, kept inside the work area horizontally.
 */
export function clockBounds(ball: Rect, workArea: Rect): Rect {
  const { width, height } = CLOCK_WINDOW_SIZE
  const centered = Math.round(ball.x + ball.width / 2 - width / 2)
  const x = Math.max(workArea.x, Math.min(centered, workArea.x + workArea.width - width))
  const below = ball.y + ball.height - BALL_INSET
  const y = below + height <= workArea.y + workArea.height ? below : ball.y + BALL_INSET - height
  return { x, y: Math.max(workArea.y, y), width, height }
}

/** Handle returned by {@link startClockService}. */
export interface ClockService {
  /** Move the clock to follow the ball now. */
  follow(): void
  stop(): void
}

/**
 * Start the clock beside the ball.
 * @param options.profileDir - Desktop profile directory holding the working-hours file.
 * @param options.shellOrigin - custom-protocol origin serving the renderer folder.
 * @param options.preload - preload script that lets the page receive the state.
 * @param options.ballBounds - current ball window bounds; undefined when it is gone.
 * @param options.ballVisible - whether the ball window is on screen.
 * @param options.log - sink for config problems.
 * @returns the running service.
 */
export function startClockService(options: {
  readonly profileDir: string
  readonly shellOrigin: string
  readonly preload: string
  readonly ballBounds: () => Rect | undefined
  readonly ballVisible: () => boolean
  readonly log?: (message: string) => void
}): ClockService {
  const log = options.log ?? ((message: string): void => { console.warn(message) })
  const configPath = join(options.profileDir, SCHEDULE_CONFIG_FILE)
  let config: ScheduleConfig | undefined
  let configStamp = -1
  let window: BrowserWindow | undefined
  let loaded = false

  function reloadConfig(): void {
    let stamp = -1
    try {
      stamp = statSync(configPath).mtimeMs
    } catch {
      // A missing file is written by the read below.
    }
    if (stamp === configStamp && config !== undefined) return
    const result = readScheduleConfig(options.profileDir)
    try {
      configStamp = statSync(configPath).mtimeMs
    } catch {
      configStamp = -1
    }
    for (const problem of result.problems) log(`dsh desktop: ${SCHEDULE_CONFIG_FILE}: ${problem}`)
    // An unreadable edit keeps the last good hours rather than blanking the clock.
    if (result.config !== undefined) config = result.config
  }

  function ensureWindow(bounds: Rect): BrowserWindow {
    if (window !== undefined && !window.isDestroyed()) return window
    loaded = false
    const created = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      ...process.platform === 'win32' ? {} : { type: 'panel' as const },
      show: false,
      hasShadow: false,
      resizable: false,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      roundedCorners: false,
      webPreferences: {
        preload: options.preload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    presentOverlayWindow(created)
    // The clock only decorates the ball; it never takes a click and stays out of Computer Use screenshots.
    created.setIgnoreMouseEvents(true)
    if (process.platform === 'win32') created.setContentProtection(true)
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.webContents.once('did-finish-load', () => { loaded = true })
    void created.loadURL(new URL('clock.html', `${options.shellOrigin}/`).toString())
    window = created
    return created
  }

  function hide(): void {
    if (window !== undefined && !window.isDestroyed() && window.isVisible()) window.hide()
  }

  function follow(): void {
    const ball = options.ballBounds()
    if (config?.showClock !== true || ball === undefined || !options.ballVisible() || ball.width > COLLAPSED_BALL_MAX) {
      hide()
      return
    }
    const workArea = screen.getDisplayNearestPoint({ x: ball.x + ball.width / 2, y: ball.y + ball.height / 2 }).workArea
    const bounds = clockBounds(ball, workArea)
    const target = ensureWindow(bounds)
    const now = target.getBounds()
    if (now.x !== bounds.x || now.y !== bounds.y || now.width !== bounds.width || now.height !== bounds.height) target.setBounds(bounds)
    if (loaded && !target.isVisible()) target.showInactive()
  }

  function tick(): void {
    reloadConfig()
    follow()
    if (config === undefined || window === undefined || window.isDestroyed() || !loaded) return
    window.webContents.send(DESKTOP_IPC.clockState, clockState(config, new Date()))
  }

  const timer = setInterval(tick, 1000)
  tick()
  return {
    follow,
    stop: () => {
      clearInterval(timer)
      if (window !== undefined && !window.isDestroyed()) window.close()
    },
  }
}
