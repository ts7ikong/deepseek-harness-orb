/** The window that shows the work log (what daily reports were confirmed into), opened from the ball's right-click menu. */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen, shell } from 'electron'
import type { ActivityConfig } from './activity-log.ts'
import { presentOverlayWindow } from './floating-window.ts'
import { DESKTOP_IPC } from './ipc.ts'
import { WEEKLY_REPORTS_DIR } from './report-service.ts'
import { readWorkLogRecent, resolveWorkLogFile, type WorkLogViewDay } from './work-log.ts'

/** Window size in DIPs. */
export const WORKLOG_WINDOW_SIZE = { width: 460, height: 560 } as const

/** How many days with entries the window lists. */
export const WORKLOG_VIEW_DAYS = 30

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** What the window shows. */
export interface WorkLogView {
  readonly file: string
  readonly days: readonly WorkLogViewDay[]
}

/** Handle returned by {@link startWorkLogService}. */
export interface WorkLogService {
  /** Open the window, or bring the open one forward. */
  open(): void
  stop(): void
}

/**
 * Start the work-log viewer.
 * @param options.profileDir - Desktop profile directory, home of the default log and the weekly reports.
 * @param options.settings - the current activity settings, which name the work log file.
 * @param options.shellOrigin - custom-protocol origin serving the renderer folder.
 * @param options.preload - preload script exposing the viewer calls.
 * @param options.ballBounds - ball window bounds, to open on the same display.
 * @param options.openPath - opens a file or folder in the system's program for it; defaults to Electron's.
 * @returns the running service.
 */
export function startWorkLogService(options: {
  readonly profileDir: string
  readonly settings: () => ActivityConfig | undefined
  readonly shellOrigin: string
  readonly preload: string
  readonly ballBounds: () => Rect | undefined
  readonly openPath?: (path: string) => Promise<string>
}): WorkLogService {
  const openPath = options.openPath ?? ((path: string) => shell.openPath(path))
  let window: BrowserWindow | undefined
  const logFile = (): string => resolveWorkLogFile(options.settings()?.workLogFile ?? '', options.profileDir)
  const owned = (sender: unknown): boolean => window !== undefined && !window.isDestroyed() && sender === window.webContents

  ipcMain.handle(DESKTOP_IPC.worklogGet, (event): WorkLogView => {
    if (!owned(event.sender)) throw new Error('dsh desktop: rejected work log IPC from an unowned renderer')
    const file = logFile()
    return { file, days: readWorkLogRecent(file, WORKLOG_VIEW_DAYS) }
  })

  ipcMain.handle(DESKTOP_IPC.worklogOpen, async (event, what: unknown): Promise<string> => {
    if (!owned(event.sender)) throw new Error('dsh desktop: rejected work log IPC from an unowned renderer')
    if (what !== 'log' && what !== 'weekly') throw new Error('dsh desktop: work log open requires "log" or "weekly"')
    if (what === 'log') return openPath(logFile())
    const dir = join(options.profileDir, WEEKLY_REPORTS_DIR)
    mkdirSync(dir, { recursive: true })
    return openPath(dir)
  })

  return {
    open: () => {
      if (window !== undefined && !window.isDestroyed()) {
        window.show()
        window.focus()
        return
      }
      const ball = options.ballBounds()
      const area = screen.getDisplayNearestPoint(
        ball === undefined
          ? screen.getCursorScreenPoint()
          : { x: ball.x + ball.width / 2, y: ball.y + ball.height / 2 },
      ).workArea
      const created = new BrowserWindow({
        x: Math.round(area.x + (area.width - WORKLOG_WINDOW_SIZE.width) / 2),
        y: Math.round(area.y + (area.height - WORKLOG_WINDOW_SIZE.height) / 2),
        ...WORKLOG_WINDOW_SIZE,
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
      presentOverlayWindow(created)
      if (process.platform === 'win32') created.setContentProtection(true)
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      created.once('ready-to-show', () => {
        created.show()
        created.focus()
      })
      created.once('closed', () => {
        if (window === created) window = undefined
      })
      window = created
      void created.loadURL(new URL('worklog.html', `${options.shellOrigin}/`).toString())
    },
    stop: () => {
      ipcMain.removeHandler(DESKTOP_IPC.worklogGet)
      ipcMain.removeHandler(DESKTOP_IPC.worklogOpen)
      if (window !== undefined && !window.isDestroyed()) window.close()
    },
  }
}
