import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPABILITY_HEADING,
  CAPABILITY_NOTES,
  composePersona,
  ensureOrbPersonaFile,
  ORB_PERSONA_FILE,
} from '../src/orb-persona.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-persona-'))
  roots.push(root)
  return root
}

describe('composePersona', () => {
  const mine = '# 一、用户基本定位\n\n我是一个长期使用 AI 的用户。\n\n---\n\n# 二、我的工作背景\n\n我是一名 Java 后端开发工程师。'

  it('keeps the user\'s text word for word, then adds the capability section after it', () => {
    const file = composePersona(mine)
    expect(file.startsWith('# 悬浮球助手设定\n\n# 一、用户基本定位')).toBe(true)
    expect(file).toContain(mine)
    expect(file.indexOf(mine)).toBeLessThan(file.indexOf(CAPABILITY_HEADING))
    expect(file.endsWith(`${CAPABILITY_NOTES}\n`)).toBe(true)
  })

  it('trims stray blank lines around the user\'s text but not inside it', () => {
    expect(composePersona(`\n\n  ${mine}  \n\n`)).toContain(`# 悬浮球助手设定\n\n${mine}\n\n---`)
  })
})

describe('capability notes', () => {
  it('say that the section outranks the text above it', () => {
    expect(CAPABILITY_HEADING).toContain('以本节为准')
  })

  it('stop the model promising memory, reminders, or chatter it cannot deliver', () => {
    expect(CAPABILITY_NOTES).toContain('只有真正写进文件的内容')
    expect(CAPABILITY_NOTES).toContain('没写进去就不要说“我记住了”')
    expect(CAPABILITY_NOTES).toContain('不能在未来某个时刻主动开口')
    expect(CAPABILITY_NOTES).toContain('不要说“到点我会提醒你”')
    expect(CAPABILITY_NOTES).toContain('不加寒暄、标题或说明')
  })
})

describe('ensureOrbPersonaFile', () => {
  it('writes a starter with the capability section when the workspace has no instructions', () => {
    const dir = join(tempDir(), 'dsh_orb')
    expect(ensureOrbPersonaFile(dir)).toBe(true)
    const text = readFileSync(join(dir, ORB_PERSONA_FILE), 'utf8')
    expect(text).toContain('## 关于我')
    expect(text).toContain(CAPABILITY_HEADING)
  })

  it('never overwrites a file the user already has', () => {
    const dir = tempDir()
    writeFileSync(join(dir, ORB_PERSONA_FILE), '我自己写的设定')
    expect(ensureOrbPersonaFile(dir)).toBe(false)
    expect(readFileSync(join(dir, ORB_PERSONA_FILE), 'utf8')).toBe('我自己写的设定')
  })

  it('writes once and then leaves its own starter alone', () => {
    const dir = tempDir()
    expect(ensureOrbPersonaFile(dir)).toBe(true)
    writeFileSync(join(dir, ORB_PERSONA_FILE), '改过的内容')
    expect(ensureOrbPersonaFile(dir)).toBe(false)
    expect(readFileSync(join(dir, ORB_PERSONA_FILE), 'utf8')).toBe('改过的内容')
    expect(existsSync(join(dir, `${ORB_PERSONA_FILE}.bak`))).toBe(false)
  })
})
