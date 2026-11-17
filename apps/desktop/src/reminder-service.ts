/** Checks the reminder schedule on a timer and shows what is due, one pop-up at a time. */

import { appendFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain, shell, type BrowserWindow } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import { showReminder } from './reminder-window.ts'
import { readScheduleConfig } from './work-schedule.ts'
import {
  alignOffWork,
  dueReminders,
  nextReminder,
  markReminderFired,
  readReminderConfig,
  readReminderState,
  REMINDERS_CONFIG_FILE,
  writeReminderState,
  type ReminderConfig,
  type ReminderEntry,
  type UpcomingReminder,
} from './reminders.ts'

/** How often the schedule is checked; reminders therefore appear within this long of their time. */
export const REMINDER_CHECK_MS = 15_000

/** Profile-relative log of when each reminder fired and was dismissed, for finding out why one was missed. */
export const REMINDER_LOG_FILE = 'orb-reminders.log'

const DISMISS_HINT = '点击任意处关闭'

/** A reminder with a button: clicking elsewhere closes it without doing anything, so the hint says so. */
const DISMISS_HINT_WITH_ACTION = '点上面的按钮开始；点其他地方只会关闭'

/** Handle returned by {@link startReminderService}. */
export interface ReminderService {
  /** Stop checking the schedule. A pop-up already on screen stays until dismissed. */
  stop(): void
  /** Show a reminder now, regardless of its schedule. */
  fire(entry: ReminderEntry): void
  /** The next reminder to come, following the user's off-work time; undefined when none is scheduled. */
  upcoming(): UpcomingReminder | undefined
}

/** Where reminders unfold when the island is up, instead of the pop-up in the middle of the screen. */
export interface ReminderIsland {
  active(): boolean
  /** Shows the reminder as a card; resolves when the user presses its button or dismisses it. */
  show(entry: ReminderEntry): Promise<'acted' | 'dismissed'>
}

/**
 * Start the reminder schedule.
 * @param options.profileDir - Desktop profile directory holding the config and state files.
 * @param options.shellOrigin - custom-protocol origin serving the renderer folder.
 * @param options.ballBounds - current floating ball window bounds, so pop-ups can fly out of it.
 * @param options.preload - preload script given to the pop-up window.
 * @param options.onAction - runs when the user presses a reminder's action button.
 * @param options.log - sink for config problems.
 * @returns the running service.
 */
export function startReminderService(options: {
  readonly profileDir: string
  readonly shellOrigin: string
  readonly ballBounds: () => { x: number; y: number; width: number; height: number } | undefined
  readonly preload: string
  readonly onAction: (entry: ReminderEntry) => void
  readonly island?: ReminderIsland
  readonly log?: (message: string) => void
}): ReminderService {
  const log = options.log ?? ((message: string): void => { console.warn(message) })
  const configPath = join(options.profileDir, REMINDERS_CONFIG_FILE)
  let config: ReminderConfig | undefined
  let configStamp = -1
  let fired = readReminderState(options.profileDir)
  const queue: ReminderEntry[] = []
  let showing = false
  let current: { readonly entry: ReminderEntry; readonly window: BrowserWindow } | undefined

  // Only the pop-up window that is on screen may press its own button.
  ipcMain.handle(DESKTOP_IPC.reminderAction, (event) => {
    if (current === undefined || event.sender !== current.window.webContents) {
      throw new Error('dsh desktop: rejected reminder IPC from an unowned renderer')
    }
    const { entry } = current
    record(`action ${entry.id} ${entry.action ?? '(none)'}`)
    if (entry.action === undefined) return
    try {
      options.onAction(entry)
    } catch (error) {
      record(`action ${entry.id} failed: ${String(error)}`)
      throw error
    }
  })

  function record(message: string): void {
    try {
      appendFileSync(join(options.profileDir, REMINDER_LOG_FILE), `${new Date().toISOString()} ${message}` + String.fromCharCode(10))
    } catch {
      // The log is a convenience; a failure to write it must not stop a reminder.
    }
  }

  function reloadConfig(): void {
    let stamp = -1
    try {
      stamp = statSync(configPath).mtimeMs
    } catch {
      // A missing file is recreated by the read below.
    }
    if (stamp === configStamp && config !== undefined) return
    const result = readReminderConfig(options.profileDir)
    try {
      configStamp = statSync(configPath).mtimeMs
    } catch {
      configStamp = -1
    }
    for (const problem of result.problems) log(`dsh desktop: ${REMINDERS_CONFIG_FILE}: ${problem}`)
    // A config that cannot be parsed keeps the last good one rather than silencing every reminder.
    if (result.config !== undefined) config = result.config
  }

  async function drain(): Promise<void> {
    if (showing) return
    showing = true
    try {
      for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
        if (config?.sound === true) shell.beep()
        if (options.island?.active() === true) {
          record(`shown ${entry.id} (island)`)
          const outcome = await options.island.show(entry)
          record(`closed ${entry.id} (${outcome})`)
          if (outcome === 'acted' && entry.action !== undefined) options.onAction(entry)
          continue
        }
        const shown = showReminder(entry, {
          shellOrigin: options.shellOrigin,
          hint: entry.action === undefined ? DISMISS_HINT : DISMISS_HINT_WITH_ACTION,
          ball: options.ballBounds(),
          preload: options.preload,
        })
        current = { entry, window: shown.window }
        record(`shown ${entry.id}`)
        await shown.closed
        record(`closed ${entry.id}`)
        current = undefined
      }
    } finally {
      showing = false
    }
  }

  function enqueue(entry: ReminderEntry): void {
    queue.push(entry)
    void drain().catch((error: unknown) => { log(`dsh desktop: reminder failed: ${String(error)}`) })
  }

  function tick(): void {
    reloadConfig()
    if (config === undefined) return
    const now = new Date()
    // The knocking-off reminder follows the off-work time set in the working-hours window.
    const due = dueReminders(alignOffWork(config, readScheduleConfig(options.profileDir).config?.workEnd), now, fired)
    if (due.length === 0) return
    // Record before showing so a crash or restart cannot show the same reminder twice.
    record(`due ${due.map(entry => entry.id).join(',')}`)
    fired = markReminderFired(fired, due.map(entry => entry.id), now)
    writeReminderState(options.profileDir, fired)
    for (const entry of due) enqueue(entry)
  }

  const upcoming = (): UpcomingReminder | undefined => {
    if (config === undefined) return undefined
    return nextReminder(alignOffWork(config, readScheduleConfig(options.profileDir).config?.workEnd), new Date(), fired)
  }

  const timer = setInterval(tick, REMINDER_CHECK_MS)
  tick()
  return {
    stop: () => {
      clearInterval(timer)
      ipcMain.removeHandler(DESKTOP_IPC.reminderAction)
    },
    fire: enqueue,
    upcoming,
  }
}
