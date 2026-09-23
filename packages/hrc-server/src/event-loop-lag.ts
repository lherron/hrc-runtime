import type { HrcEventLoopStallView, HrcEventLoopStatus } from 'hrc-core'

import { writeServerMetric } from './request-metrics.js'
import { writeServerLog } from './server-log.js'

/**
 * Event-loop lag monitor (T-08786).
 *
 * A timer that measures its own lateness. Request metrics time handlers, so
 * synchronous work that holds the loop (a broker projection, a sweep) never
 * appears as its own row; its only trace was victim latency on unrelated
 * routes. When a tick lands later than the threshold, the monitor writes one
 * `server.event_loop.stalled` line and one `event_loop_stall` metric naming the
 * tagged activities that ran since the previous tick — which, on a single
 * thread, includes whatever held the loop.
 */

const DEFAULT_INTERVAL_MS = 250
const DEFAULT_STALL_THRESHOLD_MS = 1_000
const WINDOW_MS = 5 * 60 * 1000
const BUCKET_MS = 60 * 1000
const MAX_REPORTED_ACTIVITIES = 5

type ActivityTally = { count: number; ms: number }

/**
 * Activities since the last tick. Module-level so tag sites anywhere in the
 * daemon can record without threading a monitor handle; the running monitor
 * drains it every tick.
 */
let activitiesSinceTick = new Map<string, ActivityTally>()

function tally(tag: string, ms: number): void {
  const current = activitiesSinceTick.get(tag)
  if (current) {
    current.count += 1
    current.ms += ms
  } else {
    activitiesSinceTick.set(tag, { count: 1, ms })
  }
}

/** Record that a unit of work ran, where its synchronous span cannot be timed. */
export function markLoopActivity(tag: string): void {
  tally(tag, 0)
}

/**
 * Run `fn` and attribute its synchronous span to `tag`. For an async `fn` only
 * the part before its first await is timed — which is the part that holds the
 * loop.
 */
export function timeLoopActivity<T>(tag: string, fn: () => T): T {
  const started = performance.now()
  try {
    return fn()
  } finally {
    tally(tag, performance.now() - started)
  }
}

export type EventLoopLagMonitorOptions = {
  intervalMs?: number | undefined
  stallThresholdMs?: number | undefined
  stateRoot: string
}

type Bucket = { start: number; maxLagMs: number; at: string }

export class EventLoopLagMonitor {
  private readonly intervalMs: number
  private readonly stallThresholdMs: number
  private readonly stateRoot: string
  private timer: ReturnType<typeof setTimeout> | undefined
  private expectedAt = 0
  private buckets: Bucket[] = []
  private stallCount = 0
  private lastStall: HrcEventLoopStallView | undefined

  constructor(options: EventLoopLagMonitorOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS
    this.stateRoot = options.stateRoot
  }

  start(): void {
    if (this.timer !== undefined) return
    activitiesSinceTick = new Map()
    this.schedule()
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  snapshot(): HrcEventLoopStatus {
    const recent = this.recentBuckets(Date.now())
    const max = recent.reduce<Bucket | undefined>(
      (best, bucket) => (best === undefined || bucket.maxLagMs > best.maxLagMs ? bucket : best),
      undefined
    )
    return {
      intervalMs: this.intervalMs,
      stallThresholdMs: this.stallThresholdMs,
      windowMs: WINDOW_MS,
      maxLagMs: Math.round(max?.maxLagMs ?? 0),
      ...(max !== undefined ? { maxLagAt: max.at } : {}),
      stallCount: this.stallCount,
      ...(this.lastStall !== undefined ? { lastStall: this.lastStall } : {}),
    }
  }

  private schedule(): void {
    this.expectedAt = performance.now() + this.intervalMs
    this.timer = setTimeout(() => this.tick(), this.intervalMs)
    // A monitor must never be the reason a daemon or test process stays alive.
    this.timer.unref?.()
  }

  private tick(): void {
    const lagMs = Math.max(0, performance.now() - this.expectedAt)
    const activities = activitiesSinceTick
    activitiesSinceTick = new Map()
    const now = new Date()
    this.recordLag(lagMs, now)
    if (lagMs >= this.stallThresholdMs) this.reportStall(lagMs, now, activities)
    this.schedule()
  }

  private recordLag(lagMs: number, now: Date): void {
    const nowMs = now.getTime()
    const start = nowMs - (nowMs % BUCKET_MS)
    const last = this.buckets.at(-1)
    if (last?.start === start) {
      if (lagMs > last.maxLagMs) {
        last.maxLagMs = lagMs
        last.at = now.toISOString()
      }
    } else {
      this.buckets.push({ start, maxLagMs: lagMs, at: now.toISOString() })
      this.buckets = this.recentBuckets(nowMs)
    }
  }

  private recentBuckets(nowMs: number): Bucket[] {
    return this.buckets.filter((bucket) => bucket.start > nowMs - WINDOW_MS)
  }

  private reportStall(lagMs: number, now: Date, activities: Map<string, ActivityTally>): void {
    const top = [...activities.entries()]
      .sort(([, a], [, b]) => b.ms - a.ms || b.count - a.count)
      .slice(0, MAX_REPORTED_ACTIVITIES)
      .map(([tag, { count, ms }]) => ({ tag, count, ms: Math.round(ms) }))
    const stall: HrcEventLoopStallView = {
      at: now.toISOString(),
      lagMs: Math.round(lagMs),
      activities: top,
    }
    this.stallCount += 1
    this.lastStall = stall
    writeServerLog('WARN', 'server.event_loop.stalled', {
      lagMs: stall.lagMs,
      thresholdMs: this.stallThresholdMs,
      activityTags: activities.size,
      activities: top,
    })
    writeServerMetric(
      { v: 1, kind: 'event_loop_stall', ts: stall.at, lagMs: stall.lagMs, activities: top },
      now,
      this.stateRoot
    )
  }
}
