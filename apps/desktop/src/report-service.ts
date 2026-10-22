/** Opens the report confirmation window for a draft and writes what the user confirms into the work log. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipboard, ipcMain, shell, type BrowserWindow } from 'electron'
import type { ActivityConfig } from './activity-log.ts'
import { DESKTOP_IPC } from './ipc.ts'
import { showReportWindow } from './report-window.ts'
import { localDateKey } from './reminders.ts'
import {
  cleanReportLines,
  confirmReportText,
  countPending,
  countWorkLogEntries,
  parseConfirmedLines,
  PENDING_MARK,
  resolveWorkLogFile,
  type ConfirmResult,
} from './work-log.ts'

/** Which report a draft is for. A weekly one is copied out to DingTalk rather than written to the work log. */
export type ReportKind = 'daily' | 'weekly'

/** Profile-relative folder keeping the weekly reports the user confirmed. */
export const WEEKLY_REPORTS_DIR = 'orb-weekly-reports'

/** Protocol DingTalk registers on Windows; opening it brings the app forward, starting it when needed. */
export const DINGTALK_URL = 'dingtalk://'

/** What the confirmation window shows when it opens. */
export interface ReportInit {
  readonly kind: ReportKind
  readonly text: string
  readonly date: string
  /** Entries today's log already holds, which new ones are added after. */
  readonly existing: number
  readonly pendingMark: string
}

/** Handle returned by {@link startReportService}. */
export interface ReportService {
  /** Open the window for a model reply, replacing any draft already open. */
  showDraft(reply: string, kind?: ReportKind): void
  stop(): void
}

/** Result of the copy button. */
export type CopyResult = { readonly ok: true; readonly copied: number } | { readonly ok: false; readonly reason: 'empty' }

/** Result of the weekly report's "copy and open DingTalk" button. */
export type DingTalkResult =
  | { readonly ok: true; readonly copied: number; readonly opened: boolean; readonly savedTo: string }
  | { readonly ok: false; readonly reason: 'empty' }
  | { readonly ok: false; readonly reason: 'pending'; readonly pending: number }
  | { readonly ok: false; readonly reason: 'error'; readonly message: string }

/**
 * Start the report service.
 * @param options.profileDir - Desktop profile directory, home of the default work log.
 * @param options.shellOrigin - custom-protocol origin serving the renderer folder.
 * @param options.preload - preload script given to the confirmation window.
 * @param options.settings - the current activity settings, which name the work log file.
 * @param options.ballBounds - floating ball window bounds, to open on the same display.
 * @returns the running service.
 */
export function startReportService(options: {
  readonly profileDir: string
  readonly shellOrigin: string
  readonly preload: string
  readonly settings: () => ActivityConfig | undefined
  readonly ballBounds: () => { x: number; y: number; width: number; height: number } | undefined
  /** Brings DingTalk forward; resolves false when it could not be opened. Defaults to opening {@link DINGTALK_URL}. */
  readonly openDingTalk?: () => Promise<boolean>
}): ReportService {
  const openDingTalk = options.openDingTalk ?? (async (): Promise<boolean> => {
    try {
      await shell.openExternal(DINGTALK_URL)
      return true
    } catch {
      return false
    }
  })
  let current: { readonly window: BrowserWindow; readonly lines: readonly string[]; readonly kind: ReportKind } | undefined

  const workLogFile = (): string => resolveWorkLogFile(options.settings()?.workLogFile ?? '', options.profileDir)

  // Only the confirmation window that is open may read its draft or confirm it.
  const owned = (sender: unknown): boolean => current !== undefined && sender === current.window.webContents

  async function sendWeekly(text: string): Promise<DingTalkResult> {
    const lines = parseConfirmedLines(text)
    if (lines.length === 0) return { ok: false, reason: 'empty' }
    const pending = countPending(lines)
    if (pending > 0) return { ok: false, reason: 'pending', pending }
    const body = lines.join('\n')
    try {
      const dir = join(options.profileDir, WEEKLY_REPORTS_DIR)
      mkdirSync(dir, { recursive: true })
      const savedTo = join(dir, `${localDateKey(new Date())}.txt`)
      writeFileSync(savedTo, `${body}\n`)
      clipboard.writeText(body)
      // The report stays on the clipboard for the user to paste and send; nothing is sent from here.
      return { ok: true, copied: lines.length, opened: await openDingTalk(), savedTo }
    } catch (error) {
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  ipcMain.handle(DESKTOP_IPC.reportInit, (event): ReportInit => {
    if (current === undefined || !owned(event.sender)) {
      throw new Error('dsh desktop: rejected report IPC from an unowned renderer')
    }
    const today = new Date()
    return {
      kind: current.kind,
      text: current.lines.join('\n'),
      date: localDateKey(today),
      existing: current.kind === 'daily' ? countWorkLogEntries(workLogFile(), localDateKey(today)) : 0,
      pendingMark: PENDING_MARK,
    }
  })

  ipcMain.handle(DESKTOP_IPC.reportConfirm, (event, text: unknown, mode: unknown): ConfirmResult | CopyResult | Promise<DingTalkResult> => {
    if (!owned(event.sender)) throw new Error('dsh desktop: rejected report IPC from an unowned renderer')
    if (typeof text !== 'string' || (mode !== 'log' && mode !== 'copy' && mode !== 'dingtalk')) {
      throw new Error('dsh desktop: report confirm requires text and a mode')
    }
    if (mode === 'dingtalk') {
      if (current?.kind !== 'weekly') throw new Error('dsh desktop: only a weekly report goes to DingTalk')
      return sendWeekly(text)
    }
    if (mode === 'log' && current?.kind === 'weekly') {
      throw new Error('dsh desktop: a weekly report is not written to the daily work log')
    }
    if (mode === 'copy') {
      const lines = parseConfirmedLines(text)
      if (lines.length === 0) return { ok: false, reason: 'empty' }
      clipboard.writeText(lines.join('\n'))
      return { ok: true, copied: lines.length }
    }
    return confirmReportText(text, workLogFile(), new Date())
  })

  return {
    showDraft: (reply, kind = 'daily') => {
      current?.window.close()
      const window = showReportWindow({
        shellOrigin: options.shellOrigin,
        preload: options.preload,
        near: options.ballBounds(),
      })
      const opened = { window, lines: cleanReportLines(reply), kind }
      current = opened
      window.once('closed', () => {
        if (current === opened) current = undefined
      })
    },
    stop: () => {
      ipcMain.removeHandler(DESKTOP_IPC.reportInit)
      ipcMain.removeHandler(DESKTOP_IPC.reportConfirm)
      current?.window.close()
    },
  }
}
