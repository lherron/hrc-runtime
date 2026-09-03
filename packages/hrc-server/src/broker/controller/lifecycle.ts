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
import type {
  InvocationEventEnvelope,
  InvocationFailedPayload,
} from 'spaces-harness-broker-protocol'

import { isExternalLifecycleOwner } from '../../external-participant-lifecycle'
import { appendHrcEvent } from '../../hrc-event-helper'
import { runtimeActivityPatch } from '../../runtime-activity'
import type { BrokerProjectionResult } from '../event-mapper'
import type { BrokerControllerError } from './errors'
import { isActiveBrokerRun, isControllerFencedError } from './internal'
import { findUserInitiatedContinuationClearReason } from './persistence'
import type { BrokerClientLike, BrokerControllerLogger, DurableBrokerClientLike } from './types'

export type LifecycleContext = {
  db: HrcDatabase
  now: () => string
  serverInstanceId: string
  logger: BrokerControllerLogger
  getActiveInvocationId: (runtimeId: string) => string | undefined
  getActiveClient: (runtimeId: string) => BrokerClientLike | undefined
  deleteActive: (runtimeId: string, client: BrokerClientLike) => void
  markBrokerClosing: (runtimeId: string, reason: string, client: BrokerClientLike) => void
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
  result: BrokerProjectionResult,
  options: { preserveActiveClient?: boolean } = {}
): void {
  const runtime = ctx.db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime || runtime.activeInvocationId !== String(envelope.invocationId)) {
    return
  }
  if (
    runtime.status === 'terminated' ||
    runtime.status === 'dead' ||
    runtime.status === 'crashed'
  ) {
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
  const terminalStatus = userExitReason !== undefined ? 'terminated' : 'crashed'
  const occurredAt = envelope.time ?? now
  const terminalEventKind = userExitReason !== undefined ? 'runtime.terminated' : 'runtime.crashed'
  const invocationFailure =
    envelope.type === 'invocation.failed'
      ? (envelope.payload as InvocationFailedPayload)
      : undefined
  const providerFailureMessage =
    invocationFailure?.message !== undefined && invocationFailure.message.trim().length > 0
      ? invocationFailure.message
      : undefined
  const terminalReason =
    userExitReason !== undefined
      ? 'user_initiated_session_end'
      : (providerFailureMessage ?? 'broker_invocation_abnormal_terminal')
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
            : providerFailureMessage !== undefined
              ? `broker invocation ${String(envelope.invocationId)} failed: ${providerFailureMessage}`
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
      ...(userExitReason === undefined ? { errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE } : {}),
      payload: {
        reason: terminalReason,
        ...(userExitReason !== undefined ? { userExitReason } : {}),
        invocationId: String(envelope.invocationId),
        eventType: envelope.type,
        seq: envelope.seq,
        ...(userExitReason === undefined
          ? {
              providerTerminal: {
                eventType: envelope.type,
                ...((envelope.payload as { exitCode?: unknown } | undefined)?.exitCode !== undefined
                  ? {
                      exitCode: (envelope.payload as { exitCode?: unknown }).exitCode,
                    }
                  : {}),
                ...((envelope.payload as { signal?: unknown } | undefined)?.signal !== undefined
                  ? { signal: (envelope.payload as { signal?: unknown }).signal }
                  : {}),
                ...((envelope.payload as { message?: unknown } | undefined)?.message !== undefined
                  ? { message: (envelope.payload as { message?: unknown }).message }
                  : {}),
                ...((envelope.payload as { code?: unknown } | undefined)?.code !== undefined
                  ? { code: (envelope.payload as { code?: unknown }).code }
                  : {}),
                ...((envelope.payload as { reason?: unknown } | undefined)?.reason !== undefined
                  ? { reason: (envelope.payload as { reason?: unknown }).reason }
                  : {}),
              },
            }
          : {}),
      },
    })
  }

  const activeClient = ctx.getActiveClient(runtimeId)
  if (
    !options.preserveActiveClient &&
    activeClient &&
    ctx.getActiveInvocationId(runtimeId) === String(envelope.invocationId)
  ) {
    ctx.markBrokerClosing(runtimeId, 'broker_invocation_terminal', activeClient)
    ctx.deleteActive(runtimeId, activeClient)
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

/** EPR clean exit: participant process fate is known only because it said so. */
export function markExternalParticipantInvocationTerminal(
  ctx: LifecycleContext,
  runtimeId: string,
  envelope: InvocationEventEnvelope,
  result: BrokerProjectionResult
): void {
  const runtime = ctx.db.runtimes.getByRuntimeId(runtimeId)
  if (
    !runtime ||
    runtime.activeInvocationId !== String(envelope.invocationId) ||
    runtime.status === 'terminated'
  ) {
    return
  }

  const now = ctx.now()
  const occurredAt = envelope.time ?? now
  ctx.db.runtimes.update(runtimeId, {
    status: 'terminated',
    statusChangedAt: occurredAt,
    lifecycleTerminalReason: 'external_participant_exit',
    ...runtimeActivityPatch(ctx.db, runtimeId, {
      source: 'broker-event',
      occurredAt,
      updatedAt: now,
    }),
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'terminated',
      updatedAt: now,
      terminalReason: 'external_participant_exit',
      terminalInvocation: {
        invocationId: String(envelope.invocationId),
        eventType: envelope.type,
        seq: envelope.seq,
      },
    },
  })

  if (!result.idempotent) {
    appendHrcEvent(ctx.db, 'runtime.terminated', {
      ts: now,
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
      runtimeId,
      transport: 'headless',
      payload: {
        reason: 'external_participant_exit',
        invocationId: String(envelope.invocationId),
        seq: envelope.seq,
      },
    })
  }
}

export async function failReplayStale(
  ctx: LifecycleContext,
  runtime: HrcRuntimeSnapshot,
  invocation: HrcBrokerInvocationRecord,
  client: DurableBrokerClientLike,
  error: BrokerControllerError
): Promise<void> {
  if (isControllerFencedError(error)) {
    ctx.markBrokerClosing(runtime.runtimeId, 'broker_controller_fenced', client)
    await client.close().catch(() => undefined)
    return
  }
  if (isExternalLifecycleOwner(runtime)) {
    ctx.deleteActive(runtime.runtimeId, client)
    await client.close().catch(() => undefined)
    return
  }
  ctx.deleteActive(runtime.runtimeId, client)
  ctx.markBrokerClosing(runtime.runtimeId, error.code, client)
  const now = ctx.now()
  const replayStale =
    error.code === 'broker_replay_retention_gap' || error.code === 'broker_replay_below_floor'
  ctx.db.brokerInvocations.update(invocation.invocationId, {
    invocationState: 'failed',
    ownerServerInstanceId: ctx.serverInstanceId,
    updatedAt: now,
  })
  applyTerminalRuntimeState(ctx.db, runtime, {
    status: 'stale',
    now,
    diagnostic: {
      ...(replayStale
        ? {
            brokerReplay: {
              status: 'replay-stale',
              reason: {
                code: error.code,
                message: error.message,
                detail: error.detail,
              },
            },
          }
        : {}),
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
  if (replayStale) {
    appendHrcEvent(ctx.db, 'runtime.stale', {
      ts: now,
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
      runtimeId: runtime.runtimeId,
      ...(runtime.activeRunId !== undefined ? { runId: runtime.activeRunId } : {}),
      ...(runtime.transport === 'headless' || runtime.transport === 'tmux'
        ? { transport: runtime.transport }
        : {}),
      payload: {
        reason: 'broker_replay_stale',
        code: error.code,
        invocationId: invocation.invocationId,
        detail: error.detail,
      },
    })
  }
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
  const ownedRuntime = ctx.db.runtimes.getByRuntimeId(runtimeId)
  if (ownedRuntime && isExternalLifecycleOwner(ownedRuntime)) {
    return
  }
  const activeClient = ctx.getActiveClient(runtimeId)
  if (activeClient) {
    ctx.deleteActive(runtimeId, activeClient)
  }
  ctx.db.sqlite.transaction(() => {
    const now = ctx.now()
    const runtime = ctx.db.runtimes.getByRuntimeId(runtimeId)
    if (runtime?.status === 'crashed') {
      return
    }
    const invocation =
      runtime?.activeInvocationId !== undefined
        ? ctx.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
        : ctx.db.brokerInvocations.listByRuntimeId(runtimeId).at(-1)

    // T-07908: the broker may close after dispatch has bound the run to its
    // kicker attempt but before either runtime.activeRunId or invocation.runId
    // is durable. The attempt is therefore an ownership link in its own right.
    // Gather every live run this runtime owns and terminalize all of them before
    // stamping the runtime crashed.
    const driveRunIds = ctx.db.mailDrives
      .listAttempts()
      .filter(
        (attempt) =>
          attempt.runtimeId === runtimeId &&
          (attempt.state === 'claimed' || attempt.state === 'started')
      )
      .map((attempt) => attempt.runId)
    const ownedRunIds = new Set<string>([
      ...(invocation?.runId === undefined ? [] : [invocation.runId]),
      ...(runtime?.activeRunId === undefined ? [] : [runtime.activeRunId]),
      ...driveRunIds,
    ])
    // T-07944: which of the owned runs was still LIVE when the crash landed.
    // Captured before the terminalizing loop below, because that loop is what
    // makes them terminal — and only a run this crash actually killed may carry
    // it. `invocation.runId` outlives its turn, so the old unconditional pick
    // stamped `runtime.crashed` onto runs that had completed (73 minutes
    // earlier, in the case that surfaced this): a red band on a timeline for a
    // turn that ended cleanly.
    const crashedRunIds = new Set<string>()
    for (const runId of ownedRunIds) {
      const run = ctx.db.runs.getByRunId(runId)
      if (run === null || !isActiveBrokerRun(run)) continue
      crashedRunIds.add(runId)
      ctx.db.runs.markCompleted(runId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage: error.message,
      })
    }
    // Attach the crash to a run only when this crash is what ended it; otherwise
    // it belongs to the runtime alone.
    const terminalRunId = [invocation?.runId, runtime?.activeRunId, driveRunIds.at(-1)].find(
      (candidate): candidate is string => candidate !== undefined && crashedRunIds.has(candidate)
    )

    if (invocation) {
      ctx.db.brokerInvocations.update(invocation.invocationId, {
        invocationState: 'failed',
        updatedAt: now,
      })
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
        status: 'crashed',
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
        ...(terminalRunId !== undefined ? { runId: terminalRunId } : {}),
        runtimeId,
        source: 'broker',
        eventKind: 'broker.process.closed',
        eventJson: {
          code: error.code,
          message: error.message,
          detail: error.detail,
        },
      })
      const lastBrokerEvent =
        invocation != null
          ? ctx.db.brokerInvocationEvents.listByInvocationId(invocation.invocationId).at(-1)
          : undefined
      appendHrcEvent(ctx.db, 'runtime.crashed', {
        ts: now,
        hostSessionId: runtime.hostSessionId,
        scopeRef: runtime.scopeRef,
        laneRef: runtime.laneRef,
        generation: runtime.generation,
        runtimeId,
        ...(terminalRunId !== undefined ? { runId: terminalRunId } : {}),
        ...(runtime.transport === 'headless' || runtime.transport === 'tmux'
          ? { transport: runtime.transport }
          : {}),
        errorCode: error.code,
        payload: {
          reason: 'broker_process_closed',
          ...(invocation != null ? { invocationId: invocation.invocationId } : {}),
          brokerError: {
            code: error.code,
            message: error.message,
            detail: error.detail,
          },
          ...(lastBrokerEvent !== undefined
            ? {
                lastBrokerEvent: {
                  seq: lastBrokerEvent.seq,
                  type: lastBrokerEvent.type,
                  time: lastBrokerEvent.time,
                },
              }
            : {}),
          ...(runtime.runtimeStateJson?.['stalePayload'] !== undefined
            ? { substrateEvidence: runtime.runtimeStateJson['stalePayload'] }
            : {}),
        },
      })
    }
  })()
}
