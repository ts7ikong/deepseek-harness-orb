// The hover menu: shows the time the main process sends once a second and runs the item the user picks.
const menu = document.querySelector('#menu')

function leftText(progress) {
  if (progress === undefined) return ''
  if (progress.phase === 'after') return '已下班'
  if (progress.phase === 'rest') return '今天休息'
  if (progress.phase === 'before') return '还没上班'
  const minutes = Math.ceil(progress.remainingMs / 60000)
  if (minutes <= 0) return ''
  const hours = Math.floor(minutes / 60)
  return `距离下班 ${hours > 0 ? `${hours} 小时 ` : ''}${minutes % 60} 分钟`
}

function render(state) {
  if (typeof state?.time !== 'string' || typeof state?.date !== 'string') return
  document.querySelector('#time').textContent = state.time
  document.querySelector('#date').textContent = state.date
  document.querySelector('#left').textContent = leftText(state.progress)
  menu.dataset.side = state.side === 'left' ? 'left' : 'right'
  menu.hidden = false
}

// Unfold again each time the window is shown.
function replay() {
  menu.classList.remove('open')
  void menu.offsetWidth
  menu.classList.add('open')
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') replay()
})
replay()

for (const item of document.querySelectorAll('.item')) {
  item.addEventListener('click', () => {
    void window.dshDesktop?.clock?.act(item.dataset.action)
  })
}

window.dshDesktop?.clock?.onState(render)
