/**
 * Windows of the ball's personal-assistant features (island, menu, bubble, reminder, report, work-log, catch-up, and
 * working-hours windows) that Computer Use must not see. On Windows the exclusion is `setContentProtection`, which every
 * screen capture honours, including the user's own screenshots and screen sharing, and which turns a transparent
 * window into an opaque black rectangle there. It is therefore held only while Computer Use captures or acts, the same
 * interval the ball itself is guarded for; outside it these windows appear in screenshots as drawn.
 */

import type { BrowserWindow } from 'electron'

/** One window's capture-exclusion control. */
type CaptureExcludedWindow = Pick<BrowserWindow, 'isDestroyed' | 'setContentProtection'>

const registered = new Set<CaptureExcludedWindow>()
let openIntervals = 0

function excluded(): boolean {
  return process.platform === 'win32' && openIntervals > 0
}

function sync(): void {
  const value = excluded()
  for (const window of registered) {
    if (window.isDestroyed()) registered.delete(window)
    else window.setContentProtection(value)
  }
}

/**
 * Register a window to be hidden from Computer Use captures. A window created during a capture is hidden at once.
 * @param window - an assistant window; destroyed windows are dropped on the next change.
 */
export function excludeFromComputerUseCapture(window: CaptureExcludedWindow): void {
  registered.add(window)
  if (excluded()) window.setContentProtection(true)
}

/**
 * Open or close one Computer Use capture or input interval. Overlapping intervals are counted, so the windows stay
 * hidden until the last one closes.
 * @param action - `begin` opens an interval, `end` closes one.
 */
export function setComputerUseCapture(action: 'begin' | 'end'): void {
  openIntervals = action === 'begin' ? openIntervals + 1 : Math.max(0, openIntervals - 1)
  sync()
}

/** Close every interval, so a Host exit that lost its `end` cannot leave the windows hidden from screenshots. */
export function resetComputerUseCapture(): void {
  openIntervals = 0
  sync()
}
