/**
 * The island: when the ball is dropped at the top edge of the screen it turns into a slim capsule at the top centre,
 * with the ball's face at its left end. The capsule shows the time, the work progress, what the ball is doing, and the
 * ball's own remarks. Hovering unfolds a panel (today's entries, to-dos, the next reminder, shortcuts), and a reminder
 * unfolds it as a card with its button. Clicking the face takes the ball out again.
 *
 * While the island is up the ball's window is hidden but keeps running, so the assistant's session carries on.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen } from 'electron'
import { pointInRect } from './clock-service.ts'
import { excludeFromComputerUseCapture } from './capture-exclusion.ts'
import { presentOverlayWindow } from './floating-window.ts'
import { DESKTOP_IPC } from './ipc.ts'
import { localDateKey, type ReminderEntry, type ReminderMood, type UpcomingReminder } from './reminders.ts'
import { addTodo, readTodos, removeTodo, toggleTodo, type TodoItem } from './todos.ts'
import { readWorkLogRecent, type WorkLogViewEntry } from './work-log.ts'
import { clockState, type ScheduleConfig, type WorkProgress } from './work-schedule.ts'

/** Profile-relative JSON remembering whether the island was up, so a restart brings it back. */
export const ISLAND_STATE_FILE = 'orb-island.json'

/** Island window size in DIPs; the capsule is drawn inside it at the top centre. */
export const ISLAND_WINDOW_SIZE = { width: 540, height: 340 } as const

/** What the capsule looks like in each mode: its size in DIPs. */
export const ISLAND_PILL_SIZES = {
  collapsed: { width: 420, height: 46 },
  panel: { width: 520, height: 316 },
  reminder: { width: 470, height: 152 },
} as const

export type IslandMode = keyof typeof ISLAND_PILL_SIZES

/** Gap between the top of the screen and the capsule. */
export const ISLAND_TOP_MARGIN = 6

/** A ball dropped with its top within this distance of the screen's top edge becomes the island. */
export const ISLAND_ENTER_EDGE = 24

/** The panel stays open this long after the pointer leaves the capsule. */
export const ISLAND_HOVER_GRACE_MS = 600

/** How often the pointer is checked against the capsule. */
const POINTER_CHECK_MS = 100

/** How long one of the ball's remarks stays in the capsule. */
export const ISLAND_LINE_MS = 9000

/** Most of today's entries listed in the panel. */
const MAX_ENTRIES = 6

/** What the user can ask the island to do. */
export const ISLAND_OPEN_TARGETS = ['backfill', 'weekly', 'worklog', 'hours'] as const

export type IslandOpenTarget = typeof ISLAND_OPEN_TARGETS[number]

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A reminder shown as a card. */
export interface IslandReminder {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly mood: ReminderMood
  readonly actionLabel?: string
}

/** Everything the island page draws; sent about once a second and whenever something changes. */
export interface IslandState {
  readonly mode: IslandMode
  /** `HH:MM:SS`. */
  readonly time: string
  /** `10月28日 周三`. */
  readonly date: string
  readonly progress?: WorkProgress
  readonly status: 'idle' | 'running' | 'acting'
  /** One of the ball's remarks, while it is being shown. */
  readonly line?: string
  readonly entries: readonly WorkLogViewEntry[]
  readonly todos: readonly TodoItem[]
  readonly next?: { readonly title: string; readonly time: string; readonly inMinutes: number }
  readonly reminder?: IslandReminder
}

/** A message from the island page. */
export type IslandAction =
  | { readonly type: 'open'; readonly target: IslandOpenTarget }
  | { readonly type: 'exit' }
  | { readonly type: 'reminder'; readonly outcome: 'acted' | 'dismissed' }
  | { readonly type: 'todo-add'; readonly text: string }
  | { readonly type: 'todo-toggle'; readonly id: string }
  | { readonly type: 'todo-remove'; readonly id: string }

/**
 * Where the island window sits: centered along the top of a display.
 * @param workArea - work area of the display.
 * @returns the window bounds.
 */
export function islandWindowBounds(workArea: Rect): Rect {
  return {
    x: workArea.x + Math.round((workArea.width - ISLAND_WINDOW_SIZE.width) / 2),
    y: workArea.y,
    ...ISLAND_WINDOW_SIZE,
  }
}

/**
 * The capsule's rectangle in screen coordinates.
 * @param window - the island window bounds.
 * @param mode - which size the capsule has.
 * @returns the rectangle the pointer must be in to count as being on the capsule.
 */
export function islandPillRect(window: Rect, mode: IslandMode): Rect {
  const { width, height } = ISLAND_PILL_SIZES[mode]
  return { x: window.x + Math.round((window.width - width) / 2), y: window.y + ISLAND_TOP_MARGIN, width, height }
}

/**
 * Whether a dropped ball should turn into the island.
 * @param ball - bounds of the collapsed ball window (the ball is drawn 12 DIPs inside it).
 * @param workArea - work area of the display it was dropped on.
 * @returns true when the ball sits against the top edge.
 */
export function shouldEnterIsland(ball: Rect, workArea: Rect): boolean {
  return ball.y + 12 - workArea.y <= ISLAND_ENTER_EDGE
}

/**
 * The capsule's next mode.
 * @param current - the mode now.
 * @param hovered - whether the pointer is on the capsule.
 * @param sinceHover - milliseconds since the pointer was last on it.
 * @param reminderShown - whether a reminder card is up, which always wins.
 * @returns the mode to show.
 */
export function nextIslandMode(current: IslandMode, hovered: boolean, sinceHover: number, reminderShown: boolean): IslandMode {
  if (reminderShown) return 'reminder'
  if (hovered) return 'panel'
  if (current === 'panel' && sinceHover < ISLAND_HOVER_GRACE_MS) return 'panel'
  return 'collapsed'
}

/**
 * Whether a message from the page is one the island knows how to carry out.
 * @param value - the message as received.
 * @returns the message when it is well formed, otherwise undefined.
 */
export function parseIslandAction(value: unknown): IslandAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const message = value as Record<string, unknown>
  switch (message.type) {
    case 'open':
      return ISLAND_OPEN_TARGETS.find(target => target === message.target) === undefined
        ? undefined
        : { type: 'open', target: message.target as IslandOpenTarget }
    case 'exit':
      return { type: 'exit' }
    case 'reminder':
      return message.outcome === 'acted' || message.outcome === 'dismissed' ? { type: 'reminder', outcome: message.outcome } : undefined
    case 'todo-add':
      return typeof message.text === 'string' ? { type: 'todo-add', text: message.text } : undefined
    case 'todo-toggle':
    case 'todo-remove':
      return typeof message.id === 'string' ? { type: message.type, id: message.id } : undefined
    default:
      return undefined
  }
}

/**
 * The next reminder as the panel shows it.
 * @param upcoming - the reminder to come.
 * @param now - the current time.
 * @returns its title, time of day, and minutes to go.
 */
export function describeNext(upcoming: UpcomingReminder, now: Date): { title: string; time: string; inMinutes: number } {
  const two = (value: number): string => String(value).padStart(2, '0')
  return {
    title: upcoming.entry.title,
    time: `${two(upcoming.at.getHours())}:${two(upcoming.at.getMinutes())}`,
    inMinutes: Math.max(0, Math.ceil((upcoming.at.getTime() - now.getTime()) / 60_000)),
  }
}

/** Whether the island was up when the app last ran. */
export function readIslandActive(profileDir: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(join(profileDir, ISLAND_STATE_FILE), 'utf8'))
    return typeof value === 'object' && value !== null && (value as { active?: unknown }).active === true
  } catch {
    return false
  }
}

function writeIslandActive(profileDir: string, active: boolean): void {
  try {
    writeFileSync(join(profileDir, ISLAND_STATE_FILE), `${JSON.stringify({ active })}\n`)
  } catch {
    // Not remembering the mode is a small loss; it must not stop the island.
  }
}

/** Used while the working hours cannot be read: the time still shows, without progress. */
const NO_SCHEDULE: ScheduleConfig = {
  showClock: true,
  days: [],
  workStart: undefined,
  lunchStart: undefined,
  afternoonStart: undefined,
  workEnd: undefined,
}

/** Handle returned by {@link startIslandService}. */
export interface IslandService {
  active(): boolean
  /** Turn the ball into the island on the display it is on. */
  enter(): void
  /** Take the ball out again, just under where the island's face is. */
  exit(): void
  setRunning(running: boolean): void
  setActing(acting: boolean): void
  /** Show one of the ball's remarks in the capsule for a few seconds. */
  say(text: string): void
  /** Unfold a reminder as a card; resolves when the user presses its button or dismisses it. */
  showReminder(entry: ReminderEntry): Promise<'acted' | 'dismissed'>
  stop(): void
}

/**
 * Start the island.
 * @param options.profileDir - Desktop profile directory (to-dos, the remembered mode).
 * @param options.shellOrigin - custom-protocol origin serving the renderer folder.
 * @param options.preload - preload script exposing the island calls.
 * @param options.ball - the ball's window: its bounds, hiding it, and showing it at a place.
 * @param options.schedule - the working hours, when set.
 * @param options.workLogFile - the work log path.
 * @param options.nextReminder - the next reminder to come.
 * @param options.onOpen - opens one of the app's other windows.
 * @param options.pointer - the pointer in screen coordinates; defaults to the system's.
 * @param options.log - sink for failures.
 * @returns the running island.
 */
export function startIslandService(options: {
  readonly profileDir: string
  readonly shellOrigin: string
  readonly preload: string
  readonly ball: {
    readonly bounds: () => Rect | undefined
    readonly hide: () => void
    readonly showAt: (origin: { x: number; y: number }) => void
  }
  readonly schedule: () => ScheduleConfig | undefined
  readonly workLogFile: () => string
  readonly nextReminder: () => UpcomingReminder | undefined
  readonly onOpen: (target: IslandOpenTarget) => void
  readonly pointer?: () => { readonly x: number; readonly y: number }
  readonly log?: (message: string) => void
}): IslandService {
  const pointer = options.pointer ?? ((): { x: number; y: number } => screen.getCursorScreenPoint())
  let window: BrowserWindow | undefined
  let loaded = false
  let active = false
  let workArea: Rect | undefined
  let mode: IslandMode = 'collapsed'
  let hoveredAt = -Infinity
  let ignoring = true
  let running = false
  let acting = false
  let line: { text: string; until: number } | undefined
  let reminder: { entry: ReminderEntry; resolve: (outcome: 'acted' | 'dismissed') => void } | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let stateTimer: ReturnType<typeof setInterval> | undefined

  function snapshot(): IslandState {
    const now = new Date()
    const clock = clockState(options.schedule() ?? NO_SCHEDULE, now)
    const today = localDateKey(now)
    const day = readWorkLogRecent(options.workLogFile(), 1).find(entry => entry.date === today)
    const upcoming = options.nextReminder()
    const shownLine = line !== undefined && line.until > now.getTime() ? line.text : undefined
    return {
      mode,
      time: clock.time,
      date: clock.date.replace(/^\d+年/u, ''),
      ...(clock.progress === undefined ? {} : { progress: clock.progress }),
      status: acting ? 'acting' : running ? 'running' : 'idle',
      ...(shownLine === undefined ? {} : { line: shownLine }),
      entries: (day?.entries ?? []).slice(-MAX_ENTRIES),
      todos: readTodos(options.profileDir),
      ...(upcoming === undefined ? {} : { next: describeNext(upcoming, now) }),
      ...(reminder === undefined ? {} : {
        reminder: {
          id: reminder.entry.id,
          title: reminder.entry.title,
          message: reminder.entry.message,
          mood: reminder.entry.mood,
          ...(reminder.entry.action === undefined ? {} : { actionLabel: reminder.entry.actionLabel ?? '' }),
        },
      }),
    }
  }

  function push(): void {
    if (!active || window === undefined || window.isDestroyed() || !loaded) return
    window.webContents.send(DESKTOP_IPC.islandState, snapshot())
  }

  function applyMouse(inside: boolean): void {
    if (window === undefined || window.isDestroyed() || ignoring === !inside) return
    ignoring = !inside
    window.setIgnoreMouseEvents(ignoring, { forward: true })
  }

  function check(): void {
    if (!active || window === undefined || window.isDestroyed()) return
    const rect = islandPillRect(window.getBounds(), mode)
    const inside = pointInRect(rect, pointer())
    applyMouse(inside)
    const moment = Date.now()
    if (inside) hoveredAt = moment
    const next = nextIslandMode(mode, inside, moment - hoveredAt, reminder !== undefined)
    if (next !== mode) {
      mode = next
      push()
    }
  }

  ipcMain.handle(DESKTOP_IPC.islandAction, (event, value: unknown): void => {
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents) {
      throw new Error('dsh desktop: rejected island IPC from an unowned renderer')
    }
    const action = parseIslandAction(value)
    if (action === undefined) throw new Error('dsh desktop: unknown island action')
    switch (action.type) {
      case 'open':
        options.onOpen(action.target)
        break
      case 'exit':
        service.exit()
        return
      case 'reminder':
        if (reminder !== undefined) {
          const { resolve } = reminder
          reminder = undefined
          mode = 'collapsed'
          resolve(action.outcome)
        }
        break
      case 'todo-add':
        addTodo(options.profileDir, action.text)
        break
      case 'todo-toggle':
        toggleTodo(options.profileDir, action.id)
        break
      case 'todo-remove':
        removeTodo(options.profileDir, action.id)
        break
    }
    push()
  })

  function ensureWindow(bounds: Rect): BrowserWindow {
    if (window !== undefined && !window.isDestroyed()) return window
    loaded = false
    const created = new BrowserWindow({
      ...bounds,
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
    created.setIgnoreMouseEvents(true, { forward: true })
    ignoring = true
    excludeFromComputerUseCapture(created)
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.webContents.once('did-finish-load', () => {
      loaded = true
      push()
    })
    void created.loadURL(new URL('island.html', `${options.shellOrigin}/`).toString())
    window = created
    return created
  }

  const service: IslandService = {
    active: () => active,
    enter: () => {
      const ball = options.ball.bounds()
      const display = screen.getDisplayNearestPoint(ball === undefined
        ? screen.getCursorScreenPoint()
        : { x: ball.x + ball.width / 2, y: ball.y + ball.height / 2 })
      workArea = display.workArea
      const target = ensureWindow(islandWindowBounds(workArea))
      target.setBounds(islandWindowBounds(workArea))
      active = true
      mode = 'collapsed'
      writeIslandActive(options.profileDir, true)
      options.ball.hide()
      target.showInactive()
      pollTimer ??= setInterval(check, POINTER_CHECK_MS)
      stateTimer ??= setInterval(push, 1000)
      push()
    },
    exit: () => {
      if (!active) return
      active = false
      writeIslandActive(options.profileDir, false)
      if (pollTimer !== undefined) clearInterval(pollTimer)
      if (stateTimer !== undefined) clearInterval(stateTimer)
      pollTimer = undefined
      stateTimer = undefined
      const area = workArea
      if (window !== undefined && !window.isDestroyed()) window.hide()
      // A reminder still on the card is put away unanswered.
      if (reminder !== undefined) {
        const { resolve } = reminder
        reminder = undefined
        resolve('dismissed')
      }
      const pill = islandPillRect(islandWindowBounds(area ?? { x: 0, y: 0, width: 1920, height: 1080 }), 'collapsed')
      options.ball.showAt({ x: pill.x + 4, y: pill.y + pill.height + 12 })
    },
    setRunning: (value) => { running = value; push() },
    setActing: (value) => { acting = value; push() },
    say: (text) => { line = { text, until: Date.now() + ISLAND_LINE_MS }; push() },
    showReminder: entry => new Promise((resolve) => {
      reminder = { entry, resolve }
      mode = 'reminder'
      push()
    }),
    stop: () => {
      if (pollTimer !== undefined) clearInterval(pollTimer)
      if (stateTimer !== undefined) clearInterval(stateTimer)
      ipcMain.removeHandler(DESKTOP_IPC.islandAction)
      if (window !== undefined && !window.isDestroyed()) window.close()
    },
  }
  return service
}
