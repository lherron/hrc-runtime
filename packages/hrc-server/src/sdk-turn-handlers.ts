import {
  HrcBadRequestError,
  HrcConflictError,
  HrcErrorCode,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
} from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcActiveRunContributionRequest,
  HrcActiveRunContributionResponse,
  HrcContinuationRef,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import { deliverSdkInflightInput, runSdkTurn } from './agent-spaces-adapter/index.js'
import { appendHrcEvent, deriveSemanticTurnEventFromSdkEvent } from './hrc-event-helper.js'
import {
  isPendingAskUserQuestionRun,
  isRunActive,
  requireRuntime,
  requireSession,
  requireTmuxPane,
} from './require-helpers.js'
import { findLatestRunForRuntime, findLatestSessionRuntime } from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import {
  type InFlightInputRequest,
  parseInFlightInputRequest,
  parseJsonBody,
} from './server-parsers.js'
import type { InFlightInputResponse } from './server-types.js'
import { json, timestamp } from './server-util.js'

export function failSdkHarnessPath(
  this: HrcServerInstanceForHandlers,
  caller: string,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  runId: string | undefined,
  runtimeId?: string | undefined
): never {
  const detail = {
    caller,
    harnessId: intent.harness.id ?? null,
    provider: intent.harness.provider,
    scopeRef: session.scopeRef,
    hostSessionId: session.hostSessionId,
    laneRef: session.laneRef,
    generation: session.generation,
    ...(runId !== undefined ? { runId } : {}),
    ...(runtimeId !== undefined ? { runtimeId } : {}),
  }

  writeServerLog('ERROR', 'sdk_harness.hard_fail', detail)

  throw new HrcRuntimeUnavailableError(
    `SDK harness path retired for broker cutover: ${caller} harness.id=${
      intent.harness.id ?? '<none>'
    } harness.provider=${intent.harness.provider} scopeRef=${session.scopeRef}`,
    detail
  )
}

export async function executeHeadlessSdkTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  continuation: HrcContinuationRef | undefined
): Promise<Response> {
  this.failSdkHarnessPath('executeHeadlessSdkTurn', session, intent, runId, runtime.runtimeId)

  const existingProvider =
    findLatestSessionRuntime(this.db, session.hostSessionId)?.provider ??
    session.continuation?.provider
  // runSdkTurn requires interactive=false; the outer headless path may have
  // normalized it to true for tmux provisioning, so override here.
  // Also default dryRun for start paths that bypass normalizeDispatchIntent.
  const sdkIntent = {
    ...intent,
    placement: {
      ...intent.placement,
      dryRun: intent.placement.dryRun ?? true,
    },
    harness: { ...intent.harness, interactive: false as const },
  }
  let chunkSeq = 1
  const result = await runSdkTurn({
    intent: sdkIntent,
    hostSessionId: session.hostSessionId,
    runId,
    runtimeId: runtime.runtimeId,
    prompt,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    existingProvider,
    continuation,
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
      this.db.runtimes.updateActivity(runtime.runtimeId, event.ts, event.ts)
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
  this.db.runs.markCompleted(runId, {
    status: result.result.success ? 'completed' : 'failed',
    completedAt,
    updatedAt: completedAt,
    ...(!result.result.success
      ? {
          errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
          errorMessage: result.result.error?.message ?? 'headless sdk turn failed',
        }
      : {}),
  })

  this.db.runtimes.update(runtime.runtimeId, {
    status: 'ready',
    lastActivityAt: completedAt,
    updatedAt: completedAt,
    harnessSessionJson: result.harnessSessionJson,
    // Only propagate continuation on success — a failed session's sdkSessionId
    // points to a non-existent conversation file. Passing undefined here is
    // intentional: it skips the DB update (handled below for failure case).
    continuation: result.result.success ? result.continuation : undefined,
  })
  this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)

  if (result.result.success && result.continuation) {
    this.db.sessions.updateContinuation(session.hostSessionId, result.continuation, completedAt)
  } else if (!result.result.success) {
    // Clear stale continuation on BOTH runtime and session — the next-turn
    // resolution at index.ts ~2063/3362/3762 reads
    // `runtime.continuation ?? session.continuation`, so clearing only the
    // runtime side leaves session.continuation_json as a fallback that
    // re-poisons subsequent turns with the dead sdkSessionId.
    this.db.runtimes.clearContinuation(runtime.runtimeId, completedAt)
    this.db.sessions.updateContinuation(session.hostSessionId, undefined, completedAt)
  }

  const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
    ts: completedAt,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    errorCode: result.result.success ? undefined : HrcErrorCode.RUNTIME_UNAVAILABLE,
    payload: {
      success: result.result.success,
      transport: 'headless',
    },
  })
  this.notifyEvent(completedEvent)

  if (!result.result.success) {
    throw new HrcRuntimeUnavailableError(
      result.result.error?.message ?? 'headless sdk turn failed',
      { runtimeId: runtime.runtimeId, runId }
    )
  }

  return json({
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'headless',
    status: 'completed',
    supportsInFlightInput: false,
  } satisfies DispatchTurnResponse)
}

export async function handleActiveRunContribution(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = (await parseJsonBody(request)) as HrcActiveRunContributionRequest
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof body.inputApplicationId !== 'string' ||
    body.inputApplicationId.trim().length === 0 ||
    typeof body.inputAttemptId !== 'string' ||
    body.inputAttemptId.trim().length === 0 ||
    typeof body.prompt !== 'string'
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'active-run contribution requires inputApplicationId, inputAttemptId, and prompt'
    )
  }

  const existing = this.db.activeInputDeliveries.getByInputApplicationId(body.inputApplicationId)
  if (existing?.response !== undefined) {
    return json(existing.response)
  }
  if (existing !== null) {
    return json({
      status:
        existing.status === 'ambiguous' || existing.status === 'failed'
          ? 'pending'
          : existing.status,
      inputApplicationId: existing.inputApplicationId,
      ...(existing.hostSessionId !== undefined ? { hostSessionId: existing.hostSessionId } : {}),
      ...(existing.generation !== undefined ? { generation: existing.generation } : {}),
      ...(existing.runtimeId !== undefined ? { runtimeId: existing.runtimeId } : {}),
      ...(existing.runId !== undefined ? { runId: existing.runId } : {}),
      ...(existing.errorCode !== undefined ? { errorCode: existing.errorCode } : {}),
      ...(existing.errorMessage !== undefined ? { errorMessage: existing.errorMessage } : {}),
    } satisfies HrcActiveRunContributionResponse)
  }

  const runtime =
    typeof body.selector?.runtimeId === 'string'
      ? this.db.runtimes.getByRuntimeId(body.selector.runtimeId)
      : this.db.runtimes
          .listAll()
          .filter(
            (candidate) =>
              (body.selector?.hostSessionId === undefined ||
                candidate.hostSessionId === body.selector.hostSessionId) &&
              (body.selector?.sessionRef === undefined ||
                (candidate.scopeRef === body.selector.sessionRef.scopeRef &&
                  candidate.laneRef === body.selector.sessionRef.laneRef))
          )
          .at(-1)

  this.db.activeInputDeliveries.createPending({
    request: body,
    now: timestamp(),
    ...(runtime?.hostSessionId !== undefined ? { hostSessionId: runtime.hostSessionId } : {}),
    ...(runtime?.generation !== undefined ? { generation: runtime.generation } : {}),
    ...(runtime?.runtimeId !== undefined ? { runtimeId: runtime.runtimeId } : {}),
    ...(runtime?.activeRunId !== undefined ? { runId: runtime.activeRunId } : {}),
  })

  let response: HrcActiveRunContributionResponse
  if (runtime === null || runtime === undefined) {
    response = {
      status: 'rejected',
      inputApplicationId: body.inputApplicationId,
      capability: { supported: false },
      errorCode: 'runtime_not_found',
      errorMessage: 'no runtime matched active-run contribution selector',
    }
  } else if (runtime.activeRunId === undefined) {
    response = {
      status: 'rejected',
      inputApplicationId: body.inputApplicationId,
      hostSessionId: runtime.hostSessionId,
      generation: runtime.generation,
      runtimeId: runtime.runtimeId,
      capability: { supported: false },
      errorCode: 'no_active_run',
      errorMessage: 'runtime has no active run',
    }
  } else if (body.expectedRunId !== undefined && body.expectedRunId !== runtime.activeRunId) {
    response = {
      status: 'rejected',
      inputApplicationId: body.inputApplicationId,
      hostSessionId: runtime.hostSessionId,
      generation: runtime.generation,
      runtimeId: runtime.runtimeId,
      runId: runtime.activeRunId,
      capability: { supported: false },
      errorCode: 'run_mismatch',
      errorMessage: 'expectedRunId does not match active run',
    }
  } else if (
    runtime.transport === 'tmux' &&
    isPendingAskUserQuestionRun(this.db.hrcEvents.listByRun(runtime.activeRunId))
  ) {
    const session = requireSession(this.db, runtime.hostSessionId)
    try {
      const delivered = await this.deliverTmuxQuestionAnswer(session, runtime, {
        runtimeId: runtime.runtimeId,
        runId: runtime.activeRunId,
        inputApplicationId: body.inputApplicationId,
        ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
        prompt: body.prompt,
        ...(body.inputType !== undefined ? { inputType: body.inputType } : {}),
        ...(body.semantics !== undefined ? { semantics: body.semantics } : {}),
      })
      response = {
        status: delivered.accepted ? 'accepted' : 'rejected',
        inputApplicationId: body.inputApplicationId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        runId: runtime.activeRunId,
        capability: {
          supported: true,
          deliverySemantics: 'same_turn_append',
          ackSemantics: 'accepted_only',
          ordering: 'fifo',
          supportsAttachments: false,
        },
        ...(delivered.accepted
          ? {}
          : {
              errorCode: 'provider_rejected',
              errorMessage: 'provider rejected active-run contribution',
            }),
      }
    } catch (error) {
      this.db.activeInputDeliveries.markAmbiguous(
        body.inputApplicationId,
        'delivery_ambiguous',
        error instanceof Error ? error.message : String(error),
        timestamp()
      )
      return json({
        status: 'pending',
        inputApplicationId: body.inputApplicationId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        runId: runtime.activeRunId,
        capability: {
          supported: true,
          deliverySemantics: 'same_turn_append',
          ackSemantics: 'accepted_only',
          ordering: 'fifo',
          supportsAttachments: false,
        },
        errorCode: 'delivery_ambiguous',
        errorMessage: error instanceof Error ? error.message : String(error),
      } satisfies HrcActiveRunContributionResponse)
    }
  } else if (
    process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] === '1' &&
    runtime.transport === 'sdk' &&
    runtime.supportsInflightInput
  ) {
    const session = requireSession(this.db, runtime.hostSessionId)
    try {
      const delivered = await this.deliverInFlightInputToRuntime(session, runtime, {
        runtimeId: runtime.runtimeId,
        runId: runtime.activeRunId,
        inputApplicationId: body.inputApplicationId,
        ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
        prompt: body.prompt,
        ...(body.inputType !== undefined ? { inputType: body.inputType } : {}),
        ...(body.semantics !== undefined ? { semantics: body.semantics } : {}),
      })
      response = {
        status: delivered.accepted ? 'accepted' : 'rejected',
        inputApplicationId: body.inputApplicationId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        runId: runtime.activeRunId,
        capability: {
          supported: true,
          deliverySemantics:
            body.semantics === 'interrupt_and_continue'
              ? 'interrupting_steer'
              : 'sequential_followup',
          ackSemantics: 'accepted_only',
          ordering: 'fifo',
          supportsAttachments: false,
          ...(body.semantics === 'interrupt_and_continue' ? { canInterruptTools: true } : {}),
        },
        ...(delivered.pendingTurns !== undefined ? { pendingTurns: delivered.pendingTurns } : {}),
        ...(delivered.accepted
          ? {}
          : {
              errorCode: 'provider_rejected',
              errorMessage: 'provider rejected active-run contribution',
            }),
      }
    } catch (error) {
      this.db.activeInputDeliveries.markAmbiguous(
        body.inputApplicationId,
        'delivery_ambiguous',
        error instanceof Error ? error.message : String(error),
        timestamp()
      )
      return json({
        status: 'pending',
        inputApplicationId: body.inputApplicationId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        runId: runtime.activeRunId,
        capability: {
          supported: true,
          deliverySemantics: 'sequential_followup',
          ackSemantics: 'accepted_only',
          ordering: 'fifo',
          supportsAttachments: false,
        },
        errorCode: 'delivery_ambiguous',
        errorMessage: error instanceof Error ? error.message : String(error),
      } satisfies HrcActiveRunContributionResponse)
    }
  } else {
    const contributionsEnabledEnv = process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] === '1'
    response = {
      status: 'queue_recommended',
      inputApplicationId: body.inputApplicationId,
      hostSessionId: runtime.hostSessionId,
      generation: runtime.generation,
      runtimeId: runtime.runtimeId,
      runId: runtime.activeRunId,
      capability: {
        supported: false,
        reason: !contributionsEnabledEnv ? 'feature_disabled' : 'inflight_unsupported',
      },
    }
  }

  if (response.status === 'accepted' || response.status === 'duplicate') {
    this.db.activeInputDeliveries.markAccepted(body.inputApplicationId, response, timestamp())
  } else {
    this.db.activeInputDeliveries.markRejected(body.inputApplicationId, response, timestamp())
  }
  return json(response)
}

export function handleGetActiveRunContribution(
  this: HrcServerInstanceForHandlers,
  inputApplicationId: string
): Response {
  const existing = this.db.activeInputDeliveries.getByInputApplicationId(inputApplicationId)
  if (existing === null) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_RUNTIME, 'active-run contribution not found', {
      inputApplicationId,
    })
  }
  return json(
    existing.response ?? {
      status:
        existing.status === 'ambiguous' || existing.status === 'failed'
          ? 'pending'
          : existing.status,
      inputApplicationId: existing.inputApplicationId,
      ...(existing.hostSessionId !== undefined ? { hostSessionId: existing.hostSessionId } : {}),
      ...(existing.generation !== undefined ? { generation: existing.generation } : {}),
      ...(existing.runtimeId !== undefined ? { runtimeId: existing.runtimeId } : {}),
      ...(existing.runId !== undefined ? { runId: existing.runId } : {}),
      ...(existing.errorCode !== undefined ? { errorCode: existing.errorCode } : {}),
      ...(existing.errorMessage !== undefined ? { errorMessage: existing.errorMessage } : {}),
    }
  )
}

export async function handleInFlightInput(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseInFlightInputRequest(await parseJsonBody(request))
  const runtime = requireRuntime(this.db, body.runtimeId)
  const session = requireSession(this.db, runtime.hostSessionId)
  return json(await this.deliverInFlightInputToRuntime(session, runtime, body))
}

export async function deliverInFlightInputToRuntime(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  body: InFlightInputRequest
): Promise<InFlightInputResponse> {
  if (runtime.transport !== 'sdk' || runtime.supportsInflightInput !== true) {
    throw this.appendInflightRejected(
      session,
      runtime.runtimeId,
      body.runId,
      'semantic in-flight input is unsupported for this runtime',
      body.prompt,
      body.inputType,
      new HrcUnprocessableEntityError(
        HrcErrorCode.INFLIGHT_UNSUPPORTED,
        'semantic in-flight input is unsupported for this runtime',
        {
          runtimeId: runtime.runtimeId,
          transport: runtime.transport,
          supportsInflightInput: runtime.supportsInflightInput,
        }
      )
    )
  }

  const activeRun =
    runtime.activeRunId !== undefined ? this.db.runs.getByRunId(runtime.activeRunId) : null
  const latestRun = findLatestRunForRuntime(this.db, runtime.runtimeId)
  const expectedRunId = activeRun?.runId ?? latestRun?.runId

  if (!expectedRunId || expectedRunId !== body.runId) {
    throw this.appendInflightRejected(
      session,
      runtime.runtimeId,
      body.runId,
      'run mismatch for semantic in-flight input',
      body.prompt,
      body.inputType,
      new HrcConflictError(HrcErrorCode.RUN_MISMATCH, 'run mismatch for semantic in-flight input', {
        runtimeId: runtime.runtimeId,
        expectedRunId,
        actualRunId: body.runId,
      })
    )
  }

  const delivered =
    activeRun && isRunActive(activeRun)
      ? await deliverSdkInflightInput({
          hostSessionId: runtime.hostSessionId,
          runId: body.runId,
          runtimeId: runtime.runtimeId,
          ...(body.inputApplicationId !== undefined
            ? { inputApplicationId: body.inputApplicationId }
            : {}),
          ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
          prompt: body.prompt,
          ...(body.semantics !== undefined ? { semantics: body.semantics } : {}),
          scopeRef: runtime.scopeRef,
          laneRef: runtime.laneRef,
          generation: runtime.generation,
          ...(this.options.sdkInflightInputClient !== undefined
            ? { client: this.options.sdkInflightInputClient }
            : {}),
          ...(this.options.sdkInflightInputRetryDelayMs !== undefined
            ? { retryDelayMs: this.options.sdkInflightInputRetryDelayMs }
            : {}),
          ...(this.options.sdkInflightInputMissingActiveRunRetryMs !== undefined
            ? {
                missingActiveRunRetryMs: this.options.sdkInflightInputMissingActiveRunRetryMs,
              }
            : {}),
          onHrcEvent: (event) => {
            const appended = this.db.events.append(event)
            this.notifyEvent(appended)
            this.db.runtimes.updateActivity(runtime.runtimeId, event.ts, event.ts)
          },
        })
      : { accepted: true, pendingTurns: 0 }

  const now = timestamp()
  this.db.runtimes.updateActivity(runtime.runtimeId, now, now)

  const acceptedEvent = appendHrcEvent(this.db, 'inflight.accepted', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId: body.runId,
    runtimeId: runtime.runtimeId,
    transport: 'sdk',
    payload: {
      prompt: body.prompt,
      ...(body.semantics ? { semantics: body.semantics } : {}),
      ...(body.inputType ? { inputType: body.inputType } : {}),
      ...(delivered.pendingTurns !== undefined ? { pendingTurns: delivered.pendingTurns } : {}),
    },
  })
  this.notifyEvent(acceptedEvent)

  return {
    accepted: delivered.accepted,
    runtimeId: runtime.runtimeId,
    runId: body.runId,
    ...(delivered.pendingTurns !== undefined ? { pendingTurns: delivered.pendingTurns } : {}),
  } satisfies InFlightInputResponse
}

export async function deliverTmuxQuestionAnswer(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  body: InFlightInputRequest
): Promise<InFlightInputResponse> {
  const activeRun =
    runtime.activeRunId !== undefined ? this.db.runs.getByRunId(runtime.activeRunId) : null
  if (!activeRun || !isRunActive(activeRun) || activeRun.runId !== body.runId) {
    throw this.appendInflightRejected(
      session,
      runtime.runtimeId,
      body.runId,
      'run mismatch for interactive answer',
      body.prompt,
      body.inputType,
      new HrcConflictError(HrcErrorCode.RUN_MISMATCH, 'run mismatch for interactive answer', {
        runtimeId: runtime.runtimeId,
        expectedRunId: activeRun?.runId,
        actualRunId: body.runId,
      })
    )
  }

  if (!isPendingAskUserQuestionRun(this.db.hrcEvents.listByRun(body.runId))) {
    throw this.appendInflightRejected(
      session,
      runtime.runtimeId,
      body.runId,
      'no pending AskUserQuestion is awaiting an answer',
      body.prompt,
      body.inputType,
      new HrcConflictError(
        HrcErrorCode.RUN_MISMATCH,
        'no pending AskUserQuestion is awaiting an answer',
        {
          runtimeId: runtime.runtimeId,
          runId: body.runId,
        }
      )
    )
  }

  const pane = requireTmuxPane(runtime)
  const tmux = this.tmuxForPane(pane)
  await tmux.sendKeys(pane.paneId, body.prompt)

  const now = timestamp()
  this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
  const acceptedEvent = appendHrcEvent(this.db, 'inflight.accepted', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId: body.runId,
    runtimeId: runtime.runtimeId,
    transport: 'tmux',
    payload: {
      prompt: body.prompt,
      delivery: 'tmux-interactive-answer',
      ...(body.semantics ? { semantics: body.semantics } : {}),
      ...(body.inputType ? { inputType: body.inputType } : {}),
    },
  })
  this.notifyEvent(acceptedEvent)

  return {
    accepted: true,
    runtimeId: runtime.runtimeId,
    runId: body.runId,
  } satisfies InFlightInputResponse
}

export const sdkTurnHandlersMethods = {
  failSdkHarnessPath,
  executeHeadlessSdkTurn,
  handleActiveRunContribution,
  handleGetActiveRunContribution,
  handleInFlightInput,
  deliverInFlightInputToRuntime,
  deliverTmuxQuestionAnswer,
}

export type SdkTurnHandlersMethods = typeof sdkTurnHandlersMethods
