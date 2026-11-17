/** The speech bubble beside the ball where a proactive line appears; a click anywhere on it dismisses it. */

import { BrowserWindow, screen } from 'electron'
import { excludeFromComputerUseCapture } from './capture-exclusion.ts'
import { presentOverlayWindow } from './floating-window.ts'

/** Window size in DIPs. */
export const BUBBLE_WINDOW_SIZE = { width: 270, height: 104 } as const

/** A bubble goes away by itself after this long. */
export const BUBBLE_DISMISS_MS = 15_000

/** The ball is drawn this far inside its window. */
const BALL_INSET = 12

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where the bubble sits: centered above the ball, or below it when there is no room above.
 * @param ball - bounds of the ball window.
 * @param workArea - work area of the display holding the ball.
 * @returns the bubble window bounds, kept inside the work area horizontally.
 */
export function bubbleBounds(ball: Rect, workArea: Rect): Rect {
  const { width, height } = BUBBLE_WINDOW_SIZE
  const centered = Math.round(ball.x + ball.width / 2 - width / 2)
  const x = Math.max(workArea.x, Math.min(centered, workArea.x + workArea.width - width))
  const above = ball.y + BALL_INSET - height
  const y = above >= workArea.y ? above : ball.y + ball.height - BALL_INSET
  return { x, y, width, height }
}

/** Page address for a line of text. */
export function bubblePageUrl(shellOrigin: string, text: string): string {
  const url = new URL('bubble.html', `${shellOrigin}/`)
  url.searchParams.set('text', text)
  return url.toString()
}

/**
 * Show one bubble.
 * @param text - the line to show.
 * @param options.shellOrigin - custom-protocol origin serving the renderer folder.
 * @param options.preload - preload script given to the page.
 * @param options.ball - bounds of the ball window.
 * @returns the window, which closes itself after {@link BUBBLE_DISMISS_MS}.
 */
export function showBubble(text: string, options: {
  readonly shellOrigin: string
  readonly preload: string
  readonly ball: Rect
}): BrowserWindow {
  const { ball } = options
  const workArea = screen.getDisplayNearestPoint({ x: ball.x + ball.width / 2, y: ball.y + ball.height / 2 }).workArea
  const window = new BrowserWindow({
    ...bubbleBounds(options.ball, workArea),
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
  const timer = setTimeout(() => { if (!window.isDestroyed()) window.close() }, BUBBLE_DISMISS_MS)
  window.once('closed', () => { clearTimeout(timer) })
  window.once('ready-to-show', () => { window.showInactive() })
  void window.loadURL(bubblePageUrl(options.shellOrigin, text))
  return window
}
