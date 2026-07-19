/**
 * Terminal/crash/stale lifecycle helpers for HarnessBrokerController.
 *
 * Extracted verbatim from controller.ts as a mechanical move. These mutate
 * HRC state on a broker invocation reaching a terminal/failed/stale condition.
 * They take an explicit `LifecycleContext` (db/now/serverInstanceId/logger plus
 * the small set of class callbacks they reach back into) instead of `this`, so
 * behavior is byte-for-byte identical at the call site. Nothing here is part of
 * the controller's public export surface.
 */

import { HrcErrorCode } from 'hrc-core'
import type { HrcBrokerInvocationRecord, HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { appendHrcEvent } from '../../hrc-event-helper'
import { runtimeActivityPatch } from '../../runtime-activity'
import type { BrokerProjectionResult } from '../event-mapper'
import type { BrokerControllerError } from './errors'
import { isActiveBrokerRun } from './internal'
import { findUserInitiatedContinuationClearReason } from './persistence'
import type { BrokerControllerLogger, DurableBrokerClientLike } from './types'

export type LifecycleContext = {
  db: HrcDatabase
  now: () => string
  serverInstanceId: string
  logger: BrokerControllerLogger
  getActiveInvocationId: (runtimeId: string) => string | undefined
  getActiveClient: (runtimeId: string) => { close: () => Promise<void> } | undefined
  deleteActive: (runtimeId: string) => void
  markBrokerClosing: (runtimeId: string, reason: string) => void
  fireBrokerTmuxLeaseReap: (runtimeId: string, reason: string) => void
}

/**
 * Stamp a runtime to a terminal/stale status with a single diagnostic block.
 *
 * Factored from failReplayStale + markBrokerCrashTerminal (F6 / T-04737): both
 * repeat the exact "spread the prior runtimeStateJson, re-stamp status+updatedAt,
 * append one diagnostic block, mirror status/lastActivityAt/updatedAt on the row"
 * shape. The merge order is load-bearing and preserved verbatim: prior keys
 * first, then status/updatedAt, then the caller's diagnostic LAST (so a
 * diagnostic key like `control` overwrites the prior one). Each caller keeps
 * ownership of its own diagnostic key set (lastAttachError vs brokerCrash).
 *
 * NOTE: markStartedInvocationFailed is deliberately NOT routed through this —
 * it builds runtimeStateJson from scratch (no prior spread) and stamps extra
 * activeInvocation/Operation/Run fields, so a shared spread helper would change
 * its observable field set (T-04737 STOP, see wrkq comment).
 */
function applyTerminalRuntimeState(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  params: { status: string; now: string; diagnostic: Record<string, unknown> }
): void {
  db.runtimes.update(runtime.runtimeId, {
    status: params.status,
    statusChangedAt: params.now,
    ...runtimeActivityPatch(db, runtime.runtimeId, {
      source: 'housekeeping',
      updatedAt: params.now,
    }),
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: params.status,
      updatedAt: params.now,
      ...params.diagnostic,
    },
  })
}

export function markBrokerInvocationTerminal(
  ctx: LifecycleContext,
  runtimeId: string,
  envelope: InvocationEventEnvelope,
  result: BrokerProjectionResult
): void {
  const runtime = ctx.db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime || runtime.activeInvocationId !== String(envelope.invocationId)) {
    return
  }
  if (runtime.status === 'terminated' || runtime.status === 'dead' || runtime.status === 'stale') {
    return
  }

  const now = ctx.now()
  const invocation = ctx.db.brokerInvocations.getByInvocationId(String(envelope.invocationId))
  const runId = invocation?.runId ?? runtime.activeRunId
  const userExitReason =
    envelope.type === 'invocation.exited'
      ? findUserInitiatedContinuationClearReason(
          ctx.db,
          String(envelope.invocationId),
          envelope.seq
        )
      : undefined
  const terminalStatus = userExitReason !== undefined ? 'terminated' : 'stale'
  const occurredAt = envelope.time ?? now
  const terminalEventKind = userExitReason !== undefined ? 'runtime.terminated' : 'runtime.stale'
  const terminalReason =
    userExitReason !== undefined ? 'user_initiated_session_end' : 'broker_invocation_terminal'
  if (runtime.activeRunId !== undefined) {
    const activeRun = ctx.db.runs.getByRunId(runtime.activeRunId)
    if (activeRun && isActiveBrokerRun(activeRun)) {
      ctx.db.runs.markCompleted(activeRun.runId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage:
          userExitReason !== undefined
            ? `broker invocation ${String(envelope.invocationId)} ended by user request (${userExitReason})`
            : `broker invocation ${String(envelope.invocationId)} reached terminal state ${envelope.type}`,
      })
    }
    ctx.db.runtimes.updateRunId(runtimeId, undefined, now)
  }
  ctx.db.runtimes.update(runtimeId, {
    status: terminalStatus,
    statusChangedAt: occurredAt,
    ...runtimeActivityPatch(ctx.db, runtimeId, {
      source: 'broker-event',
      occurredAt,
      updatedAt: now,
    }),
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: terminalStatus,
      updatedAt: now,
      terminalReason,
      ...(userExitReason !== undefined ? { userExitReason } : {}),
      terminalInvocation: {
        invocationId: String(envelope.invocationId),
        eventType: envelope.type,
        seq: envelope.seq,
      },
    },
  })

  if (!result.idempotent) {
    appendHrcEvent(ctx.db, terminalEventKind, {
      ts: now,
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
      runtimeId,
      ...(runId !== undefined ? { runId } : {}),
      ...(runtime.transport === 'headless' || runtime.transport === 'tmux'
        ? { transport: runtime.transport }
        : {}),
      payload: {
        reason: terminalReason,
        ...(userExitReason !== undefined ? { userExitReason } : {}),
        invocationId: String(envelope.invocationId),
        eventType: envelope.type,
        seq: envelope.seq,
      },
    })
  }

  const activeClient = ctx.getActiveClient(runtimeId)
  if (activeClient && ctx.getActiveInvocationId(runtimeId) === String(envelope.invocationId)) {
    ctx.markBrokerClosing(runtimeId, 'broker_invocation_terminal')
    ctx.deleteActive(runtimeId)
    void activeClient.close().catch((error) => {
      ctx.logger.warn?.('harness broker close after terminal invocation failed', {
        runtimeId,
        invocationId: String(envelope.invocationId),
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  // Lever 2 graceful exit (defensive — secondary to the continuation.cleared
  // hook): if a /quit DOES surface as a clean invocation.exited, the durable
  // unix broker survives the client close above by design, so tear the lease
  // down here too. Deduped against the continuation-clear reap. Gated on
  // userExitReason so crashes / idle-ttl terminals keep durability for reattach.
  if (userExitReason !== undefined) {
    ctx.fireBrokerTmuxLeaseReap(runtimeId, 'invocation_exited')
  }
}

export async function failReplayStale(
  ctx: LifecycleContext,
  runtime: HrcRuntimeSnapshot,
  invocation: HrcBrokerInvocationRecord,
  client: DurableBrokerClientLike,
  error: BrokerControllerError
): Promise<void> {
  ctx.deleteActive(runtime.runtimeId)
  ctx.markBrokerClosing(runtime.runtimeId, error.code)
  const now = ctx.now()
  ctx.db.brokerInvocations.update(invocation.invocationId, {
    invocationState: 'failed',
    ownerServerInstanceId: ctx.serverInstanceId,
    updatedAt: now,
  })
  applyTerminalRuntimeState(ctx.db, runtime, {
    status: 'stale',
    now,
    diagnostic: {
      control: {
        mode: 'broker-ipc',
        brokerAttached: false,
        lastAttachError: {
          code: error.code,
          message: error.message,
          detail: error.detail,
        },
      },
    },
  })
  await client.close().catch((closeError: unknown) => {
    ctx.logger.warn?.('harness broker close after replay failure failed', {
      runtimeId: runtime.runtimeId,
      invocationId: invocation.invocationId,
      error: closeError instanceof Error ? closeError.message : String(closeError),
    })
  })
}

export function markBrokerCrashTerminal(
  ctx: LifecycleContext,
  runtimeId: string,
  error: BrokerControllerError
): void {
  ctx.deleteActive(runtimeId)
  const now = ctx.now()
  const runtime = ctx.db.runtimes.getByRuntimeId(runtimeId)
  const invocation =
    runtime?.activeInvocationId !== undefined
      ? ctx.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
      : ctx.db.brokerInvocations.listByRuntimeId(runtimeId).at(-1)

  if (invocation) {
    ctx.db.brokerInvocations.update(invocation.invocationId, {
      invocationState: 'failed',
      updatedAt: now,
    })
    if (invocation.runId !== undefined) {
      ctx.db.runs.markCompleted(invocation.runId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage: error.message,
      })
    }
    ctx.db.runtimeOperations.update(invocation.operationId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: error.code,
      errorMessage: error.message,
    })
  }

  if (runtime) {
    applyTerminalRuntimeState(ctx.db, runtime, {
      status: 'terminated',
      now,
      diagnostic: {
        brokerCrash: {
          code: error.code,
          message: error.message,
          detail: error.detail,
        },
      },
    })
    ctx.db.events.append({
      ts: now,
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
      ...(invocation?.runId !== undefined ? { runId: invocation.runId } : {}),
      runtimeId,
      source: 'broker',
      eventKind: 'broker.process.closed',
      eventJson: {
        code: error.code,
        message: error.message,
        detail: error.detail,
      },
    })
  }
}
