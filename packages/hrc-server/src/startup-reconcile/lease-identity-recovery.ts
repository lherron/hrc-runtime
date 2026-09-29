import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { parseBrokerRuntimeHostingState } from '../broker/runtime-hosting.js'
import { runtimeActivityPatch } from '../runtime-activity.js'
import { timestamp } from '../server-util.js'

export function runtimeTerminalAgeMs(runtime: HrcRuntimeSnapshot, now: number): number {
  const observedAt =
    runtime.statusChangedAt && runtime.statusChangedAt !== 'unknown'
      ? runtime.statusChangedAt
      : runtime.updatedAt
  const timestampMs = Date.parse(observedAt)
  return Number.isFinite(timestampMs) ? Math.max(0, now - timestampMs) : Number.POSITIVE_INFINITY
}

export function runtimeLeaseFingerprint(runtime: HrcRuntimeSnapshot): string {
  const hosting = parseBrokerRuntimeHostingState(runtime)
  return JSON.stringify({
    runtimeId: runtime.runtimeId,
    status: runtime.status,
    statusChangedAt: runtime.statusChangedAt,
    updatedAt: runtime.updatedAt,
    tmuxJson: runtime.tmuxJson,
    hosting,
    brokerRecovery: getBrokerRecoveryState(runtime),
  })
}

export function resolvePositiveMs(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

type BrokerRecoveryState = {
  fingerprint: string
  count: number
  firstFailedAt: string
  lastFailedAt: string
  lastReason: string
}

export function getBrokerRecoveryState(
  runtime: HrcRuntimeSnapshot
): BrokerRecoveryState | undefined {
  const control = getRecord(runtime.runtimeStateJson?.['control'])
  const state = getRecord(control?.['brokerRecovery'])
  if (
    !state ||
    typeof state['fingerprint'] !== 'string' ||
    typeof state['count'] !== 'number' ||
    typeof state['firstFailedAt'] !== 'string' ||
    typeof state['lastFailedAt'] !== 'string' ||
    typeof state['lastReason'] !== 'string'
  ) {
    return undefined
  }
  return {
    fingerprint: state['fingerprint'],
    count: state['count'],
    firstFailedAt: state['firstFailedAt'],
    lastFailedAt: state['lastFailedAt'],
    lastReason: state['lastReason'],
  }
}

export function brokerRecoveryFingerprint(runtime: HrcRuntimeSnapshot): string {
  const hosting = parseBrokerRuntimeHostingState(runtime)
  return JSON.stringify({
    generation: runtime.generation,
    endpoint: hosting?.endpoint,
    substrate: hosting?.substrate,
  })
}

export function isBrokerRecoveryExhausted(runtime: HrcRuntimeSnapshot, now = Date.now()): boolean {
  const recovery = getBrokerRecoveryState(runtime)
  if (!recovery || recovery.fingerprint !== brokerRecoveryFingerprint(runtime)) {
    return false
  }
  const maxFailures = resolvePositiveMs('HRC_BROKER_RECOVERY_MAX_FAILURES') ?? 3
  const minElapsedMs = resolvePositiveMs('HRC_BROKER_RECOVERY_MIN_MS') ?? 60_000
  const firstFailedAt = Date.parse(recovery.firstFailedAt)
  return (
    recovery.count >= maxFailures &&
    Number.isFinite(firstFailedAt) &&
    now - firstFailedAt >= minElapsedMs
  )
}

export function recordBrokerRecoveryFailure(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  reason: string,
  now = timestamp()
): HrcRuntimeSnapshot {
  const latest = db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
  const fingerprint = brokerRecoveryFingerprint(latest)
  const prior = getBrokerRecoveryState(latest)
  const next: BrokerRecoveryState =
    prior?.fingerprint === fingerprint
      ? {
          ...prior,
          count: prior.count + 1,
          lastFailedAt: now,
          lastReason: reason,
        }
      : {
          fingerprint,
          count: 1,
          firstFailedAt: now,
          lastFailedAt: now,
          lastReason: reason,
        }
  const control = getRecord(latest.runtimeStateJson?.['control']) ?? {}
  db.runtimes.update(latest.runtimeId, {
    runtimeStateJson: {
      ...(latest.runtimeStateJson ?? {}),
      control: { ...control, brokerRecovery: next },
      updatedAt: now,
    },
    ...runtimeActivityPatch(db, latest.runtimeId, { source: 'housekeeping', updatedAt: now }),
  })
  return db.runtimes.getByRuntimeId(latest.runtimeId) ?? latest
}

export function clearBrokerRecovery(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  now = timestamp()
): void {
  const latest = db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
  const control = getRecord(latest.runtimeStateJson?.['control'])
  if (!control || control['brokerRecovery'] === undefined) {
    return
  }
  const { brokerRecovery: _removed, ...rest } = control
  db.runtimes.update(latest.runtimeId, {
    runtimeStateJson: {
      ...(latest.runtimeStateJson ?? {}),
      control: rest,
      updatedAt: now,
    },
    ...runtimeActivityPatch(db, latest.runtimeId, { source: 'housekeeping', updatedAt: now }),
  })
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
