import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ desktopCapturer: {}, powerMonitor: { getSystemIdleTime: () => 0 } }))
vi.mock('../src/foreground-window.ts', () => ({ readForegroundWindow: () => undefined }))

import { defaultActivityConfig, mergeScreenNotes, NATIVE_VISION_DIR, readScreenNotes } from '../src/activity-log.ts'
import {
  appendVisionNote,
  buildVisionRequest,
  DEFAULT_VISION_BASE_URL,
  mayCaptureFor,
  parseVisionConfig,
  parseVisionReply,
  readVisionConfig,
  readVisionCredentials,
  startScreenVision,
  VISION_CONFIG_FILE,
} from '../src/screen-vision.ts'

const roots: string[] = []
const running: { stop(): void }[] = []

afterEach(() => {
  for (const item of running.splice(0)) item.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vision-'))
  roots.push(root)
  return root
}

function credentialsFile(root: string, content: unknown = { endpoint_id: 'ep-123', api_key: 'sk-secret-key', api_url: '' }): string {
  const file = join(root, 'ai_config.json')
  writeFileSync(file, JSON.stringify(content))
  return file
}

describe('config', () => {
  it('writes a starter file that is on, every 20 minutes, reading the old assistant\'s access file', () => {
    const root = temp()
    const { config } = readVisionConfig(root)
    expect(config).toMatchObject({ enabled: true, intervalMinutes: 20 })
    expect(config?.credentialsFile).toContain('VPet-WorkingPet')
    expect(readFileSync(join(root, VISION_CONFIG_FILE), 'utf8')).toContain('credentialsFile')
  })

  it('takes edits, and falls back for a bad interval', () => {
    expect(parseVisionConfig('{"enabled":false,"intervalMinutes":30,"credentialsFile":"x.json"}').config).toEqual({ enabled: false, intervalMinutes: 30, credentialsFile: 'x.json' })
    const bad = parseVisionConfig('{"intervalMinutes":1}')
    expect(bad.config?.intervalMinutes).toBe(20)
    expect(bad.problems).toHaveLength(1)
    expect(parseVisionConfig('{oops').config).toBeUndefined()
  })
})

describe('readVisionCredentials', () => {
  it('reads the endpoint and key, with the default address when none is given', () => {
    expect(readVisionCredentials(credentialsFile(temp()))).toEqual({ model: 'ep-123', apiKey: 'sk-secret-key', baseUrl: DEFAULT_VISION_BASE_URL })
    expect(readVisionCredentials(credentialsFile(temp(), { endpoint_id: 'e', api_key: 'k', api_url: 'https://x.test/v1/' }))?.baseUrl).toBe('https://x.test/v1')
  })

  it('gives nothing when the file is missing, damaged, or lacks the model or key', () => {
    const root = temp()
    expect(readVisionCredentials(join(root, 'none.json'))).toBeUndefined()
    expect(readVisionCredentials(credentialsFile(root, { endpoint_id: 'e', api_key: '' }))).toBeUndefined()
    expect(readVisionCredentials(credentialsFile(root, { api_key: 'k' }))).toBeUndefined()
    writeFileSync(join(root, 'bad.json'), '{oops')
    expect(readVisionCredentials(join(root, 'bad.json'))).toBeUndefined()
  })
})

describe('request and reply', () => {
  it('sends every screenshot as an inline image after the question', () => {
    const body = buildVisionRequest('ep-1', ['AAA', 'BBB']) as { model: string; messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[] }
    expect(body.model).toBe('ep-1')
    const content = body.messages[0]!.content
    expect(content.map(part => part.type)).toEqual(['text', 'image_url', 'image_url'])
    expect(content[1]!.image_url!.url).toBe('data:image/jpeg;base64,AAA')
    expect(content[0]!.text).toContain('不要抄录')
  })

  it('takes the first line of the reply, shortens a long one, and drops "cannot tell"', () => {
    const reply = (content: unknown) => ({ choices: [{ message: { content } }] })
    expect(parseVisionReply(reply('\n  正在编写 Java 代码。\n多余的话'))).toBe('正在编写 Java 代码。')
    expect(parseVisionReply(reply('字'.repeat(300)))).toHaveLength(120)
    expect(parseVisionReply(reply('无法判断'))).toBeUndefined()
    expect(parseVisionReply(reply(''))).toBeUndefined()
    expect(parseVisionReply({})).toBeUndefined()
    expect(parseVisionReply(null)).toBeUndefined()
  })
})

describe('storage', () => {
  it('appends notes the report reader understands, and skips a repeat of the last one', () => {
    const root = temp()
    const dir = join(root, NATIVE_VISION_DIR)
    expect(appendVisionNote(dir, '2026-10-22', '10:00', '正在编写代码')).toBe(true)
    expect(appendVisionNote(dir, '2026-10-22', '10:20', '正在编写代码')).toBe(false)
    expect(appendVisionNote(dir, '2026-10-22', '10:40', '正在查看服务器')).toBe(true)
    expect(readScreenNotes(dir, '2026-10-22')).toEqual([{ time: '10:00', text: '正在编写代码' }, { time: '10:40', text: '正在查看服务器' }])
  })

  it('merges two sources in time order without doubling an identical note', () => {
    const merged = mergeScreenNotes(
      [{ time: '10:00', text: 'a' }, { time: '12:00', text: 'c' }],
      [{ time: '11:00', text: 'b' }, { time: '12:00', text: 'c' }],
    )
    expect(merged.map(note => note.text)).toEqual(['a', 'b', 'c'])
  })
})

describe('mayCaptureFor', () => {
  const activity = defaultActivityConfig()
  it('allows ordinary programs and refuses password managers, chat apps, hidden-word titles, and unknown windows', () => {
    expect(mayCaptureFor({ app: 'idea64', title: 'App.java' }, activity)).toBe(true)
    expect(mayCaptureFor({ app: 'KeePass', title: 'db' }, activity)).toBe(false)
    expect(mayCaptureFor({ app: 'WeChat', title: '文件传输助手' }, activity)).toBe(false)
    expect(mayCaptureFor({ app: 'msedge', title: '银行登录' }, activity)).toBe(false)
    expect(mayCaptureFor(undefined, activity)).toBe(false)
  })
})

describe('startScreenVision', () => {
  function harness(overrides: Partial<Parameters<typeof startScreenVision>[0]> = {}, reply: unknown = { choices: [{ message: { content: '正在编写 Java 代码' } }] }) {
    const root = temp()
    const credentials = credentialsFile(root)
    writeFileSync(join(root, VISION_CONFIG_FILE), JSON.stringify({ credentialsFile: credentials, intervalMinutes: 20 }))
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify(reply), { status: 200 })
    }) as unknown as typeof fetch
    let clock = new Date(2026, 9, 22, 10, 0, 0)
    const logs: string[] = []
    const vision = startScreenVision({
      profileDir: root,
      activity: () => defaultActivityConfig(),
      log: (message) => { logs.push(message) },
      capture: async () => ['IMG'],
      fetchImpl,
      idleSeconds: () => 0,
      foreground: () => ({ app: 'idea64', title: 'App.java' }),
      now: () => clock,
      ...overrides,
    })
    running.push(vision)
    return { root, vision, calls, logs, advance: (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000) } }
  }

  it('describes the screen, stores one line, and sends the key only as a header', async () => {
    const { root, vision, calls } = harness()
    expect(await vision.runOnce()).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${DEFAULT_VISION_BASE_URL}/chat/completions`)
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret-key')
    expect(String(calls[0]!.init.body)).not.toContain('sk-secret-key')
    expect(readScreenNotes(join(root, NATIVE_VISION_DIR), '2026-10-22')).toEqual([{ time: '10:00', text: '正在编写 Java 代码' }])
  })

  it('waits for the interval before the next description', async () => {
    const { vision, calls, advance } = harness()
    await vision.runOnce()
    advance(5)
    expect(await vision.runOnce()).toBe(false)
    expect(calls).toHaveLength(1)
    advance(16)
    await vision.runOnce()
    expect(calls).toHaveLength(2)
  })

  it('does nothing while the user is away, in a chat app, or when turned off', async () => {
    const idle = harness({ idleSeconds: () => 9999 })
    expect(await idle.vision.runOnce()).toBe(false)
    expect(idle.calls).toHaveLength(0)
    const chat = harness({ foreground: () => ({ app: 'WeChat', title: 'x' }) })
    expect(await chat.vision.runOnce()).toBe(false)
    expect(chat.calls).toHaveLength(0)
    const off = harness()
    writeFileSync(join(off.root, VISION_CONFIG_FILE), JSON.stringify({ enabled: false }))
    expect(await off.vision.runOnce()).toBe(false)
    expect(off.calls).toHaveLength(0)
  })

  it('backs off and logs without the key when the service fails, and when there is no access file', async () => {
    const failing = harness({ fetchImpl: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch })
    expect(await failing.vision.runOnce()).toBe(false)
    expect(failing.logs.join('\n')).toContain('401')
    expect(failing.logs.join('\n')).not.toContain('sk-secret-key')
    failing.advance(5)
    expect(await failing.vision.runOnce()).toBe(false)
    expect(failing.logs).toHaveLength(1)

    const missing = harness()
    writeFileSync(join(missing.root, VISION_CONFIG_FILE), JSON.stringify({ credentialsFile: join(missing.root, 'none.json') }))
    expect(await missing.vision.runOnce()).toBe(false)
    expect(missing.logs.join('\n')).toContain('no usable model access')
    expect(missing.calls).toHaveLength(0)
  })

  it('stores nothing when the model cannot tell', async () => {
    const { vision, root } = harness({}, { choices: [{ message: { content: '无法判断' } }] })
    expect(await vision.runOnce()).toBe(false)
    expect(readScreenNotes(join(root, NATIVE_VISION_DIR), '2026-10-22')).toEqual([])
    mkdirSync(join(root, NATIVE_VISION_DIR), { recursive: true })
  })
})
