/** The window where the user edits and confirms a daily report draft before it is written to the work log. */

import { BrowserWindow, screen } from 'electron'
import { excludeFromComputerUseCapture } from './capture-exclusion.ts'
import { presentOverlayWindow } from './floating-window.ts'

/** Window size in DIPs. */
export const REPORT_WINDOW_SIZE = { width: 480, height: 560 } as const

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where the window opens: centered in a display work area.
 * @param workArea - display work area.
 * @returns the window bounds.
 */
export function reportWindowBounds(workArea: Rect): Rect {
  return {
    x: Math.round(workArea.x + (workArea.width - REPORT_WINDOW_SIZE.width) / 2),
    y: Math.round(workArea.y + (workArea.height - REPORT_WINDOW_SIZE.height) / 2),
    ...REPORT_WINDOW_SIZE,
  }
}

/**
 * Open the confirmation window and give it keyboard focus, since the user has to edit in it.
 * @param options.shellOrigin - custom-protocol origin serving the renderer folder.
 * @param options.preload - preload script exposing the report calls.
 * @param options.near - bounds of the floating ball, used to pick the display.
 * @returns the window.
 */
export function showReportWindow(options: {
  readonly shellOrigin: string
  readonly preload: string
  readonly near: Rect | undefined
}): BrowserWindow {
  const display = screen.getDisplayNearestPoint(
    options.near === undefined
      ? screen.getCursorScreenPoint()
      : { x: options.near.x + options.near.width / 2, y: options.near.y + options.near.height / 2 },
  )
  const window = new BrowserWindow({
    ...reportWindowBounds(display.workArea),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
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
  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })
  void window.loadURL(new URL('report.html', `${options.shellOrigin}/`).toString())
  return window
}
