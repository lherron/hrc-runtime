/**
 * Runtime turn-ownership + awaiting-input state projection for the
 * BrokerEventMapper.
 *
 * Extracted verbatim from event-mapper.ts as a pure mechanical move. Manages
 * runtime.status / activeRunId (and the mirrored runtimeStateJson) in lockstep,
 * the T-01946 awaiting-input park/resume, the run-mismatch unwedge, and the
 * HRC-derived turn lifecycle event emission.
 */
import type { HrcLifecycleEvent } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { runtimeHasAnyOpenAskBracket } from '../../ask-bracket'
import { appendHrcEvent } from '../../hrc-event-helper'
import { writeServerLog } from '../../server-log.js'
import {
  type ProjectionContext,
  type RuntimeRecord,
  isRecord,
  omitRuntimeStateActiveRun,
} from './helpers'
import { TERMINAL_TURN_EVENT_TYPE_SQL } from './helpers'

/** True iff the runtime is currently projected as parked on a user prompt. */
export function isRuntimeAwaitingInput(db: HrcDatabase, runtimeId: string): boolean {
  return db.runtimes.getByRuntimeId(runtimeId)?.status === 'awaiting_input'
}

export function claimRuntimeTurnOwnership(
  db: HrcDatabase,
  ctx: ProjectionContext,
  runId: string,
  now: string
): void {
  const runtime = db.runtimes.getByRuntimeId(ctx.runtimeId)
  if (!runtime) return
  if (runtime.activeRunId !== undefined && runtime.activeRunId !== runId) {
    const activeRun = db.runs.getByRunId(runtime.activeRunId)
    if (activeRun && activeRun.completedAt === undefined) return
  }

  const runtimeStateJson = isRecord(runtime.runtimeStateJson) ? runtime.runtimeStateJson : undefined
  db.runtimes.update(ctx.runtimeId, {
    status: 'busy',
    activeRunId: runId,
    lastActivityAt: now,
    updatedAt: now,
    ...(runtimeStateJson !== undefined
      ? {
          runtimeStateJson: {
            ...runtimeStateJson,
            status: 'busy',
            activeRunId: runId,
            updatedAt: now,
          },
        }
      : {}),
  })
}

/** Park the runtime on an open ask bracket (T-01946): turn is active but blocked. */
export function markRuntimeAwaitingInput(
  db: HrcDatabase,
  ctx: ProjectionContext,
  invocationId: string,
  now: string
): void {
  db.brokerInvocations.update(invocationId, {
    invocationState: 'awaiting_input',
    updatedAt: now,
  })
  setRuntimeStatus(db, ctx.runtimeId, 'awaiting_input', now)
}

/**
 * Resume after the operator answers: the SAME turn continues (busy), it does
 * NOT complete — `turn.completed` later flips ready via markRuntimeTurnTerminal.
 */
export function markRuntimeInputResumed(
  db: HrcDatabase,
  ctx: ProjectionContext,
  invocationId: string,
  now: string
): void {
  db.brokerInvocations.update(invocationId, {
    invocationState: 'turn_active',
    updatedAt: now,
  })
  setRuntimeStatus(db, ctx.runtimeId, 'busy', now)
}

/** Update runtime.status (and the mirrored runtimeStateJson.status) in lockstep. */
export function setRuntimeStatus(
  db: HrcDatabase,
  runtimeId: string,
  status: string,
  now: string
): void {
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) return
  const runtimeStateJson = isRecord(runtime.runtimeStateJson) ? runtime.runtimeStateJson : undefined
  db.runtimes.update(runtimeId, {
    status,
    lastActivityAt: now,
    updatedAt: now,
    ...(runtimeStateJson !== undefined
      ? { runtimeStateJson: { ...runtimeStateJson, status, updatedAt: now } }
      : {}),
  })
}

/**
 * Emit an HRC-derived turn lifecycle event (turn.awaiting_input /
 * turn.input_resumed). These have no broker event type — the mapper synthesizes
 * them from the ask bracket as the observability / fast-path surface. The
 * authority remains the durable bracket in broker_invocation_events.
 */
export function emitDerivedTurnEvent(
  db: HrcDatabase,
  eventKind: 'turn.awaiting_input' | 'turn.input_resumed',
  envelope: InvocationEventEnvelope,
  ctx: ProjectionContext,
  now: string,
  extra: { toolUseId: string; toolName: string }
): HrcLifecycleEvent {
  return appendHrcEvent(db, eventKind, {
    ts: now,
    hostSessionId: ctx.hostSessionId,
    scopeRef: ctx.scopeRef,
    laneRef: ctx.laneRef,
    generation: ctx.generation,
    runtimeId: ctx.runtimeId,
    ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
    transport: ctx.transport,
    payload: {
      toolUseId: extra.toolUseId,
      toolName: extra.toolName,
      invocationId: envelope.invocationId,
      seq: envelope.seq,
      ...(envelope.harnessGeneration !== undefined
        ? { harnessGeneration: envelope.harnessGeneration }
        : {}),
      ...(envelope.turnAttempt !== undefined ? { turnAttempt: envelope.turnAttempt } : {}),
    },
  })
}

export function clearRuntimeTurnOwnership(
  db: HrcDatabase,
  runtime: RuntimeRecord,
  now: string
): void {
  db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
  const runtimeStateJson = isRecord(runtime.runtimeStateJson)
    ? omitRuntimeStateActiveRun(runtime.runtimeStateJson)
    : runtime.runtimeStateJson
  db.runtimes.update(runtime.runtimeId, {
    status: 'ready',
    lastActivityAt: now,
    updatedAt: now,
    ...(runtimeStateJson !== undefined
      ? {
          runtimeStateJson: {
            ...runtimeStateJson,
            status: 'ready',
            updatedAt: now,
          },
        }
      : {}),
  })
}

function terminalBelongsToActiveInvocation(
  runtime: RuntimeRecord,
  ctx: ProjectionContext,
  invocationId: string
): boolean {
  if (runtime.activeInvocationId !== undefined && runtime.activeInvocationId !== invocationId) {
    return false
  }
  if (runtime.activeOperationId !== undefined && runtime.activeOperationId !== ctx.operationId) {
    return false
  }
  return true
}

function hasOpenTurnBracketAtSeq(db: HrcDatabase, invocationId: string, seq: number): boolean {
  const row = db.sqlite
    .query<{ count: number }, [string, number, number]>(
      `SELECT COUNT(*) AS count
         FROM broker_invocation_events AS started
        WHERE started.invocation_id = ?
          AND started.type = 'turn.started'
          AND started.seq <= ?
          AND NOT EXISTS (
            SELECT 1
              FROM broker_invocation_events AS terminal
             WHERE terminal.invocation_id = started.invocation_id
               AND terminal.type IN (${TERMINAL_TURN_EVENT_TYPE_SQL})
               AND terminal.seq > started.seq
               AND terminal.seq <= ?
          )`
    )
    .get(invocationId, seq, seq)
  return (row?.count ?? 0) > 0
}

export function markRuntimeTurnTerminal(
  db: HrcDatabase,
  ctx: ProjectionContext,
  envelope: InvocationEventEnvelope,
  runId: string,
  now: string
): void {
  const runtime = db.runtimes.getByRuntimeId(ctx.runtimeId)
  if (!runtime) return
  if (runtime.activeRunId !== undefined && runtime.activeRunId !== runId) {
    const canUnwedge =
      terminalBelongsToActiveInvocation(runtime, ctx, envelope.invocationId) &&
      !hasOpenTurnBracketAtSeq(db, envelope.invocationId, envelope.seq) &&
      !runtimeHasAnyOpenAskBracket(db, runtime)
    if (canUnwedge) {
      writeServerLog('WARN', 'broker.event_mapper.runtime_unwedged_on_run_mismatch', {
        runtimeId: ctx.runtimeId,
        invocationId: envelope.invocationId,
        seq: envelope.seq,
        activeRunId: runtime.activeRunId,
        terminalRunId: runId,
      })
      clearRuntimeTurnOwnership(db, runtime, now)
    }
    return
  }

  // Gate 3 / invariant (T-01946): never project `ready` while an ask bracket is
  // still open on this runtime. A genuine same-run terminal closes this run's
  // brackets (the authority requires no later same-run terminal), so this is
  // normally false — it only holds if another run on the runtime is still
  // parked, in which case the still-open bracket governs the runtime and we
  // leave ownership/awaiting untouched rather than projecting a false `ready`.
  if (runtimeHasAnyOpenAskBracket(db, runtime)) {
    return
  }

  clearRuntimeTurnOwnership(db, runtime, now)
}
