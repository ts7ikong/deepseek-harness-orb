/** Turns a day's activity totals into the prompt that asks the model for a daily report draft. */

import { HIDDEN_TITLE, type DaySummary, type ScreenNote, type WorkLogDay } from './activity-log.ts'

/** Programs shown with a friendly name; anything else is shown as its program name. */
const FRIENDLY_APP_NAMES: Readonly<Record<string, string>> = {
  chrome: 'Chrome 浏览器',
  msedge: 'Edge 浏览器',
  firefox: 'Firefox 浏览器',
  code: 'VS Code',
  idea64: 'IntelliJ IDEA',
  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  wps: 'WPS',
  weixin: '微信',
  wechat: '微信',
  wechatappex: '微信',
  dingtalk: '钉钉',
  feishu: '飞书',
  qq: 'QQ',
  explorer: '文件资源管理器',
  windowsterminal: '终端',
  powershell: 'PowerShell',
  notepad: '记事本',
  navicat: 'Navicat',
  searchhost: 'Windows 搜索',
  claude: 'Claude',
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const
const MAX_APPS = 12
const MAX_TITLES_PER_APP = 6
const MAX_TITLE_CHARS = 80
const MIN_LISTED_MS = 60_000
/** Below this much activity there is nothing worth summarizing; the model is asked for a blank template instead. */
export const MIN_REPORT_ACTIVE_MS = 5 * 60_000
/** `- Google Chrome` and similar, plus a browser profile name before it such as `- 个人`. */
const BROWSER_NAMES = String.raw`(?:Google Chrome|Microsoft\u200b? ?Edge|Mozilla Firefox|Visual Studio Code)`
const BROWSER_SUFFIX = new RegExp(String.raw`(?:\s[-–—]\s(?:个人|工作|Personal|Work))?\s[-–—]\s${BROWSER_NAMES}$`, 'u')
/** Some logs keep the profile name after stripping the browser name. */
const TRAILING_PROFILE = /\s[-–—]\s(?:个人|工作|Personal|Work)$/u
/** Edge's `和另外 3 个页面` tab-group note. */
const OTHER_PAGES = /\s和另外 \d+ 个页面/u

/**
 * Friendly display name for a program.
 * @param app - program name without `.exe`.
 * @returns a Chinese or product name when known, otherwise the program name.
 */
export function friendlyAppName(app: string): string {
  return FRIENDLY_APP_NAMES[app.toLowerCase()] ?? app
}

/**
 * Human-readable duration.
 * @param ms - milliseconds.
 * @returns such as `不到 1 分钟`, `35 分钟`, `2 小时`, or `2 小时 5 分钟`.
 */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${String(minutes)} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${String(hours)} 小时` : `${String(hours)} 小时 ${String(rest)} 分钟`
}

function clock(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** A title that only repeats the program's name says nothing about the work. */
function isAppName(title: string, app: string): boolean {
  const lower = title.trim().toLowerCase()
  return lower === app.toLowerCase() || lower === friendlyAppName(app).toLowerCase()
}

function shortTitle(title: string): string {
  const cleaned = title.replace(OTHER_PAGES, '').replace(BROWSER_SUFFIX, '').replace(TRAILING_PROFILE, '').trim()
  return cleaned.length > MAX_TITLE_CHARS ? `${cleaned.slice(0, MAX_TITLE_CHARS - 1)}…` : cleaned
}

const REPLY_IN_TEXT = '直接用文字回复，不要操作电脑，不要打开任何程序或文件。'

function exampleLines(examples: readonly WorkLogDay[]): string[] {
  return examples.flatMap(day => [day.date, ...day.items.map(item => `- ${item}`)])
}

/**
 * Build the prompt that asks for a daily report draft.
 * @param summary - the day's totals.
 * @param date - the day being reported.
 * @param examples - the user's past report entries, oldest first. When present they set the wording and format.
 * @param notes - one-sentence descriptions of the screen through the day, used as extra context.
 * @returns the prompt text. It states the data's limits so the model does not invent results.
 */
export function buildDailyReportPrompt(
  summary: DaySummary,
  date: Date,
  examples: readonly WorkLogDay[] = [],
  notes: readonly ScreenNote[] = [],
): string {
  const dateLine = `${String(date.getFullYear())}年${String(date.getMonth() + 1)}月${String(date.getDate())}日 周${WEEKDAYS[date.getDay()] ?? ''}`
  if (summary.activeMs < MIN_REPORT_ACTIVE_MS) {
    return [
      `今天（${dateLine}）本机记录到的电脑使用时间只有 ${formatDuration(summary.activeMs)}，记录功能可能刚启动，`
      + '没有足够的内容可以整理。',
      '请先给我一份日报模板（今日工作、遇到的问题、明日计划），每一项留空，由我自己补充。',
      REPLY_IN_TEXT,
    ].join('\n')
  }
  const lines: string[] = []
  summary.apps
    .filter(app => app.ms >= MIN_LISTED_MS)
    .slice(0, MAX_APPS)
    .forEach((app, index) => {
      lines.push(`${String(index + 1)}. ${friendlyAppName(app.app)}：${formatDuration(app.ms)}`)
      const titles = app.titles
        .filter(entry => entry.title !== '' && entry.title !== HIDDEN_TITLE && entry.ms >= MIN_LISTED_MS
          && !isAppName(entry.title, app.app))
        .slice(0, MAX_TITLES_PER_APP)
      for (const entry of titles) lines.push(`   - ${shortTitle(entry.title)}：${formatDuration(entry.ms)}`)
    })
  const span = summary.firstAt === undefined || summary.lastAt === undefined
    ? ''
    : `活跃时段：${clock(summary.firstAt)} – ${clock(summary.lastAt)}，`
  const preface = [
    '我今天在电脑上的使用记录如下。它由本机自动记录，只有程序名、窗口标题和时长，不含具体内容，空闲时间已排除。',
    '请据此帮我整理一份今天的工作日报草稿。',
    '',
    '要求：',
  ]
  const requirements = examples.length > 0
    ? [
      '- 写法完全参照文末“我过去的日报条目”：一条一句话、不带时间，写清客户或系统的名字和做了什么'
      + '（部署、修复、处理、编写等），用词和叫法跟范例保持一致。范例只用来学写法，不要照抄其中的内容。',
      '- 只依据使用记录推断；看不出具体客户或内容的地方写“（待补充）”，不要编造客户名、数量或结果。',
      '- 聊天、搜索、系统窗口等看不出工作内容的，忽略或一句话带过；视频、游戏、购物、娱乐等与工作无关的内容一律不写。',
      '- 条目数量参照范例，通常几条即可，合并同一件事的多个窗口。',
    ]
    : [
      '- 用中文，条目式，按“工作内容”归纳，不要罗列软件名；同一件事的多个窗口合并成一条。',
      '- 只依据下面的记录推断，不确定的地方写“（待补充）”，不要编造具体数据、结论或结果。',
      '- 聊天、搜索、系统窗口等看不出工作内容的，可以忽略或一句话带过；视频、游戏、购物、娱乐等与工作无关的内容一律不写。',
      '- 最后附上“明日计划：（待补充）”。',
    ]
  const outputRequirement = '- 只输出日报条目本身，每行一条；不要写标题、说明或总结，也不要把会话号、IP 地址、账号、密码之类的标识写进去。'
  const noteRequirement = notes.length > 0
    ? ['- “屏幕描述”只是补充线索，可能不准；与程序统计矛盾时以程序统计为准，描述里提到的娱乐、闲聊内容不要写进日报。']
    : []
  const noteSection = notes.length > 0
    ? ['', '屏幕描述（另一个工具每隔一段时间用一句话概括当时屏幕上的内容）：', ...notes.map(note => `- ${note.time} ${note.text}`)]
    : []
  return [
    ...preface,
    ...requirements,
    ...noteRequirement,
    outputRequirement,
    `- ${REPLY_IN_TEXT}`,
    '',
    `日期：${dateLine}`,
    `${span}实际使用 ${formatDuration(summary.activeMs)}。`,
    '',
    '按程序统计（时长从多到少）：',
    ...lines,
    ...noteSection,
    ...(examples.length > 0 ? ['', '我过去的日报条目（仅作写法参考）：', ...exampleLines(examples)] : []),
  ].join('\n')
}
