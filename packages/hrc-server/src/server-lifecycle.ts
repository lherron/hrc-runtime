import type { HrcLastRestart, HrcLifecycleEvent, HrcServerLifecycleGrant } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { appendHrcEvent } from './hrc-event-helper.js'

/**
 * T-08137 — daemon lifecycle provenance (Daedalus-approved rev 4, EN-19426).
 *
 * The daemon's own lifecycle is an HRC-owned durable observation. The ledger
 * requires a session/scope/lane/generation on every row; a daemon fact belongs
 * to no seat, so these sentinels (the `store.migrated` pattern) keep it out of
 * every seat-filtered read while leaving it in the unfiltered firehose and an
 * explicit `scopeRef=server:hrc` read.
 *
 * Only the production daemon integration (`hrc server serve`) writes any of
 * this; an embedded or test server is silent unless explicitly configured.
 */
export const SERVER_EVENT_HOST_SESSION_ID = 'hrc-server'
export const SERVER_EVENT_SCOPE_REF = 'server:hrc'
export const SERVER_EVENT_LANE_REF = 'main'

export type ServerLifecycleEventKind =
  | 'server.shutting_down'
  | 'server.stopped'
  | 'server.previous_exit_unattributed'
  | 'server.started'

/**
 * T-09861 §7: what `server.shutting_down` / `server.stopped` attribute a
 * shutdown to. The attribution SOURCE is the daemon's own verified lifecycle
 * grant — never a caller-written file or env. A graceful shutdown with no grant
 * (a raw `kill`/`launchctl kickstart -k` SIGTERM) carries an explicit
 * `grant: null` plus `ungranted: true`; it is still initiation evidence only.
 */
export type ServerShutdownAttribution =
  | {
      /** The signal or cause that began shutdown (`SIGTERM`, `lifecycle:restart`). */
      reason: string
      grant: HrcServerLifecycleGrant
    }
  | {
      reason: string
      grant: null
      ungranted: true
    }

export type ServerBootProvenance = {
  pid: number
  release: string | null
  sourceCommit: string | null
  storeSchema: string | null
  processStartedAt: string
}

export function appendServerLifecycleEvent(
  db: HrcDatabase,
  eventKind: ServerLifecycleEventKind,
  payload: Record<string, unknown>
): HrcLifecycleEvent {
  return appendHrcEvent(db, eventKind, {
    ts: new Date().toISOString(),
    hostSessionId: SERVER_EVENT_HOST_SESSION_ID,
    scopeRef: SERVER_EVENT_SCOPE_REF,
    laneRef: SERVER_EVENT_LANE_REF,
    generation: 0,
    payload,
  })
}

function latestServerFact(
  db: HrcDatabase,
  beforeHrcSeq?: number | undefined
): HrcLifecycleEvent | null {
  return db.hrcEvents.findLatestLocalInScope(SERVER_EVENT_SCOPE_REF, { beforeHrcSeq })
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Boot classification, then the start fact. A predecessor whose latest fact is
 * its own `server.started` or `server.shutting_down` did not confirm a clean
 * stop (kill, crash, or a timeout after shutdown initiation): exactly one
 * `server.previous_exit_unattributed` is appended before this start. A latest
 * `server.stopped` is a clean predecessor.
 */
export function recordServerBoot(db: HrcDatabase, boot: ServerBootProvenance): HrcLifecycleEvent {
  const latest = latestServerFact(db)
  const latestPayload = record(latest?.payload)
  const previousPid =
    latest === null
      ? null
      : latest.eventKind === 'server.previous_exit_unattributed'
        ? numberOrNull(latestPayload['previousPid'])
        : numberOrNull(latestPayload['pid'])
  if (latest?.eventKind === 'server.started' || latest?.eventKind === 'server.shutting_down') {
    appendServerLifecycleEvent(db, 'server.previous_exit_unattributed', { previousPid })
  }
  return appendServerLifecycleEvent(db, 'server.started', {
    pid: boot.pid,
    release: boot.release,
    sourceCommit: boot.sourceCommit,
    storeSchema: boot.storeSchema,
    processStartedAt: boot.processStartedAt,
    ...(previousPid === null ? {} : { previousPid }),
  })
}

/**
 * `lastRestart`: the latest `server.started` plus the server fact immediately
 * preceding it. Only a completed `server.stopped` carries attribution through:
 * its verified grant (T-09861), or the flat attribution a pre-contract
 * predecessor wrote.
 */
export function projectLastRestart(db: HrcDatabase): HrcLastRestart | null {
  const started = db.hrcEvents.findLatestLocalInScope(SERVER_EVENT_SCOPE_REF, {
    eventKind: 'server.started',
  })
  if (started === null) return null
  const previous = latestServerFact(db, started.hrcSeq)
  if (previous?.eventKind !== 'server.stopped') {
    return { at: started.ts, requestedBy: null, reason: null }
  }
  const payload = record(previous.payload)
  if ('grant' in payload) {
    const grant = record(payload['grant'])
    return {
      at: started.ts,
      requestedBy: stringOrNull(grant['requestedBy']),
      reason: stringOrNull(grant['reason']),
    }
  }
  return {
    at: started.ts,
    requestedBy: stringOrNull(payload['requestedBy']),
    reason: stringOrNull(payload['requestedReason']),
  }
}
