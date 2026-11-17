/**
 * The ball's date, time, and work progress, and the menu that unfolds beside it. The progress is drawn by the ball
 * itself as a ring and digits (see `onProgress`). While the pointer is over the ball, a small window opens next to it
 * with the time and a column of shortcuts that slide out one after another, in the manner of a game's radial menu;
 * it closes a moment after the pointer leaves both the ball and the menu.
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import { excludeFromComputerUseCapture } from './capture-exclusion.ts'
import { presentOverlayWindow } from './floating-window.ts'
import { clockState, readScheduleConfig, SCHEDULE_CONFIG_FILE, type ScheduleConfig, type WorkProgress } from './work-schedule.ts'

/** Menu window size in DIPs. */
export const MENU_WINDOW_SIZE = { width: 216, height: 304 } as const

/** What the menu's items do; the page sends one of these names and the main process runs it. */
export const MENU_ACTIONS = ['backfill', 'weekly', 'worklog', 'hours'] as const

export type MenuAction = typeof MENU_ACTIONS[number]

/** The collapsed ball window is 96 DIPs square; anything clearly larger is the open conversation panel. */
export const COLLAPSED_BALL_MAX = 120

/** The ball is drawn this far inside its window, so the menu may start inside that margin. */
const BALL_INSET = 12

/** The drawn ball's radius, and how far past it the pointer still counts as being over the ball. */
const BALL_RADIUS = 36
const HOVER_SLACK = 6

/** The menu stays this long after the pointer leaves, so a small slip does not make it flicker. */
const HOVER_GRACE_MS = 450

/** How often the pointer is checked against the ball and the menu. */
const HOVER_CHECK_MS = 120

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Which side of the ball the menu opens on. */
export type MenuSide = 'left' | 'right'

/**
 * Where the menu sits: beside the ball on the side with more room, centered on the ball's height.
 * @param ball - bounds of the ball window.
 * @param workArea - work area of the display holding the ball.
 * @returns the menu window bounds, kept inside the work area, and the side it opens on.
 */
export function menuBounds(ball: Rect, workArea: Rect): { bounds: Rect; side: MenuSide } {
  const { width, height } = MENU_WINDOW_SIZE
  const ballRight = ball.x + ball.width - BALL_INSET
  const ballLeft = ball.x + BALL_INSET
  const side: MenuSide = ballRight + width <= workArea.x + workArea.width ? 'right' : 'left'
  const x = side === 'right' ? ballRight : ballLeft - width
  const centered = Math.round(ball.y + ball.height / 2 - height / 2)
  const y = Math.max(workArea.y, Math.min(centered, workArea.y + workArea.height - height))
  return { bounds: { x, y, width, height }, side }
}

/**
 * Whether the pointer is over the drawn ball.
 * @param ball - bounds of the ball window.
 * @param point - the pointer in screen coordinates.
 * @returns true within the ball's circle, plus a small margin.
 */
export function pointerOverBall(ball: Rect, point: { readonly x: number; readonly y: number }): boolean {
  const dx = point.x - (ball.x + ball.width / 2)
  const dy = point.y - (ball.y + ball.height / 2)
  return Math.hypot(dx, dy) <= BALL_RADIUS + HOVER_SLACK
}

/**
 * Whether a point lies inside a rectangle.
 * @param rect - the rectangle.
 * @param point - the point.
 * @returns true when the point is within it, edges included.
 */
export function pointInRect(rect: Rect, point: { readonly x: number; readonly y: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

/** Handle returned by {@link startClockService}. */
export interface ClockService {
  /** Check the pointer and move the menu to follow the ball now. */
  follow(): void
  stop(): void
}

/**
 * Start the clock and the hover menu.
 * @param options.profileDir - Desktop profile directory holding the working-hours file.
 * @param options.shellOrigin - custom-protocol origin serving the renderer folder.
 * @param options.preload - preload script that lets the page receive the state and send a choice.
 * @param options.ballBounds - current ball window bounds; undefined when it is gone.
 * @param options.ballVisible - whether the ball window is on screen.
 * @param options.onAction - runs when the user picks a menu item.
 * @param options.log - sink for config problems.
 * @param options.onProgress - receives today's work progress each second for the ball to draw; null when there is none.
 * @param options.pointer - the pointer in screen coordinates; defaults to the system's.
 * @returns the running service.
 */
export function startClockService(options: {
  readonly profileDir: string
  readonly shellOrigin: string
  readonly preload: string
  readonly ballBounds: () => Rect | undefined
  readonly ballVisible: () => boolean
  readonly onAction: (action: MenuAction) => void
  readonly log?: (message: string) => void
  readonly onProgress?: (progress: WorkProgress | null) => void
  readonly pointer?: () => { readonly x: number; readonly y: number }
}): ClockService {
  const log = options.log ?? ((message: string): void => { console.warn(message) })
  const configPath = join(options.profileDir, SCHEDULE_CONFIG_FILE)
  let config: ScheduleConfig | undefined
  let configStamp = -1
  let window: BrowserWindow | undefined
  let loaded = false
  let side: MenuSide = 'right'
  let hoveredAt = -Infinity
  const pointer = options.pointer ?? ((): { x: number; y: number } => screen.getCursorScreenPoint())

  // Only the menu window that is open may choose an item.
  ipcMain.handle(DESKTOP_IPC.menuAction, (event, action: unknown): void => {
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents) {
      throw new Error('dsh desktop: rejected menu IPC from an unowned renderer')
    }
    const known = MENU_ACTIONS.find(candidate => candidate === action)
    if (known === undefined) throw new Error('dsh desktop: unknown menu action')
    // The menu closes at once; the pointer is no longer over the ball or the menu.
    hoveredAt = -Infinity
    window.hide()
    options.onAction(known)
  })

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
    excludeFromComputerUseCapture(created)
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.webContents.once('did-finish-load', () => { loaded = true })
    void created.loadURL(new URL('menu.html', `${options.shellOrigin}/`).toString())
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
    const moment = Date.now()
    const point = pointer()
    const workArea = screen.getDisplayNearestPoint({ x: ball.x + ball.width / 2, y: ball.y + ball.height / 2 }).workArea
    const placed = menuBounds(ball, workArea)
    // The window is made hidden ahead of time so it is loaded by the first hover.
    const target = ensureWindow(placed.bounds)
    const open = target.isVisible()
    // While the menu is open the pointer may rest on it as well as on the ball.
    if (pointerOverBall(ball, point) || (open && pointInRect(target.getBounds(), point))) hoveredAt = moment
    if (!open) {
      const now = target.getBounds()
      const { bounds } = placed
      if (now.x !== bounds.x || now.y !== bounds.y || now.width !== bounds.width || now.height !== bounds.height) target.setBounds(bounds)
    }
    if (moment - hoveredAt > HOVER_GRACE_MS) {
      hide()
    } else if (loaded && !open) {
      side = placed.side
      target.webContents.send(DESKTOP_IPC.clockState, { ...clockState(config, new Date()), side })
      target.showInactive()
    }
  }

  function tick(): void {
    reloadConfig()
    follow()
    if (config === undefined) return
    const state = clockState(config, new Date())
    options.onProgress?.(config.showClock ? state.progress ?? null : null)
    if (window === undefined || window.isDestroyed() || !loaded) return
    window.webContents.send(DESKTOP_IPC.clockState, { ...state, side })
  }

  const timer = setInterval(tick, 1000)
  const hoverTimer = setInterval(follow, HOVER_CHECK_MS)
  tick()
  return {
    follow,
    stop: () => {
      clearInterval(timer)
      clearInterval(hoverTimer)
      ipcMain.removeHandler(DESKTOP_IPC.menuAction)
      if (window !== undefined && !window.isDestroyed()) window.close()
    },
  }
}
