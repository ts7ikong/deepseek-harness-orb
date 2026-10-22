/** Samples the foreground window on a timer and stores it locally for the daily report. */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { powerMonitor } from 'electron'
import {
  ACTIVITY_CONFIG_FILE,
  mergeScreenNotes,
  NATIVE_VISION_DIR,
  appendActivitySample,
  filterObservation,
  pruneActivity,
  readActivityConfig,
  readActivityDay,
  readScreenNotes,
  readWorkLogExamples,
  type ActivityConfig,
  type ActivitySample,
  type ScreenNote,
  type WorkLogDay,
} from './activity-log.ts'
import { resolveWorkLogFile } from './work-log.ts'
import { readForegroundWindow, type ForegroundWindow } from './foreground-window.ts'
import { localDateKey } from './reminders.ts'

const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000

/**
 * One sample for this moment, or nothing when there is nothing to record.
 * While the user is away the sample carries no program or title.
 * @param config - the privacy and timing settings.
 * @param foreground - the foreground window as read, if any.
 * @param idleSeconds - seconds since the last keyboard or mouse input.
 * @param nowMs - the current time in milliseconds.
 * @returns the sample to store, or undefined for an ignored or unreadable window.
 */
export function makeActivitySample(
  config: ActivityConfig,
  foreground: ForegroundWindow | undefined,
  idleSeconds: number,
  nowMs: number,
): ActivitySample | undefined {
  if (idleSeconds >= config.idleSeconds) return { t: nowMs, app: '', title: '', idle: true }
  if (foreground === undefined) return undefined
  const allowed = filterObservation(foreground, config)
  return allowed === undefined ? undefined : { t: nowMs, ...allowed, idle: false }
}

/** Handle returned by {@link startActivityRecorder}. */
export interface ActivityRecorder {
  stop(): void
  /** Today's samples, the sampling interval, past report entries as writing examples, and screen descriptions. */
  today(): {
    readonly samples: ActivitySample[]
    readonly intervalMs: number
    readonly examples: WorkLogDay[]
    readonly notes: ScreenNote[]
  }
  /** The current settings, or undefined before the first read. */
  settings(): ActivityConfig | undefined
}

/**
 * Start recording the foreground window.
 * @param options.profileDir - Desktop profile directory.
 * @param options.log - sink for config problems and read failures.
 * @returns the running recorder.
 */
export function startActivityRecorder(options: {
  readonly profileDir: string
  readonly log?: (message: string) => void
}): ActivityRecorder {
  const log = options.log ?? ((message: string): void => { console.warn(message) })
  const configPath = join(options.profileDir, ACTIVITY_CONFIG_FILE)
  let config: ActivityConfig | undefined
  let configStamp = -1
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastPrune = 0
  let stopped = false

  function reloadConfig(): void {
    let stamp = -1
    try {
      stamp = statSync(configPath).mtimeMs
    } catch {
      // A missing file is recreated by the read below.
    }
    if (stamp === configStamp && config !== undefined) return
    const result = readActivityConfig(options.profileDir)
    try {
      configStamp = statSync(configPath).mtimeMs
    } catch {
      configStamp = -1
    }
    for (const problem of result.problems) log(`dsh desktop: ${ACTIVITY_CONFIG_FILE}: ${problem}`)
    // A config that cannot be parsed keeps the last good one.
    if (result.config !== undefined) config = result.config
  }

  function tick(): void {
    reloadConfig()
    if (config?.enabled === true) {
      try {
        const now = Date.now()
        if (now - lastPrune >= PRUNE_EVERY_MS) {
          lastPrune = now
          pruneActivity(options.profileDir, new Date(now), config.keepDays)
        }
        const sample = makeActivitySample(config, readForegroundWindow(), powerMonitor.getSystemIdleTime(), now)
        if (sample !== undefined) appendActivitySample(options.profileDir, sample)
      } catch (error) {
        log(`dsh desktop: activity sample failed: ${String(error)}`)
      }
    }
    if (!stopped) timer = setTimeout(tick, (config?.intervalSeconds ?? 30) * 1000)
  }

  tick()
  return {
    stop: () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    },
    today: () => {
      const todayKey = localDateKey(new Date())
      return {
        samples: readActivityDay(options.profileDir, todayKey),
        intervalMs: (config?.intervalSeconds ?? 30) * 1000,
        examples: readWorkLogExamples(
          resolveWorkLogFile(config?.workLogFile ?? '', options.profileDir),
          config?.exampleDays ?? 0,
          todayKey,
        ),
        // The old assistant's descriptions (visionDir) and this app's own are used together.
        notes: mergeScreenNotes(
          readScreenNotes(config?.visionDir ?? '', todayKey),
          readScreenNotes(join(options.profileDir, NATIVE_VISION_DIR), todayKey),
        ),
      }
    },
    settings: () => config,
  }
}
