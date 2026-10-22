/** Streams the pointer position to the floating ball so its face can look at it anywhere on screen. */

import { screen, type BrowserWindow } from 'electron'

/** How often the pointer is sampled. */
export const CURSOR_FEED_MS = 50

/**
 * Send the pointer position (screen DIPs) to a window whenever it changes.
 * Nothing is sent while the window is hidden, and the feed ends by itself when the window is destroyed.
 * @param window - the floating ball window.
 * @param channel - IPC channel the window listens on.
 * @returns a handle that stops the feed.
 */
export function startCursorFeed(window: BrowserWindow, channel: string): { stop(): void } {
  let last = { x: Number.NaN, y: Number.NaN }
  const timer = setInterval(() => {
    if (window.isDestroyed()) {
      clearInterval(timer)
      return
    }
    if (!window.isVisible()) return
    const point = screen.getCursorScreenPoint()
    if (point.x === last.x && point.y === last.y) return
    last = point
    window.webContents.send(channel, point)
  }, CURSOR_FEED_MS)
  return { stop: () => { clearInterval(timer) } }
}
