/**
 * Screen descriptions: every few minutes, take a screenshot of each display, ask a vision model for one sentence about
 * what the user is doing, and keep that sentence locally as extra context for the daily report.
 *
 * Only that one sentence is stored. The screenshots are sent to the model's service and are never written to disk.
 * Nothing is captured while the user is away, or while the foreground program is one the activity privacy settings
 * (`orb-activity.json`) never records or only records by name, such as a password manager or a chat app.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktopCapturer, powerMonitor } from 'electron'
import {
  expandEnvironment,
  filterObservation,
  HIDDEN_TITLE,
  NATIVE_VISION_DIR,
  type ActivityConfig,
} from './activity-log.ts'
import { readForegroundWindow, type ForegroundWindow } from './foreground-window.ts'
import { localDateKey } from './reminders.ts'

/** Profile-relative JSON holding the screen-description settings; edits apply within a minute. */
export const VISION_CONFIG_FILE = 'orb-vision.json'

/** Where the previous desktop assistant keeps the model access this reads by default. */
export const DEFAULT_CREDENTIALS_FILE = '%APPDATA%\\VPet-WorkingPet\\ai_config.json'

/** Volcengine Ark's OpenAI-compatible endpoint, used when the credentials file names no address. */
export const DEFAULT_VISION_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

const MAX_NOTE_CHARS = 120
const REQUEST_TIMEOUT_MS = 60_000
const CHECK_EVERY_MS = 30_000
const FAILURE_BACKOFF_MS = 10 * 60_000
/** Longest side of a screenshot sent to the model. */
const IMAGE_MAX_WIDTH = 1600
const JPEG_QUALITY = 70

export interface VisionConfig {
  readonly enabled: boolean
  /** Minutes between descriptions. */
  readonly intervalMinutes: number
  /**
   * JSON file holding the model access: `endpoint_id` (the model), `api_key`, and optionally `api_url`.
   * Read each time it is needed; the key is never copied anywhere. `%NAME%` expands to an environment variable.
   */
  readonly credentialsFile: string
}

/** Model access read from the credentials file. */
export interface VisionCredentials {
  readonly model: string
  readonly apiKey: string
  readonly baseUrl: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The file a fresh profile starts with.
 * @returns the JSON text.
 */
export function defaultVisionText(): string {
  return `${JSON.stringify({
    help: '每隔 intervalMinutes 分钟截一次屏，让视觉模型用一句话概括你在做什么，只保存这句话（截图不落盘），给日报当补充线索。'
      + '用户空闲时、前台是密码管理器或聊天软件时不截。credentialsFile 指向保存模型接入点（endpoint_id）和密钥（api_key）的 JSON，'
      + '每次直接读取，密钥不会被复制。enabled 设为 false 即关闭。改动一分钟内生效。',
    enabled: true,
    intervalMinutes: 20,
    credentialsFile: DEFAULT_CREDENTIALS_FILE,
  }, undefined, 2)}\n`
}

/**
 * Parse the config text, falling back to the defaults for anything missing or invalid.
 * @param text - JSON file contents.
 * @returns the config (absent when the JSON is unusable) and a message per adjusted value.
 */
export function parseVisionConfig(text: string): { config: VisionConfig | undefined; problems: string[] } {
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { config: undefined, problems: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!isRecord(raw)) return { config: undefined, problems: ['the top level must be an object'] }
  let intervalMinutes = 20
  if (raw.intervalMinutes !== undefined) {
    if (typeof raw.intervalMinutes === 'number' && Number.isFinite(raw.intervalMinutes) && raw.intervalMinutes >= 5 && raw.intervalMinutes <= 240) {
      intervalMinutes = Math.round(raw.intervalMinutes)
    } else {
      problems.push('intervalMinutes must be a number from 5 to 240; using 20')
    }
  }
  return {
    config: {
      enabled: raw.enabled !== false,
      intervalMinutes,
      credentialsFile: typeof raw.credentialsFile === 'string' && raw.credentialsFile !== '' ? raw.credentialsFile : DEFAULT_CREDENTIALS_FILE,
    },
    problems,
  }
}

/**
 * Read the config, writing the starter file first when none exists.
 * @param profileDir - Desktop profile directory.
 * @returns the parsed result.
 */
export function readVisionConfig(profileDir: string): { config: VisionConfig | undefined; problems: string[] } {
  const path = join(profileDir, VISION_CONFIG_FILE)
  if (!existsSync(path)) {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(path, defaultVisionText())
  }
  return parseVisionConfig(readFileSync(path, 'utf8'))
}

/**
 * Read the model access from the credentials file.
 * @param file - the credentials file path; `%NAME%` expands to an environment variable.
 * @returns the access, or undefined when the file is missing, unreadable, or lacks the model or key.
 */
export function readVisionCredentials(file: string): VisionCredentials | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(expandEnvironment(file), 'utf8'))
    if (!isRecord(raw)) return undefined
    const model = typeof raw.endpoint_id === 'string' ? raw.endpoint_id.trim() : ''
    const apiKey = typeof raw.api_key === 'string' ? raw.api_key.trim() : ''
    if (model === '' || apiKey === '') return undefined
    const url = typeof raw.api_url === 'string' ? raw.api_url.trim() : ''
    return { model, apiKey, baseUrl: (url === '' ? DEFAULT_VISION_BASE_URL : url).replace(/\/+$/u, '') }
  } catch {
    return undefined
  }
}

/** The question asked of the model along with the screenshots. */
export const VISION_PROMPT = [
  '下面是用户电脑上各个屏幕此刻的截图。请用一句话（不超过 60 个字）概括他现在在做什么工作，',
  '例如“正在编写 Java 代码，同时查看服务器配置”。',
  '只描述在做的事和涉及的对象（项目、系统、软件），不要抄录聊天内容、账号、密码、手机号、证件号等具体文字。',
  '只输出这一句话；实在看不出就回答“无法判断”。',
].join('')

/**
 * The chat-completions request body.
 * @param model - the model or endpoint id.
 * @param images - screenshots as JPEG base64 text, one per display.
 * @returns the JSON-serializable body.
 */
export function buildVisionRequest(model: string, images: readonly string[]): Record<string, unknown> {
  return {
    model,
    max_tokens: 200,
    temperature: 0.2,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: VISION_PROMPT },
        ...images.map(image => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } })),
      ],
    }],
  }
}

/**
 * The sentence in a chat-completions reply.
 * @param reply - the parsed JSON response.
 * @returns one trimmed line of at most 120 characters; undefined when empty or when the model could not tell.
 */
export function parseVisionReply(reply: unknown): string | undefined {
  const content = isRecord(reply) && Array.isArray(reply.choices) && isRecord(reply.choices[0]) && isRecord(reply.choices[0].message)
    ? reply.choices[0].message.content
    : undefined
  if (typeof content !== 'string') return undefined
  const line = content.replaceAll('\r', '').split('\n').map(part => part.trim()).find(part => part !== '')
  if (line === undefined || line.includes('无法判断')) return undefined
  return line.length > MAX_NOTE_CHARS ? `${line.slice(0, MAX_NOTE_CHARS - 1)}…` : line
}

/**
 * Store one description for the day. A line identical to the day's last one is not added again.
 * @param dir - folder of `YYYY-MM-DD.jsonl` files.
 * @param dateKey - local date as `YYYY-MM-DD`.
 * @param time - local `HH:MM`.
 * @param text - the description.
 * @returns whether a line was added.
 */
export function appendVisionNote(dir: string, dateKey: string, time: string, text: string): boolean {
  const file = join(dir, `${dateKey}.jsonl`)
  mkdirSync(dir, { recursive: true })
  if (existsSync(file)) {
    const last = readFileSync(file, 'utf8').trimEnd().split('\n').at(-1)
    try {
      if (last !== undefined && last !== '' && (JSON.parse(last) as { description?: unknown }).description === text) return false
    } catch {
      // A damaged last line does not stop a new one being added.
    }
  }
  appendFileSync(file, `${JSON.stringify({ time, description: text })}\n`)
  return true
}

/**
 * Whether the screen may be captured for the foreground window, by the activity privacy settings.
 * @param foreground - the foreground window; unknown windows are not captured.
 * @param activity - the recorder's privacy settings.
 * @returns true when the program is not ignored, is not one whose titles are hidden, and the title has no hidden word.
 */
export function mayCaptureFor(foreground: ForegroundWindow | undefined, activity: ActivityConfig): boolean {
  if (foreground === undefined) return false
  const allowed = filterObservation(foreground, activity)
  return allowed !== undefined && allowed.title !== HIDDEN_TITLE
}

/** One screenshot per display as JPEG base64 text. */
export type CaptureScreens = () => Promise<string[]>

/** Capture every display with Electron's screen capturer. */
export const captureScreens: CaptureScreens = async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: IMAGE_MAX_WIDTH, height: IMAGE_MAX_WIDTH },
  })
  return sources
    .filter(source => !source.thumbnail.isEmpty())
    .map(source => source.thumbnail.toJPEG(JPEG_QUALITY).toString('base64'))
}

/** Handle returned by {@link startScreenVision}. */
export interface ScreenVision {
  stop(): void
}

/**
 * Start describing the screen on a timer.
 * @param options.profileDir - Desktop profile directory holding `orb-vision.json` and the notes folder.
 * @param options.activity - the recorder's current privacy settings.
 * @param options.log - sink for config problems and failures.
 * @param options.capture - screenshot source; defaults to Electron's.
 * @param options.fetchImpl - HTTP client; defaults to the global `fetch`.
 * @param options.idleSeconds - seconds since the last input; defaults to the system's.
 * @param options.foreground - the foreground window; defaults to the system's.
 * @param options.now - current time; defaults to the clock.
 * @returns the running describer.
 */
export function startScreenVision(options: {
  readonly profileDir: string
  readonly activity: () => ActivityConfig | undefined
  readonly log?: (message: string) => void
  readonly capture?: CaptureScreens
  readonly fetchImpl?: typeof fetch
  readonly idleSeconds?: () => number
  readonly foreground?: () => ForegroundWindow | undefined
  readonly now?: () => Date
}): ScreenVision & { runOnce(): Promise<boolean> } {
  const log = options.log ?? ((message: string): void => { console.warn(message) })
  const capture = options.capture ?? captureScreens
  const doFetch = options.fetchImpl ?? fetch
  const idleSeconds = options.idleSeconds ?? ((): number => powerMonitor.getSystemIdleTime())
  const foreground = options.foreground ?? readForegroundWindow
  const now = options.now ?? ((): Date => new Date())
  const configPath = join(options.profileDir, VISION_CONFIG_FILE)
  let config: VisionConfig | undefined
  let configStamp = -1
  let nextAt = 0
  let busy = false
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined

  function reloadConfig(): void {
    let stamp = -1
    try {
      stamp = statSync(configPath).mtimeMs
    } catch {
      // A missing file is written by the read below.
    }
    if (stamp === configStamp && config !== undefined) return
    const result = readVisionConfig(options.profileDir)
    try {
      configStamp = statSync(configPath).mtimeMs
    } catch {
      configStamp = -1
    }
    for (const problem of result.problems) log(`dsh desktop: ${VISION_CONFIG_FILE}: ${problem}`)
    if (result.config !== undefined) config = result.config
  }

  /** One check: describe the screen when it is due and allowed. Resolves true when a note was stored. */
  async function runOnce(): Promise<boolean> {
    reloadConfig()
    const activity = options.activity()
    if (config?.enabled !== true || activity?.enabled !== true || busy || stopped) return false
    const moment = now()
    if (moment.getTime() < nextAt) return false
    if (idleSeconds() >= activity.idleSeconds) return false
    if (!mayCaptureFor(foreground(), activity)) return false
    const credentials = readVisionCredentials(config.credentialsFile)
    if (credentials === undefined) {
      nextAt = moment.getTime() + FAILURE_BACKOFF_MS
      log(`dsh desktop: ${VISION_CONFIG_FILE}: no usable model access in ${config.credentialsFile}`)
      return false
    }
    busy = true
    try {
      const images = await capture()
      if (images.length === 0) return false
      const response = await doFetch(`${credentials.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.apiKey}` },
        body: JSON.stringify(buildVisionRequest(credentials.model, images)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`the model service answered ${String(response.status)}`)
      nextAt = moment.getTime() + config.intervalMinutes * 60_000
      const text = parseVisionReply(await response.json())
      if (text === undefined) return false
      const time = `${String(moment.getHours()).padStart(2, '0')}:${String(moment.getMinutes()).padStart(2, '0')}`
      return appendVisionNote(join(options.profileDir, NATIVE_VISION_DIR), localDateKey(moment), time, text)
    } catch (error) {
      // The key is never part of the message: only the failure reason is logged.
      nextAt = moment.getTime() + FAILURE_BACKOFF_MS
      log(`dsh desktop: screen description failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      busy = false
    }
  }

  timer = setInterval(() => { void runOnce() }, CHECK_EVERY_MS)
  return {
    runOnce,
    stop: () => {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
