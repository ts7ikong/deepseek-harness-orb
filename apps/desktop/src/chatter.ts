/**
 * Proactive chat: now and then the ball says one short sentence by itself, in the voice the user described for their
 * assistant, drawing on the long-term memory and what the screen descriptions show. A line is shown as a bubble beside
 * the ball (see `bubble-window.ts`); it never enters the conversation or interrupts typing.
 *
 * It asks the same model service as the screen descriptions (`orb-vision.json` names the access file), so it needs
 * no key of its own. Nothing is said while the user is away, while the conversation panel is open, or outside work
 * hours; the gaps between lines are random within the configured range.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { powerMonitor } from 'electron'
import type { ScreenNote } from './activity-log.ts'
import { localDateKey } from './reminders.ts'
import { DEFAULT_VISION_BASE_URL, readVisionConfig, readVisionCredentials, type VisionCredentials } from './screen-vision.ts'
import { workProgress, type ScheduleConfig, type WorkProgress } from './work-schedule.ts'

/** Profile-relative JSON holding the proactive-chat settings; edits apply within a minute. */
export const CHATTER_CONFIG_FILE = 'orb-chatter.json'

/** Profile-relative log of what the ball said, so it does not repeat itself. */
export const CHATTER_LOG_FILE = 'orb-chatter.jsonl'

const MAX_LINE_CHARS = 60
const PERSONA_CHARS = 3500
const MEMORY_CHARS = 2000
const RECENT_LINES = 6
const REQUEST_TIMEOUT_MS = 45_000
const CHECK_EVERY_MS = 30_000
const FAILURE_BACKOFF_MS = 15 * 60_000
/** Without working hours set, the ball may speak between these local hours. */
const DEFAULT_START_HOUR = 9
const DEFAULT_END_HOUR = 20
/** A user who has not touched the keyboard or mouse for this long is treated as away. */
const AWAY_SECONDS = 300

export interface ChatterConfig {
  readonly enabled: boolean
  /** Shortest and longest gap between lines, in minutes. */
  readonly minMinutes: number
  readonly maxMinutes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The file a fresh profile starts with.
 * @returns the JSON text.
 */
export function defaultChatterText(): string {
  return `${JSON.stringify({
    help: '悬浮球偶尔会自己冒出一句话（在球旁边的气泡里，不会打断你，也不会写进对话）。两次之间随机间隔 minMinutes 到 maxMinutes 分钟；'
      + '你不在电脑前、对话面板打开着、或不在上班时间（设置了工作时间按工作时间，没设置按 09:00-20:00）时不说。'
      + '它用 orb-vision.json 里指定的模型接入。enabled 设为 false 即关闭。改动一分钟内生效。',
    enabled: true,
    minMinutes: 60,
    maxMinutes: 120,
  }, undefined, 2)}\n`
}

/**
 * Parse the config text, falling back to the defaults for anything missing or invalid.
 * @param text - JSON file contents.
 * @returns the config (absent when the JSON is unusable) and a message per adjusted value.
 */
export function parseChatterConfig(text: string): { config: ChatterConfig | undefined; problems: string[] } {
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { config: undefined, problems: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!isRecord(raw)) return { config: undefined, problems: ['the top level must be an object'] }
  const minutes = (value: unknown, fallback: number, name: string): number => {
    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isFinite(value) && value >= 10 && value <= 600) return Math.round(value)
    problems.push(`${name} must be a number from 10 to 600; using ${String(fallback)}`)
    return fallback
  }
  const minMinutes = minutes(raw.minMinutes, 60, 'minMinutes')
  const maxMinutes = Math.max(minMinutes, minutes(raw.maxMinutes, 120, 'maxMinutes'))
  return { config: { enabled: raw.enabled !== false, minMinutes, maxMinutes }, problems }
}

/**
 * Read the config, writing the starter file first when none exists.
 * @param profileDir - Desktop profile directory.
 * @returns the parsed result.
 */
export function readChatterConfig(profileDir: string): { config: ChatterConfig | undefined; problems: string[] } {
  const path = join(profileDir, CHATTER_CONFIG_FILE)
  if (!existsSync(path)) {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(path, defaultChatterText())
  }
  return parseChatterConfig(readFileSync(path, 'utf8'))
}

/**
 * A random gap before the next line.
 * @param config - the settings.
 * @param random - a number in [0, 1).
 * @returns milliseconds between `minMinutes` and `maxMinutes`.
 */
export function nextChatterDelayMs(config: ChatterConfig, random: number): number {
  return Math.round((config.minMinutes + (config.maxMinutes - config.minMinutes) * random) * 60_000)
}

/** What decides whether the ball may speak now. */
export interface ChatterContext {
  readonly now: Date
  readonly schedule: ScheduleConfig | undefined
  readonly idleSeconds: number
  /** The ball is collapsed: no conversation panel is open. */
  readonly collapsed: boolean
}

/**
 * Whether now is a good moment to speak.
 * @param context - the moment and the user's state.
 * @returns true when the user is at the computer, the panel is closed, and it is working time.
 */
export function mayChatter(context: ChatterContext): boolean {
  if (!context.collapsed || context.idleSeconds >= AWAY_SECONDS) return false
  const progress = context.schedule === undefined ? undefined : workProgress(context.schedule, context.now)
  if (progress !== undefined) return progress.phase === 'morning' || progress.phase === 'afternoon'
  const hour = context.now.getHours()
  return hour >= DEFAULT_START_HOUR && hour < DEFAULT_END_HOUR
}

/** Everything the model is shown to write one line. */
export interface ChatterInput {
  readonly now: Date
  /** The user's own description of the assistant (the standing instructions file). */
  readonly persona: string
  readonly memory: string
  readonly progress: WorkProgress | undefined
  /** Today's screen descriptions, oldest first. */
  readonly notes: readonly ScreenNote[]
  /** The lines already said, oldest first. */
  readonly recent: readonly string[]
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const
const PHASES: Readonly<Record<WorkProgress['phase'], string>> = {
  before: '还没上班',
  morning: '上午工作中',
  lunch: '午休',
  afternoon: '下午工作中',
  after: '已下班',
  rest: '休息日',
}

/**
 * The messages sent to the model.
 * @param input - the persona, memory, and what is going on.
 * @returns a system message and a user message.
 */
export function buildChatterMessages(input: ChatterInput): { role: 'system' | 'user'; content: string }[] {
  const two = (value: number): string => String(value).padStart(2, '0')
  const clock = `${two(input.now.getHours())}:${two(input.now.getMinutes())}`
  const context = [
    `现在是周${WEEKDAYS[input.now.getDay()] ?? ''} ${clock}。`,
    input.progress === undefined ? '' : `用户今天${PHASES[input.progress.phase]}，今天的工作时间已过去约 ${String(input.progress.percent)}%（这是时间进度，不是项目进度）。`,
    input.notes.length === 0 ? '' : `今天屏幕上的情况（每隔一阵一句话的描述，最近的在最后）：\n${input.notes.slice(-5).map(note => `- ${note.time} ${note.text}`).join('\n')}`,
    input.recent.length === 0 ? '' : `你最近说过的话（不要重复同样的意思）：\n${input.recent.map(line => `- ${line}`).join('\n')}`,
  ].filter(part => part !== '').join('\n')
  return [
    {
      role: 'system',
      content: [
        '你是用户电脑桌面上的悬浮球助手。下面是用户写给你的设定，请按这个身份和性格说话：',
        input.persona.slice(0, PERSONA_CHARS),
        input.memory === '' ? '' : `你记得关于用户的这些事：\n${input.memory.slice(-MEMORY_CHARS)}`,
      ].filter(part => part !== '').join('\n\n'),
    },
    {
      role: 'user',
      content: [
        context,
        '',
        `请主动对用户说一句话，不超过 ${String(MAX_LINE_CHARS)} 个字，像熟悉他的朋友随口说的：可以是关心、调侃、对他在做的事的一点看法，或用上你记得的事。`,
        '不要提醒喝水、休息、站起来活动，不要催他干活或评价他的进度快慢，不要复述屏幕上的具体文字，不要打招呼式的套话，不要用表情符号。',
        '只输出这一句话本身。',
      ].join('\n'),
    },
  ]
}

/**
 * The line in a chat-completions reply.
 * @param reply - the parsed JSON response.
 * @returns one trimmed line without surrounding quotes, at most 60 characters; undefined when empty.
 */
export function parseChatterReply(reply: unknown): string | undefined {
  const content = isRecord(reply) && Array.isArray(reply.choices) && isRecord(reply.choices[0]) && isRecord(reply.choices[0].message)
    ? reply.choices[0].message.content
    : undefined
  if (typeof content !== 'string') return undefined
  const line = content.replaceAll('\r', '').split('\n').map(part => part.trim()).find(part => part !== '')
  if (line === undefined) return undefined
  const bare = line.replace(/^["“「『]+/u, '').replace(/["”」』]+$/u, '').trim()
  if (bare === '') return undefined
  return bare.length > MAX_LINE_CHARS ? `${bare.slice(0, MAX_LINE_CHARS - 1)}…` : bare
}

/**
 * The lines said most recently.
 * @param profileDir - Desktop profile directory.
 * @param count - how many to return.
 * @returns up to `count` lines, oldest first.
 */
export function readRecentChatter(profileDir: string, count: number = RECENT_LINES): string[] {
  try {
    const lines = readFileSync(join(profileDir, CHATTER_LOG_FILE), 'utf8').split('\n').flatMap((line) => {
      try {
        const text = (JSON.parse(line) as { text?: unknown }).text
        return typeof text === 'string' ? [text] : []
      } catch {
        // A damaged or blank line is skipped.
        return []
      }
    })
    return lines.slice(-count)
  } catch {
    return []
  }
}

/**
 * Remember a line that was said.
 * @param profileDir - Desktop profile directory.
 * @param at - when it was said.
 * @param text - the line.
 */
export function logChatter(profileDir: string, at: Date, text: string): void {
  mkdirSync(profileDir, { recursive: true })
  const two = (value: number): string => String(value).padStart(2, '0')
  appendFileSync(join(profileDir, CHATTER_LOG_FILE), `${JSON.stringify({ date: localDateKey(at), time: `${two(at.getHours())}:${two(at.getMinutes())}`, text })}\n`)
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

/** Handle returned by {@link startChatter}. */
export interface Chatter {
  /** Run one check now, ignoring the random gap; resolves to the line said, if any. */
  sayOnce(): Promise<string | undefined>
  stop(): void
}

/**
 * Start the proactive chat.
 * @param options.profileDir - Desktop profile directory.
 * @param options.workspaceDir - the ball's workspace folder, holding `AGENTS.md` and `memory.md`.
 * @param options.schedule - the working hours, when set.
 * @param options.notes - today's screen descriptions.
 * @param options.collapsed - whether the ball is collapsed (the panel is closed).
 * @param options.onSpeak - shows a line to the user.
 * @param options.log - sink for failures.
 * @param options.fetchImpl - HTTP client; defaults to the global `fetch`.
 * @param options.idleSeconds - seconds since the last input; defaults to the system's.
 * @param options.now - current time; defaults to the clock.
 * @param options.random - a number in [0, 1); defaults to `Math.random`.
 * @returns the running chat.
 */
export function startChatter(options: {
  readonly profileDir: string
  readonly workspaceDir: string
  readonly schedule: () => ScheduleConfig | undefined
  readonly notes: () => ScreenNote[]
  readonly collapsed: () => boolean
  readonly onSpeak: (text: string) => void
  readonly log?: (message: string) => void
  readonly fetchImpl?: typeof fetch
  readonly idleSeconds?: () => number
  readonly now?: () => Date
  readonly random?: () => number
}): Chatter {
  const log = options.log ?? ((message: string): void => { console.warn(message) })
  const doFetch = options.fetchImpl ?? fetch
  const idleSeconds = options.idleSeconds ?? ((): number => powerMonitor.getSystemIdleTime())
  const now = options.now ?? ((): Date => new Date())
  const random = options.random ?? Math.random
  const configPath = join(options.profileDir, CHATTER_CONFIG_FILE)
  let config: ChatterConfig | undefined
  let configStamp = -1
  let nextAt: number | undefined
  let busy = false
  let stopped = false

  function reloadConfig(): void {
    let stamp = -1
    try {
      stamp = statSync(configPath).mtimeMs
    } catch {
      // A missing file is written by the read below.
    }
    if (stamp === configStamp && config !== undefined) return
    const result = readChatterConfig(options.profileDir)
    try {
      configStamp = statSync(configPath).mtimeMs
    } catch {
      configStamp = -1
    }
    for (const problem of result.problems) log(`dsh desktop: ${CHATTER_CONFIG_FILE}: ${problem}`)
    if (result.config !== undefined) config = result.config
  }

  async function ask(credentials: VisionCredentials, moment: Date, schedule: ScheduleConfig | undefined): Promise<string | undefined> {
    const messages = buildChatterMessages({
      now: moment,
      persona: readTextFile(join(options.workspaceDir, 'AGENTS.md')),
      memory: readTextFile(join(options.workspaceDir, 'memory.md')),
      progress: schedule === undefined ? undefined : workProgress(schedule, moment),
      notes: options.notes(),
      recent: readRecentChatter(options.profileDir),
    })
    const response = await doFetch(`${credentials.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.apiKey}` },
      body: JSON.stringify({ model: credentials.model, max_tokens: 120, temperature: 0.9, messages }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`the model service answered ${String(response.status)}`)
    return parseChatterReply(await response.json())
  }

  async function check(force: boolean): Promise<string | undefined> {
    reloadConfig()
    if (config?.enabled !== true || busy || stopped) return undefined
    const moment = now()
    nextAt ??= moment.getTime() + nextChatterDelayMs(config, random())
    if (!force && moment.getTime() < nextAt) return undefined
    const schedule = options.schedule()
    if (!mayChatter({ now: moment, schedule, idleSeconds: idleSeconds(), collapsed: options.collapsed() })) return undefined
    const vision = readVisionConfig(options.profileDir).config
    const credentials = vision === undefined ? undefined : readVisionCredentials(vision.credentialsFile)
    if (credentials === undefined) {
      nextAt = moment.getTime() + FAILURE_BACKOFF_MS
      log('dsh desktop: proactive chat: no usable model access (see orb-vision.json)')
      return undefined
    }
    busy = true
    try {
      const text = await ask({ ...credentials, baseUrl: credentials.baseUrl || DEFAULT_VISION_BASE_URL }, moment, schedule)
      nextAt = moment.getTime() + nextChatterDelayMs(config, random())
      if (text === undefined) return undefined
      logChatter(options.profileDir, moment, text)
      options.onSpeak(text)
      return text
    } catch (error) {
      // The key is never part of the message: only the failure reason is logged.
      nextAt = moment.getTime() + FAILURE_BACKOFF_MS
      log(`dsh desktop: proactive chat failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => { void check(false) }, CHECK_EVERY_MS)
  return {
    sayOnce: () => check(true),
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
