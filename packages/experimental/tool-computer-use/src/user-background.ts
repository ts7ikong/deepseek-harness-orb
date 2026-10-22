/**
 * Overlay-only plugin: the user's own standing description as the `{{user_background}}` prompt variable.
 *
 * The Computer Use preset is a lean tool set and does not mount the workspace-instructions plugin, so an
 * `AGENTS.md` in the floating ball's workspace is never read by it. This plugin closes that gap for the one file
 * that matters here, `<DSH_HOME>/dsh_orb/AGENTS.md`: the preset's persona suffix renders it at the end of the
 * system prompt. The file is read again whenever it changes, so an edit reaches the next request with no restart.
 *
 * The same variable also carries the ball's long-term memory, `<DSH_HOME>/dsh_orb/memory.md`: its current text and the
 * rules for adding to it. The model writes the file with its shell tool, and the user can open and edit it any time.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/user-background
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'computer-use-user-background'

/** The prompt registry this row contributes a variable to. */
export const inject = ['systemPrompt']

/** Name of the prompt variable, written `{{user_background}}` in a template. */
export const USER_BACKGROUND_VARIABLE = 'user_background'

/** The floating ball's workspace folder under the harness home; its sessions run there. */
const ORB_WORKSPACE_NAME = 'dsh_orb'

/** File in that workspace holding the user's own description. */
export const USER_BACKGROUND_FILE = 'AGENTS.md'

/** Longest text taken from the file, so a mistaken paste cannot swamp the prompt. */
export const MAX_USER_BACKGROUND_CHARS = 20_000

/** File in the same workspace holding what the assistant has been asked to remember. */
export const MEMORY_FILE = 'memory.md'

/** Longest memory text put in the prompt; when the file is longer the newest lines (the end) are kept. */
export const MAX_MEMORY_CHARS = 8_000

/**
 * Where the user's description lives.
 * Follows the harness home rule: `$DSH_HOME` when set, otherwise `~/.dsh`.
 * @param env - process environment.
 * @param home - the operating-system home directory.
 * @returns the absolute path of `dsh_orb/AGENTS.md`.
 */
export function userBackgroundPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dshHome = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(home, '.dsh')
  return join(dshHome, ORB_WORKSPACE_NAME, USER_BACKGROUND_FILE)
}

/**
 * Where the long-term memory lives, beside the description file.
 * @param env - process environment.
 * @param home - the operating-system home directory.
 * @returns the absolute path of `dsh_orb/memory.md`.
 */
export function memoryPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(userBackgroundPath(env, home), '..', MEMORY_FILE)
}

/**
 * A reader for a text file that re-reads only when the file changes.
 * @param path - the file to read.
 * @param keep - how many characters to keep: the first ones, or the last ones when `fromEnd` is set.
 * @returns a function giving the file's trimmed text, empty when the file is missing or unreadable.
 */
export function createUserBackgroundReader(
  path: string,
  keep: { readonly max: number; readonly fromEnd?: boolean } = { max: MAX_USER_BACKGROUND_CHARS },
): () => string {
  let stamp = ''
  let text = ''
  return () => {
    try {
      const info = statSync(path)
      const next = `${String(info.mtimeMs)}:${String(info.size)}`
      if (next !== stamp) {
        const whole = readFileSync(path, 'utf8').trim()
        text = keep.fromEnd === true ? whole.slice(-keep.max) : whole.slice(0, keep.max)
        stamp = next
      }
      return text
    } catch {
      // No file yet means no standing description; an empty value drops the section instead of failing the prompt.
      stamp = ''
      text = ''
      return ''
    }
  }
}

/**
 * The long-term memory section: where the file is, what it holds now, and how to add to it.
 * @param memory - the file's current text; empty when nothing has been remembered yet.
 * @param path - the memory file's path, which the model is told to write.
 * @returns the section text.
 */
export function composeMemorySection(memory: string, path: string): string {
  return [
    '## 长期记忆',
    '',
    `你有一份跨会话的长期记忆文件：${path}`,
    '它现在的内容如下（“（还没有）”表示还没记过东西）：',
    '',
    memory === '' ? '（还没有）' : memory,
    '',
    '使用规则：',
    '- 用户说“记住……/别忘了……”，或你发现对今后帮助他有长期价值的信息（偏好、项目背景、人物、约定、决定）时，'
    + '用 shell 工具把一条简短的记忆追加到该文件末尾，格式 `- YYYY-MM-DD 内容`，一条一行，用 UTF-8 写入，不要改动已有内容。'
    + '文件或目录不存在就先创建。',
    '- 先看上面的内容：已经记过的不要重复；信息变了就改那一行。',
    '- 不要记密码、密钥、令牌、证件号这类敏感信息，也不要记一次性的琐事。',
    '- 写入后用一句话告诉用户记了什么。没有真正写入文件，就不要说“我记住了”。',
    '- 用户说“忘掉……”时，把文件里对应的行删掉，并告诉用户。',
  ].join('\n')
}

/**
 * Join the user's description and the memory section into the prompt variable's value.
 * @param background - the description file's text; may be empty.
 * @param memory - the memory section.
 * @returns the text, with a rule between the two parts when both exist.
 */
export function composeUserBackground(background: string, memory: string): string {
  return background === '' ? memory : `${background}\n\n---\n\n${memory}`
}

/**
 * Register the `{{user_background}}` prompt variable for the mounting agent scope.
 * @param ctx - an agent scope context with the prompt registry.
 */
export function apply(ctx: Context): void {
  const readBackground = createUserBackgroundReader(userBackgroundPath())
  const memoryFile = memoryPath()
  const readMemory = createUserBackgroundReader(memoryFile, { max: MAX_MEMORY_CHARS, fromEnd: true })
  ctx.effect(
    () => ctx.systemPrompt.variable(
      USER_BACKGROUND_VARIABLE,
      () => composeUserBackground(readBackground(), composeMemorySection(readMemory(), memoryFile)),
    ),
    'user-background.variable()',
  )
}
