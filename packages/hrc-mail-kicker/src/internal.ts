import { normalizeSessionRef } from 'hrc-core'
import type { HrcRunRecord } from 'hrc-core'

export const RUNTIME_TERMINAL_EVENTS = new Set([
  'runtime.terminated',
  'runtime.crashed',
  'runtime.dead',
  'runtime.stale',
])

export const MAIL_DRIVE_TERMINAL_EVENTS = new Set([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'turn.zombied',
  'turn.reaped',
])

export const REMINDER_HOLD_MS = 60_000
export const KICKER_SUBMISSION_TTL_MS = 30 * 60_000
export const LEDGER_TAIL_PAGE_LIMIT = 500
export const LEDGER_SWEEP_SCOPE_BATCH = 100
export const LEDGER_SWEEP_TICKS = 30
export const BIRTH_SWEEP_BACKOFF_BASE_MS = 60_000
export const BIRTH_SWEEP_MAX_REFUSALS = 5
export const LAPSE_SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000
/**
 * How long `stop()` will wait for in-flight obligation disposals (T-07963).
 *
 * BOUNDED on purpose. Each disposal is a wrkq RPC per envelope, and a stop that
 * waits on an unreachable ledger forever is a daemon that cannot be restarted —
 * strictly worse than the stranding this drain exists to prevent. The bound is
 * safe because the drain is not the only mechanism: every disposition is written
 * durably as it is decided, so whatever this deadline cuts off is recovered by
 * the next boot's reconcile and reported as `dispose_interrupted` rather than
 * lost silently.
 */
export const DISPOSAL_DRAIN_DEADLINE_MS = 2_000

/**
 * How long a LIVE attempt may hold a presentation without its turn ever
 * starting before the delivery is called stalled rather than awaited (T-07964,
 * assigned by mable as the interim net for T-07971).
 *
 * Five minutes, and ONE constant so T-07971 can revisit it in one place. The
 * number is chosen against the thing it must not false-positive on: a cold
 * birth reaches its seat in about thirteen seconds and `turn.started` arrives
 * at the HEAD of the turn, not its end. So five minutes without one is not a
 * slow turn — a turn that has started is excluded structurally, because
 * `recordStart` writes `state='started'` and `started_at` in the same
 * statement — it is a delivery that never began.
 */
export const STALLED_DELIVERY_THRESHOLD_MS = 5 * 60_000

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseSessionRef(sessionRef: string): { scopeRef: string; laneRef: string } {
  const normalized = sessionRef.trim()
  const parts = normalized.split('/')
  if (parts.length !== 2 || !parts[1]?.startsWith('lane:')) {
    throw new Error('sessionRef must use "<scopeRef>/lane:<laneRef>" format')
  }
  const scopeRef = parts[0]?.trim() ?? ''
  const laneRef = parts[1].slice('lane:'.length).trim()
  if (scopeRef.length === 0 || laneRef.length === 0) {
    throw new Error('sessionRef must include scopeRef and laneRef')
  }
  return { scopeRef, laneRef }
}

export function formatSessionRef(scopeRef: string, laneRef: string): string {
  return `${scopeRef}/lane:${laneRef === 'default' ? 'main' : laneRef}`
}

export function normalizeTargetSessionRef(sessionRef: string): string {
  const normalized = normalizeSessionRef(sessionRef)
  const { scopeRef, laneRef } = parseSessionRef(normalized)
  return formatSessionRef(scopeRef, laneRef)
}

export function isRunActive(run: HrcRunRecord): boolean {
  return run.status === 'accepted' || run.status === 'started' || run.status === 'running'
}

export function isRuntimeUnavailableStatus(status: string): boolean {
  return (
    status === 'terminated' ||
    status === 'dead' ||
    status === 'stale' ||
    status === 'crashed' ||
    status === 'detached'
  )
}
