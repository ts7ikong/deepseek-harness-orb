// Catch-up picker: choose a recent day and ask for its daily report draft.
const api = window.dshDesktop?.backfill
const daysBox = document.querySelector('#days')
const status = document.querySelector('#status')
const goButton = document.querySelector('#go')
let selected = ''

function say(message, kind) {
  status.textContent = message
  status.className = kind ?? ''
}

function describe(day) {
  const parts = []
  parts.push(day.entries > 0 ? `已有 ${day.entries} 条日报` : '没有日报')
  if (day.activeMinutes > 0) {
    const hours = Math.floor(day.activeMinutes / 60)
    const minutes = day.activeMinutes % 60
    parts.push(`电脑使用 ${hours > 0 ? `${hours} 小时 ` : ''}${minutes} 分钟`)
  } else {
    parts.push('没有使用记录')
  }
  return parts.join(' · ')
}

function select(date) {
  selected = date
  for (const row of daysBox.querySelectorAll('[data-date]')) {
    row.setAttribute('aria-selected', row.dataset.date === date ? 'true' : 'false')
  }
  goButton.disabled = date === ''
}

function render(view) {
  daysBox.textContent = ''
  for (const day of view.days) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'day'
    row.dataset.date = day.date
    row.setAttribute('role', 'option')
    const title = document.createElement('span')
    title.className = 'day-title'
    title.textContent = `${day.date} ${day.weekday}`
    const detail = document.createElement('span')
    detail.className = 'day-detail'
    detail.textContent = describe(day)
    if (day.entries === 0 && day.activeMinutes > 0) row.classList.add('missing')
    row.append(title, detail)
    row.addEventListener('click', () => { select(day.date) })
    row.addEventListener('dblclick', () => { void generate() })
    daysBox.append(row)
  }
  select(view.defaultDate)
}

async function generate() {
  if (selected === '' || goButton.disabled) return
  goButton.disabled = true
  say('正在生成，草稿窗口马上弹出…')
  try {
    await api.go(selected)
  } catch (error) {
    say(`没能生成：${error instanceof Error ? error.message : String(error)}`, 'error')
    goButton.disabled = false
  }
}

async function start() {
  if (api === undefined) {
    say('这个窗口没有连上主程序，请关掉重试', 'error')
    return
  }
  render(await api.get())
}

goButton.addEventListener('click', () => { void generate() })
document.querySelector('#cancel').addEventListener('click', () => { window.close() })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.close()
  if (event.key === 'Enter') void generate()
})

void start().catch((error) => {
  say(`没能加载日期：${error instanceof Error ? error.message : String(error)}`, 'error')
})
