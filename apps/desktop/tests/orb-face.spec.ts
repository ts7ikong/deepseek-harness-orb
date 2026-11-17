import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../renderer/orb-face.css', import.meta.url), 'utf8')

function mount() {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', url: 'dsh-app://shell/x.html' })
  runInContext(readFileSync(new URL('../renderer/orb-face.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  const host = dom.window.document.querySelector('#host')!
  const api = (dom.window as unknown as {
    OrbFace: { create: (host: Element, options: Record<string, unknown>) => { destroy: () => void } }
  }).OrbFace
  const face = api.create(host, { getState: () => ({}), faceImages: false, interactive: false, localLook: false })
  return { dom, host, face }
}

describe('the drawn face', () => {
  it('has no glasses any more', () => {
    const { host, face } = mount()
    expect(host.querySelector('.glasses')).toBeNull()
    expect(host.querySelector('.lens')).toBeNull()
    expect(css).not.toContain('.glasses')
    face.destroy()
  })

  it('has a question mark and an exclamation mark, hidden until a mood shows them', () => {
    const { host, face } = mount()
    const marks = [...host.querySelectorAll('.marks text')].map(node => node.textContent)
    expect(marks).toEqual(['?', '!'])
    expect(css).toMatch(/\.marks text \{[^}]*opacity: 0;/u)
    face.destroy()
  })

  it('shows the question mark for the curious mood and the exclamation mark for the surprised one, and nothing for thinking or error', () => {
    expect(css).toMatch(/data-mood="curious"\] \.marks text:nth-child\(1\) \{ opacity: 1; \}/u)
    expect(css).toMatch(/data-mood="surprised"\] \.marks text:nth-child\(2\) \{ opacity: 1; \}/u)
    expect(css).not.toMatch(/data-mood="(?:thinking|error)"\] \.marks/u)
  })
})

describe('the ball when work progress is showing', () => {
  it('lifts the face a little so it does not crowd the digits under the eyes', () => {
    const floating = readFileSync(new URL('../renderer/floating.css', import.meta.url), 'utf8')
    expect(floating).toMatch(/body\.has-work:not\(\.expanded\) #ball-face \.orb-face \{\s*translate: 0 -3px;/u)
  })
})
