import { describe, expect, it } from 'vitest'
import { summarizeDay, type ActivitySample } from '../src/activity-log.ts'
import {
  buildDailyReportPrompt,
  formatDuration,
  friendlyAppName,
  MIN_REPORT_ACTIVE_MS,
} from '../src/daily-report.ts'

const MINUTE = 60_000
// 2026-10-20 is a Tuesday.
const at = (hours: number, minutes: number) => new Date(2026, 9, 20, hours, minutes).getTime()
const day = new Date(2026, 9, 20)

/** Samples one minute apart, `minutes` of them, all in the same window. */
function steady(start: number, minutes: number, app: string, title: string): ActivitySample[] {
  return Array.from({ length: minutes }, (_, index) => ({ t: start + index * MINUTE, app, title, idle: false }))
}

describe('formatDuration', () => {
  it('writes minutes, hours, and hours with minutes', () => {
    expect(formatDuration(20_000)).toBe('不到 1 分钟')
    expect(formatDuration(35 * MINUTE)).toBe('35 分钟')
    expect(formatDuration(120 * MINUTE)).toBe('2 小时')
    expect(formatDuration(125 * MINUTE)).toBe('2 小时 5 分钟')
  })
})

describe('friendlyAppName', () => {
  it('names known programs and passes unknown ones through', () => {
    expect(friendlyAppName('WINWORD')).toBe('Word')
    expect(friendlyAppName('WeChatAppEx')).toBe('微信')
    expect(friendlyAppName('mytool')).toBe('mytool')
  })
})

describe('buildDailyReportPrompt', () => {
  const samples = [
    ...steady(at(9, 0), 90, 'Code', 'report.ts - project - Visual Studio Code'),
    ...steady(at(10, 30), 40, 'chrome', 'API 文档 - Google Chrome'),
    ...steady(at(11, 10), 20, 'Weixin', '(已隐藏)'),
    // A program in front for only 20 seconds, then the next sample.
    { t: at(11, 30), app: 'explorer', title: 'tiny', idle: false },
    { t: at(11, 30) + 20_000, app: 'zz', title: '', idle: false },
  ]

  it('lists programs by time with their main windows, in friendly terms', () => {
    const prompt = buildDailyReportPrompt(summarizeDay(samples, MINUTE), day)
    expect(prompt).toContain('2026年10月20日 周二')
    expect(prompt).toContain('1. VS Code：1 小时 30 分钟')
    expect(prompt).toContain('   - report.ts - project：1 小时 30 分钟')
    expect(prompt).toContain('2. Chrome 浏览器：40 分钟')
    expect(prompt).toContain('3. 微信：20 分钟')
    expect(prompt).toContain('活跃时段：09:00 – 11:30')
  })

  it('drops the browser suffix, hidden titles, and programs used under a minute', () => {
    const prompt = buildDailyReportPrompt(summarizeDay(samples, MINUTE), day)
    expect(prompt).toContain('   - API 文档：40 分钟')
    expect(prompt).not.toContain('Google Chrome')
    expect(prompt).not.toContain('Visual Studio Code')
    expect(prompt).not.toContain('tiny')
    expect(prompt).not.toContain('(已隐藏)')
  })

  it('tells the model not to invent results and not to operate the computer', () => {
    const prompt = buildDailyReportPrompt(summarizeDay(samples, MINUTE), day)
    expect(prompt).toContain('不要编造')
    expect(prompt).toContain('待补充')
    expect(prompt).toContain('不要操作电脑')
  })

  it('asks for a blank template when there is too little to summarize', () => {
    const few = steady(at(9, 0), 2, 'Code', 'x')
    expect(summarizeDay(few, MINUTE).activeMs).toBeLessThan(MIN_REPORT_ACTIVE_MS)
    const prompt = buildDailyReportPrompt(summarizeDay(few, MINUTE), day)
    expect(prompt).toContain('日报模板')
    expect(prompt).toContain('不要操作电脑')
    expect(prompt).not.toContain('按程序统计')
  })

  it('caps the length for a very busy day', () => {
    const busy: ActivitySample[] = []
    for (let app = 0; app < 40; app += 1) busy.push(...steady(at(8, 0) + app * 3 * MINUTE, 3, `app${String(app)}`, `title ${String(app)}`))
    const prompt = buildDailyReportPrompt(summarizeDay(busy, MINUTE), day)
    expect(prompt.split('\n').filter(line => /^\d+\. /u.test(line))).toHaveLength(12)
  })
})

describe('buildDailyReportPrompt with past report entries as examples', () => {
  const samples = steady(at(9, 0), 90, 'Code', 'report.ts - project')
  const summary = summarizeDay(samples, MINUTE)
  const examples = [
    { date: '2026-10-14', items: ['部署创普达人员定位系统', '修复龙冉人员定位无法处理SOS报警问题'] },
    { date: '2026-10-15', items: ['处理江川化工人员定位的证书问题'] },
  ]

  it('lists the past entries after the usage data, day by day', () => {
    const prompt = buildDailyReportPrompt(summary, day, examples)
    const tail = prompt.slice(prompt.indexOf('我过去的日报条目（仅作写法参考）：'))
    expect(tail).toBe([
      '我过去的日报条目（仅作写法参考）：',
      '2026-10-14',
      '- 部署创普达人员定位系统',
      '- 修复龙冉人员定位无法处理SOS报警问题',
      '2026-10-15',
      '- 处理江川化工人员定位的证书问题',
    ].join('\n'))
    expect(prompt.indexOf('按程序统计')).toBeLessThan(prompt.indexOf('我过去的日报条目（仅作写法参考）'))
  })

  it('makes the examples set the wording and format, and drops the fixed tomorrow-plan line', () => {
    const prompt = buildDailyReportPrompt(summary, day, examples)
    expect(prompt).toContain('写法完全参照文末')
    expect(prompt).toContain('不要照抄其中的内容')
    expect(prompt).toContain('不要编造客户名')
    expect(prompt).not.toContain('明日计划')
  })

  it('keeps the plain format and the tomorrow-plan line when there are no examples', () => {
    const prompt = buildDailyReportPrompt(summary, day)
    expect(prompt).toContain('明日计划')
    expect(prompt).not.toContain('我过去的日报条目')
    expect(prompt).toBe(buildDailyReportPrompt(summary, day, []))
  })

  it('leaves the examples out of the blank-template request, which has no data to write from', () => {
    const few = summarizeDay(steady(at(9, 0), 2, 'Code', 'x'), MINUTE)
    expect(buildDailyReportPrompt(few, day, examples)).not.toContain('2026-10-14')
  })
})

describe('title cleanup and non-work content', () => {
  const edge = [
    ...steady(at(9, 0), 10, 'msedge', '视频历史报警数据 - 预警系统 和另外 2 个页面 - 个人 - Microsoft​ Edge'),
    ...steady(at(9, 10), 10, 'msedge', 'Nacos - 个人'),
    ...steady(at(9, 20), 10, 'claude', 'Claude'),
    ...steady(at(9, 30), 10, 'Weixin', '微信'),
  ]

  it('drops the tab-group note, the browser profile, and the browser name from a title', () => {
    const prompt = buildDailyReportPrompt(summarizeDay(edge, MINUTE), day)
    expect(prompt).toContain('   - 视频历史报警数据 - 预警系统：10 分钟')
    expect(prompt).toContain('   - Nacos：10 分钟')
    expect(prompt).not.toContain('和另外')
    expect(prompt).not.toContain('个人')
    expect(prompt).not.toContain('Microsoft')
  })

  it('omits a title that only repeats the program name', () => {
    const prompt = buildDailyReportPrompt(summarizeDay(edge, MINUTE), day)
    expect(prompt).toContain('Claude：10 分钟')
    expect(prompt).not.toContain('   - Claude')
    expect(prompt).not.toContain('   - 微信')
  })

  it('tells the model to leave out video, games, and other non-work content, with or without examples', () => {
    const summary = summarizeDay(edge, MINUTE)
    expect(buildDailyReportPrompt(summary, day)).toContain('视频、游戏、购物、娱乐等与工作无关的内容一律不写')
    expect(buildDailyReportPrompt(summary, day, [{ date: '2026-10-14', items: ['x'] }]))
      .toContain('视频、游戏、购物、娱乐等与工作无关的内容一律不写')
  })
})

describe('buildDailyReportPrompt with screen descriptions', () => {
  const summary = summarizeDay(steady(at(9, 0), 90, 'Code', 'report.ts - project'), MINUTE)
  const notes = [
    { time: '09:50', text: '调试脚本，同时处理日报' },
    { time: '10:07', text: '编写Maven项目代码，右侧显示运维系统登录页' },
  ]

  it('lists them with their times after the program totals, as extra clues', () => {
    const prompt = buildDailyReportPrompt(summary, day, [], notes)
    const section = prompt.slice(prompt.indexOf('屏幕描述（'))
    expect(section).toBe([
      '屏幕描述（另一个工具每隔一段时间用一句话概括当时屏幕上的内容）：',
      '- 09:50 调试脚本，同时处理日报',
      '- 10:07 编写Maven项目代码，右侧显示运维系统登录页',
    ].join('\n'))
    expect(prompt.indexOf('按程序统计')).toBeLessThan(prompt.indexOf('屏幕描述（'))
  })

  it('says the descriptions are only clues, and that the program totals win a disagreement', () => {
    const prompt = buildDailyReportPrompt(summary, day, [], notes)
    expect(prompt).toContain('补充线索')
    expect(prompt).toContain('以程序统计为准')
  })

  it('puts the descriptions before the writing examples', () => {
    const prompt = buildDailyReportPrompt(summary, day, [{ date: '2026-10-14', items: ['部署甲'] }], notes)
    expect(prompt.indexOf('屏幕描述（')).toBeLessThan(prompt.indexOf('我过去的日报条目（仅作写法参考）'))
  })

  it('asks for the entries alone, with no explanation and no identifiers such as session numbers', () => {
    for (const prompt of [buildDailyReportPrompt(summary, day), buildDailyReportPrompt(summary, day, [{ date: '2026-10-14', items: ['x'] }], notes)]) {
      expect(prompt).toContain('只输出日报条目本身')
      expect(prompt).toContain('不要写标题、说明或总结')
      expect(prompt).toContain('会话号、IP 地址、账号、密码')
    }
  })

  it('adds nothing when there are none', () => {
    const prompt = buildDailyReportPrompt(summary, day)
    expect(prompt).not.toContain('屏幕描述')
    expect(prompt).toBe(buildDailyReportPrompt(summary, day, [], []))
  })
})
