import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getCursorScreenPoint = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ screen: { getCursorScreenPoint } }))

import { CURSOR_FEED_MS, startCursorFeed } from '../src/cursor-feed.ts'

function fakeWindow() {
  const state = { destroyed: false, visible: true }
  const send = vi.fn()
  const window = {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    webContents: { send },
  }
  return { window, state, send }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  getCursorScreenPoint.mockReset()
})

describe('startCursorFeed', () => {
  it('sends the pointer position only when it changes', () => {
    const { window, send } = fakeWindow()
    getCursorScreenPoint.mockReturnValue({ x: 10, y: 20 })
    const feed = startCursorFeed(window as never, 'cursor')
    vi.advanceTimersByTime(CURSOR_FEED_MS * 3)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('cursor', { x: 10, y: 20 })
    getCursorScreenPoint.mockReturnValue({ x: 11, y: 20 })
    vi.advanceTimersByTime(CURSOR_FEED_MS)
    expect(send).toHaveBeenCalledTimes(2)
    feed.stop()
  })

  it('sends nothing while the window is hidden, and catches up when it shows again', () => {
    const { window, state, send } = fakeWindow()
    getCursorScreenPoint.mockReturnValue({ x: 1, y: 1 })
    state.visible = false
    const feed = startCursorFeed(window as never, 'cursor')
    vi.advanceTimersByTime(CURSOR_FEED_MS * 4)
    expect(send).not.toHaveBeenCalled()
    state.visible = true
    vi.advanceTimersByTime(CURSOR_FEED_MS)
    expect(send).toHaveBeenCalledTimes(1)
    feed.stop()
  })

  it('ends by itself once the window is destroyed and can be stopped early', () => {
    const { window, state, send } = fakeWindow()
    getCursorScreenPoint.mockReturnValue({ x: 1, y: 1 })
    startCursorFeed(window as never, 'cursor')
    state.destroyed = true
    vi.advanceTimersByTime(CURSOR_FEED_MS)
    expect(vi.getTimerCount()).toBe(0)
    expect(send).not.toHaveBeenCalled()

    const second = fakeWindow()
    const feed = startCursorFeed(second.window as never, 'cursor')
    feed.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
