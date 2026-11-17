// Today's work progress: a ring around the ball, and the percent in a small seven-segment clock face under the eyes.
// The text card with the time appears on hover (clock-service.ts).
const RING_LENGTH = 2 * Math.PI * 40
const SVG_NS = 'http://www.w3.org/2000/svg'

// One digit is drawn in a 6 x 10 box from up to seven segments (a top, b upper right, c lower right, d bottom,
// e lower left, f upper left, g middle), like a digital clock.
const SEGMENT_PATHS = {
  a: 'M1 0H5',
  b: 'M6 1V4.5',
  c: 'M6 5.5V9',
  d: 'M1 10H5',
  e: 'M0 5.5V9',
  f: 'M0 1V4.5',
  g: 'M1 5H5',
}
const DIGIT_SEGMENTS = {
  0: 'abcdef',
  1: 'bc',
  2: 'abdeg',
  3: 'abcdg',
  4: 'bcfg',
  5: 'acdfg',
  6: 'acdefg',
  7: 'abc',
  8: 'abcdefg',
  9: 'abcdfg',
}
const GLYPH_WIDTH = 6
const GLYPH_GAP = 3
/** Rendered height of the digits in pixels; the box is 10 units tall. */
const DIGIT_PIXELS = 9

function svgElement(name, attributes) {
  const element = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
  return element
}

/** Draw `percent` (a whole number) followed by a percent sign in seven-segment form. */
function drawPercent(svg, percent) {
  const glyphs = [...String(percent)].map(digit => ({ kind: 'digit', value: digit }))
  glyphs.push({ kind: 'percent', value: '%' })
  svg.textContent = ''
  glyphs.forEach((glyph, index) => {
    const group = svgElement('g', { transform: `translate(${index * (GLYPH_WIDTH + GLYPH_GAP)} 0)`, 'data-glyph': glyph.value })
    if (glyph.kind === 'digit') {
      for (const segment of DIGIT_SEGMENTS[glyph.value]) group.append(svgElement('path', { d: SEGMENT_PATHS[segment], 'data-segment': segment }))
    } else {
      group.append(
        svgElement('path', { d: 'M0.5 9.5L5.5 0.5' }),
        svgElement('circle', { cx: '1', cy: '1.6', r: '0.9', 'stroke-width': '0.6' }),
        svgElement('circle', { cx: '5', cy: '8.4', r: '0.9', 'stroke-width': '0.6' }),
      )
    }
    svg.append(group)
  })
  const width = glyphs.length * GLYPH_WIDTH + (glyphs.length - 1) * GLYPH_GAP
  svg.setAttribute('viewBox', `-1 -1 ${width + 2} 12`)
  svg.style.width = `${((width + 2) * DIGIT_PIXELS) / 10}px`
  svg.dataset.value = String(percent)
}

/** Show `progress` (`{ phase, percent }`) on the ring and as digits, or hide both when there is none or it is a day off. */
function setWorkRing(progress) {
  const fill = document.querySelector('#work-ring-fill')
  if (fill === null) return
  const shown = progress !== null && progress !== undefined && typeof progress.percent === 'number' && progress.phase !== 'rest'
  document.body.classList.toggle('has-work', shown)
  if (!shown) return
  const percent = Math.round(Math.max(0, Math.min(100, progress.percent)))
  fill.style.strokeDasharray = `${(RING_LENGTH * percent) / 100} ${RING_LENGTH}`
  document.body.dataset.workPhase = progress.phase
  const digits = document.querySelector('#work-percent')
  if (digits !== null && digits.dataset.value !== String(percent)) drawPercent(digits, percent)
}
