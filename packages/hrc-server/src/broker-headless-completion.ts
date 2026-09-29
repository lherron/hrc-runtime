import { setTimeout as delay } from 'node:timers/promises'
import { HrcErrorCode, HrcRuntimeUnavailableError } from 'hrc-core'
import type { HrcRunRecord, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import {
  compilerPrimingSubmissionId,
  isCompilerPrimingSubmissionTerminal,
} from './compiler-priming.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { isRunActive } from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { timestamp } from './server-util.js'

/**
 * A promptless cold Codex boot still runs the compiler-owned agent priming
 * input. The caller prompt is a separate guarded invoke, so it must wait for
 * that priming submission's identified turn to become terminal. This consumes
 * only the broker ledger/subscriber projection: no local busy guess, polling,
 * timer, or reply row participates.
 */
export async function waitForCompilerPrimingTerminal(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  signal: AbortSignal
): Promise<void> {
  const submissionId = compilerPrimingSubmissionId(server.db, runtime)
  const invocationId = runtime.activeInvocationId
  if (submissionId === undefined || invocationId === undefined) return

  const evaluate = (): boolean =>
    isCompilerPrimingSubmissionTerminal(server.db, invocationId, submissionId)

  if (evaluate()) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      server.rawBrokerSubscribers.delete(subscriber)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(
        new HrcRuntimeUnavailableError('compiler priming wait aborted', {
          runtimeId: runtime.runtimeId,
          invocationId,
          submissionId,
        })
      )
    }
    const subscriber = (notification: { record: { invocationId: string } }) => {
      if (notification.record.invocationId === invocationId && evaluate()) finish()
    }
    server.rawBrokerSubscribers.add(subscriber)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else if (evaluate()) finish()
  })
}

export async function waitForInteractiveBrokerRunCompletion(
  this: HrcServerInstanceForHandlers,
  runId: string,
  runtimeId: string
): Promise<HrcRunRecord> {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    const run = this.db.runs.getByRunId(runId)
    if (run && !isRunActive(run)) {
      if (run.status !== 'completed') {
        throw new HrcRuntimeUnavailableError('interactive broker turn failed', {
          runtimeId,
          runId,
          status: run.status,
          errorCode: run.errorCode,
          errorMessage: run.errorMessage,
        })
      }
      return run
    }
    await delay(100)
  }

  throw new HrcRuntimeUnavailableError('interactive broker turn timed out', {
    runtimeId,
    runId,
    route: 'interactive-broker',
  })
}

export async function waitForHeadlessBrokerRunCompletion(
  this: HrcServerInstanceForHandlers,
  runId: string,
  runtimeId: string
): Promise<HrcRunRecord> {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    const run = this.db.runs.getByRunId(runId)
    if (run && !isRunActive(run)) {
      // Guarded cleanup: only clear runtime.activeRunId / set status='ready'
      // when the runtime's active run is STILL this one. With broker FIFO
      // queueing, the event-mapper may have already flipped activeRunId to
      // a drained queued run on input.accepted; unconditionally clearing
      // would clobber that pointer and re-introduce the T-01711 hang class.
      const currentRuntime = this.db.runtimes.getByRuntimeId(runtimeId)
      if (currentRuntime?.activeRunId === runId) {
        const now = timestamp()
        this.db.runtimes.updateRunId(runtimeId, undefined, now)
        this.db.runtimes.update(runtimeId, {
          status: 'ready',
          statusChangedAt: run.completedAt ?? now,
          ...runtimeActivityPatch(this.db, runtimeId, {
            source: 'housekeeping',
            updatedAt: now,
          }),
        })
      }
      if (run.status !== 'completed') {
        throw new HrcRuntimeUnavailableError('headless broker turn failed', {
          runtimeId,
          runId,
          status: run.status,
          errorCode: run.errorCode,
          errorMessage: run.errorMessage,
        })
      }
      return run
    }
    await delay(100)
  }

  throw new HrcRuntimeUnavailableError('headless broker turn timed out', {
    runtimeId,
    runId,
    route: 'broker',
  })
}

export function recordDetachedHeadlessTurnFailure(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtimeId: string,
  runId: string,
  err: unknown
): void {
  const errorMessage = err instanceof Error ? err.message : String(err)
  writeServerLog('WARN', 'headless.detached_turn_failed', {
    hostSessionId: session.hostSessionId,
    runtimeId,
    runId,
    error: errorMessage,
  })

  const run = this.db.runs.getByRunId(runId)
  if (!run || !isRunActive(run)) {
    return
  }

  const now = timestamp()
  this.db.runs.markCompleted(runId, {
    status: 'failed',
    completedAt: now,
    updatedAt: now,
    errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
    errorMessage,
  })

  const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
  if (runtime?.activeRunId === runId) {
    this.db.runtimes.updateRunId(runtimeId, undefined, now)
    this.db.runtimes.update(runtimeId, {
      status: 'ready',
      statusChangedAt: now,
      ...runtimeActivityPatch(this.db, runtimeId, {
        source: 'turn',
        occurredAt: now,
        updatedAt: now,
      }),
    })
  }

  const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId,
    errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
    payload: {
      success: false,
      transport: 'headless',
    },
  })
  this.notifyEvent(completedEvent)
}
