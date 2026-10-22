/**
 * The floating ball's standing instructions.
 *
 * `dsh_orb/AGENTS.md` is where the user writes who they are and how the assistant should behave. The Computer Use
 * preset the ball runs on does not load workspace instructions itself, so its `user-background` plugin renders this
 * one file at the end of the system prompt (see `packages/experimental/tool-computer-use/src/user-background.ts`),
 * and an edit reaches the next request with no restart. This module composes that file and creates a starter when
 * none exists; it never overwrites one the user has.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File the harness loads as workspace instructions. */
export const ORB_PERSONA_FILE = 'AGENTS.md'

/** Heading of the section that states what the assistant can really do; it outranks the user's own text. */
export const CAPABILITY_HEADING = '## 当前能力与限制（与上文冲突时，以本节为准）'

/**
 * What the assistant can and cannot do today. The user's own description of an ideal assistant often asks
 * for more (long-term memory, speaking up on its own); without this the model would promise it.
 */
export const CAPABILITY_NOTES = [
  CAPABILITY_HEADING,
  '',
  '你运行在用户 Windows 电脑上的 DeepSeek Orb 悬浮球里。下面是你现在真实能做和不能做的事，请据此说话，不要承诺做不到的事：',
  '',
  '- 你能通过截图和鼠标键盘操作用户的电脑，也能把耗时的代码、文档类任务交给后台会话。操作电脑时少说话，做完后用一两句话汇报结果。',
  '- 你的长期记忆就是记忆文件（见下文“长期记忆”一节）：只有真正写进文件的内容明天才还在，没写进去就不要说“我记住了”。你不会自动记得对话里没写下来的事。',
  '- 你不能在未来某个时刻主动开口。提醒由应用的定时器负责（例如工作日的日报提醒和下班提醒，时间在应用的配置里改）。不要说“到点我会提醒你”。',
  '- 日报和周报由应用自己的流程生成：它把当天或本周的记录交给你，你按要求输出报告条目。被要求按固定格式输出时，严格按要求，不加寒暄、标题或说明，也不要加个性化语气。',
  '- 不确定的事直接说不确定，不要编造。',
].join('\n')

const STARTER_BODY = [
  '这个文件是悬浮球助手每次回答前都会读到的长期设定，放在系统提示的末尾。',
  '在下面写下你是谁、做什么工作、希望助手怎么和你相处，保存后下一次提问就会生效，不用重启。',
  '',
  '## 关于我',
  '',
  '（在这里写：你的工作、常用的技术、沟通偏好……）',
].join('\n')

/**
 * Compose the instruction file from the user's own description.
 * @param userText - what the user wrote about themselves and the assistant, kept word for word.
 * @returns the file contents: the user's text, then the capability section.
 */
export function composePersona(userText: string): string {
  return `# 悬浮球助手设定\n\n${userText.trim()}\n\n---\n\n${CAPABILITY_NOTES}\n`
}

/**
 * Create the starter instruction file when the workspace has none.
 * @param workspaceDir - the `dsh_orb` workspace directory.
 * @returns true when a starter was written; false when the user's file was left alone.
 */
export function ensureOrbPersonaFile(workspaceDir: string): boolean {
  const file = join(workspaceDir, ORB_PERSONA_FILE)
  if (existsSync(file)) return false
  mkdirSync(workspaceDir, { recursive: true })
  writeFileSync(file, composePersona(STARTER_BODY))
  return true
}
