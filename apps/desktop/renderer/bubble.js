// The ball's speech bubble: show the line from the address, close on a click.
const LEAVE_MS = 180
const text = new URLSearchParams(window.location.search).get('text') ?? ''
document.querySelector('#text').textContent = text

let leaving = false
function dismiss() {
  if (leaving) return
  leaving = true
  document.body.classList.add('leaving')
  setTimeout(() => { window.close() }, LEAVE_MS)
}

document.addEventListener('click', dismiss)
