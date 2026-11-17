/** The reminder pop-up: a transparent always-on-top window that flies from the ball to the screen center. */

import { BrowserWindow, screen } from 'electron'
import { excludeFromComputerUseCapture } from './capture-exclusion.ts'
import { presentOverlayWindow } from './floating-window.ts'
import type { ReminderEntry } from './reminders.ts'

/** Reminder window size in DIPs; it holds the large orb and the message card. */
export const REMINDER_WINDOW_SIZE = { width: 360, height: 290 } as const

/** Extra height for the action button when a reminder has one. */
export const REMINDER_ACTION_EXTRA_HEIGHT = 52

/**
 * Window size for one reminder.
 * @param entry - the reminder.
 * @returns the base size, taller when the reminder carries an action button.
 */
export function reminderWindowSize(entry: ReminderEntry): { readonly width: number; readonly height: number } {
  return entry.action === undefined
    ? REMINDER_WINDOW_SIZE
    : { width: REMINDER_WINDOW_SIZE.width, height: REMINDER_WINDOW_SIZE.height + REMINDER_ACTION_EXTRA_HEIGHT }
}

/** Duration of the flight from the ball to the middle of the screen. */
export const REMINDER_FLIGHT_MS = 650

/** A plain reminder nobody clicked closes itself after this long. */
export const REMINDER_AUTO_DISMISS_MS = 5 * 60_000

/** One with a button waits longer, so stepping away from the desk does not make the user miss it. */
export const REMINDER_ACTION_DISMISS_MS = 30 * 60_000

/**
 * How long a reminder stays when nobody clicks it.
 * @param entry - the reminder.
 * @returns milliseconds.
 */
export function reminderDismissMs(entry: ReminderEntry): number {
  return entry.action === undefined ? REMINDER_AUTO_DISMISS_MS : REMINDER_ACTION_DISMISS_MS
}

const REMINDER_FADE_IN_MS = 240
const FRAME_MS = 16

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where the reminder rests: centered in a display work area.
 * @param workArea - display work area.
 * @param size - the window size.
 * @returns the window bounds.
 */
export function reminderRestBounds(
  workArea: Rect,
  size: { readonly width: number; readonly height: number } = REMINDER_WINDOW_SIZE,
): Rect {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
    width: size.width,
    height: size.height,
  }
}

/**
 * Where the reminder starts: centered on the ball, so it appears to leave it.
 * @param ball - the floating ball window bounds, when there is one.
 * @param rest - the resting bounds, used when there is no ball to fly from; also fixes the window size.
 * @returns the window bounds at the start of the flight.
 */
export function reminderStartBounds(ball: Rect | undefined, rest: Rect): Rect {
  if (ball === undefined) return rest
  return {
    x: Math.round(ball.x + ball.width / 2 - rest.width / 2),
    y: Math.round(ball.y + ball.height / 2 - rest.height / 2),
    width: rest.width,
    height: rest.height,
  }
}

/**
 * Page URL for one reminder. The text travels in the query string and is only ever shown as text.
 * @param shellOrigin - custom-protocol origin serving the renderer folder, such as `dsh-app://shell`.
 * @param entry - the reminder to show.
 * @param hint - small dismiss hint under the message.
 * @returns the `reminder.html` URL; an action button appears only when the entry has an action.
 */
export function reminderPageUrl(shellOrigin: string, entry: ReminderEntry, hint: string): string {
  const url = new URL('reminder.html', `${shellOrigin}/`)
  url.searchParams.set('mood', entry.mood)
  url.searchParams.set('title', entry.title)
  url.searchParams.set('message', entry.message)
  url.searchParams.set('hint', hint)
  if (entry.action !== undefined) url.searchParams.set('actionLabel', entry.actionLabel ?? '')
  return url.toString()
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

function fly(window: BrowserWindow, from: Rect, to: Rect): void {
  const startedAt = Date.now()
  const step = (): void => {
    if (window.isDestroyed()) return
    const t = Math.min(1, (Date.now() - startedAt) / REMINDER_FLIGHT_MS)
    const eased = easeOutCubic(t)
    window.setBounds({
      x: Math.round(from.x + (to.x - from.x) * eased),
      y: Math.round(from.y + (to.y - from.y) * eased),
      width: to.width,
      height: to.height,
    })
    window.setOpacity(Math.min(1, (Date.now() - startedAt) / REMINDER_FADE_IN_MS))
    if (t < 1) setTimeout(step, FRAME_MS)
  }
  step()
}

/**
 * Show one reminder.
 * The window never takes keyboard focus, so a reminder cannot swallow what the user is typing.
 * @param entry - the reminder to show.
 * @param options.shellOrigin - custom-protocol origin serving the renderer folder.
 * @param options.hint - small dismiss hint under the message.
 * @param options.ball - bounds of the floating ball window to fly out of.
 * @param options.preload - preload script that gives the page its single "run the action" call.
 * @returns the window, and a promise that resolves once the pop-up is gone.
 */
export function showReminder(
  entry: ReminderEntry,
  options: {
    readonly shellOrigin: string
    readonly hint: string
    readonly ball: Rect | undefined
    readonly preload: string
  },
): { window: BrowserWindow; closed: Promise<void> } {
  const rest = reminderRestBounds(
    screen.getDisplayNearestPoint(
      options.ball === undefined
        ? screen.getCursorScreenPoint()
        : { x: options.ball.x + options.ball.width / 2, y: options.ball.y + options.ball.height / 2 },
    ).workArea,
    reminderWindowSize(entry),
  )
  const start = reminderStartBounds(options.ball, rest)
  const window = new BrowserWindow({
    ...start,
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
  presentOverlayWindow(window)
  excludeFromComputerUseCapture(window)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const closed = new Promise<void>((resolve) => {
    const dismissTimer = setTimeout(() => {
      if (!window.isDestroyed()) window.close()
    }, reminderDismissMs(entry))
    window.once('closed', () => {
      clearTimeout(dismissTimer)
      resolve()
    })
    window.once('ready-to-show', () => {
      window.setOpacity(0)
      window.showInactive()
      fly(window, start, rest)
    })
    void window.loadURL(reminderPageUrl(options.shellOrigin, entry, options.hint))
  })
  return { window, closed }
}
