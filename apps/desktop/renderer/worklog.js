// Work log viewer: recent days of confirmed daily-report entries, newest first.
const api = window.dshDesktop?.worklog
const list = document.querySelector('#list')
const status = document.querySelector('#status')

function say(message, kind) {
  status.textContent = message
  status.className = kind ?? ''
}

function render(view) {
  document.querySelector('#path').textContent = view.file
  document.querySelector('#count').textContent = view.days.length === 0 ? '' : `最近 ${view.days.length} 天`
  list.textContent = ''
  if (view.days.length === 0) {
    const empty = document.createElement('p')
    empty.id = 'empty'
    empty.textContent = '还没有工作记录。在日报草稿窗口里点“记入工作日志”，确认过的条目就会出现在这里。'
    list.append(empty)
    return
  }
  for (const day of view.days) {
    const section = document.createElement('section')
    const heading = document.createElement('h2')
    heading.textContent = day.date
    const items = document.createElement('ul')
    for (const entry of day.entries) {
      const item = document.createElement('li')
      if (entry.time !== '') {
        const time = document.createElement('time')
        time.textContent = entry.time
        item.append(time)
      }
      item.append(document.createTextNode(entry.content))
      items.append(item)
    }
    section.append(heading, items)
    list.append(section)
  }
}

async function open(what) {
  try {
    const failure = await api.open(what)
    const failed = typeof failure === 'string' && failure !== ''
    say(failed ? `没能打开：${failure}` : '', failed ? 'warn' : '')
  } catch (error) {
    say(`没能打开：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

async function start() {
  if (api === undefined) {
    say('这个窗口没有连上主程序，请关掉重试', 'error')
    return
  }
  render(await api.get())
}

document.querySelector('#open-log').addEventListener('click', () => { void open('log') })
document.querySelector('#open-weekly').addEventListener('click', () => { void open('weekly') })
document.querySelector('#close').addEventListener('click', () => { window.close() })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.close()
})

void start().catch((error) => {
  say(`没能加载记录：${error instanceof Error ? error.message : String(error)}`, 'error')
})
