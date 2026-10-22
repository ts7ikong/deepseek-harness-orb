import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

function mountClock() {
  const dom = new JSDOM(readFileSync(new URL('../renderer/clock.html', import.meta.url), 'utf8'), {
    runScripts: 'outside-only',
    url: 'dsh-app://shell/clock.html',
  })
  let push: (state: unknown) => void = () => {}
  Object.defineProperty(dom.window, 'dshDesktop', {
    value: { clock: { onState: (listener: (state: unknown) => void) => { push = listener; return () => {} } } },
  })
  runInContext(readFileSync(new URL('../renderer/clock.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  const text = (selector: string) => dom.window.document.querySelector<HTMLElement>(selector)
  return { push: (state: unknown) => { push(state) }, text }
}

describe('the clock page', () => {
  it('stays hidden until the first state arrives, then shows the date and time', () => {
    const { push, text } = mountClock()
    expect(text('#chip')?.hidden).toBe(true)
    push({ date: '2026年10月20日 周二', time: '09:05:07' })
    expect(text('#chip')?.hidden).toBe(false)
    expect(text('#time')?.textContent).toBe('09:05:07')
    expect(text('#date')?.textContent).toBe('2026年10月20日 周二')
  })

  it('has no progress bar when the working hours are not set', () => {
    const { push, text } = mountClock()
    push({ date: 'd', time: 't' })
    expect(text('#work')?.hidden).toBe(true)
  })

  it('shows the phase, percent, bar, and time left while working', () => {
    const { push, text } = mountClock()
    push({ date: 'd', time: 't', progress: { phase: 'afternoon', percent: 70, workedMs: 0, remainingMs: 2.25 * 3_600_000 } })
    expect(text('#work')?.hidden).toBe(false)
    expect(text('#phase')?.textContent).toBe('下午工作中')
    expect(text('#percent')?.textContent).toBe('70%')
    expect(text('#fill')?.style.width).toBe('70%')
    expect(text('#left')?.textContent).toBe('距离下班还有 2 小时 15 分钟')
  })

  it('says it is over after work and on a rest day, without a countdown', () => {
    const { push, text } = mountClock()
    push({ date: 'd', time: 't', progress: { phase: 'after', percent: 100, workedMs: 1, remainingMs: 0 } })
    expect(text('#phase')?.textContent).toBe('已下班')
    expect(text('#left')?.hidden).toBe(true)
    push({ date: 'd', time: 't', progress: { phase: 'rest', percent: 0, workedMs: 0, remainingMs: 0 } })
    expect(text('#phase')?.textContent).toBe('今天休息')
    expect(text('#percent')?.textContent).toBe('')
  })

  it('ignores malformed state', () => {
    const { push, text } = mountClock()
    push(undefined)
    push({ time: 5 })
    expect(text('#chip')?.hidden).toBe(true)
  })
})

describe('the weekly report page', () => {
  async function mountWeekly(confirm = vi.fn(async () => ({ ok: true, copied: 2, opened: true }))) {
    const dom = new JSDOM(readFileSync(new URL('../renderer/report.html', import.meta.url), 'utf8'), {
      runScripts: 'outside-only',
      url: 'dsh-app://shell/report.html',
    })
    Object.defineProperty(dom.window, 'close', { value: vi.fn() })
    Object.defineProperty(dom.window, 'dshDesktop', {
      value: { report: { init: async () => ({ kind: 'weekly', text: '处理甲\n处理乙', date: '2026-10-23', existing: 0, pendingMark: '（待补充）' }), confirm } },
    })
    runInContext(readFileSync(new URL('../renderer/report.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    const document = dom.window.document
    await expect.poll(() => document.querySelector<HTMLTextAreaElement>('#text')?.value).toBe('处理甲\n处理乙')
    return { dom, document, confirm }
  }

  it('shows the DingTalk button instead of the work-log one, under a weekly title', async () => {
    const { document } = await mountWeekly()
    expect(document.querySelector<HTMLElement>('#log')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('#dingtalk')?.hidden).toBe(false)
    expect(document.querySelector('#title')?.textContent).toBe('周报草稿')
  })

  it('sends the text in DingTalk mode and tells the user to paste', async () => {
    const { dom, document, confirm } = await mountWeekly()
    document.querySelector<HTMLButtonElement>('#dingtalk')?.click()
    await expect.poll(() => document.querySelector('#status')?.textContent).toContain('打开钉钉')
    expect(confirm).toHaveBeenCalledWith('处理甲\n处理乙', 'dingtalk')
    expect(dom.window.document.querySelector('#status')?.textContent).toContain('粘贴')
  })

  it('blocks the DingTalk button while an entry is still marked to be filled in', async () => {
    const { dom, document } = await mountWeekly()
    const text = document.querySelector<HTMLTextAreaElement>('#text')!
    text.value = '下周计划：（待补充）'
    text.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect(document.querySelector<HTMLButtonElement>('#dingtalk')?.disabled).toBe(true)
  })
})
