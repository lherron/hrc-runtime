/**
 * Module-level constants, timeout/env resolvers, and small pure helpers for
 * HarnessBrokerController (split verbatim out of controller.ts).
 */

import { setTimeout as delay } from 'node:timers/promises'
import type { HrcBrokerInvocationEventRecord, HrcRuntimeSnapshot } from 'hrc-core'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { BrokerInspectionCapabilities } from './internal'
import type { BrokerClientLike, BrokerControllerStartInput, DurableBrokerClientLike } from './types'

export const DEFAULT_BROKER_TMUX_SUMMARY_REAP_GRACE_MS = 500

// Ceiling on the broker stop/dispose/close RPC sequence (see dispose()). Chosen
// generous: a healthy broker acks in well under a second; this only fires for a
// wedged/unresponsive broker (notably a durable broker-tmux runtime reattached
// after an hrc-server restart that no longer answers control RPCs).
export const DEFAULT_BROKER_DISPOSE_TIMEOUT_MS = 15_000
export const DEFAULT_BROKER_ACTIVE_RPC_TIMEOUT_MS = 20_000
export const DEFAULT_BROKER_ATTACH_CONTROL_PROBE_TIMEOUT_MS = 2_000
export const DEFAULT_BROKER_EVENT_GAP_BACKFILL_DELAY_MS = 500
export const DEFAULT_BROKER_DB_BUSY_RETRY_WINDOW_MS = 15_000
export const DEFAULT_BROKER_DB_BUSY_RETRY_BASE_DELAY_MS = 100
export const BROKER_DB_BUSY_RETRY_MAX_DELAY_MS = 1_000
export const BROKER_CRASH_TERMINAL_RETRY_BASE_DELAY_MS = 1_000
export const BROKER_CRASH_TERMINAL_MAX_ATTEMPTS = 3

// T-05358: the broker socket can close mid-dispose. The durable unix/stdio
// transport rejects the in-flight RPC with `Broker transport closed`, while a
// call issued on an already-closed json-rpc channel rejects with `Broker
// transport is closed`. Both mean the broker is already gone, so disposal is a
// no-op — swallowing them lets dispose complete cleanly (and narrows the
// `stopping` window) instead of surfacing a spurious `broker_dispose_failed`.
// Guarded narrowly: ONLY a `BrokerTransportError` whose message is exactly one
// of the two closed strings — any other transport error (timeout, protocol,
// non-closed) still surfaces.
export const BENIGN_BROKER_TRANSPORT_CLOSED = /^Broker transport (is )?closed$/

export function isBenignBrokerTransportClosed(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'BrokerTransportError' &&
    BENIGN_BROKER_TRANSPORT_CLOSED.test(error.message)
  )
}

/**
 * Race a broker RPC against a timeout. If `ms <= 0`, the operation is awaited
 * unbounded (legacy behavior). On timeout, `onTimeout()` is thrown; the abandoned
 * operation gets a no-op catch so a late rejection cannot surface as an unhandled
 * rejection. The timer is cancelled via AbortController when the op wins so it
 * does not keep the event loop alive.
 */
export async function withBrokerRpcTimeout<T>(
  op: Promise<T>,
  ms: number,
  onTimeout: () => Error
): Promise<T> {
  if (!(ms > 0)) return op
  const controller = new AbortController()
  const timedOut = Symbol('broker-rpc-timeout')
  const timer = delay(ms, timedOut, { signal: controller.signal })
  try {
    const result = await Promise.race([op, timer])
    if (result === timedOut) {
      void op.catch(() => undefined)
      throw onTimeout()
    }
    return result as T
  } finally {
    // Cancel the pending timer when the op wins; swallow the AbortError that
    // `delay` then rejects with so it never surfaces as an unhandled rejection.
    controller.abort()
    void timer.catch(() => undefined)
  }
}

/**
 * Resolve the broker dispose timeout: an explicit deps value (finite, >= 0) wins,
 * else the `HRC_BROKER_DISPOSE_TIMEOUT_MS` env override (same validity rule), else
 * the default. 0 is honored as "disabled" (unbounded).
 */
export function resolveBrokerDisposeTimeoutMs(depsValue?: number, envValue?: string): number {
  if (typeof depsValue === 'number' && Number.isFinite(depsValue) && depsValue >= 0) {
    return depsValue
  }
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_BROKER_DISPOSE_TIMEOUT_MS
}

export function resolveBrokerActiveRpcTimeoutMs(depsValue?: number, envValue?: string): number {
  if (typeof depsValue === 'number' && Number.isFinite(depsValue) && depsValue >= 0) {
    return depsValue
  }
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_BROKER_ACTIVE_RPC_TIMEOUT_MS
}

export function resolveNonNegativeNumber(envValue: string | undefined, fallback: number): number {
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return fallback
}

export function isSqliteBusyError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) {
      return true
    }
  }
  return error instanceof Error && /database (?:table )?is locked/i.test(error.message)
}

/**
 * Resolve the per-RPC attach control-proof timeout. Unlike the general active
 * RPC and dispose bounds, this safety proof can never be disabled: invalid,
 * zero, negative, and non-finite values all fall back to the exact 2s default.
 */
export function resolveBrokerAttachControlProbeTimeoutMs(
  depsValue?: number,
  envValue?: string
): number {
  if (typeof depsValue === 'number' && Number.isFinite(depsValue) && depsValue > 0) {
    return depsValue
  }
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_BROKER_ATTACH_CONTROL_PROBE_TIMEOUT_MS
}

export function parseRawBrokerEnvelope(
  record: HrcBrokerInvocationEventRecord
): InvocationEventEnvelope | undefined {
  if (!record.brokerEnvelopeJson) {
    return undefined
  }
  try {
    return JSON.parse(record.brokerEnvelopeJson) as InvocationEventEnvelope
  } catch {
    return undefined
  }
}

export type ActiveBrokerRuntime = {
  runtimeId: string
  invocationId: string
  client: BrokerClientLike
  closing: boolean
  closeReason?: string | undefined
  /**
   * T-01855 — broker inspection capabilities from the most recent hello (or
   * rehydrated from persisted broker state on durable reattach). Lifetime is the
   * active record: cleared automatically when the runtime leaves `active`.
   */
  inspection?: BrokerInspectionCapabilities | undefined
  birthTimeline?: BrokerControllerStartInput['birthTimeline']
}

export type StagedParticipantBroker = {
  attemptId: string
  attachEpoch: number
  runtimeId: string
  invocationId: string
  client: DurableBrokerClientLike
}

export type PendingBrokerEventGapBackfill = {
  runtimeId: string
  missingSeqs: Set<number>
  timer: ReturnType<typeof setTimeout>
}

export type BrokerPermissionPolicy =
  | { mode: 'deny'; [key: string]: unknown }
  | { mode: 'allow'; [key: string]: unknown }
  | { mode: 'ask-client'; [key: string]: unknown }

export function resolveBrokerPermissionPolicy(
  runtime: HrcRuntimeSnapshot | null
): BrokerPermissionPolicy {
  const permission = runtime?.runtimeStateJson?.['permission']
  if (typeof permission !== 'object' || permission === null) {
    return { mode: 'deny', reason: 'no HRC permission policy configured' }
  }
  const policy = (permission as Record<string, unknown>)['policy']
  if (typeof policy !== 'object' || policy === null) {
    return { mode: 'deny', reason: 'no HRC permission policy configured' }
  }
  const mode = (policy as Record<string, unknown>)['mode']
  if (mode === 'allow' || mode === 'deny' || mode === 'ask-client') {
    return policy as BrokerPermissionPolicy
  }
  return { mode: 'deny', reason: 'unsupported HRC permission policy mode', policy }
}
