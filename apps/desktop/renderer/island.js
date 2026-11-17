// The island page: draws the state the main process sends and sends back what the user picks.
const api = window.dshDesktop?.island
const island = document.querySelector('#island')
const el = id => document.querySelector(`#${id}`)

let status = 'idle'
let shownLine = ''
let reminderId = ''
let todoSignature = ''
let entrySignature = ''

const face = window.OrbFace?.create(el('ball-face'), {
  faceImages: false,
  interactive: false,
  localLook: false,
  getState: () => ({
    running: status === 'running',
    acting: status === 'acting',
    asking: false,
    tcc: false,
    expanded: false,
    dragging: false,
    disconnected: false,
  }),
})
window.dshDesktop?.floating?.onCursor?.(point => { face?.lookAtScreen(point.x, point.y) })

function act(message) {
  void api?.act(message)
}

function compactLeft(progress) {
  if (progress === undefined) return ''
  if (progress.phase === 'before') return '未上班'
  if (progress.phase === 'lunch') return '午休'
  if (progress.phase === 'after') return '已下班'
  if (progress.phase === 'rest') return '休息日'
  const minutes = Math.ceil(progress.remainingMs / 60000)
  const hours = Math.floor(minutes / 60)
  return `还有 ${hours > 0 ? `${hours} 小时 ` : ''}${minutes % 60} 分`
}

function nextText(next) {
  if (next === undefined) return '没有即将到来的提醒'
  const hours = Math.floor(next.inMinutes / 60)
  const wait = next.inMinutes < 1 ? '马上' : `${hours > 0 ? `${hours} 小时 ` : ''}${next.inMinutes % 60} 分钟后`
  return `下一个提醒：<strong>${next.time} ${escapeHtml(next.title)}</strong> · ${wait}`
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function renderEntries(entries) {
  const signature = JSON.stringify(entries)
  if (signature === entrySignature) return
  entrySignature = signature
  const list = el('entries')
  list.textContent = ''
  el('entries-empty').hidden = entries.length > 0
  for (const entry of entries) {
    const item = document.createElement('li')
    if (entry.time !== '') {
      const time = document.createElement('time')
      time.textContent = entry.time
      item.append(time)
    }
    const text = document.createElement('span')
    text.textContent = entry.content
    text.title = entry.content
    item.append(text)
    list.append(item)
  }
}

function renderTodos(todos) {
  const signature = JSON.stringify(todos)
  if (signature === todoSignature) return
  todoSignature = signature
  const list = el('todos')
  list.textContent = ''
  for (const todo of todos) {
    const item = document.createElement('li')
    item.classList.toggle('done', todo.done)
    const label = document.createElement('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = todo.done
    box.addEventListener('change', () => { act({ type: 'todo-toggle', id: todo.id }) })
    const text = document.createElement('span')
    text.textContent = todo.text
    text.title = todo.text
    label.append(box, text)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '×'
    remove.setAttribute('aria-label', '删除')
    remove.addEventListener('click', () => { act({ type: 'todo-remove', id: todo.id }) })
    item.append(label, remove)
    list.append(item)
  }
}

function render(state) {
  if (typeof state?.time !== 'string' || typeof state?.mode !== 'string') return
  island.dataset.mode = state.mode
  island.dataset.phase = state.progress?.phase ?? ''
  island.hidden = false
  status = state.status === 'running' || state.status === 'acting' ? state.status : 'idle'

  el('time').textContent = state.time
  const hasProgress = state.progress !== undefined && state.progress.phase !== 'rest'
  el('meter').hidden = !hasProgress
  el('meter-fill').style.width = `${hasProgress ? state.progress.percent : 0}%`
  el('percent').textContent = hasProgress ? `${state.progress.percent}%` : ''
  el('left').textContent = compactLeft(state.progress)

  // What the centre of the capsule shows, in order: a reminder, the ball's remark, what it is doing, the clock.
  const reminder = state.reminder
  const line = typeof state.line === 'string' ? state.line : ''
  const busy = status !== 'idle'
  el('reminder-title').hidden = reminder === undefined
  el('line').hidden = reminder !== undefined || line === ''
  el('status').hidden = reminder !== undefined || line !== '' || !busy
  el('info').hidden = reminder !== undefined || line !== '' || busy
  if (reminder !== undefined) el('reminder-title').textContent = reminder.title
  el('line').textContent = line
  el('status').textContent = status === 'acting' ? '正在操作电脑…' : '正在处理…'

  if (reminder !== undefined && reminder.id !== reminderId) {
    reminderId = reminder.id
    el('reminder-message').textContent = reminder.message
    const button = el('reminder-act')
    button.hidden = reminder.actionLabel === undefined
    button.textContent = reminder.actionLabel ?? ''
    face?.pulse(reminder.mood, 24 * 60 * 60 * 1000)
  } else if (reminder === undefined && reminderId !== '') {
    reminderId = ''
    face?.pulse('idle', 50)
  }
  if (line !== '' && line !== shownLine) face?.pulse('hello', 3500)
  shownLine = line

  renderEntries(state.entries ?? [])
  renderTodos(state.todos ?? [])
  el('next').innerHTML = nextText(state.next)
}

el('face-button').addEventListener('click', () => { act({ type: 'exit' }) })
el('take-out').addEventListener('click', () => { act({ type: 'exit' }) })
for (const button of document.querySelectorAll('[data-open]')) {
  button.addEventListener('click', () => { act({ type: 'open', target: button.dataset.open }) })
}
el('reminder-act').addEventListener('click', () => { act({ type: 'reminder', outcome: 'acted' }) })
el('reminder-dismiss').addEventListener('click', () => { act({ type: 'reminder', outcome: 'dismissed' }) })
el('todo-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = el('todo-input')
  const text = input.value.trim()
  if (text === '') return
  input.value = ''
  act({ type: 'todo-add', text })
})

api?.onState(render)
