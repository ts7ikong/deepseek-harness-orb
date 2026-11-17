/** Assistant windows are hidden from screen capture only while Computer Use captures or acts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeWindow {
  contentProtection = false
  destroyed = false
  isDestroyed(): boolean { return this.destroyed }
  setContentProtection(value: boolean): void { this.contentProtection = value }
}

const platform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

async function load(): Promise<typeof import('../src/capture-exclusion.ts')> {
  vi.resetModules()
  return import('../src/capture-exclusion.ts')
}

describe('capture exclusion', () => {
  beforeEach(() => { setPlatform('win32') })
  afterEach(() => { setPlatform(platform) })

  it('leaves a registered window visible to screenshots outside Computer Use', async () => {
    const { excludeFromComputerUseCapture } = await load()
    const window = new FakeWindow()
    excludeFromComputerUseCapture(window)
    expect(window.contentProtection).toBe(false)
  })

  it('hides registered windows until the last overlapping interval ends', async () => {
    const { excludeFromComputerUseCapture, setComputerUseCapture } = await load()
    const island = new FakeWindow()
    const menu = new FakeWindow()
    excludeFromComputerUseCapture(island)
    excludeFromComputerUseCapture(menu)
    setComputerUseCapture('begin')
    setComputerUseCapture('begin')
    expect([island.contentProtection, menu.contentProtection]).toEqual([true, true])
    setComputerUseCapture('end')
    expect(island.contentProtection).toBe(true)
    setComputerUseCapture('end')
    expect([island.contentProtection, menu.contentProtection]).toEqual([false, false])
    setComputerUseCapture('end')
    setComputerUseCapture('begin')
    expect(island.contentProtection).toBe(true)
  })

  it('hides a window created during a capture at once', async () => {
    const { excludeFromComputerUseCapture, setComputerUseCapture } = await load()
    setComputerUseCapture('begin')
    const bubble = new FakeWindow()
    excludeFromComputerUseCapture(bubble)
    expect(bubble.contentProtection).toBe(true)
  })

  it('reset closes every interval and skips destroyed windows', async () => {
    const { excludeFromComputerUseCapture, resetComputerUseCapture, setComputerUseCapture } = await load()
    const report = new FakeWindow()
    const closed = new FakeWindow()
    excludeFromComputerUseCapture(report)
    excludeFromComputerUseCapture(closed)
    setComputerUseCapture('begin')
    closed.destroyed = true
    closed.contentProtection = false
    resetComputerUseCapture()
    expect(report.contentProtection).toBe(false)
    setComputerUseCapture('begin')
    expect(closed.contentProtection).toBe(false)
  })

  it('never protects windows off Windows', async () => {
    setPlatform('darwin')
    const { excludeFromComputerUseCapture, setComputerUseCapture } = await load()
    const window = new FakeWindow()
    excludeFromComputerUseCapture(window)
    setComputerUseCapture('begin')
    expect(window.contentProtection).toBe(false)
  })
})
