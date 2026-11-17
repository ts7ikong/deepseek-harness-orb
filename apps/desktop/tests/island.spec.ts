import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown

interface FakeWindow {
  webContents: { id: number; send: ReturnType<typeof vi.fn> }
  visible: boolean
  closed: boolean
  ignoring: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  windows: [] as unknown[],
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => { electron.handlers.set(channel, handler) },
    removeHandler: (channel: string) => { electron.handlers.delete(channel) },
  },
  screen: {
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 3440, height: 1400 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  BrowserWindow: class {
    webContents = {
      id: electron.windows.length + 1,
      send: vi.fn(),
      setWindowOpenHandler() {},
      once: (_event: string, listener: () => void) => { listener() },
    }
    visible = false
    closed = false
    ignoring = false
    bounds: { x: number; y: number; width: number; height: number }
    constructor(options: { x: number; y: number; width: number; height: number }) {
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      electron.windows.push(this)
    }
    isDestroyed() { return this.closed }
    isVisible() { return this.visible }
    getBounds() { return this.bounds }
    setBounds(bounds: { x: number; y: number; width: number; height: number }) { this.bounds = bounds }
    showInactive() { this.visible = true }
    hide() { this.visible = false }
    close() { this.closed = true }
    setContentProtection() {}
    setIgnoreMouseEvents(value: boolean) { this.ignoring = value }
    loadURL() { return Promise.resolve() }
  },
}))
vi.mock('../src/floating-window.ts', () => ({ presentOverlayWindow: () => {} }))

import { DESKTOP_IPC } from '../src/ipc.ts'
import {
  describeNext,
  ISLAND_ENTER_EDGE,
  ISLAND_HOVER_GRACE_MS,
  ISLAND_LINE_MS,
  ISLAND_PILL_SIZES,
  ISLAND_STATE_FILE,
  ISLAND_WINDOW_SIZE,
  islandPanelHeight,
  islandPillRect,
  islandWindowBounds,
  nextIslandMode,
  parseIslandAction,
  readIslandActive,
  shouldEnterIsland,
  startIslandService,
  type IslandState,
} from '../src/island-service.ts'
import { defaultReminderConfig, type ReminderEntry } from '../src/reminders.ts'
import { readTodos } from '../src/todos.ts'
import type { ScheduleConfig } from '../src/work-schedule.ts'

const roots: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 28, 10, 30, 0))
})

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  electron.handlers.clear()
  electron.windows.length = 0
})

const area = { x: 0, y: 0, width: 3440, height: 1400 }

describe('geometry and modes', () => {
  it('puts the window at the top centre of the display and the capsule inside it', () => {
    const window = islandWindowBounds(area)
    expect(window).toEqual({ x: (3440 - ISLAND_WINDOW_SIZE.width) / 2, y: 0, ...ISLAND_WINDOW_SIZE })
    const pill = islandPillRect(window, 'collapsed')
    expect(pill.x + pill.width / 2).toBe(3440 / 2)
    expect(pill.y).toBe(6)
    expect(islandPillRect(window, 'panel').width).toBe(ISLAND_PILL_SIZES.panel.width)
    expect(ISLAND_PILL_SIZES.panel.width).toBeLessThanOrEqual(ISLAND_WINDOW_SIZE.width)
    expect(ISLAND_PILL_SIZES.panel.height + 6).toBeLessThanOrEqual(ISLAND_WINDOW_SIZE.height)
  })

  it('fits the panel to a measured height within the collapsed and tallest capsule', () => {
    const window = islandWindowBounds(area)
    expect(islandPanelHeight(212.2)).toBe(213)
    expect(islandPanelHeight(10)).toBe(ISLAND_PILL_SIZES.collapsed.height)
    expect(islandPanelHeight(900)).toBe(ISLAND_PILL_SIZES.panel.height)
    expect(islandPillRect(window, 'panel').height).toBe(ISLAND_PILL_SIZES.panel.height)
    expect(islandPillRect(window, 'panel', 213).height).toBe(213)
    expect(islandPillRect(window, 'collapsed', 213).height).toBe(ISLAND_PILL_SIZES.collapsed.height)
  })

  it('turns a ball dropped against the top edge into the island, and no other', () => {
    expect(shouldEnterIsland({ x: 500, y: -12, width: 96, height: 96 }, area)).toBe(true)
    expect(shouldEnterIsland({ x: 500, y: ISLAND_ENTER_EDGE - 12, width: 96, height: 96 }, area)).toBe(true)
    expect(shouldEnterIsland({ x: 500, y: ISLAND_ENTER_EDGE - 11, width: 96, height: 96 }, area)).toBe(false)
    expect(shouldEnterIsland({ x: 500, y: 600, width: 96, height: 96 }, { ...area, y: 40 })).toBe(false)
    expect(shouldEnterIsland({ x: 500, y: 30, width: 96, height: 96 }, { ...area, y: 40 })).toBe(true)
  })

  it('opens the panel on hover, holds it briefly after, and lets a reminder win over both', () => {
    expect(nextIslandMode('collapsed', true, 0, false)).toBe('panel')
    expect(nextIslandMode('panel', false, ISLAND_HOVER_GRACE_MS - 1, false)).toBe('panel')
    expect(nextIslandMode('panel', false, ISLAND_HOVER_GRACE_MS, false)).toBe('collapsed')
    expect(nextIslandMode('collapsed', false, 5000, false)).toBe('collapsed')
    expect(nextIslandMode('collapsed', true, 0, true)).toBe('reminder')
    expect(nextIslandMode('panel', false, 99999, true)).toBe('reminder')
  })

  it('accepts only well-formed messages from the page', () => {
    expect(parseIslandAction({ type: 'open', target: 'backfill' })).toEqual({ type: 'open', target: 'backfill' })
    expect(parseIslandAction({ type: 'open', target: 'rm -rf' })).toBeUndefined()
    expect(parseIslandAction({ type: 'exit' })).toEqual({ type: 'exit' })
    expect(parseIslandAction({ type: 'reminder', outcome: 'acted' })).toEqual({ type: 'reminder', outcome: 'acted' })
    expect(parseIslandAction({ type: 'reminder', outcome: 'maybe' })).toBeUndefined()
    expect(parseIslandAction({ type: 'todo-add', text: '甲' })).toEqual({ type: 'todo-add', text: '甲' })
    expect(parseIslandAction({ type: 'todo-add', text: 5 })).toBeUndefined()
    expect(parseIslandAction({ type: 'todo-toggle', id: 'a' })).toEqual({ type: 'todo-toggle', id: 'a' })
    expect(parseIslandAction({ type: 'todo-remove' })).toBeUndefined()
    expect(parseIslandAction({ type: 'panel-height', height: 212.5 })).toEqual({ type: 'panel-height', height: 212.5 })
    expect(parseIslandAction({ type: 'panel-height', height: '212' })).toBeUndefined()
    expect(parseIslandAction({ type: 'panel-height', height: Number.NaN })).toBeUndefined()
    expect(parseIslandAction({ type: 'other' })).toBeUndefined()
    expect(parseIslandAction(null)).toBeUndefined()
    expect(parseIslandAction('exit')).toBeUndefined()
  })

  it('describes the next reminder with its time and how many minutes are left', () => {
    const entry = defaultReminderConfig().reminders[0]!
    const upcoming = { entry, at: new Date(2026, 9, 28, 18, 20, 0) }
    expect(describeNext(upcoming, new Date(2026, 9, 28, 16, 0, 0))).toEqual({ title: '该写日报了', time: '18:20', inMinutes: 140 })
    expect(describeNext(upcoming, new Date(2026, 9, 28, 18, 19, 30)).inMinutes).toBe(1)
    expect(describeNext(upcoming, new Date(2026, 9, 28, 19, 0, 0)).inMinutes).toBe(0)
  })
})

describe('the island service', () => {
  const hours: ScheduleConfig = {
    showClock: true, days: [1, 2, 3, 4, 5], workStart: 540, lunchStart: 720, afternoonStart: 810, workEnd: 1110,
  }
  const reminder: ReminderEntry = {
    id: 'daily-report', time: '18:20', days: [3], mood: 'writing', title: '该写日报了', message: '趁还记得', action: 'daily-report', actionLabel: '生成日报草稿',
  }

  function start(overrides: Partial<Parameters<typeof startIslandService>[0]> = {}) {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-island-'))
    roots.push(profileDir)
    const logFile = join(profileDir, 'log.json')
    writeFileSync(logFile, JSON.stringify({ '2026-10-28': [{ time: '10:00', content: '处理甲' }], '2026-10-27': [{ time: '18:00', content: '昨天的' }] }))
    let pointer = { x: 5000, y: 5000 }
    const ball = { hide: vi.fn(), showAt: vi.fn(), bounds: () => ({ x: 800, y: -12, width: 96, height: 96 }) }
    const onOpen = vi.fn()
    const island = startIslandService({
      profileDir,
      shellOrigin: 'dsh-app://shell',
      preload: 'p.cjs',
      ball,
      schedule: () => hours,
      workLogFile: () => logFile,
      nextReminder: () => ({ entry: reminder, at: new Date(2026, 9, 28, 18, 20, 0) }),
      onOpen,
      pointer: () => pointer,
      log: () => {},
      ...overrides,
    })
    const win = (): FakeWindow => electron.windows[0] as FakeWindow
    const states = (): IslandState[] => win().webContents.send.mock.calls
      .filter(call => call[0] === DESKTOP_IPC.islandState).map(call => call[1] as IslandState)
    const last = (): IslandState => states().at(-1)!
    const act = (value: unknown, sender: unknown = win().webContents) => electron.handlers.get(DESKTOP_IPC.islandAction)!({ sender }, value)
    return { profileDir, island, ball, onOpen, win, states, last, act, move: (x: number, y: number) => { pointer = { x, y } } }
  }

  it('hides the ball and shows the capsule when it enters, and remembers it for the next start', () => {
    const { profileDir, island, ball, win, last } = start()
    expect(island.active()).toBe(false)
    island.enter()
    expect(island.active()).toBe(true)
    expect(ball.hide).toHaveBeenCalledTimes(1)
    expect(win().visible).toBe(true)
    expect(win().bounds).toEqual(islandWindowBounds(area))
    expect(readIslandActive(profileDir)).toBe(true)
    expect(JSON.parse(readFileSync(join(profileDir, ISLAND_STATE_FILE), 'utf8'))).toEqual({ active: true })
    expect(last()).toMatchObject({ mode: 'collapsed', time: '10:30:00', status: 'idle' })
    island.stop()
  })

  it('sends the time, progress, today\'s entries only, to-dos, and the next reminder', () => {
    const { island, last, act } = start()
    island.enter()
    act({ type: 'todo-add', text: '回复甲客户' })
    const state = last()
    expect(state.date).toBe('10月28日 周三')
    expect(state.progress).toMatchObject({ phase: 'morning' })
    expect(state.entries).toEqual([{ time: '10:00', content: '处理甲' }])
    expect(state.todos.map(item => item.text)).toEqual(['回复甲客户'])
    expect(state.next).toMatchObject({ title: '该写日报了', time: '18:20' })
    island.stop()
  })

  it('opens the panel when the pointer is on the capsule and takes mouse events only then', () => {
    const { island, win, last, move } = start()
    island.enter()
    vi.advanceTimersByTime(300)
    expect(win().ignoring).toBe(true)
    const pill = islandPillRect(win().bounds, 'collapsed')
    move(pill.x + 60, pill.y + 20)
    vi.advanceTimersByTime(300)
    expect(win().ignoring).toBe(false)
    expect(last().mode).toBe('panel')
    move(5000, 5000)
    vi.advanceTimersByTime(300)
    expect(last().mode).toBe('panel')
    vi.advanceTimersByTime(900)
    expect(last().mode).toBe('collapsed')
    expect(win().ignoring).toBe(true)
    island.stop()
  })

  it('lets the pointer leave a fitted panel through the space below it', () => {
    const { island, win, last, move, act } = start()
    island.enter()
    const pill = islandPillRect(win().bounds, 'collapsed')
    move(pill.x + 60, pill.y + 20)
    vi.advanceTimersByTime(300)
    act({ type: 'panel-height', height: 200 })
    move(pill.x + 60, pill.y + 250)
    vi.advanceTimersByTime(300)
    expect(win().ignoring).toBe(true)
    vi.advanceTimersByTime(900)
    expect(last().mode).toBe('collapsed')
    island.stop()
  })

  it('shows what the ball is doing, and one of its remarks for a few seconds', () => {
    const { island, last } = start()
    island.enter()
    island.setRunning(true)
    expect(last().status).toBe('running')
    island.setActing(true)
    expect(last().status).toBe('acting')
    island.setActing(false)
    island.setRunning(false)
    expect(last().status).toBe('idle')
    island.say('又在跟 nginx 较劲啊')
    expect(last().line).toBe('又在跟 nginx 较劲啊')
    vi.advanceTimersByTime(ISLAND_LINE_MS + 1500)
    expect(last().line).toBeUndefined()
    island.stop()
  })

  it('unfolds a reminder as a card, and hands back what the user did with it', async () => {
    const { island, last, act } = start()
    island.enter()
    const outcome = island.showReminder(reminder)
    expect(last()).toMatchObject({ mode: 'reminder', reminder: { id: 'daily-report', title: '该写日报了', actionLabel: '生成日报草稿', mood: 'writing' } })
    act({ type: 'reminder', outcome: 'acted' })
    await expect(outcome).resolves.toBe('acted')
    expect(last().mode).toBe('collapsed')
    expect(last().reminder).toBeUndefined()
    const { action: _action, ...withoutAction } = reminder
    const second = island.showReminder({ ...withoutAction, id: 'off-work' })
    expect(last().reminder?.actionLabel).toBeUndefined()
    act({ type: 'reminder', outcome: 'dismissed' })
    await expect(second).resolves.toBe('dismissed')
    island.stop()
  })

  it('keeps a reminder up while the pointer comes and goes', () => {
    const { island, last, move } = start()
    island.enter()
    void island.showReminder(reminder)
    move(5000, 5000)
    vi.advanceTimersByTime(3000)
    expect(last().mode).toBe('reminder')
    island.stop()
  })

  it('opens the app\'s other windows and edits the to-do list on request', () => {
    const { profileDir, island, onOpen, act, last } = start()
    island.enter()
    act({ type: 'open', target: 'weekly' })
    expect(onOpen).toHaveBeenCalledWith('weekly')
    act({ type: 'todo-add', text: '甲' })
    const [item] = readTodos(profileDir)
    act({ type: 'todo-toggle', id: item!.id })
    expect(last().todos[0]?.done).toBe(true)
    act({ type: 'todo-remove', id: item!.id })
    expect(last().todos).toEqual([])
    island.stop()
  })

  it('refuses messages from any other window and malformed ones', () => {
    const { island, act } = start()
    island.enter()
    expect(() => act({ type: 'exit' }, { id: 99 })).toThrow(/unowned/u)
    expect(() => act({ type: 'open', target: 'format' })).toThrow(/unknown/u)
    expect(() => act(undefined)).toThrow(/unknown/u)
    island.stop()
  })

  it('takes the ball out just under the face, puts away an open reminder, and forgets the island', async () => {
    const { profileDir, island, ball, win, act } = start()
    island.enter()
    const outcome = island.showReminder(reminder)
    act({ type: 'exit' })
    expect(island.active()).toBe(false)
    expect(win().visible).toBe(false)
    await expect(outcome).resolves.toBe('dismissed')
    const pill = islandPillRect(islandWindowBounds(area), 'collapsed')
    expect(ball.showAt).toHaveBeenCalledWith({ x: pill.x + 4, y: pill.y + pill.height + 12 })
    expect(readIslandActive(profileDir)).toBe(false)
    island.stop()
  })

  it('says nothing and does nothing while the island is not up', () => {
    const { island } = start()
    island.say('hello')
    island.setRunning(true)
    expect(electron.windows).toHaveLength(0)
    island.stop()
  })

  it('removes its handler when stopped', () => {
    const { island } = start()
    island.stop()
    expect(electron.handlers.has(DESKTOP_IPC.islandAction)).toBe(false)
  })
})

describe('the island page', () => {
  function mount() {
    const dom = new JSDOM(readFileSync(new URL('../renderer/island.html', import.meta.url), 'utf8'), {
      runScripts: 'outside-only',
      url: 'dsh-app://shell/island.html',
    })
    let push: (state: unknown) => void = () => {}
    const act = vi.fn(async (_message: unknown) => undefined)
    Object.defineProperty(dom.window, 'dshDesktop', {
      value: { island: { act, onState: (listener: (state: unknown) => void) => { push = listener; return () => {} } } },
    })
    runInContext(readFileSync(new URL('../renderer/island.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    const document = dom.window.document
    const text = (selector: string) => document.querySelector<HTMLElement>(selector)
    return { dom, document, act, text, push: (state: unknown) => { push(state) } }
  }

  const base = {
    mode: 'collapsed', time: '10:30:00', date: '10月28日 周三', status: 'idle', entries: [], todos: [],
  }
  const progress = { phase: 'morning', percent: 38, workedMs: 0, remainingMs: 4.5 * 3_600_000 }

  it('stays hidden until the first state arrives, then shows the time, progress bar, percent, and time left', () => {
    const { text, push } = mount()
    expect(text('#island')?.hidden).toBe(true)
    push({ ...base, progress })
    expect(text('#island')?.hidden).toBe(false)
    expect(text('#island')?.dataset.mode).toBe('collapsed')
    expect(text('#time')?.textContent).toBe('10:30:00')
    expect(text('#meter')?.hidden).toBe(false)
    expect(text('#meter-fill')?.style.width).toBe('38%')
    expect(text('#percent')?.textContent).toBe('38%')
    expect(text('#left')?.textContent).toBe('还有 4 小时 30 分')
  })

  it('has no bar without working hours, or on a day off', () => {
    const { text, push } = mount()
    push(base)
    expect(text('#meter')?.hidden).toBe(true)
    expect(text('#percent')?.textContent).toBe('')
    push({ ...base, progress: { phase: 'rest', percent: 0, workedMs: 0, remainingMs: 0 } })
    expect(text('#meter')?.hidden).toBe(true)
    expect(text('#left')?.textContent).toBe('休息日')
  })

  it('shows what the ball is doing in place of the clock, and its remark in place of that', () => {
    const { text, push } = mount()
    push({ ...base, status: 'running' })
    expect(text('#status')?.hidden).toBe(false)
    expect(text('#status')?.textContent).toBe('正在处理…')
    expect(text('#info')?.hidden).toBe(true)
    push({ ...base, status: 'acting' })
    expect(text('#status')?.textContent).toBe('正在操作电脑…')
    push({ ...base, status: 'running', line: '又在跟 nginx 较劲啊' })
    expect(text('#line')?.hidden).toBe(false)
    expect(text('#line')?.textContent).toBe('又在跟 nginx 较劲啊')
    expect(text('#status')?.hidden).toBe(true)
    push(base)
    expect(text('#info')?.hidden).toBe(false)
    expect(text('#line')?.hidden).toBe(true)
  })

  it('fills the panel with today\'s entries, the to-dos, and the next reminder', () => {
    const { document, text, push } = mount()
    push({
      ...base,
      mode: 'panel',
      entries: [{ time: '10:00', content: '处理甲系统' }, { time: '', content: '部署乙' }],
      todos: [{ id: 'a', text: '回复客户', done: false }, { id: 'b', text: '写周报', done: true }],
      next: { title: '该写日报了', time: '18:20', inMinutes: 470 },
    })
    expect(text('#island')?.dataset.mode).toBe('panel')
    expect([...document.querySelectorAll('#entries li')].map(item => item.textContent)).toEqual(['10:00处理甲系统', '部署乙'])
    expect(text('#entries-empty')?.hidden).toBe(true)
    expect([...document.querySelectorAll('#todos li')].map(item => item.classList.contains('done'))).toEqual([false, true])
    expect(text('#next')?.textContent).toBe('下一个提醒：18:20 该写日报了 · 7 小时 50 分钟后')
  })

  it('says so when there are no entries, and when no reminder is coming', () => {
    const { text, push } = mount()
    push({ ...base, mode: 'panel' })
    expect(text('#entries-empty')?.hidden).toBe(false)
    expect(text('#next')?.textContent).toBe('没有即将到来的提醒')
  })

  it('does not treat text in an entry or reminder title as markup', () => {
    const { document, text, push } = mount()
    push({ ...base, mode: 'panel', entries: [{ time: '', content: '<img src=x onerror=alert(1)>' }], next: { title: '<b>x</b>', time: '18:20', inMinutes: 5 } })
    expect(document.querySelector('#entries img')).toBeNull()
    expect(text('#next')?.querySelector('b')).toBeNull()
    expect(text('#next')?.textContent).toContain('<b>x</b>')
  })

  it('sends what the user presses: shortcuts, take-out, face click, and the to-do list', () => {
    const { document, act, push } = mount()
    push({ ...base, mode: 'panel', todos: [{ id: 'a', text: '回复客户', done: false }] })
    document.querySelector<HTMLButtonElement>('[data-open="backfill"]')?.click()
    expect(act).toHaveBeenLastCalledWith({ type: 'open', target: 'backfill' })
    document.querySelector<HTMLButtonElement>('#take-out')?.click()
    expect(act).toHaveBeenLastCalledWith({ type: 'exit' })
    document.querySelector<HTMLButtonElement>('#face-button')?.click()
    expect(act).toHaveBeenLastCalledWith({ type: 'exit' })
    const box = document.querySelector<HTMLInputElement>('#todos input[type="checkbox"]')!
    box.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }))
    expect(act).toHaveBeenLastCalledWith({ type: 'todo-toggle', id: 'a' })
    document.querySelector<HTMLButtonElement>('#todos button')?.click()
    expect(act).toHaveBeenLastCalledWith({ type: 'todo-remove', id: 'a' })
    const input = document.querySelector<HTMLInputElement>('#todo-input')!
    input.value = '  新待办  '
    document.querySelector<HTMLFormElement>('#todo-form')?.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }))
    expect(act).toHaveBeenLastCalledWith({ type: 'todo-add', text: '新待办' })
    expect(input.value).toBe('')
    const calls = act.mock.calls.length
    document.querySelector<HTMLFormElement>('#todo-form')?.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }))
    expect(act.mock.calls.length).toBe(calls)
  })

  it('shows a reminder as a card with its button, and answers it', () => {
    const { document, text, act, push } = mount()
    push({
      ...base,
      mode: 'reminder',
      reminder: { id: 'daily-report', title: '该写日报了', message: '趁还记得，把今天做的事记下来吧', mood: 'writing', actionLabel: '生成日报草稿' },
    })
    expect(text('#island')?.dataset.mode).toBe('reminder')
    expect(text('#reminder-title')?.textContent).toBe('该写日报了')
    expect(text('#reminder-message')?.textContent).toBe('趁还记得，把今天做的事记下来吧')
    expect(text('#reminder-act')?.hidden).toBe(false)
    expect(text('#reminder-act')?.textContent).toBe('生成日报草稿')
    expect(text('#info')?.hidden).toBe(true)
    text('#reminder-act')?.click()
    expect(act).toHaveBeenLastCalledWith({ type: 'reminder', outcome: 'acted' })
    text('#reminder-dismiss')?.click()
    expect(act).toHaveBeenLastCalledWith({ type: 'reminder', outcome: 'dismissed' })
    push({
      ...base,
      mode: 'reminder',
      reminder: { id: 'off-work', title: '下班啦', message: '收拾东西回家吧', mood: 'celebrate' },
    })
    expect(text('#reminder-act')?.hidden).toBe(true)
    push(base)
    expect(text('#reminder-title')?.hidden).toBe(true)
    expect(document.querySelector('#island')?.getAttribute('data-mode')).toBe('collapsed')
  })

  it('sizes the open capsule to the panel content and reports that height once per change', () => {
    const { dom, text, act, push } = mount()
    const panel = text('#panel')!
    const pill = text('#pill')!
    let content = 160
    Object.defineProperty(panel, 'offsetHeight', { get: () => content })
    Object.defineProperty(panel, 'offsetTop', { value: 46 })
    Object.defineProperty(pill, 'offsetHeight', { value: 48 })
    Object.defineProperty(pill, 'clientHeight', { value: 46 })
    push({ ...base, mode: 'panel' })
    expect(text('#island')?.style.getPropertyValue('--panel-height')).toBe('208px')
    expect(act).toHaveBeenLastCalledWith({ type: 'panel-height', height: 208 })
    const calls = act.mock.calls.length
    push({ ...base, mode: 'panel' })
    expect(act.mock.calls.length).toBe(calls)
    content = 200.4
    push({ ...base, mode: 'panel' })
    expect(act).toHaveBeenLastCalledWith({ type: 'panel-height', height: 249 })
    dom.window.close()
  })

  it('ignores malformed state', () => {
    const { text, push } = mount()
    push(undefined)
    push({ time: 5 })
    expect(text('#island')?.hidden).toBe(true)
  })
})
