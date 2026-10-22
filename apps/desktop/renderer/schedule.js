// Working-hours settings: load the saved hours, save them back, and close.
const api = window.dshDesktop?.schedule
const CLOSE_AFTER_SAVE_MS = 900
const TIME_FIELDS = ['workStart', 'lunchStart', 'afternoonStart', 'workEnd']
const status = document.querySelector('#status')
const saveButton = document.querySelector('#save')
const showClock = document.querySelector('#showClock')
const field = id => document.querySelector(`#${id}`)

function say(message, kind) {
  status.textContent = message
  status.className = kind ?? ''
}

function formValue() {
  return {
    showClock: showClock.checked,
    ...Object.fromEntries(TIME_FIELDS.map(id => [id, field(id).value])),
  }
}

async function save() {
  saveButton.disabled = true
  say('正在保存…')
  try {
    const result = await api.set(formValue())
    if (result.ok) {
      say('已保存，几秒内生效', 'ok')
      setTimeout(() => { window.close() }, CLOSE_AFTER_SAVE_MS)
      return
    }
    say(result.message, 'warn')
  } catch (error) {
    say(`没能保存：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
  saveButton.disabled = false
}

async function start() {
  if (api === undefined) {
    say('这个窗口没有连上主程序，请关掉重试', 'error')
    return
  }
  const form = await api.get()
  showClock.checked = form.showClock !== false
  for (const id of TIME_FIELDS) field(id).value = typeof form[id] === 'string' ? form[id] : ''
  field('workStart').focus()
}

saveButton.addEventListener('click', () => { void save() })
document.querySelector('#cancel').addEventListener('click', () => { window.close() })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.close()
  if (event.key === 'Enter' && !saveButton.disabled) void save()
})

void start().catch((error) => {
  say(`没能加载设置：${error instanceof Error ? error.message : String(error)}`, 'error')
})
