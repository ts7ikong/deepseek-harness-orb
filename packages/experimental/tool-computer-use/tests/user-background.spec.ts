import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { PERSONA_SUFFIX_SECTION, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as UserBackground from '../src/user-background.ts'
import {
  apply,
  composeMemorySection,
  composeUserBackground,
  MAX_MEMORY_CHARS,
  MEMORY_FILE,
  memoryPath,
  createUserBackgroundReader,
  inject,
  MAX_USER_BACKGROUND_CHARS,
  name,
  USER_BACKGROUND_FILE,
  USER_BACKGROUND_VARIABLE,
  userBackgroundPath,
} from '../src/user-background.ts'

const roots: string[] = []
const contexts: Context[] = []
const savedHome = process.env.DSH_HOME

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
})

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-user-background-'))
  roots.push(root)
  return root
}

function writeBackground(home: string, text: string): string {
  mkdirSync(join(home, 'dsh_orb'), { recursive: true })
  const file = join(home, 'dsh_orb', USER_BACKGROUND_FILE)
  writeFileSync(file, text)
  return file
}

describe('plugin identity', () => {
  it('is a loader plugin that needs the prompt registry and has no default export', () => {
    expect(name).toBe('computer-use-user-background')
    expect(inject).toEqual(['systemPrompt'])
    expect('default' in UserBackground).toBe(false)
    expect(USER_BACKGROUND_VARIABLE).toBe('user_background')
  })
})

describe('userBackgroundPath', () => {
  it('follows the harness home rule: $DSH_HOME when set, otherwise ~/.dsh', () => {
    expect(userBackgroundPath({ DSH_HOME: '/data/dsh' }, '/home/me')).toBe(join('/data/dsh', 'dsh_orb', 'AGENTS.md'))
    expect(userBackgroundPath({}, '/home/me')).toBe(join('/home/me', '.dsh', 'dsh_orb', 'AGENTS.md'))
    expect(userBackgroundPath({ DSH_HOME: '' }, '/home/me')).toBe(join('/home/me', '.dsh', 'dsh_orb', 'AGENTS.md'))
  })
})

describe('createUserBackgroundReader', () => {
  it('reads and trims the file, and is empty while there is none', () => {
    const home = tempHome()
    const read = createUserBackgroundReader(join(home, 'dsh_orb', USER_BACKGROUND_FILE))
    expect(read()).toBe('')
    writeBackground(home, '\n\n  我是一名 Java 后端开发工程师。  \n\n')
    expect(read()).toBe('我是一名 Java 后端开发工程师。')
  })

  it('picks up an edit, and goes back to empty when the file is deleted', () => {
    const home = tempHome()
    const file = writeBackground(home, '第一版')
    const read = createUserBackgroundReader(file)
    expect(read()).toBe('第一版')
    writeFileSync(file, '第二版，更长一些')
    // Keep the timestamp from matching the earlier write so the change is seen even on a coarse clock.
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    expect(read()).toBe('第二版，更长一些')
    rmSync(file)
    expect(read()).toBe('')
  })

  it('takes at most the capped number of characters', () => {
    const home = tempHome()
    const file = writeBackground(home, 'x'.repeat(MAX_USER_BACKGROUND_CHARS + 5000))
    expect(createUserBackgroundReader(file)()).toHaveLength(MAX_USER_BACKGROUND_CHARS)
  })

})

async function mintAgentScope(ctx: Context, id: string) {
  const key = { id: id as SessionId } as Agent
  let scope!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['systemPrompt'] }))
  return { scope, key }
}

describe('the variable in a real system prompt', () => {
  async function mount(home: string) {
    process.env.DSH_HOME = home
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are a desktop agent.' })
    const { scope, key } = await mintAgentScope(ctx, 'orb')
    // The preset's persona row renders `{{user_background}}` as the persona suffix.
    scope.ctx.systemPrompt.section({
      name: PERSONA_SUFFIX_SECTION,
      order: scope.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: '{{user_background}}',
    })
    apply(scope.ctx)
    return { ctx, key }
  }

  it('puts the user\'s description at the end of the system prompt', async () => {
    const home = tempHome()
    writeBackground(home, '# 我的设定\n\n我是一名 Java 后端开发工程师。')
    const { ctx, key } = await mount(home)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
    expect(prompt).toContain('You are a desktop agent.')
    expect(prompt).toContain('我是一名 Java 后端开发工程师。')
    expect(prompt.indexOf('我是一名 Java 后端开发工程师。')).toBeLessThan(prompt.indexOf('## 长期记忆'))
    expect(prompt.indexOf('You are a desktop agent.')).toBeLessThan(prompt.indexOf('我的设定'))
  })

  it('shows an edit in the very next assembly, with no restart', async () => {
    const home = tempHome()
    const file = writeBackground(home, '旧设定')
    const { ctx, key } = await mount(home)
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toContain('旧设定')
    writeFileSync(file, '新的设定，内容更长')
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
    expect(prompt).toContain('新的设定，内容更长')
    expect(prompt).not.toContain('旧设定')
  })

  it('assembles normally, with nothing added, when the user has no description file', async () => {
    const { ctx, key } = await mount(tempHome())
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
    expect(prompt).toContain('You are a desktop agent.')
    expect(prompt).not.toContain('{{')
  })

  it('does not leak into agents outside the scope that mounted it', async () => {
    const home = tempHome()
    writeBackground(home, '只给悬浮球的设定')
    const { ctx } = await mount(home)
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('只给悬浮球的设定')
  })
})

const composition = readFileSync(
  fileURLToPath(new URL('../presets/computer-use/agent.cordis.yml', import.meta.url)),
  'utf8',
)

describe('the Computer Use preset', () => {
  it('renders the variable as the persona suffix and mounts the plugin that provides it', () => {
    expect(composition).toContain("suffix: '{{user_background}}'")
    expect(composition).toContain("name: '../../src/user-background.ts'")
  })

  it('still does not mount the workspace-instructions plugin the slim preset leaves out', () => {
    expect(composition).not.toContain('@deepseek-ai/dsh-agent-instructions')
  })
})

// The Desktop Host does not read the preset file above: it takes the preset from the overlay, which writes the whole
// composition out again. A change made to only one of the two never reaches the floating ball (this happened once),
// so each of them has to carry it.
describe('the overlay the Desktop Host actually loads', () => {
  const overlay = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    exports: Record<string, { default: string }>
    files: string[]
  }

  it('renders the variable as the persona suffix and mounts the plugin by its package export', () => {
    expect(overlay).toContain("suffix: '{{user_background}}'")
    expect(overlay).toContain("name: '@deepseek-ai/dsh-experimental-tool-computer-use/user-background'")
  })

  it('mounts the plugin row beside the persona row, in the same preset', () => {
    const persona = overlay.indexOf('id: persona')
    const row = overlay.indexOf('id: user-background')
    const nextTool = overlay.indexOf('id: tool-bash')
    expect(persona).toBeGreaterThan(-1)
    expect(row).toBeGreaterThan(persona)
    expect(row).toBeLessThan(nextTool)
  })

  it('has a package export that points at the built plugin, and ships that file', () => {
    expect(manifest.exports['./user-background']?.default).toBe('./lib/user-background.js')
    expect(manifest.files).toContain('lib/user-background.js')
  })

  it('keeps the persona text the same in both preset files, so the ball behaves alike on either path', () => {
    const prefixOf = (text: string) => /prefix: >-\n([\s\S]*?)\n\s*(?:#|suffix:|- id:)/u.exec(text)?.[1]
      ?.split('\n').map(line => line.trim()).join(' ')
    expect(prefixOf(overlay)).toBeDefined()
    expect(prefixOf(overlay)).toBe(prefixOf(composition))
  })
})

describe('long-term memory', () => {
  it('lives beside the description file', () => {
    expect(memoryPath({ DSH_HOME: '/data/dsh' }, '/home/me')).toBe(join('/data/dsh', 'dsh_orb', MEMORY_FILE))
    expect(memoryPath({}, '/home/me')).toBe(join('/home/me', '.dsh', 'dsh_orb', 'memory.md'))
  })

  it('tells the model where the file is, shows what it holds, and says how to add to it', () => {
    const section = composeMemorySection('- 2026-10-20 喜欢先看日志再看代码', '/x/memory.md')
    expect(section).toContain('/x/memory.md')
    expect(section).toContain('- 2026-10-20 喜欢先看日志再看代码')
    expect(section).toContain('追加')
    expect(section).toContain('不要记密码')
    expect(composeMemorySection('', '/x/memory.md')).toContain('（还没有）')
  })

  it('joins with the description, and stands alone when there is none', () => {
    expect(composeUserBackground('我是 Java 后端', 'M')).toBe('我是 Java 后端\n\n---\n\nM')
    expect(composeUserBackground('', 'M')).toBe('M')
  })

  it('shows the memory in the real system prompt, and an edit appears in the next assembly', async () => {
    const home = tempHome()
    writeBackground(home, '我是一名 Java 后端开发工程师。')
    const file = join(home, 'dsh_orb', MEMORY_FILE)
    writeFileSync(file, '- 2026-10-20 部署在广西服务器')
    process.env.DSH_HOME = home
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are a desktop agent.' })
    const { scope, key } = await mintAgentScope(ctx, 'orb')
    scope.ctx.systemPrompt.section({
      name: PERSONA_SUFFIX_SECTION,
      order: scope.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: '{{user_background}}',
    })
    apply(scope.ctx)
    const first = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
    expect(first).toContain('- 2026-10-20 部署在广西服务器')
    expect(first).toContain(file)
    writeFileSync(file, '- 2026-10-21 新的一条')
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    const second = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
    expect(second).toContain('新的一条')
    expect(second).not.toContain('部署在广西服务器')
  })

  it('keeps the newest lines of an oversized memory file', () => {
    const home = tempHome()
    mkdirSync(join(home, 'dsh_orb'), { recursive: true })
    const file = join(home, 'dsh_orb', MEMORY_FILE)
    writeFileSync(file, 'old'.repeat(MAX_MEMORY_CHARS) + 'NEWEST')
    const text = createUserBackgroundReader(file, { max: MAX_MEMORY_CHARS, fromEnd: true })()
    expect(text).toHaveLength(MAX_MEMORY_CHARS)
    expect(text.endsWith('NEWEST')).toBe(true)
  })
})
