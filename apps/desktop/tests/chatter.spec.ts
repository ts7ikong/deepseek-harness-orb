import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: vi.fn(), screen: {}, desktopCapturer: {}, powerMonitor: { getSystemIdleTime: () => 0 } }))
vi.mock('../src/floating-window.ts', () => ({ presentOverlayWindow: () => {} }))
vi.mock('../src/foreground-window.ts', () => ({ readForegroundWindow: () => undefined }))

import { bubbleBounds, BUBBLE_WINDOW_SIZE, bubblePageUrl } from '../src/bubble-window.ts'
import {
  buildChatterMessages,
  CHATTER_CONFIG_FILE,
  logChatter,
  mayChatter,
  nextChatterDelayMs,
  parseChatterConfig,
  parseChatterReply,
  readChatterConfig,
  readRecentChatter,
  startChatter,
} from '../src/chatter.ts'
import { VISION_CONFIG_FILE } from '../src/screen-vision.ts'
import type { ScheduleConfig } from '../src/work-schedule.ts'

const roots: string[] = []
const running: { stop(): void }[] = []

afterEach(() => {
  for (const item of running.splice(0)) item.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-chatter-'))
  roots.push(root)
  return root
}

const hours: ScheduleConfig = {
  showClock: true, days: [1, 2, 3, 4, 5], workStart: 540, lunchStart: 720, afternoonStart: 810, workEnd: 1110,
}
// 2026-10-22 is a Thursday.
const at = (hour: number, minute = 0): Date => new Date(2026, 9, 22, hour, minute, 0)

describe('config', () => {
  it('writes a starter file: on, one line every 60 to 120 minutes', () => {
    const root = temp()
    expect(readChatterConfig(root).config).toEqual({ enabled: true, minMinutes: 60, maxMinutes: 120 })
    expect(readFileSync(join(root, CHATTER_CONFIG_FILE), 'utf8')).toContain('minMinutes')
  })

  it('takes edits, keeps max at least min, and falls back for bad numbers', () => {
    expect(parseChatterConfig('{"enabled":false,"minMinutes":30,"maxMinutes":45}').config).toEqual({ enabled: false, minMinutes: 30, maxMinutes: 45 })
    expect(parseChatterConfig('{"minMinutes":90,"maxMinutes":30}').config).toMatchObject({ minMinutes: 90, maxMinutes: 90 })
    const bad = parseChatterConfig('{"minMinutes":2}')
    expect(bad.config?.minMinutes).toBe(60)
    expect(bad.problems).toHaveLength(1)
    expect(parseChatterConfig('{oops').config).toBeUndefined()
  })

  it('draws the gap from the whole range', () => {
    const config = { enabled: true, minMinutes: 60, maxMinutes: 120 }
    expect(nextChatterDelayMs(config, 0)).toBe(60 * 60_000)
    expect(nextChatterDelayMs(config, 0.5)).toBe(90 * 60_000)
    expect(nextChatterDelayMs(config, 0.999)).toBeLessThanOrEqual(120 * 60_000)
  })
})

describe('mayChatter', () => {
  const base = { schedule: hours, idleSeconds: 0, collapsed: true }
  it('speaks only while working, at the computer, with the panel closed', () => {
    expect(mayChatter({ ...base, now: at(10) })).toBe(true)
    expect(mayChatter({ ...base, now: at(15) })).toBe(true)
    expect(mayChatter({ ...base, now: at(12, 30) })).toBe(false)
    expect(mayChatter({ ...base, now: at(8) })).toBe(false)
    expect(mayChatter({ ...base, now: at(19) })).toBe(false)
    expect(mayChatter({ ...base, now: at(10), idleSeconds: 600 })).toBe(false)
    expect(mayChatter({ ...base, now: at(10), collapsed: false })).toBe(false)
    expect(mayChatter({ ...base, now: new Date(2026, 9, 24, 10, 0) })).toBe(false)
  })

  it('without working hours set, uses 09:00 to 20:00', () => {
    expect(mayChatter({ ...base, schedule: undefined, now: at(9) })).toBe(true)
    expect(mayChatter({ ...base, schedule: undefined, now: at(20) })).toBe(false)
    expect(mayChatter({ ...base, schedule: { ...hours, workStart: undefined }, now: at(21) })).toBe(false)
  })
})

describe('the prompt', () => {
  const input = {
    now: at(15, 5),
    persona: '我是 Java 后端工程师。',
    memory: '- 2026-10-20 部署用宝塔',
    progress: { phase: 'afternoon' as const, percent: 70, workedMs: 1, remainingMs: 1 },
    notes: [{ time: '14:50', text: '正在编写 Java 代码' }],
    recent: ['上次说过的话'],
  }

  it('gives the persona, memory, time, progress, screen notes, and what was said before', () => {
    const [system, user] = buildChatterMessages(input)
    expect(system!.role).toBe('system')
    expect(system!.content).toContain('我是 Java 后端工程师。')
    expect(system!.content).toContain('部署用宝塔')
    expect(user!.content).toContain('周四 15:05')
    expect(user!.content).toContain('70%（这是时间进度，不是项目进度）')
    expect(user!.content).toContain('14:50 正在编写 Java 代码')
    expect(user!.content).toContain('上次说过的话')
    expect(user!.content).toContain('不要提醒喝水')
  })

  it('leaves out the parts there is nothing for', () => {
    const [system, user] = buildChatterMessages({ ...input, memory: '', progress: undefined, notes: [], recent: [] })
    expect(system!.content).not.toContain('你记得关于用户')
    expect(user!.content).not.toContain('时间进度')
    expect(user!.content).not.toContain('屏幕上的情况')
    expect(user!.content).not.toContain('最近说过')
  })
})

describe('parseChatterReply', () => {
  const reply = (content: unknown) => ({ choices: [{ message: { content } }] })
  it('takes one line, strips quotes, and shortens a long one', () => {
    expect(parseChatterReply(reply('\n“又在跟 nginx 较劲啊。”\n后面的'))).toBe('又在跟 nginx 较劲啊。')
    expect(parseChatterReply(reply('字'.repeat(200)))).toHaveLength(60)
    expect(parseChatterReply(reply(''))).toBeUndefined()
    expect(parseChatterReply(reply('""'))).toBeUndefined()
    expect(parseChatterReply({})).toBeUndefined()
  })
})

describe('the log of what was said', () => {
  it('returns the latest lines, oldest first, and survives a damaged line', () => {
    const root = temp()
    expect(readRecentChatter(root)).toEqual([])
    for (const text of ['一', '二', '三']) logChatter(root, at(10), text)
    writeFileSync(join(root, 'orb-chatter.jsonl'), `${readFileSync(join(root, 'orb-chatter.jsonl'), 'utf8')}{broken\n`)
    expect(readRecentChatter(root, 2)).toEqual(['二', '三'])
    expect(readRecentChatter(root)).toEqual(['一', '二', '三'])
  })
})

describe('startChatter', () => {
  function harness(overrides: Partial<Parameters<typeof startChatter>[0]> = {}, content: unknown = '今天的接口调通了没？') {
    const root = temp()
    const access = join(root, 'ai_config.json')
    writeFileSync(access, JSON.stringify({ endpoint_id: 'ep-1', api_key: 'sk-secret-key' }))
    writeFileSync(join(root, VISION_CONFIG_FILE), JSON.stringify({ credentialsFile: access }))
    writeFileSync(join(root, CHATTER_CONFIG_FILE), JSON.stringify({ minMinutes: 60, maxMinutes: 60 }))
    writeFileSync(join(root, 'AGENTS.md'), '我是 Java 后端工程师。')
    const spoken: string[] = []
    const logs: string[] = []
    const bodies: string[] = []
    let clock = at(10, 0)
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const chatter = startChatter({
      profileDir: root,
      workspaceDir: root,
      schedule: () => hours,
      notes: () => [],
      collapsed: () => true,
      onSpeak: (text) => { spoken.push(text) },
      log: (message) => { logs.push(message) },
      fetchImpl,
      idleSeconds: () => 0,
      now: () => clock,
      random: () => 0,
      ...overrides,
    })
    running.push(chatter)
    return { root, chatter, spoken, logs, bodies, advance: (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000) } }
  }

  it('says one line, shows it, and keeps it in the log', async () => {
    const { root, chatter, spoken } = harness()
    expect(await chatter.sayOnce()).toBe('今天的接口调通了没？')
    expect(spoken).toEqual(['今天的接口调通了没？'])
    expect(readRecentChatter(root)).toEqual(['今天的接口调通了没？'])
  })

  it('asks with the persona and what it said before, and never puts the key in the body', async () => {
    const { chatter, bodies } = harness()
    await chatter.sayOnce()
    await chatter.sayOnce()
    expect(bodies[0]).toContain('Java 后端工程师')
    expect(bodies[1]).toContain('今天的接口调通了没？')
    expect(bodies.join('')).not.toContain('sk-secret-key')
  })

  it('stays quiet when the user is away, the panel is open, or it is turned off', async () => {
    const away = harness({ idleSeconds: () => 9999 })
    expect(await away.chatter.sayOnce()).toBeUndefined()
    const open = harness({ collapsed: () => false })
    expect(await open.chatter.sayOnce()).toBeUndefined()
    const off = harness()
    writeFileSync(join(off.root, CHATTER_CONFIG_FILE), JSON.stringify({ enabled: false }))
    expect(await off.chatter.sayOnce()).toBeUndefined()
    expect(away.bodies.length + open.bodies.length + off.bodies.length).toBe(0)
  })

  it('logs a failure without the key and says nothing', async () => {
    const { chatter, logs, spoken } = harness({ fetchImpl: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch })
    expect(await chatter.sayOnce()).toBeUndefined()
    expect(logs.join('\n')).toContain('401')
    expect(logs.join('\n')).not.toContain('sk-secret-key')
    expect(spoken).toHaveLength(0)
  })

  it('says nothing when there is no model access file', async () => {
    const { root, chatter, logs } = harness()
    writeFileSync(join(root, VISION_CONFIG_FILE), JSON.stringify({ credentialsFile: join(root, 'none.json') }))
    expect(await chatter.sayOnce()).toBeUndefined()
    expect(logs.join('\n')).toContain('no usable model access')
  })
})

describe('bubble window', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  const { width, height } = BUBBLE_WINDOW_SIZE

  it('sits centered above the ball, staying inside the display', () => {
    expect(bubbleBounds({ x: 800, y: 500, width: 96, height: 96 }, area))
      .toEqual({ x: 800 + 48 - width / 2, y: 500 + 12 - height, width, height })
    expect(bubbleBounds({ x: 1850, y: 500, width: 96, height: 96 }, area).x).toBe(1920 - width)
  })

  it('drops below the clock when the ball is at the top of the screen', () => {
    expect(bubbleBounds({ x: 800, y: 20, width: 96, height: 96 }, area).y).toBeGreaterThan(100)
  })

  it('carries the line in the page address, and the page shows it and closes on a click', () => {
    const url = new URL(bubblePageUrl('dsh-app://shell', '又在跟 nginx 较劲啊？'))
    expect(url.searchParams.get('text')).toBe('又在跟 nginx 较劲啊？')
    const dom = new JSDOM(readFileSync(new URL('../renderer/bubble.html', import.meta.url), 'utf8'), {
      runScripts: 'outside-only',
      url: url.toString(),
    })
    const close = vi.fn()
    Object.defineProperty(dom.window, 'close', { value: close })
    runInContext(readFileSync(new URL('../renderer/bubble.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    expect(dom.window.document.querySelector('#text')?.textContent).toBe('又在跟 nginx 较劲啊？')
    dom.window.document.body.click()
    expect(dom.window.document.body.classList.contains('leaving')).toBe(true)
  })
})
