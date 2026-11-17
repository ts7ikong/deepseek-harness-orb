/**
 * Expressive face for the floating ball.
 *
 * The face is an inline SVG whose look is driven entirely by `data-mood` on the root element
 * (see orb-face.css). This module owns the mood state machine: it derives a mood from the ball's
 * state, plays short transient moods (happy, shy, surprised), blinks at random, and lets the
 * eyes follow the pointer while it hovers over the ball.
 */
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const SLEEP_AFTER_MS = 90_000
  const POLL_MS = 250
  const BLINK_MIN_MS = 2200
  const BLINK_MAX_MS = 6000
  const BLINK_HOLD_MS = 140
  const CLICK_SLOP_PX = 4
  const EYE_TRAVEL_PX = 3.5
  /** Cursor distance in screen pixels at which the eyes reach full travel. */
  const GAZE_FULL_DISTANCE_PX = 160
  /** Moods in which blinking looks natural; the others already draw closed or special eyes. */
  const BLINKING_MOODS = new Set(['idle', 'hello', 'curious', 'working', 'thinking', 'error'])

  /** Folder (relative to the page) holding optional per-mood images: `<mood>.png`, `.webp`, or `.gif`. */
  const FACE_IMAGE_DIR = 'faces/'
  const FACE_IMAGE_EXTENSIONS = ['png', 'webp', 'gif']
  const FACE_CROSSFADE_MS = 120
  /** Head tilt in degrees at full gaze deflection; image faces cannot move their eyes, so the head leans instead. */
  const TILT_MAX_DEG = 6
  /**
   * Image stand-ins, in order, for a mood whose own image is missing. `idle` is the final fallback,
   * so a partial image set never mixes in the drawn SVG face.
   */
  const IMAGE_FALLBACKS = {
    hello: [],
    working: ['thinking'],
    thinking: [],
    curious: ['surprised'],
    happy: [],
    error: [],
    sleepy: ['blink'],
    surprised: [],
    shy: ['happy'],
    dizzy: ['surprised'],
    celebrate: ['happy'],
    writing: ['working', 'thinking'],
  }
  const IMAGE_MOODS = ['idle', 'blink', ...Object.keys(IMAGE_FALLBACKS)]

  function starPath(cx, cy, outer, inner) {
    const points = []
    for (let index = 0; index < 10; index += 1) {
      const radius = index % 2 === 0 ? outer : inner
      const angle = -Math.PI / 2 + (index * Math.PI) / 5
      points.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`)
    }
    return `M${points.join(' L')} Z`
  }

  function node(tag, attributes, children) {
    const element = document.createElementNS(SVG_NS, tag)
    for (const [name, value] of Object.entries(attributes ?? {})) element.setAttribute(name, String(value))
    for (const child of children ?? []) element.append(child)
    return element
  }

  function eye(side, cx) {
    const cy = 46
    return node('g', { class: `eye eye-${side}` }, [
      node('g', { class: 'open' }, [
        node('rect', { class: 'pupil', x: cx - 3.6, y: cy - 8, width: 7.2, height: 16, rx: 3.6 }),
      ]),
      node('path', { class: 'star', d: starPath(cx, cy, 9, 4) }),
      node('path', { class: 'happy', d: `M${cx - 7},${cy + 4} Q${cx},${cy - 5} ${cx + 7},${cy + 4}` }),
      node('path', { class: 'closed', d: `M${cx - 7},${cy + 1} Q${cx},${cy + 7} ${cx + 7},${cy + 1}` }),
      node('path', {
        class: 'dizzy',
        d: `M${cx},${cy} m-1,0 a1,1 0 1 1 2,0 a2.6,2.6 0 1 1 -5.2,0 a4.2,4.2 0 1 1 8.4,0 a5.8,5.8 0 1 1 -11.6,0`,
      }),
    ])
  }

  function buildFace() {
    const svg = node('svg', { class: 'orb-face', viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false' })
    svg.dataset.mood = 'idle'
    const text = (value, x, y, size) => {
      const element = node('text', { x, y, 'font-size': size }, [])
      element.textContent = value
      return element
    }
    svg.append(
      node('ellipse', { class: 'gloss', cx: 35, cy: 20, rx: 22, ry: 10, transform: 'rotate(-22 35 20)' }),
      node('circle', { class: 'rim', cx: 50, cy: 50, r: 48.4 }),
      node('g', { class: 'head' }, [
        // Everything that glows lives in one layer so the halo filter touches only the glowing parts.
        node('g', { class: 'glow-layer' }, [
          node('g', { class: 'eyes' }, [eye('l', 31), eye('r', 69)]),
          node('g', { class: 'dots' }, [
            node('circle', { cx: 64, cy: 20, r: 2.4 }),
            node('circle', { cx: 73, cy: 20, r: 2.4 }),
            node('circle', { cx: 82, cy: 20, r: 2.4 }),
          ]),
          node('g', { class: 'zzz' }, [text('z', 70, 30, 12), text('z', 79, 21, 9)]),
          node('g', { class: 'sparkles' }, [
            node('path', { d: starPath(16, 30, 5, 1.6) }),
            node('path', { d: starPath(86, 40, 4, 1.3) }),
            node('path', { d: starPath(78, 14, 3.4, 1.1) }),
          ]),
          node('g', { class: 'pencil' }, [
            node('path', { class: 'scribble', d: 'M26,82 q4,-5 8,0 t8,0 t8,0 t8,0' }),
            node('g', { class: 'pencil-body' }, [
              node('path', { class: 'pencil-shaft', d: 'M64,78 L80,62' }),
              node('path', { class: 'pencil-tip', d: 'M64,78 L61,81' }),
            ]),
          ]),
        ]),
        // Small glowing symbols beside the eyes: a question mark when the ball is curious, an exclamation when surprised.
        node('g', { class: 'marks' }, [text('?', 74, 30, 14), text('!', 74, 30, 14)]),
      ]),
    )
    return svg
  }

  /**
   * Mount a face into `host` and keep its mood in sync.
   * @param host Element that receives the SVG.
   * @param options.getState Returns `{ running, acting, asking, tcc, expanded, dragging, disconnected }`.
   * @param options.pointerTarget Element whose hover, press, and pointer position drive the reactions.
   * @param options.localLook Set to false when the host feeds global pointer positions to `lookAtScreen`.
   * @param options.faceImageDir Folder of per-mood images (default `faces/`); when `idle.*` exists the images replace the drawn face.
   * @param options.faceImages Set to false to skip looking for per-mood images.
   * @param options.interactive Set to false so hovering and poking do not change the mood.
   * @returns `{ pulse(mood, ms), refresh(), lookAtScreen(x, y), destroy() }`.
   */
  function create(host, options) {
    const svg = buildFace()
    const layers = [0, 1].map(() => {
      const image = document.createElement('img')
      image.className = 'orb-img'
      image.alt = ''
      image.draggable = false
      return image
    })
    const look = document.createElement('div')
    look.className = 'orb-look'
    look.append(...layers)
    const photo = document.createElement('div')
    photo.className = 'orb-photo'
    photo.append(look)
    host.replaceChildren(svg, photo)
    const faceDir = options.faceImageDir ?? FACE_IMAGE_DIR
    const target = options.pointerTarget ?? host
    const images = new Map()
    let imageMode = false
    let shownUrl
    let topLayer = 1
    let hideTimer
    let blinkingNow = false
    let transient
    let lastActive = Date.now()
    let blinkTimer
    let blinkRelease
    let pressStart

    function probeImage(mood) {
      return new Promise(resolve => {
        let index = 0
        const next = () => {
          if (index >= FACE_IMAGE_EXTENSIONS.length) {
            resolve()
            return
          }
          const url = `${faceDir}${mood}.${FACE_IMAGE_EXTENSIONS[index]}`
          index += 1
          const probe = new Image()
          probe.onload = () => {
            images.set(mood, url)
            resolve()
          }
          probe.onerror = next
          probe.src = url
        }
        next()
      })
    }

    /** The image to show for a mood: its own, then its stand-ins, then idle. */
    function imageFor(mood) {
      for (const key of [mood, ...(IMAGE_FALLBACKS[mood] ?? []), 'idle']) {
        const url = images.get(key)
        if (url !== undefined) return { key, url }
      }
      return undefined
    }

    function showImage(url) {
      if (url === shownUrl) return
      shownUrl = url
      const previous = layers[topLayer]
      topLayer = 1 - topLayer
      const next = layers[topLayer]
      next.src = url
      previous.classList.remove('top')
      next.classList.add('top', 'on')
      // The old image stays opaque under the fade so the ball never shows through mid-transition.
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => { previous.classList.remove('on') }, FACE_CROSSFADE_MS + 40)
    }

    if (options.faceImages !== false) {
      void Promise.all(IMAGE_MOODS.map(probeImage)).then(() => {
        imageMode = images.has('idle')
        host.dataset.render = imageMode ? 'image' : 'svg'
        document.body?.classList.toggle('face-photo', imageMode)
        refresh()
      })
    }

    function resolveMood(now) {
      const state = options.getState()
      if (state.dragging) return 'dizzy'
      if (transient !== undefined && now < transient.until) return transient.mood
      if (state.disconnected) return 'error'
      if (state.asking || state.tcc) return 'curious'
      // Holding the mouse and keyboard is acting; any other running time is the model thinking.
      if (state.running) return state.acting ? 'working' : 'thinking'
      if (state.expanded) return 'hello'
      if (now - lastActive > SLEEP_AFTER_MS) return 'sleepy'
      return 'idle'
    }

    function refresh() {
      const now = Date.now()
      const mood = resolveMood(now)
      if (mood !== 'idle' && mood !== 'sleepy') lastActive = now
      if (svg.dataset.mood !== mood) svg.dataset.mood = mood
      if (host.dataset.mood !== mood) host.dataset.mood = mood
      if (!imageMode) return
      const found = imageFor(mood)
      if (found === undefined) return
      // Only the plain idle picture blinks; other moods keep their own eyes.
      const blinkUrl = images.get('blink')
      showImage(found.key === 'idle' && blinkingNow && blinkUrl !== undefined ? blinkUrl : found.url)
    }

    function pulse(mood, ms) {
      transient = { mood, until: Date.now() + ms }
      lastActive = Date.now()
      refresh()
    }

    function scheduleBlink() {
      const wait = BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS)
      blinkTimer = setTimeout(() => {
        if (imageMode) {
          if (imageFor(host.dataset.mood)?.key === 'idle' && images.has('blink')) {
            blinkingNow = true
            refresh()
            blinkRelease = setTimeout(() => {
              blinkingNow = false
              refresh()
            }, BLINK_HOLD_MS)
          }
        } else if (BLINKING_MOODS.has(svg.dataset.mood)) {
          svg.classList.add('blinking')
          blinkRelease = setTimeout(() => { svg.classList.remove('blinking') }, BLINK_HOLD_MS)
        }
        scheduleBlink()
      }, wait)
    }

    /**
     * Aim the face. Drawn eyes slide by `--px/--py`; image faces move as a whole and lean by `--tilt`.
     * @param fx Horizontal deflection from -1 (left) to 1 (right).
     * @param fy Vertical deflection from -1 (up) to 1 (down).
     */
    function setGaze(fx, fy) {
      host.style.setProperty('--px', `${(fx * EYE_TRAVEL_PX).toFixed(2)}px`)
      host.style.setProperty('--py', `${(fy * EYE_TRAVEL_PX).toFixed(2)}px`)
      host.style.setProperty('--tilt', `${(fx * TILT_MAX_DEG).toFixed(2)}deg`)
    }

    function lookToward(event) {
      const rect = target.getBoundingClientRect()
      if (rect.width === 0) return
      const dx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)
      const dy = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)
      const clamp = value => Math.max(-1, Math.min(1, value))
      setGaze(clamp(dx), clamp(dy))
    }

    function lookAhead() {
      host.style.removeProperty('--px')
      host.style.removeProperty('--py')
      host.style.removeProperty('--tilt')
    }

    /**
     * Turn the eyes toward a point anywhere on screen.
     * @param screenX Pointer x in screen DIPs.
     * @param screenY Pointer y in screen DIPs.
     */
    function lookAtScreen(screenX, screenY) {
      const rect = target.getBoundingClientRect()
      if (rect.width === 0) return
      const dx = screenX - (window.screenX + rect.left + rect.width / 2)
      const dy = screenY - (window.screenY + rect.top + rect.height / 2)
      const distance = Math.hypot(dx, dy)
      if (distance < 1) {
        lookAhead()
        return
      }
      const reach = Math.min(1, distance / GAZE_FULL_DISTANCE_PX)
      setGaze((dx / distance) * reach, (dy / distance) * reach)
    }

    const reactions = options.interactive === false ? [] : [
      ['pointerenter', () => { lastActive = Date.now(); pulse('surprised', 650) }],
      ['pointerdown', event => { pressStart = { x: event.screenX, y: event.screenY } }],
      ['pointerup', event => {
        const start = pressStart
        pressStart = undefined
        if (start === undefined) return
        // A drag is not a poke: only a near-stationary press-and-release makes the face react shyly.
        if (Math.hypot(event.screenX - start.x, event.screenY - start.y) <= CLICK_SLOP_PX) pulse('shy', 1400)
      }],
    ]
    const listeners = [
      ...reactions,
      ...(options.localLook === false ? [] : [['pointermove', lookToward], ['pointerleave', lookAhead]]),
    ]
    for (const [name, handler] of listeners) target.addEventListener(name, handler)

    const poll = setInterval(refresh, POLL_MS)
    scheduleBlink()
    refresh()

    return {
      pulse,
      refresh,
      lookAtScreen,
      destroy() {
        clearInterval(poll)
        clearTimeout(blinkTimer)
        clearTimeout(blinkRelease)
        clearTimeout(hideTimer)
        for (const [name, handler] of listeners) target.removeEventListener(name, handler)
        document.body?.classList.remove('face-photo')
        host.replaceChildren()
      },
    }
  }

  window.OrbFace = { create }
})()
