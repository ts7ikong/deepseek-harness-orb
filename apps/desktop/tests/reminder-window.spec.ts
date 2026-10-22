import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class FakeBrowserWindow { readonly kind = 'window' },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getDisplayNearestPoint: vi.fn(), getPrimaryDisplay: vi.fn(), getCursorScreenPoint: vi.fn() },
  shell: { beep: vi.fn() },
  systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
}))

import {
  REMINDER_ACTION_EXTRA_HEIGHT,
  REMINDER_WINDOW_SIZE,
  reminderPageUrl,
  reminderRestBounds,
  reminderStartBounds,
  reminderWindowSize,
} from '../src/reminder-window.ts'
import { REMINDER_MOODS, type ReminderEntry } from '../src/reminders.ts'

const entry: ReminderEntry = {
  id: 'off-work',
  time: '18:30',
  days: [1, 2, 3, 4, 5],
  mood: 'celebrate',
  title: '下班啦',
  message: 'a & b <c> "d"',
}

describe('reminder window geometry', () => {
  const workArea = { x: 100, y: 50, width: 1000, height: 800 }

  it('rests in the middle of the work area', () => {
    expect(reminderRestBounds(workArea)).toEqual({
      x: 100 + (1000 - REMINDER_WINDOW_SIZE.width) / 2,
      y: 50 + (800 - REMINDER_WINDOW_SIZE.height) / 2,
      ...REMINDER_WINDOW_SIZE,
    })
  })

  it('starts centered on the ball so it appears to leave it', () => {
    const rest = reminderRestBounds(workArea)
    const ball = { x: 900, y: 400, width: 96, height: 96 }
    const start = reminderStartBounds(ball, rest)
    expect(start.x + start.width / 2).toBe(900 + 48)
    expect(start.y + start.height / 2).toBe(400 + 48)
    expect(start.width).toBe(REMINDER_WINDOW_SIZE.width)
  })

  it('is taller when the reminder carries an action button, and stays centered', () => {
    const withAction = reminderWindowSize({ ...entry, action: 'daily-report', actionLabel: '生成' })
    expect(withAction.height).toBe(REMINDER_WINDOW_SIZE.height + REMINDER_ACTION_EXTRA_HEIGHT)
    expect(reminderWindowSize(entry)).toEqual(REMINDER_WINDOW_SIZE)
    const rest = reminderRestBounds(workArea, withAction)
    expect(rest.y + rest.height / 2).toBe(50 + 800 / 2)
    expect(reminderStartBounds({ x: 900, y: 400, width: 96, height: 96 }, rest).height).toBe(withAction.height)
  })

  it('appears in place when there is no ball to fly from', () => {
    const rest = reminderRestBounds(workArea)
    expect(reminderStartBounds(undefined, rest)).toEqual(rest)
  })
})

describe('reminder page', () => {
  it('carries the text in the query string without letting it change the URL', () => {
    const url = new URL(reminderPageUrl('dsh-app://shell', entry, '点击任意处关闭'))
    // A custom scheme has an opaque `origin`, so compare its parts instead.
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('dsh-app://shell/reminder.html')
    expect(url.searchParams.get('mood')).toBe('celebrate')
    expect(url.searchParams.get('title')).toBe('下班啦')
    expect(url.searchParams.get('message')).toBe('a & b <c> "d"')
    expect(url.searchParams.get('hint')).toBe('点击任意处关闭')
  })

  it('passes the button label only for a reminder with an action', () => {
    const plain = new URL(reminderPageUrl('dsh-app://shell', entry, 'hint'))
    expect(plain.searchParams.has('actionLabel')).toBe(false)
    const withAction = new URL(reminderPageUrl('dsh-app://shell', { ...entry, action: 'daily-report', actionLabel: '生成日报草稿' }, 'hint'))
    expect(withAction.searchParams.get('actionLabel')).toBe('生成日报草稿')
  })

  it('lets a press on the button run its action instead of closing the pop-up', () => {
    const script = readFileSync(new URL('../renderer/reminder.js', import.meta.url), 'utf8')
    expect(script).toContain("closest('#action')")
    expect(script).toContain('dshDesktop.reminder.act()')
  })

  it('shows its text as text, never as markup', () => {
    const script = readFileSync(new URL('../renderer/reminder.js', import.meta.url), 'utf8')
    expect(script).toContain("querySelector('#message').textContent")
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/u)
  })

  it('only offers moods the face knows how to draw', () => {
    const face = readFileSync(new URL('../renderer/orb-face.css', import.meta.url), 'utf8')
    // idle is the unstyled default; every other mood must have its own rule.
    for (const mood of REMINDER_MOODS.filter(candidate => candidate !== 'idle')) {
      expect(face).toContain(`data-mood="${mood}"]`)
    }
  })
})
