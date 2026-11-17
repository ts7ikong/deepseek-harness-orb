/** The small window where the user sets their working hours, opened from the ball's right-click menu. */

import { BrowserWindow, ipcMain, screen } from 'electron'
import { excludeFromComputerUseCapture } from './capture-exclusion.ts'
import { presentOverlayWindow } from './floating-window.ts'
import { DESKTOP_IPC } from './ipc.ts'
import { readScheduleForm, saveScheduleForm, type ScheduleForm, type ScheduleSaveResult } from './work-schedule.ts'

/** Window size in DIPs. */
export const SCHEDULE_WINDOW_SIZE = { width: 380, height: 490 } as const

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Handle returned by {@link startScheduleService}. */
export interface ScheduleService {
  /** Open the window, or bring the open one forward. */
  open(): void
  stop(): void
}

/**
 * Start the working-hours settings service.
 * @param options.profileDir - Desktop profile directory holding `orb-schedule.json`.
 * @param options.shellOrigin - custom-protocol origin serving the renderer folder.
 * @param options.preload - preload script exposing the schedule calls.
 * @param options.ballBounds - ball window bounds, to open on the same display.
 * @returns the running service.
 */
export function startScheduleService(options: {
  readonly profileDir: string
  readonly shellOrigin: string
  readonly preload: string
  readonly ballBounds: () => Rect | undefined
}): ScheduleService {
  let window: BrowserWindow | undefined

  // Only the settings window that is open may read or change the hours.
  const owned = (sender: unknown): boolean => window !== undefined && !window.isDestroyed() && sender === window.webContents

  ipcMain.handle(DESKTOP_IPC.scheduleGet, (event): ScheduleForm => {
    if (!owned(event.sender)) throw new Error('dsh desktop: rejected schedule IPC from an unowned renderer')
    return readScheduleForm(options.profileDir)
  })
  ipcMain.handle(DESKTOP_IPC.scheduleSet, (event, form: unknown): ScheduleSaveResult => {
    if (!owned(event.sender)) throw new Error('dsh desktop: rejected schedule IPC from an unowned renderer')
    return saveScheduleForm(options.profileDir, form)
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
        x: Math.round(area.x + (area.width - SCHEDULE_WINDOW_SIZE.width) / 2),
        y: Math.round(area.y + (area.height - SCHEDULE_WINDOW_SIZE.height) / 2),
        ...SCHEDULE_WINDOW_SIZE,
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
      excludeFromComputerUseCapture(created)
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      created.once('ready-to-show', () => {
        created.show()
        created.focus()
      })
      created.once('closed', () => {
        if (window === created) window = undefined
      })
      window = created
      void created.loadURL(new URL('schedule.html', `${options.shellOrigin}/`).toString())
    },
    stop: () => {
      ipcMain.removeHandler(DESKTOP_IPC.scheduleGet)
      ipcMain.removeHandler(DESKTOP_IPC.scheduleSet)
      if (window !== undefined && !window.isDestroyed()) window.close()
    },
  }
}
