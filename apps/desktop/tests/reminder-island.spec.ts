import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }) => unknown>(),
  beep: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: { sender: unknown }) => unknown) => { electron.handlers.set(channel, handler) },
    removeHandler: (channel: string) => { electron.handlers.delete(channel) },
  },
  shell: { beep: electron.beep },
}))

const popup = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('../src/reminder-window.ts', () => ({ showReminder: popup.show }))

import { REMINDER_LOG_FILE, startReminderService } from '../src/reminder-service.ts'

type Island = NonNullable<Parameters<typeof startReminderService>[0]['island']>

const roots: string[] = []
const running: { stop(): void }[] = []

beforeEach(() => {
  vi.useFakeTimers()
  // 2026-10-28 is a Wednesday.
  vi.setSystemTime(new Date(2026, 9, 28, 18, 21, 0))
})

afterEach(() => {
  for (const item of running.splice(0)) item.stop()
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  electron.handlers.clear()
  popup.show.mockReset()
  electron.beep.mockReset()
})

function start(island: Island) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-reminder-island-'))
  roots.push(profileDir)
  writeFileSync(join(profileDir, 'orb-reminders.json'), JSON.stringify({
    sound: true,
    reminders: [{
      id: 'daily-report', time: '18:20', days: [3], mood: 'writing', title: '该写日报了', message: '趁还记得', action: 'daily-report', actionLabel: '生成日报草稿',
    }],
  }))
  const onAction = vi.fn()
  const service = startReminderService({
    profileDir,
    shellOrigin: 'dsh-app://shell',
    ballBounds: () => undefined,
    preload: 'p.cjs',
    onAction,
    island,
    log: () => {},
  })
  running.push(service)
  const log = (): string => readFileSync(join(profileDir, REMINDER_LOG_FILE), 'utf8')
  return { profileDir, service, onAction, log }
}

describe('reminders while the island is up', () => {
  it('unfold from the island with a beep instead of the pop-up, and run the action when the button is pressed', async () => {
    const show = vi.fn<Island['show']>(async () => 'acted')
    const { onAction, log } = start({ active: () => true, show })
    await vi.advanceTimersByTimeAsync(10)
    expect(show).toHaveBeenCalledTimes(1)
    expect(show.mock.calls[0]?.[0]).toMatchObject({ id: 'daily-report', actionLabel: '生成日报草稿' })
    expect(popup.show).not.toHaveBeenCalled()
    expect(electron.beep).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({ id: 'daily-report' })
    expect(log()).toContain('shown daily-report (island)')
    expect(log()).toContain('closed daily-report (acted)')
  })

  it('does nothing more when the user just dismisses the card', async () => {
    const show = vi.fn(async () => 'dismissed' as const)
    const { onAction, log } = start({ active: () => true, show })
    await vi.advanceTimersByTimeAsync(10)
    expect(show).toHaveBeenCalledTimes(1)
    expect(onAction).not.toHaveBeenCalled()
    expect(log()).toContain('closed daily-report (dismissed)')
  })

  it('uses the pop-up in the middle of the screen when the island is not up', async () => {
    const show = vi.fn<Island['show']>(async () => 'acted')
    popup.show.mockReturnValue({ window: { webContents: {} }, closed: Promise.resolve() })
    start({ active: () => false, show })
    await vi.advanceTimersByTimeAsync(10)
    expect(show).not.toHaveBeenCalled()
    expect(popup.show).toHaveBeenCalledTimes(1)
  })

  it('tells the island which reminder is next, following the off-work time', () => {
    const { service } = start({ active: () => true, show: vi.fn() })
    // The only reminder was due at 18:20 and has just fired, so the next one is next week\'s Wednesday.
    const next = service.upcoming()
    expect(next?.entry.id).toBe('daily-report')
    expect(next?.at.getDate()).toBe(4)
  })
})
