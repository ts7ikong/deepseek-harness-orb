/** Context-isolated bridge for the floating-ball shell document. */

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'

const floating = {
  move: (x: number, y: number, canDock?: boolean) => ipcRenderer.invoke(DESKTOP_IPC.floatingMove, x, y, canDock),
  clamp: (canDock?: boolean) => ipcRenderer.invoke(DESKTOP_IPC.floatingClamp, canDock),
  unsnap: () => ipcRenderer.invoke(DESKTOP_IPC.floatingUnsnap),
  setExpanded: (expanded: boolean) => ipcRenderer.invoke(DESKTOP_IPC.floatingSetExpanded, expanded),
  sessionId: () => ipcRenderer.invoke(DESKTOP_IPC.floatingSessionGet),
  setSessionId: (sessionId: string) => ipcRenderer.invoke(DESKTOP_IPC.floatingSessionSet, sessionId),
  overlayModel: () => ipcRenderer.invoke(DESKTOP_IPC.floatingOverlayModelGet),
  onOverlayModel: (listener: (selection: unknown) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, selection: unknown): void => { listener(selection) }
    ipcRenderer.on(DESKTOP_IPC.floatingOverlayModel, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingOverlayModel, handle) }
  },
  overlayPermission: () => ipcRenderer.invoke(DESKTOP_IPC.floatingOverlayPermissionGet),
  setOverlayPermission: (preset: string, sessionId?: string) =>
    ipcRenderer.invoke(DESKTOP_IPC.floatingOverlayPermissionSet, preset, sessionId),
  orbWorkspacePath: () => ipcRenderer.invoke(DESKTOP_IPC.floatingOrbWorkspace),
  focusMain: () => ipcRenderer.invoke(DESKTOP_IPC.floatingFocusMain),
  quit: () => ipcRenderer.invoke(DESKTOP_IPC.floatingQuit),
  setSessionRunning: (running: boolean) => ipcRenderer.invoke(DESKTOP_IPC.floatingRunning, running),
  setTextEditing: (editing: boolean) => ipcRenderer.invoke(DESKTOP_IPC.floatingEditing, editing),
  restoreFrontApp: () => ipcRenderer.invoke(DESKTOP_IPC.floatingRestoreFront),
  avatarUrl: () => ipcRenderer.invoke(DESKTOP_IPC.floatingAvatarGet),
  onAvatar: (listener: (url: string) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, url: string): void => { listener(url) }
    ipcRenderer.on(DESKTOP_IPC.floatingAvatar, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingAvatar, handle) }
  },
  /** Global pointer position in screen DIPs, so the ball's eyes can follow it anywhere. */
  onCursor: (listener: (point: { x: number; y: number }) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, point: { x: number; y: number }): void => { listener(point) }
    ipcRenderer.on(DESKTOP_IPC.floatingCursor, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingCursor, handle) }
  },
  /** Whether the agent is physically driving the mouse and keyboard right now. */
  onActing: (listener: (acting: boolean) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, acting: boolean): void => { listener(acting) }
    ipcRenderer.on(DESKTOP_IPC.floatingActing, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingActing, handle) }
  },
  /** The ball has just said something by itself (proactive chat); the face reacts. */
  onSpeak: (listener: () => void) => {
    const handle = (): void => { listener() }
    ipcRenderer.on(DESKTOP_IPC.floatingSpeak, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingSpeak, handle) }
  },
  /** A daily-report request from the main process: send this prompt, then hand the reply back with `reportDraft`. */
  onReportPrompt: (listener: (payload: { text: string }) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, payload: { text: string }): void => { listener(payload) }
    ipcRenderer.on(DESKTOP_IPC.reportPrompt, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.reportPrompt, handle) }
  },
  /** Give the model's finished daily-report reply to the main process, which opens the confirmation window. */
  reportDraft: (text: string) => ipcRenderer.invoke(DESKTOP_IPC.reportDraft, text),
  onSelectionPrompt: (listener: (payload: { text: string }) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, payload: { text: string }): void => { listener(payload) }
    ipcRenderer.on(DESKTOP_IPC.selectionPrompt, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.selectionPrompt, handle) }
  },
  onSelectionAttach: (listener: (payload: { text: string }) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, payload: { text: string }): void => { listener(payload) }
    ipcRenderer.on(DESKTOP_IPC.selectionAttach, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.selectionAttach, handle) }
  },
  onCreateSession: (listener: () => void) => {
    const handle = (): void => { listener() }
    ipcRenderer.on(DESKTOP_IPC.floatingCreateSession, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingCreateSession, handle) }
  },
  tccStatus: () => ipcRenderer.invoke(DESKTOP_IPC.floatingTccGet),
  openTcc: (right: string) => ipcRenderer.invoke(DESKTOP_IPC.floatingTccOpen, right),
  relaunch: () => ipcRenderer.invoke(DESKTOP_IPC.floatingTccRelaunch),
  onTccStatus: (listener: (status: unknown) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, status: unknown): void => { listener(status) }
    ipcRenderer.on(DESKTOP_IPC.floatingTcc, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingTcc, handle) }
  },
}

/** Used only by the reminder pop-up; the main process accepts it from that window alone. */
const reminder = {
  act: () => ipcRenderer.invoke(DESKTOP_IPC.reminderAction),
}

/** The clock window below the ball receives its state once a second. */
const clock = {
  onState: (listener: (state: unknown) => void) => {
    const handle = (_event: unknown, state: unknown): void => { listener(state) }
    ipcRenderer.on(DESKTOP_IPC.clockState, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.clockState, handle) }
  },
}

/** Used only by the working-hours settings window; the main process accepts it from that window alone. */
const schedule = {
  get: () => ipcRenderer.invoke(DESKTOP_IPC.scheduleGet),
  set: (form: unknown) => ipcRenderer.invoke(DESKTOP_IPC.scheduleSet, form),
}

/** Used only by the report confirmation window; the main process accepts it from that window alone. */
const report = {
  init: () => ipcRenderer.invoke(DESKTOP_IPC.reportInit),
  confirm: (text: string, mode: 'log' | 'copy' | 'dingtalk') => ipcRenderer.invoke(DESKTOP_IPC.reportConfirm, text, mode),
}

const selection = {
  search: () => ipcRenderer.invoke(DESKTOP_IPC.selectionSearch),
  translate: () => ipcRenderer.invoke(DESKTOP_IPC.selectionTranslate),
  sendToAgent: () => ipcRenderer.invoke(DESKTOP_IPC.selectionAttach),
  setLanguage: (language: string) => ipcRenderer.invoke(DESKTOP_IPC.selectionSetLanguage, language),
  interact: () => ipcRenderer.invoke(DESKTOP_IPC.selectionInteract),
  setContentSize: (size: { width: number; height: number }) => ipcRenderer.invoke(DESKTOP_IPC.selectionSetContentSize, size),
  onState: (listener: (state: unknown) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: unknown): void => { listener(state) }
    ipcRenderer.on(DESKTOP_IPC.selectionState, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.selectionState, handle) }
  },
}

const backend = {
  status: () => ipcRenderer.invoke(DESKTOP_IPC.backendStatus),
  subscribe: (listener: (state: unknown) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: unknown): void => { listener(state) }
    ipcRenderer.on(DESKTOP_IPC.backendState, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.backendState, handle) }
  },
}

contextBridge.exposeInMainWorld('dshDesktop', {
  protocolVersion: 1,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.floatingLocale),
  backend,
  floating,
  reminder,
  clock,
  schedule,
  report,
  selection,
})
