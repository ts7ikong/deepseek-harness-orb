// Clock under the ball: shows the state the main process sends once a second.
const chip = document.querySelector('#chip')
const work = document.querySelector('#work')
const PHASE_LABELS = {
  before: '还没上班',
  morning: '上午工作中',
  lunch: '午休中',
  afternoon: '下午工作中',
  after: '已下班',
  rest: '今天休息',
}

function leftText(ms) {
  const minutes = Math.ceil(ms / 60000)
  if (minutes <= 0) return ''
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `距离下班还有 ${hours > 0 ? `${hours} 小时 ` : ''}${rest} 分钟`
}

function render(state) {
  if (typeof state?.time !== 'string' || typeof state?.date !== 'string') return
  document.querySelector('#time').textContent = state.time
  document.querySelector('#date').textContent = state.date
  const progress = state.progress
  work.hidden = progress === undefined
  if (progress !== undefined) {
    document.querySelector('#fill').style.width = `${progress.percent}%`
    document.querySelector('#phase').textContent = PHASE_LABELS[progress.phase] ?? ''
    document.querySelector('#percent').textContent = progress.phase === 'rest' ? '' : `${progress.percent}%`
    const left = progress.phase === 'morning' || progress.phase === 'afternoon' || progress.phase === 'lunch'
      ? leftText(progress.remainingMs)
      : ''
    document.querySelector('#left').textContent = left
    document.querySelector('#left').hidden = left === ''
  }
  chip.hidden = false
}

window.dshDesktop?.clock?.onState(render)
