/**
 * Catching up on a daily report that was never written: the user picks one of the last two weeks, and the same
 * pipeline as the evening report builds a draft from that day's activity record and screen descriptions.
 */

import { BrowserWindow, ipcMain, screen } from 'electron'
import { readActivityDay, summarizeDay, type ActivityConfig } from './activity-log.ts'
import { excludeFromComputerUseCapture } from './capture-exclusion.ts'
import { presentOverlayWindow } from './floating-window.ts'
import { DESKTOP_IPC } from './ipc.ts'
import { localDateKey } from './reminders.ts'
import { countWorkLogEntries, resolveWorkLogFile } from './work-log.ts'

/** Window size in DIPs. */
export const BACKFILL_WINDOW_SIZE = { width: 400, height: 500 } as const

/** How many days before today are offered. */
export const BACKFILL_DAYS = 14

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

/** One day the user may catch up on. */
export interface BackfillDay {
  /** `YYYY-MM-DD`. */
  readonly date: string
  /** `周二`. */
  readonly weekday: string
  /** Entries the work log already holds for the day. */
  readonly entries: number
  /** Minutes of computer use recorded that day; zero when nothing was recorded. */
  readonly activeMinutes: number
}

/** What the picker shows. */
export interface BackfillView {
  readonly days: readonly BackfillDay[]
  /** The day to preselect: the newest one with a record of activity but no log entries, else the newest day. */
  readonly defaultDate: string
}

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The days offered for catching up.
 * @param options.profileDir - Desktop profile directory, home of the activity record.
 * @param options.workLogFile - the work log path.
 * @param options.intervalSeconds - the recorder's sampling interval, which sets how long each sample counts for.
 * @param options.now - the current time.
 * @returns the last {@link BACKFILL_DAYS} days before today, newest first, with the default choice.
 */
export function backfillView(options: {
  readonly profileDir: string
  readonly workLogFile: string
  readonly intervalSeconds: number
  readonly now: Date
}): BackfillView {
  const days: BackfillDay[] = []
  for (let back = 1; back <= BACKFILL_DAYS; back += 1) {
    const day = new Date(options.now.getFullYear(), options.now.getMonth(), options.now.getDate() - back)
    const date = localDateKey(day)
    const activeMs = summarizeDay(readActivityDay(options.profileDir, date), options.intervalSeconds * 1000).activeMs
    days.push({
      date,
      weekday: `周${WEEKDAYS[day.getDay()] ?? ''}`,
      entries: countWorkLogEntries(options.workLogFile, date),
      activeMinutes: Math.round(activeMs / 60_000),
    })
  }
  const missing = days.find(day => day.entries === 0 && day.activeMinutes > 0)
  return { days, defaultDate: (missing ?? days[0])?.date ?? '' }
}

/** Handle returned by {@link startBackfillService}. */
export interface BackfillService {
  /** Open the picker, or bring the open one forward. */
  open(): void
  stop(): void
}

/**
 * Start the catch-up picker.
 * @param options.profileDir - Desktop profile directory.
 * @param options.settings - the current activity settings, which name the work log and the sampling interval.
 * @param options.shellOrigin - custom-protocol origin serving the renderer folder.
 * @param options.preload - preload script exposing the picker calls.
 * @param options.ballBounds - ball window bounds, to open on the same display.
 * @param options.onGenerate - asks for a draft for the chosen day (`YYYY-MM-DD`).
 * @returns the running service.
 */
export function startBackfillService(options: {
  readonly profileDir: string
  readonly settings: () => ActivityConfig | undefined
  readonly shellOrigin: string
  readonly preload: string
  readonly ballBounds: () => Rect | undefined
  readonly onGenerate: (date: string) => void
}): BackfillService {
  let window: BrowserWindow | undefined
  const owned = (sender: unknown): boolean => window !== undefined && !window.isDestroyed() && sender === window.webContents
  const view = (): BackfillView => backfillView({
    profileDir: options.profileDir,
    workLogFile: resolveWorkLogFile(options.settings()?.workLogFile ?? '', options.profileDir),
    intervalSeconds: options.settings()?.intervalSeconds ?? 30,
    now: new Date(),
  })

  ipcMain.handle(DESKTOP_IPC.backfillGet, (event): BackfillView => {
    if (!owned(event.sender)) throw new Error('dsh desktop: rejected backfill IPC from an unowned renderer')
    return view()
  })

  ipcMain.handle(DESKTOP_IPC.backfillGo, (event, date: unknown): void => {
    if (!owned(event.sender)) throw new Error('dsh desktop: rejected backfill IPC from an unowned renderer')
    // Only a day the picker offered may be asked for.
    if (typeof date !== 'string' || !view().days.some(day => day.date === date)) {
      throw new Error('dsh desktop: backfill requires one of the offered days')
    }
    options.onGenerate(date)
    window?.close()
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
        x: Math.round(area.x + (area.width - BACKFILL_WINDOW_SIZE.width) / 2),
        y: Math.round(area.y + (area.height - BACKFILL_WINDOW_SIZE.height) / 2),
        ...BACKFILL_WINDOW_SIZE,
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
      void created.loadURL(new URL('backfill.html', `${options.shellOrigin}/`).toString())
    },
    stop: () => {
      ipcMain.removeHandler(DESKTOP_IPC.backfillGet)
      ipcMain.removeHandler(DESKTOP_IPC.backfillGo)
      if (window !== undefined && !window.isDestroyed()) window.close()
    },
  }
}
