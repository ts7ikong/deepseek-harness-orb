// Fills the reminder pop-up from the query string and closes it on any click.
const params = new URL(location.href).searchParams
const DISMISS_FADE_MS = 200

document.querySelector('#title').textContent = params.get('title') ?? ''
document.querySelector('#message').textContent = params.get('message') ?? ''
document.querySelector('#hint').textContent = params.get('hint') ?? ''
document.title = params.get('title') ?? ''

const face = window.OrbFace?.create(document.querySelector('#ball-face'), {
  faceImages: false,
  interactive: false,
  getState: () => ({}),
})
// The mood is held for as long as the window lives.
face?.pulse(params.get('mood') ?? 'happy', 24 * 60 * 60 * 1000)

const action = document.querySelector('#action')
const actionLabel = params.get('actionLabel')
if (actionLabel !== null && window.dshDesktop?.reminder !== undefined) {
  action.textContent = actionLabel
  action.hidden = false
  action.addEventListener('click', () => {
    action.disabled = true
    // The main process runs the action; the pop-up closes either way.
    void window.dshDesktop.reminder.act().catch(() => {}).finally(() => { dismiss() })
  })
}

let leaving = false
function dismiss() {
  if (leaving) return
  leaving = true
  document.body.classList.add('leaving')
  setTimeout(() => { window.close() }, DISMISS_FADE_MS)
}

// A press on the button runs its action instead of just closing.
document.addEventListener('pointerdown', (event) => {
  if (event.target instanceof Element && event.target.closest('#action') !== null) return
  dismiss()
})
