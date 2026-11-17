// Daily report confirmation: edit the draft, then write it to the work log or copy it.
const api = window.dshDesktop?.report
const CLOSE_AFTER_LOG_MS = 1300
const CLOSE_AFTER_SEND_MS = 2600
const text = document.querySelector('#text')
const status = document.querySelector('#status')
const logButton = document.querySelector('#log')
const copyButton = document.querySelector('#copy')
const cancelButton = document.querySelector('#cancel')
const intro = document.querySelector('#intro')
const dingtalkButton = document.querySelector('#dingtalk')
let pendingMark = '（待补充）'
let busy = false
let weekly = false

function pendingCount() {
  const marks = [pendingMark, '(待补充)']
  return text.value.split('\n').filter(line => marks.some(mark => line.includes(mark))).length
}

function say(message, kind) {
  status.textContent = message
  status.className = kind ?? ''
}

// The entries still marked as guesses must be settled before they go into the log.
function sync() {
  const pending = pendingCount()
  logButton.disabled = busy || pending > 0 || text.value.trim() === ''
  dingtalkButton.disabled = logButton.disabled
  copyButton.disabled = busy || text.value.trim() === ''
  if (!busy && pending > 0) say(`还有 ${pending} 处“待补充”，补全或删掉后才能${weekly ? '发出去' : '记入工作日志'}`, 'warn')
  else if (!busy && status.className === 'warn') say('')
}

function describeFailure(result) {
  if (result.reason === 'empty') return '没有可记入的内容'
  if (result.reason === 'pending') return `还有 ${result.pending} 处“待补充”`
  return `没能写入：${result.message ?? '未知错误'}`
}

async function confirmLog() {
  busy = true
  sync()
  say('正在写入…')
  try {
    const result = await api.confirm(text.value, 'log')
    if (result.ok) {
      const { added, skipped } = result.write
      say(skipped > 0 ? `已记入 ${added} 条（${skipped} 条今天已有，已跳过）` : `已记入 ${added} 条`, 'ok')
      setTimeout(() => { window.close() }, CLOSE_AFTER_LOG_MS)
      return
    }
    say(describeFailure(result), result.reason === 'error' ? 'error' : 'warn')
  } catch (error) {
    say(`没能写入：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
  busy = false
  sync()
}

// The report is put on the clipboard and DingTalk is brought forward; pasting and sending stay with the user.
async function sendToDingTalk() {
  busy = true
  sync()
  say('正在复制…')
  try {
    const result = await api.confirm(text.value, 'dingtalk')
    if (result.ok) {
      say(result.opened
        ? `已复制 ${result.copied} 条并打开钉钉，到要发的地方粘贴（Ctrl+V）即可`
        : `已复制 ${result.copied} 条，但没能打开钉钉，请手动打开后粘贴`, result.opened ? 'ok' : 'warn')
      setTimeout(() => { window.close() }, CLOSE_AFTER_SEND_MS)
      return
    }
    say(describeFailure(result), result.reason === 'error' ? 'error' : 'warn')
  } catch (error) {
    say(`没能复制：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
  busy = false
  sync()
}

async function copyText() {
  try {
    const result = await api.confirm(text.value, 'copy')
    say(result.ok ? `已复制 ${result.copied} 条` : '没有可复制的内容', result.ok ? 'ok' : 'warn')
  } catch (error) {
    say(`没能复制：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

async function start() {
  if (api === undefined) {
    say('这个窗口没有连上主程序，请关掉重试', 'error')
    return
  }
  const info = await api.init()
  pendingMark = info.pendingMark
  weekly = info.kind === 'weekly'
  text.value = info.text
  document.querySelector('#date').textContent = info.date
  logButton.hidden = weekly
  dingtalkButton.hidden = !weekly
  if (weekly) {
    document.title = '周报草稿'
    document.querySelector('#title').textContent = '周报草稿'
    intro.textContent = '每行一条，直接修改，“待补充”处补全后，点“复制并打开钉钉”，再到钉钉里粘贴发送。'
  } else if (info.today === false) {
    document.title = '补写日报'
    document.querySelector('#title').textContent = '补写日报'
    intro.textContent = info.existing > 0
      ? `这是补写 ${info.date} 的日报，那天的工作日志已有 ${info.existing} 条，下面的内容会追加在后面。每行一条，可以直接修改。`
      : `这是补写 ${info.date} 的日报，确认后会记入那一天的工作日志。每行一条，可以直接修改。`
  } else intro.textContent = info.existing > 0
    ? `今天的工作日志已有 ${info.existing} 条，下面的内容会追加在后面。每行一条，可以直接修改。`
    : '每行一条，直接在下面修改；改好后点“记入工作日志”。'
  sync()
  text.focus()
  text.setSelectionRange(0, 0)
}

text.addEventListener('input', sync)
logButton.addEventListener('click', () => { void confirmLog() })
dingtalkButton.addEventListener('click', () => { void sendToDingTalk() })
copyButton.addEventListener('click', () => { void copyText() })
cancelButton.addEventListener('click', () => { window.close() })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.close()
  // Ctrl+Enter confirms from the keyboard without leaving the text.
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !logButton.disabled) {
    void (weekly ? sendToDingTalk() : confirmLog())
  }
})

void start().catch((error) => {
  say(`没能加载草稿：${error instanceof Error ? error.message : String(error)}`, 'error')
})
