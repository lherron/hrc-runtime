import { randomUUID } from 'node:crypto'

import {
  HrcConflictError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
} from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcProvider,
  HrcRuntimeIntent,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { getSdkInflightCapability, runSdkTurn } from '../agent-spaces-adapter/index.js'
import { deriveSdkHarness } from '../broker-decisions.js'
import {
  appendHrcEvent,
  createUserPromptPayload,
  deriveSemanticTurnEventFromSdkEvent,
} from '../hrc-event-helper.js'
import {
  assertRuntimeNotBusy,
  isRunActive,
  isRuntimeUnavailableStatus,
} from '../require-helpers.js'
import { runtimeActivityPatch } from '../runtime-activity.js'
import { findLatestSessionRuntime } from '../runtime-select.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import { json, timestamp } from '../server-util.js'

type DispatchTurnResponseBase = Omit<DispatchTurnResponse, 'startIdentity' | 'observation'>

/**
 * Provisions the SDK runtime/run rows and emits the runtime.created/turn.accepted/
 * turn.user_prompt/turn.started lifecycle events for an SDK dispatch turn.
 * Extracted from {@link handleSdkDispatchTurn} (behavior-preserving) to keep the
 * handler a linear orchestrator.
 */
function resolveSdkDispatchTarget(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string
): {
  runtime: ReturnType<HrcDatabase['runtimes']['insert']>
  run: ReturnType<HrcDatabase['runs']['insert']>
  existingProvider: HrcProvider | undefined
  startedAt: string
} {
  const existingProvider =
    findLatestSessionRuntime(this.db, session.hostSessionId)?.provider ??
    session.continuation?.provider
  const now = timestamp()
  const sdkHarness = deriveSdkHarness(intent.harness)
  const matchingRuntimes = this.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .filter(
      (runtime) =>
        runtime.transport === 'sdk' &&
        runtime.provider === intent.harness.provider &&
        runtime.harness === sdkHarness
    )
    .filter((runtime) => !isRuntimeUnavailableStatus(runtime.status))

  for (const runtime of matchingRuntimes) {
    assertRuntimeNotBusy(this.db, runtime)
  }

  const reusableRuntimes = matchingRuntimes.filter((runtime) => runtime.status === 'ready')
  if (
    matchingRuntimes.length > 1 ||
    (matchingRuntimes.length === 1 && reusableRuntimes.length === 0)
  ) {
    throw new HrcConflictError(
      HrcErrorCode.RUNTIME_BUSY,
      'SDK session does not have exactly one reusable runtime',
      {
        hostSessionId: session.hostSessionId,
        runtimeIds: matchingRuntimes.map((runtime) => runtime.runtimeId),
      }
    )
  }

  this.db.sessions.updateIntent(session.hostSessionId, intent, now)

  const reusableRuntime = reusableRuntimes[0]
  const runtimeId = reusableRuntime?.runtimeId ?? `rt-${randomUUID()}`
  const runtime = reusableRuntime
    ? this.db.runtimes.update(runtimeId, {
        status: 'busy',
        statusChangedAt: now,
        continuation: session.continuation,
        activeRunId: runId,
        ...runtimeActivityPatch(this.db, runtimeId, {
          source: 'turn',
          occurredAt: now,
          updatedAt: now,
        }),
      })
    : this.db.runtimes.insert({
        runtimeId,
        runtimeKind: 'harness',
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        transport: 'sdk',
        harness: sdkHarness,
        provider: intent.harness.provider,
        status: 'busy',
        statusChangedAt: now,
        continuation: session.continuation,
        supportsInflightInput: getSdkInflightCapability(sdkHarness),
        adopted: false,
        activeRunId: runId,
        ...runtimeActivityPatch(this.db, runtimeId, {
          source: 'turn',
          occurredAt: now,
          updatedAt: now,
        }),
        createdAt: now,
      })

  if (!runtime) {
    throw new Error(`failed to update SDK runtime ${runtimeId}`)
  }

  const run = this.db.runs.insert({
    runId,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'sdk',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
  })

  if (!reusableRuntime) {
    const runtimeCreatedEvent = appendHrcEvent(this.db, 'runtime.created', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      payload: {
        harness: runtime.harness,
      },
    })
    this.notifyEvent(runtimeCreatedEvent)
  }

  const acceptedEvent = appendHrcEvent(this.db, 'turn.accepted', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    transport: 'sdk',
    payload: {
      promptLength: prompt.length,
    },
  })
  this.notifyEvent(acceptedEvent)

  const userPromptEvent = appendHrcEvent(this.db, 'turn.user_prompt', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    transport: 'sdk',
    payload: createUserPromptPayload(prompt),
  })
  this.notifyEvent(userPromptEvent)

  const startedAt = timestamp()
  this.db.runs.update(run.runId, {
    status: 'started',
    startedAt,
    updatedAt: startedAt,
  })
  this.db.runtimes.update(
    runtime.runtimeId,
    runtimeActivityPatch(this.db, runtime.runtimeId, {
      source: 'turn',
      occurredAt: startedAt,
      updatedAt: startedAt,
    })
  )

  const startedEvent = appendHrcEvent(this.db, 'turn.started', {
    ts: startedAt,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    transport: 'sdk',
  })
  this.notifyEvent(startedEvent)

  return { runtime, run, existingProvider, startedAt }
}

export async function handleSdkDispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: {
    waitForCompletion?: boolean | undefined
  } = {}
): Promise<Response> {
  this.failSdkHarnessPath('handleSdkDispatchTurn', session, intent, runId)

  const { runtime, run, existingProvider } = resolveSdkDispatchTarget.call(
    this,
    session,
    intent,
    prompt,
    runId
  )

  const execute = async (): Promise<Response> => {
    let chunkSeq = 1
    const result = await runSdkTurn({
      intent,
      hostSessionId: session.hostSessionId,
      runId,
      runtimeId: runtime.runtimeId,
      prompt,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      existingProvider,
      continuation: session.continuation,
      onHrcEvent: (event) => {
        const appended = this.db.events.append(event)
        this.notifyEvent(appended)
        const semanticEvent = deriveSemanticTurnEventFromSdkEvent(event.eventKind, event.eventJson)
        if (semanticEvent) {
          const appendedSemanticEvent = appendHrcEvent(this.db, semanticEvent.eventKind, {
            ts: event.ts,
            hostSessionId: event.hostSessionId,
            scopeRef: event.scopeRef,
            laneRef: event.laneRef,
            generation: event.generation,
            runId: event.runId,
            runtimeId: event.runtimeId,
            transport: 'sdk',
            payload: semanticEvent.payload,
          })
          this.notifyEvent(appendedSemanticEvent)
        }
        this.db.runtimes.update(
          runtime.runtimeId,
          runtimeActivityPatch(this.db, runtime.runtimeId, {
            source: 'agent-message',
            occurredAt: event.ts,
            updatedAt: timestamp(),
          })
        )
      },
      onBuffer: (text) => {
        this.db.runtimeBuffers.append({
          runtimeId: runtime.runtimeId,
          runId,
          chunkSeq,
          text,
          createdAt: timestamp(),
        })
        chunkSeq += 1
      },
    })

    const completedAt = timestamp()
    this.db.runs.markCompleted(run.runId, {
      status: result.result.success ? 'completed' : 'failed',
      completedAt,
      updatedAt: completedAt,
      ...(!result.result.success
        ? {
            errorCode:
              result.result.error?.code === 'provider_mismatch'
                ? HrcErrorCode.PROVIDER_MISMATCH
                : HrcErrorCode.RUNTIME_UNAVAILABLE,
            errorMessage: result.result.error?.message ?? 'sdk turn failed',
          }
        : {}),
    })

    this.db.runtimes.update(runtime.runtimeId, {
      status: 'ready',
      statusChangedAt: completedAt,
      ...runtimeActivityPatch(this.db, runtime.runtimeId, {
        source: 'turn',
        occurredAt: completedAt,
        updatedAt: completedAt,
      }),
      harnessSessionJson: result.harnessSessionJson,
      continuation: result.continuation,
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)

    if (result.continuation) {
      this.db.sessions.updateContinuation(session.hostSessionId, result.continuation, completedAt)
    }

    const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
      ts: completedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      errorCode: result.result.success
        ? undefined
        : result.result.error?.code === 'provider_mismatch'
          ? HrcErrorCode.PROVIDER_MISMATCH
          : HrcErrorCode.RUNTIME_UNAVAILABLE,
      payload: {
        success: result.result.success,
      },
    })
    this.notifyEvent(completedEvent)

    if (!result.result.success) {
      if (result.result.error?.code === 'provider_mismatch') {
        throw new HrcUnprocessableEntityError(
          HrcErrorCode.PROVIDER_MISMATCH,
          result.result.error.message,
          result.result.error.details ?? {}
        )
      }

      throw new HrcRuntimeUnavailableError(result.result.error?.message ?? 'sdk turn failed', {
        runtimeId: runtime.runtimeId,
        runId,
      })
    }

    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      status: 'completed',
      supportsInFlightInput: runtime.supportsInflightInput,
    } satisfies DispatchTurnResponseBase)
  }

  if (options.waitForCompletion === false) {
    void execute().catch((err: unknown) => {
      try {
        this.recordDetachedSemanticTurnFailure(session, runtime.runtimeId, runId, 'sdk', err)
      } catch (failureErr) {
        writeServerLog('WARN', 'sdk.detached_turn_failure_record_failed', {
          hostSessionId: session.hostSessionId,
          runtimeId: runtime.runtimeId,
          runId,
          error: failureErr instanceof Error ? failureErr.message : String(failureErr),
        })
      }
    })

    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      status: 'started',
      supportsInFlightInput: runtime.supportsInflightInput,
    } satisfies DispatchTurnResponseBase)
  }

  return await execute()
}

export function recordDetachedSemanticTurnFailure(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtimeId: string,
  runId: string,
  transport: 'sdk' | 'headless',
  err: unknown
): void {
  const errorMessage = err instanceof Error ? err.message : String(err)
  writeServerLog('WARN', `${transport}.detached_turn_failed`, {
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
    transport,
    errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
    payload: {
      success: false,
      transport,
    },
  })
  this.notifyEvent(completedEvent)
}
