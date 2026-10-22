/** Which application and window the user is looking at right now (Windows only). */

import { basename, extname } from 'node:path'
import koffi from 'koffi'

/** The foreground window: the owning program's name without `.exe`, and the window title. */
export interface ForegroundWindow {
  readonly app: string
  readonly title: string
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TITLE_CHARS = 512
const PATH_CHARS = 1024

interface ForegroundApi {
  readonly GetForegroundWindow: () => unknown
  readonly GetWindowTextW: (hwnd: unknown, buffer: Buffer, max: number) => number
  readonly GetWindowThreadProcessId: (hwnd: unknown, pid: number[]) => number
  readonly OpenProcess: (access: number, inherit: number, pid: number) => unknown
  readonly QueryFullProcessImageNameW: (process: unknown, flags: number, buffer: Buffer, size: number[]) => number
  readonly CloseHandle: (handle: unknown) => number
}

let api: ForegroundApi | undefined

function foregroundApi(): ForegroundApi {
  if (api !== undefined) return api
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  api = {
    GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()') as ForegroundApi['GetForegroundWindow'],
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hWnd, _Out_ uint8_t *text, int max)') as ForegroundApi['GetWindowTextW'],
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)') as ForegroundApi['GetWindowThreadProcessId'],
    OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)') as ForegroundApi['OpenProcess'],
    QueryFullProcessImageNameW: kernel32.func('int __stdcall QueryFullProcessImageNameW(void *process, uint32 flags, _Out_ uint8_t *name, _Inout_ uint32 *size)') as ForegroundApi['QueryFullProcessImageNameW'],
    CloseHandle: kernel32.func('int __stdcall CloseHandle(void *handle)') as ForegroundApi['CloseHandle'],
  }
  return api
}

/**
 * Program name from a full executable path.
 * @param path - such as `C:\Program Files\Google\Chrome\Application\chrome.exe`.
 * @returns the file name without its extension, such as `chrome`.
 */
export function programNameFromPath(path: string): string {
  const name = basename(path.replaceAll('\\', '/'))
  const extension = extname(name)
  return extension === '' ? name : name.slice(0, -extension.length)
}

function processImagePath(native: ForegroundApi, pid: number): string | undefined {
  const handle = native.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (handle === null || handle === undefined) return undefined
  try {
    const buffer = Buffer.alloc(PATH_CHARS * 2)
    const size = [PATH_CHARS]
    if (native.QueryFullProcessImageNameW(handle, 0, buffer, size) === 0) return undefined
    return buffer.toString('utf16le', 0, (size[0] ?? 0) * 2)
  } finally {
    native.CloseHandle(handle)
  }
}

/**
 * Read the foreground window.
 * @returns the program and title, or undefined off Windows, with no foreground window, or when the
 * owning process cannot be inspected (for example an elevated program).
 */
export function readForegroundWindow(): ForegroundWindow | undefined {
  if (process.platform !== 'win32') return undefined
  const native = foregroundApi()
  const hwnd = native.GetForegroundWindow()
  if (hwnd === null || hwnd === undefined) return undefined
  const titleBuffer = Buffer.alloc(TITLE_CHARS * 2)
  const length = native.GetWindowTextW(hwnd, titleBuffer, TITLE_CHARS)
  const title = titleBuffer.toString('utf16le', 0, Math.max(0, length) * 2)
  const pid = [0]
  native.GetWindowThreadProcessId(hwnd, pid)
  const path = pid[0] === undefined || pid[0] === 0 ? undefined : processImagePath(native, pid[0])
  if (path === undefined) return undefined
  return { app: programNameFromPath(path), title }
}
