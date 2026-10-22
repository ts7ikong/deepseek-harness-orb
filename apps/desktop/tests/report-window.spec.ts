import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class FakeBrowserWindow { readonly kind = 'window' },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getDisplayNearestPoint: vi.fn(), getPrimaryDisplay: vi.fn(), getCursorScreenPoint: vi.fn() },
  systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
}))

import { REPORT_WINDOW_SIZE, reportWindowBounds } from '../src/report-window.ts'

describe('report window geometry', () => {
  it('opens centered in the work area', () => {
    const bounds = reportWindowBounds({ x: 100, y: 50, width: 1000, height: 800 })
    expect(bounds.x + bounds.width / 2).toBe(100 + 500)
    expect(bounds.y + bounds.height / 2).toBe(50 + 400)
    expect(bounds.width).toBe(REPORT_WINDOW_SIZE.width)
  })
})

interface ConfirmResult {
  ok: boolean
  reason?: string
  pending?: number
  message?: string
  copied?: number
  write?: { added: number; skipped: number; total: number }
}

async function mountReport(options: {
  text: string
  existing?: number
  confirm?: (text: string, mode: 'log' | 'copy') => Promise<ConfirmResult>
}) {
  const dom = new JSDOM(readFileSync(new URL('../renderer/report.html', import.meta.url), 'utf8'), {
    runScripts: 'outside-only',
    url: 'dsh-app://shell/report.html',
  })
  const confirm = vi.fn(options.confirm ?? (async () => ({ ok: true, write: { added: 1, skipped: 0, total: 1 } })))
  const close = vi.fn()
  Object.defineProperty(dom.window, 'close', { value: close })
  Object.defineProperty(dom.window, 'dshDesktop', {
    value: {
      report: {
        init: async () => ({ text: options.text, date: '2026-10-20', existing: options.existing ?? 0, pendingMark: '（待补充）' }),
        confirm,
      },
    },
  })
  runInContext(readFileSync(new URL('../renderer/report.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  const document = dom.window.document
  const text = document.querySelector<HTMLTextAreaElement>('#text')
  const log = document.querySelector<HTMLButtonElement>('#log')
  const copy = document.querySelector<HTMLButtonElement>('#copy')
  const cancel = document.querySelector<HTMLButtonElement>('#cancel')
  const status = document.querySelector<HTMLElement>('#status')
  if (text === null || log === null || copy === null || cancel === null || status === null) throw new Error('missing report controls')
  await expect.poll(() => text.value).toBe(options.text)
  const type = (value: string) => {
    text.value = value
    text.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  }
  return { dom, document, text, log, copy, cancel, status, confirm, close, type }
}

describe('report confirmation page', () => {
  it('shows the draft and the date, and offers to confirm it', async () => {
    const page = await mountReport({ text: '处理甲\n处理乙' })
    try {
      expect(page.document.querySelector('#date')?.textContent).toBe('2026-10-20')
      expect(page.log.disabled).toBe(false)
      expect(page.status.textContent).toBe('')
    } finally { page.dom.window.close() }
  })

  it('says new entries are added after what the log already holds for today', async () => {
    const page = await mountReport({ text: '处理甲', existing: 3 })
    try {
      expect(page.document.querySelector('#intro')?.textContent).toContain('已有 3 条')
    } finally { page.dom.window.close() }
  })

  it('holds back the write while an entry is still marked to-be-filled, and releases it once settled', async () => {
    const page = await mountReport({ text: '处理甲\n部署乙（待补充）\n修复丙(待补充)' })
    try {
      expect(page.log.disabled).toBe(true)
      expect(page.status.className).toBe('warn')
      expect(page.status.textContent).toContain('2 处')
      page.type('处理甲\n部署乙：已上线\n修复丙(待补充)')
      expect(page.log.disabled).toBe(true)
      expect(page.status.textContent).toContain('1 处')
      page.type('处理甲\n部署乙：已上线')
      expect(page.log.disabled).toBe(false)
      expect(page.status.textContent).toBe('')
    } finally { page.dom.window.close() }
  })

  it('does not allow confirming an empty draft', async () => {
    const page = await mountReport({ text: '处理甲' })
    try {
      page.type('   \n ')
      expect(page.log.disabled).toBe(true)
      expect(page.copy.disabled).toBe(true)
    } finally { page.dom.window.close() }
  })

  it('writes the edited text, reports what was added, and closes itself', async () => {
    const page = await mountReport({
      text: '处理甲',
      confirm: async () => ({ ok: true, write: { added: 2, skipped: 1, total: 4 } }),
    })
    try {
      page.type('处理甲\n处理乙\n处理丙')
      page.log.click()
      await expect.poll(() => page.status.className).toBe('ok')
      expect(page.confirm).toHaveBeenCalledWith('处理甲\n处理乙\n处理丙', 'log')
      expect(page.status.textContent).toBe('已记入 2 条（1 条今天已有，已跳过）')
      await expect.poll(() => page.close.mock.calls.length, { timeout: 3000 }).toBe(1)
    } finally { page.dom.window.close() }
  })

  it('stays open and says why when the write fails, so nothing the user typed is lost', async () => {
    const page = await mountReport({
      text: '处理甲',
      confirm: async () => ({ ok: false, reason: 'error', message: 'the work log is not valid JSON' }),
    })
    try {
      page.log.click()
      await expect.poll(() => page.status.className).toBe('error')
      expect(page.status.textContent).toContain('the work log is not valid JSON')
      expect(page.close).not.toHaveBeenCalled()
      expect(page.text.value).toBe('处理甲')
      expect(page.log.disabled).toBe(false)
    } finally { page.dom.window.close() }
  })

  it('copies the text without writing, and cancels with the button or Escape', async () => {
    const page = await mountReport({
      text: '处理甲',
      confirm: async (_text, mode) => (mode === 'copy' ? { ok: true, copied: 1 } : { ok: false, reason: 'empty' }),
    })
    try {
      page.copy.click()
      await expect.poll(() => page.status.textContent).toBe('已复制 1 条')
      expect(page.confirm).toHaveBeenCalledWith('处理甲', 'copy')
      expect(page.close).not.toHaveBeenCalled()
      page.cancel.click()
      expect(page.close).toHaveBeenCalledTimes(1)
      page.document.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
      expect(page.close).toHaveBeenCalledTimes(2)
    } finally { page.dom.window.close() }
  })

  it('confirms with Ctrl+Enter from inside the text', async () => {
    const page = await mountReport({ text: '处理甲' })
    try {
      page.document.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }))
      await expect.poll(() => page.confirm.mock.calls.length).toBe(1)
      expect(page.confirm).toHaveBeenCalledWith('处理甲', 'log')
    } finally { page.dom.window.close() }
  })

  it('shows its text as text and only talks to the main process through the report bridge', () => {
    const script = readFileSync(new URL('../renderer/report.js', import.meta.url), 'utf8')
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|eval\(/u)
    expect(script).toContain('window.dshDesktop?.report')
  })
})
