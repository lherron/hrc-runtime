import { CliUsageError, parseDuration } from 'cli-kit'
import type { HrcMonitorState } from 'hrc-core'

export type TerminalFence = { seq: number; inclusive: boolean }

export function resolveTerminalFence(
  state: HrcMonitorState,
  since?: string | undefined
): TerminalFence {
  const highWater =
    state.eventGlobalHighWaterSeq ??
    state.events.reduce((max, event) => Math.max(max, event.seq), 0)
  if (since === undefined) return { seq: highWater, inclusive: false }

  if (/^\d+$/.test(since)) {
    const seq = Number(since)
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new CliUsageError('--since sequence must be a positive safe integer')
    }
    return { seq, inclusive: true }
  }

  const cutoff = Date.now() - parseDuration(since)
  const firstEligible = state.events
    .filter((event) => {
      const timestamp = event.ts === undefined ? Number.NaN : Date.parse(event.ts)
      return Number.isFinite(timestamp) && timestamp >= cutoff
    })
    .reduce<number | undefined>(
      (min, event) => (min === undefined ? event.seq : Math.min(min, event.seq)),
      undefined
    )
  return { seq: firstEligible ?? highWater + 1, inclusive: true }
}
