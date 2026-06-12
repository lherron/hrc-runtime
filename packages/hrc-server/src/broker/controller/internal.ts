/**
 * Internal constants and module-level helpers for HarnessBrokerController.
 *
 * Extracted verbatim from controller.ts as a pure mechanical move (T-01807-class
 * big-file decomposition). Nothing here is part of the controller's public export
 * surface — the controller imports these and continues to behave identically.
 */

import type { HrcRunRecord } from 'hrc-core'
import type { BrokerCapabilities } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'

import { BrokerControllerError } from './errors'

export const DEFAULT_BROKER_COMMAND = 'harness-broker'
export const DEFAULT_BROKER_ARGS = ['run', '--transport', 'stdio']

// Durable-broker connect race (T-02009). The leased-tmux allocator launches the
// broker window (`exec harness-broker run --transport unix --socket …`) and
// returns the socket path WITHOUT waiting for the broker to bind its listener.
// The very next thing we do is dial that path via `connectUnix`, which is a
// single `net.connect()` with no retry — so if the freshly-spawned broker has
// not bound yet, the dial fails ENOENT/ECONNREFUSED and the whole start aborts
// as `broker_start_failed` (an operator just retries `hrc run` and it works).
// Bridge that gap with a bounded connect-retry: only socket-not-ready failures
// are retried; any other dial error (path budget, etc.) throws immediately.
export const BROKER_UNIX_CONNECT_MAX_ATTEMPTS = 24
export const BROKER_UNIX_CONNECT_BASE_DELAY_MS = 25
export const BROKER_UNIX_CONNECT_MAX_DELAY_MS = 200
export const BROKER_UNIX_CONNECT_ATTEMPT_TIMEOUT_MS = 1_000
// node socket-connect error codes that mean "the listener isn't up YET" — the
// broker is still booting inside its tmux window. EPIPE/ECONNRESET cover a
// listener that accepted then dropped mid-handshake during its own startup.
export const BROKER_UNIX_CONNECT_RETRYABLE_CODES = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'EAGAIN',
  'EPIPE',
  'ECONNRESET',
])
export const USER_INITIATED_CONTINUATION_CLEAR_REASONS = new Set([
  'prompt_input_exit',
  'logout',
  'clear',
])
// Lever 2 graceful exit: the SUBSET of user-initiated continuation-clear reasons
// that mean the operator is LEAVING the session (so the broker-tmux lease should
// be torn down). `clear` is deliberately EXCLUDED — a `/clear` wipes context but
// keeps the harness running, so reaping on it would kill a live session.
export const BROKER_TMUX_PROMPT_EXIT_REASONS = new Set(['prompt_input_exit', 'logout'])

/**
 * T-01855 — the negotiated broker inspection capability block, cached per active
 * runtime so inspection RPCs gate on what the broker actually advertises. Absent
 * (`undefined`) means an older broker with no inspection block at all.
 */
export type BrokerInspectionCapabilities = NonNullable<BrokerCapabilities['inspection']>

export function isActiveBrokerRun(run: HrcRunRecord): boolean {
  return run.status === 'accepted' || run.status === 'started' || run.status === 'running'
}

export function compactEnv(
  env: Record<string, string | undefined> | undefined
): Record<string, string> | undefined {
  if (!env) {
    return undefined
  }
  const compact: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      compact[key] = value
    }
  }
  return compact
}

/**
 * True iff a broker close error is the `control.fenced` signal (a newer
 * controller re-attached and superseded this one). The unix transport surfaces
 * it as a `BrokerRpcError` carrying `BrokerErrorCode.ControllerFenced`.
 */
export function isControllerFencedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === BrokerErrorCode.ControllerFenced
  )
}

/**
 * True when a durable-broker Unix dial failed because the broker had not bound
 * its listener YET (T-02009 boot race) — safe to retry. The broker client wraps
 * the node socket error in a `BrokerTransportError` carrying the original error
 * on `.causeError`; we read that node `.code`. A connect timeout (the broker is
 * mid-bind) is also retryable.
 */
export function isBrokerSocketNotReadyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const causeCode = (error as { causeError?: { code?: unknown } }).causeError?.code
  if (typeof causeCode === 'string' && BROKER_UNIX_CONNECT_RETRYABLE_CODES.has(causeCode)) {
    return true
  }
  // Fallback to the node error's own code when it surfaces directly, and to the
  // transport's timeout message ("Timed out connecting to broker unix socket").
  const directCode = (error as { code?: unknown }).code
  if (typeof directCode === 'string' && BROKER_UNIX_CONNECT_RETRYABLE_CODES.has(directCode)) {
    return true
  }
  const message = error instanceof Error ? error.message : ''
  return message.includes('Timed out connecting to broker unix socket')
}

/**
 * True when `error` is bun:sqlite's "Cannot use a closed database" — the signal
 * that a broker event consumer outlived the backing DB during server teardown.
 * Used as a safety net for the window between the `shuttingDown` flag and
 * `db.close()`, so a late event exits the consumer quietly instead of crashing.
 */
export function isClosedDbError(error: unknown): boolean {
  return error instanceof Error && /closed database/i.test(error.message)
}

export function toControllerError(code: string, error: unknown): BrokerControllerError {
  if (error instanceof BrokerControllerError) {
    return error
  }
  if (error instanceof Error) {
    return new BrokerControllerError(code, error.message, { name: error.name })
  }
  return new BrokerControllerError(code, String(error))
}

/**
 * T-01855 tri-state liveness gate. A live probe is permitted only when the broker
 * advertises `liveness: 'probe'`, OR advertises no inspection block at all (older
 * broker — pass the caller's flag through and let the broker ignore what it does
 * not support). An explicit `'cached'`/`'none'` forbids the probe.
 */
export function livenessProbeAllowed(
  inspection: BrokerInspectionCapabilities | undefined
): boolean {
  return inspection === undefined || inspection.liveness === 'probe'
}

/**
 * T-01855 — best-effort rehydration of the broker inspection capabilities from
 * persisted runtime state, used on durable reattach (which rebuilds the active
 * record without a fresh hello). Returns `undefined` when nothing valid is
 * persisted, which the inspection RPCs treat as an older/uninspectable broker.
 */
export function rehydrateInspectionCapabilities(
  runtimeStateJson: Record<string, unknown> | null | undefined
): BrokerInspectionCapabilities | undefined {
  const broker = runtimeStateJson?.['broker']
  if (typeof broker !== 'object' || broker === null) {
    return undefined
  }
  const inspection = (broker as Record<string, unknown>)['inspection']
  if (typeof inspection !== 'object' || inspection === null) {
    return undefined
  }
  const candidate = inspection as Record<string, unknown>
  if (
    typeof candidate['listInvocations'] !== 'boolean' ||
    typeof candidate['timestamps'] !== 'boolean' ||
    typeof candidate['lifecycleView'] !== 'boolean' ||
    typeof candidate['eventTypeFilter'] !== 'boolean' ||
    (candidate['liveness'] !== 'none' &&
      candidate['liveness'] !== 'cached' &&
      candidate['liveness'] !== 'probe')
  ) {
    return undefined
  }
  return inspection as BrokerInspectionCapabilities
}
