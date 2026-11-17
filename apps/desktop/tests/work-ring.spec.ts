import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: vi.fn(), screen: {}, desktopCapturer: {} }))
vi.mock('../src/floating-window.ts', () => ({ presentOverlayWindow: () => {} }))

import { pointerOverBall } from '../src/clock-service.ts'

const RING_LENGTH = 2 * Math.PI * 40

function mount() {
  const dom = new JSDOM(readFileSync(new URL('../renderer/floating.html', import.meta.url), 'utf8'), {
    runScripts: 'outside-only',
    url: 'dsh-app://shell/floating.html',
  })
  runInContext(readFileSync(new URL('../renderer/work-ring.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  const set = (progress: unknown) => { (dom.window as unknown as { setWorkRing: (value: unknown) => void }).setWorkRing(progress) }
  const fill = dom.window.document.querySelector<SVGCircleElement>('#work-ring-fill')!
  return { dom, set, fill, body: dom.window.document.body }
}

describe('the work progress ring', () => {
  it('is part of the ball, hidden until there is progress', () => {
    const { dom, body } = mount()
    expect(dom.window.document.querySelector('#ball #work-ring')).not.toBeNull()
    expect(body.classList.contains('has-work')).toBe(false)
  })

  it('fills the circle in proportion to the percent and notes the phase', () => {
    const { set, fill, body } = mount()
    set({ phase: 'afternoon', percent: 50 })
    expect(body.classList.contains('has-work')).toBe(true)
    expect(body.dataset.workPhase).toBe('afternoon')
    const [drawn, total] = fill.style.strokeDasharray.split(' ').map(Number)
    expect(total).toBeCloseTo(RING_LENGTH)
    expect(drawn).toBeCloseTo(RING_LENGTH / 2)
  })

  it('stays within 0 to 100 percent', () => {
    const { set, fill } = mount()
    set({ phase: 'after', percent: 250 })
    expect(Number(fill.style.strokeDasharray.split(' ')[0])).toBeCloseTo(RING_LENGTH)
    set({ phase: 'before', percent: -5 })
    expect(Number(fill.style.strokeDasharray.split(' ')[0])).toBe(0)
  })

  it('goes away when there is no progress, or on a day off', () => {
    const { set, body } = mount()
    set({ phase: 'morning', percent: 10 })
    set(null)
    expect(body.classList.contains('has-work')).toBe(false)
    set({ phase: 'morning', percent: 10 })
    set({ phase: 'rest', percent: 0 })
    expect(body.classList.contains('has-work')).toBe(false)
    set(undefined)
    set({ phase: 'morning' })
    expect(body.classList.contains('has-work')).toBe(false)
  })
})

describe('the percent under the eyes', () => {
  const digits = (dom: JSDOM) => dom.window.document.querySelector<SVGSVGElement>('#work-percent')!
  const segmentsOf = (dom: JSDOM, glyph: string) =>
    [...digits(dom).querySelectorAll(`g[data-glyph="${glyph}"] path`)].map(path => path.getAttribute('data-segment'))

  it('sits inside the ball, next to the face', () => {
    const { dom } = mount()
    expect(dom.window.document.querySelector('#ball #work-percent')).not.toBeNull()
  })

  it('draws each digit from the right seven-segment strokes, then a percent sign', () => {
    const { dom, set } = mount()
    set({ phase: 'afternoon', percent: 86 })
    expect(digits(dom).dataset.value).toBe('86')
    expect([...digits(dom).querySelectorAll('g')].map(group => group.getAttribute('data-glyph'))).toEqual(['8', '6', '%'])
    expect(segmentsOf(dom, '8')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(segmentsOf(dom, '6')).toEqual(['a', 'c', 'd', 'e', 'f', 'g'])
    expect(digits(dom).querySelectorAll('g[data-glyph="%"] circle')).toHaveLength(2)
  })

  it('follows the progress, and does not redraw when the number has not changed', () => {
    const { dom, set } = mount()
    set({ phase: 'morning', percent: 7 })
    const first = digits(dom).querySelector('g')
    set({ phase: 'morning', percent: 7 })
    expect(digits(dom).querySelector('g')).toBe(first)
    set({ phase: 'morning', percent: 100 })
    expect([...digits(dom).querySelectorAll('g')].map(group => group.getAttribute('data-glyph'))).toEqual(['1', '0', '0', '%'])
    expect(segmentsOf(dom, '1')).toEqual(['b', 'c'])
  })

  it('rounds to a whole number and stays within 0 to 100', () => {
    const { dom, set } = mount()
    set({ phase: 'morning', percent: 42.6 })
    expect(digits(dom).dataset.value).toBe('43')
    set({ phase: 'after', percent: 999 })
    expect(digits(dom).dataset.value).toBe('100')
  })
})

describe('pointerOverBall', () => {
  const ball = { x: 100, y: 100, width: 96, height: 96 }
  it('counts the ball\'s circle and a small margin, not its window corners', () => {
    expect(pointerOverBall(ball, { x: 148, y: 148 })).toBe(true)
    expect(pointerOverBall(ball, { x: 148 + 40, y: 148 })).toBe(true)
    expect(pointerOverBall(ball, { x: 148 + 44, y: 148 })).toBe(false)
    expect(pointerOverBall(ball, { x: 102, y: 102 })).toBe(false)
  })
})
