import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: vi.fn(() => 0) } }))

import { defaultActivityConfig, HIDDEN_TITLE } from '../src/activity-log.ts'
import { makeActivitySample } from '../src/activity-recorder.ts'

const config = defaultActivityConfig()
const NOW = 1_760_000_000_000

describe('makeActivitySample', () => {
  it('records the foreground program and title while the user is active', () => {
    expect(makeActivitySample(config, { app: 'Code', title: 'main.ts' }, 5, NOW))
      .toEqual({ t: NOW, app: 'Code', title: 'main.ts', idle: false })
  })

  it('records only that the user is away, with no program or title, once idle long enough', () => {
    expect(makeActivitySample(config, { app: 'Code', title: 'secret.ts' }, config.idleSeconds, NOW))
      .toEqual({ t: NOW, app: '', title: '', idle: true })
    expect(makeActivitySample(config, { app: 'Code', title: 'x' }, config.idleSeconds - 1, NOW)?.idle).toBe(false)
  })

  it('applies the privacy rules', () => {
    expect(makeActivitySample(config, { app: 'WeChatAppEx', title: '张三' }, 0, NOW)?.title).toBe(HIDDEN_TITLE)
    expect(makeActivitySample(config, { app: 'KeePassXC', title: 'db' }, 0, NOW)).toBeUndefined()
  })

  it('records nothing when no foreground window can be read', () => {
    expect(makeActivitySample(config, undefined, 0, NOW)).toBeUndefined()
  })
})
