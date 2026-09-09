import { describe, expect, test } from 'bun:test'

import { HrcViewer, type HrcViewerClient, type ViewerGhostmux, type ViewerLog } from '../viewer.js'

/**
 * T-08296: the reconnect backoff must escalate for a stream that keeps closing
 * immediately.
 *
 * `watchBoundedEvents` is a BOUNDED stream, so a normal close is turned into a
 * throw by `run()`. The previous shape reset `failures` to 0 *before* consuming
 * the stream, so that throw always re-entered the catch with `failures === 0`,
 * always took `reconnectDelaysMs[0]` (which is 0), and reconnected with no
 * delay — paying a full reconcile (`listPresentationRuntimes` +
 * `listLatestEventBySession`) every iteration.
 */

// A fast ladder: `delay()` uses real timers, so the suite asserts the
// escalation SHAPE rather than the production millisecond values.
const DELAYS = [0, 5, 10, 20, 40] as const

function makeViewer(input: {
  /** Simulated lifetime of each stream, in ms of the injected clock. */
  streamMs: number
  /** Stop after this many stream_failed warnings. */
  stopAfter: number
}) {
  const warnings: Array<Record<string, unknown>> = []
  let clock = 0
  const controller = new AbortController()

  const log: ViewerLog = (_level, event, fields) => {
    if (event !== 'broker_headless_viewer.stream_failed') return
    warnings.push(fields ?? {})
    if (warnings.length >= input.stopAfter) controller.abort()
  }

  const client = {
    async health() {
      return { ok: true }
    },
    async tailEvents() {
      return { events: [], ledgerIncarnationId: 'ledger-1', headHrcSeq: 1, truncated: false }
    },
    // Advance the clock by the stream's simulated lifetime, then close, which
    // `run()` converts into `bounded event stream closed`.
    watchBoundedEvents() {
      clock += input.streamMs
      return (async function* () {})()
    },
    async listLatestEventBySession() {
      return []
    },
    async listPresentationRuntimes() {
      return { ok: true as const, runtimes: [] }
    },
  } as unknown as HrcViewerClient

  const ghostmux = {
    async listHeadlessViewerPanes() {
      return []
    },
  } as unknown as ViewerGhostmux

  const viewer = new HrcViewer({
    client,
    ghostmux,
    log,
    now: () => clock,
    reconnectDelaysMs: DELAYS,
    streamStableAfterMs: 5_000,
    probeTmuxClients: async () => [],
    readTaskTitles: async () => new Map(),
  })

  return { viewer, warnings, signal: controller.signal }
}

describe('T-08296 viewer reconnect backoff', () => {
  test('a stream that closes immediately escalates the delay instead of spinning at 0ms', async () => {
    const { viewer, warnings, signal } = makeViewer({ streamMs: 0, stopAfter: 5 })

    await viewer.run(signal)

    expect(warnings.map((w) => w.delayMs)).toEqual([0, 5, 10, 20, 40])
    // Every reconnect but the first must actually wait.
    expect(warnings.slice(1).every((w) => (w.delayMs as number) > 0)).toBe(true)
  })

  test('a stream that stayed up past the stability window resets the backoff', async () => {
    const { viewer, warnings, signal } = makeViewer({ streamMs: 30_000, stopAfter: 3 })

    await viewer.run(signal)

    // Each stream lived well past streamStableAfterMs, so this is a healthy
    // stream ending, not a failing reconnect: the fast first delay is correct.
    expect(warnings.map((w) => w.delayMs)).toEqual([0, 0, 0])
    expect(warnings.map((w) => w.failures)).toEqual([0, 0, 0])
    expect(warnings.map((w) => w.streamMs)).toEqual([30_000, 30_000, 30_000])
  })

  test('the backoff caps at the last configured delay', async () => {
    const { viewer, warnings, signal } = makeViewer({ streamMs: 0, stopAfter: 7 })

    await viewer.run(signal)

    expect(warnings.map((w) => w.delayMs)).toEqual([0, 5, 10, 20, 40, 40, 40])
  })
})
