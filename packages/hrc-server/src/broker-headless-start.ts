import { HrcErrorCode, HrcRuntimeUnavailableError, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  HrcExecutionFormat,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import { prepareActuatorSplitIntent } from './actuator-split.js'
import {
  assertPreparedAspdAttemptFormat,
  findPreparedAspdAttemptForFormatRetry,
  launchAspdPreparedAttempt,
  prepareAspdHeadlessAttempt,
  readAspdPreparation,
} from './aspd-headless-start.js'
import type { createBirthTimeline } from './birth-timeline.js'
import type { DispatchTurnResponseBase, JsonRepairRunCorrelation } from './broker-headless-types.js'
import { isClosedDbError } from './broker/controller/internal.js'
import { submissionOrigin } from './broker/submission-doors.js'
import { compilerPrimingSubmissionId } from './compiler-priming.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { waitForLaunchCarriedSubmissionIdentity } from './launch-carried-submission.js'
import { recordStartBirth, startBirthOfIntent } from './presentation-operator.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import {
  type AttachBeforeInvocationStartOption,
  type DispatchRunPersistenceOptions,
  dispatchOriginRunFields,
  dispatchRunPersistence,
  isLaunchCarriedInvokeCorrelationJson,
} from './server-types.js'
import { json, timestamp } from './server-util.js'

/**
 * T-08542 — the aspd-prepared headless codex start. A same-host-session,
 * same-idempotency-key retry whose frozen run identity this dispatch reused
 * launches the never-submitted preparation; anything else prepares anew. Both
 * paths launch only from the persisted operation.
 */
export async function startAspdHeadlessBrokerRuntime(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  requestedTurnIntent: HrcRuntimeIntent,
  runId: string | undefined,
  endpoint: string,
  options: DispatchRunPersistenceOptions & {
    executionFormat?: HrcExecutionFormat | undefined
    allowCompilerInitialInputWithoutIdentity?: boolean | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
    onAccepted?: ((runtime: HrcRuntimeSnapshot) => Promise<void> | void) | undefined
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
  },
  birthTimeline: ReturnType<typeof createBirthTimeline>
): Promise<HrcRuntimeSnapshot> {
  const executionFormat = options.executionFormat ?? 'format1'
  const resumable =
    options.dispatchIdempotencyKey !== undefined
      ? findPreparedAspdAttemptForFormatRetry(
          server,
          session.hostSessionId,
          options.dispatchIdempotencyKey
        )
      : undefined
  let operationId: string
  if (resumable !== undefined) {
    assertPreparedAspdAttemptFormat(resumable, executionFormat, session.hostSessionId)
  }
  if (resumable !== undefined && resumable.runId === runId) {
    // A keyed v2 retry launches only its persisted attempt. It does not
    // re-resolve selection, driver, or presentation from the retry intent.
    operationId = resumable.operationId
    writeServerLog('INFO', 'aspd.preparation.resume', {
      operationId,
      runId,
      hostSessionId: session.hostSessionId,
      dispatchIdempotencyKey: options.dispatchIdempotencyKey,
    })
  } else {
    const preparedActuatorSplit = await prepareActuatorSplitIntent(requestedTurnIntent)
    operationId = await prepareAspdHeadlessAttempt(server, {
      session,
      intent: preparedActuatorSplit.intent,
      preparedAuthority: preparedActuatorSplit.authority,
      runId,
      executionFormat,
      endpoint,
      allowCompilerInitialInputWithoutIdentity: options.allowCompilerInitialInputWithoutIdentity,
      ...(options.coldBirthPromptMode !== undefined
        ? {
            launchCarriedPrompt: {
              prompt: requestedTurnIntent.initialPrompt ?? '',
              mode: options.coldBirthPromptMode,
            },
          }
        : {}),
      responseFormat: options.responseFormat,
      dispatchIdempotencyKey: options.dispatchIdempotencyKey,
      format2RequestHash: options.format2RequestHash,
      birthTimeline,
      observation: options.attachBeforeInvocationStart?.observation,
    })
  }
  birthTimeline.mark('aspd-preparation-frozen', { operationId })
  const { runtime, intent } = await launchAspdPreparedAttempt(server, operationId, {
    ...dispatchRunPersistence(options),
    ...(options.onAccepted ? { onAccepted: options.onAccepted } : {}),
    ...(options.attachBeforeInvocationStart !== undefined
      ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
      : {}),
    birthTimeline,
    settleFailure: (error) => {
      const { record } = readAspdPreparation(server, operationId)
      if (record.runId === undefined) {
        // Format 2 has no accepted run to complete synthetically. Its durable
        // input protection stays with the ingress/mapper until exact evidence.
        throw new HrcRuntimeUnavailableError(error.message, {
          ...error.detail,
          code: error.code,
          hostSessionId: session.hostSessionId,
          runtimeId: record.runtimeId,
          invocationId: String(record.admission.identity.invocationId),
          operationId,
          route: 'broker',
        })
      }
      return settleFailedHeadlessBrokerStart(server, {
        session,
        runId: record.runId,
        runtimeId: record.runtimeId,
        invocationId: String(record.admission.identity.invocationId),
        operationId,
        error,
        responseFormat: options.responseFormat,
      })
    },
  })
  // Same authority rule as the facade route: commit the applied intent only
  // after the controller launched exactly this frozen intent.
  server.db.sessions.updateIntent(session.hostSessionId, intent, timestamp())
  return runtime
}

/**
 * Project a controller start failure onto the accepted run graph (when the start
 * graph exists) and throw the caller-facing error. Shared by the facade-compiled
 * and the aspd-prepared (T-08542) headless routes.
 */
export function settleFailedHeadlessBrokerStart(
  server: HrcServerInstanceForHandlers,
  input: {
    session: HrcSessionRecord
    runId: string
    runtimeId: string
    invocationId: string
    operationId: string
    error: { code: string; message: string; detail: Record<string, unknown> }
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): never {
  const { session, runId, runtimeId } = input
  const result = { error: input.error }
  const options = { responseFormat: input.responseFormat }
  const acceptedRun = server.db.runs.getByRunId(runId)
  if (acceptedRun !== null) {
    const failedAt = timestamp()
    server.db.runs.markCompleted(runId, {
      status: 'failed',
      completedAt: failedAt,
      updatedAt: failedAt,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: result.error.message,
    })
    server.db.brokerInvocations.update(input.invocationId, {
      invocationState: 'failed',
      updatedAt: failedAt,
    })
    server.db.runtimeOperations.update(input.operationId, {
      status: 'failed',
      completedAt: failedAt,
      updatedAt: failedAt,
      errorCode: result.error.code,
      errorMessage: result.error.message,
    })
    server.db.runtimes.update(runtimeId, {
      status: 'failed',
      statusChangedAt: failedAt,
      activeRunId: runId,
      updatedAt: failedAt,
      runtimeStateJson: {
        ...(server.db.runtimes.getByRuntimeId(runtimeId)?.runtimeStateJson ?? {}),
        status: 'failed',
        updatedAt: failedAt,
        startFailure: {
          code: result.error.code,
          message: result.error.message,
        },
      },
    })
    const failedEvent = appendHrcEvent(server.db, 'turn.failed', {
      ts: failedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId,
      transport: 'headless',
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      payload: {
        code: result.error.code,
        message: result.error.message,
        phase: 'broker-invocation-start',
      },
    })
    server.notifyEvent(failedEvent)
  }
  if (
    result.error.code === 'unsupported_capability' &&
    options.responseFormat?.kind === 'json_schema'
  ) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.UNSUPPORTED_CAPABILITY,
      result.error.message,
      result.error.detail
    )
  }
  const externalToolchainFailure = typeof result.error.detail['toolchainSource'] === 'string'
  throw new HrcRuntimeUnavailableError(
    externalToolchainFailure ? result.error.message : 'headless broker start failed',
    {
      hostSessionId: session.hostSessionId,
      runId,
      code: result.error.code,
      message: result.error.message,
      route: 'broker',
      ...result.error.detail,
    }
  )
}

/**
 * T-09643: the submission identity a door reports for a v2 cold birth.
 *
 * A launch that carries its first turn as broker `initialInput` (codex-app-server)
 * is admitted under that input's id, known at the durable start graph. An
 * argv-carried launch (claude-code-tmux, muse-cli-tmux) has no initialInput;
 * the start graph marks its run launch-carried and the broker names the turn
 * only once observed. The door waits (bounded) for that identity -- the body is
 * already on the launch, so answering without one reports a delivered write as
 * unavailable. Anything else keeps no identity and the door refuses as before.
 */
async function coldBirthDoorSubmissionId(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  runId: string
): Promise<string | undefined> {
  const compiled = compilerPrimingSubmissionId(server.db, runtime)
  if (compiled !== undefined) return compiled
  if (!isLaunchCarriedInvokeCorrelationJson(server.db.runs.getCorrelationJson(runId))) {
    return undefined
  }
  return await waitForLaunchCarriedSubmissionIdentity(server, runId, runtime.runtimeId)
}

export async function executeHeadlessBrokerStartTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: DispatchRunPersistenceOptions & {
    waitForCompletion?: boolean | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
    coldBirthPromptMode?: 'replace-priming' | 'append-to-priming' | undefined
  },
  runtimeStartOwnership?:
    | {
        operation: Promise<HrcRuntimeSnapshot>
        resolve(runtime: HrcRuntimeSnapshot): void
        reject(error: unknown): void
      }
    | undefined
): Promise<Response> {
  // Publish the runtime-producing promise before yielding so crossing dispatches
  // join this boot through handleHeadlessBrokerDispatchTurn's deferral branch.
  // A cold-durable recovery may already own the map across its awaited
  // reattach/cleanup work. In that case keep its promise as the stable join
  // point and settle it from the fresh boot instead of replacing it here.
  const { initialPrompt: _initialPrompt, ...promptlessIntent } = intent
  let resolveAccepted!: (runtime: HrcRuntimeSnapshot) => void
  let rejectAccepted!: (error: unknown) => void
  let acceptedSettled = false
  const accepted = new Promise<HrcRuntimeSnapshot>((resolve, reject) => {
    resolveAccepted = (runtime) => {
      acceptedSettled = true
      resolve(runtime)
    }
    rejectAccepted = reject
  })
  // A blocking caller awaits `bootOperation`, never `accepted`, so a boot that
  // fails before acceptance would otherwise leave this rejection unobserved and
  // fail-fast the whole daemon (T-08542). The detached caller still awaits it.
  accepted.catch(() => undefined)
  const bootOperation = this.startHeadlessBrokerRuntime(session, promptlessIntent, prompt, runId, {
    // T-07963 (Lance's ruling): the cold boot's FIRST turn IS the delivery of the
    // message that initiated it. The caller prompt rides the compile as
    // `initialPrompt`, so the compiler emits ONE initial input holding priming +
    // caller text (`combineBrokerPrompts`) and allocates `initialInputId` + this
    // run's identity for it. There is no second submission to owe, and therefore
    // no window in which a restart can lose one.
    //
    // The flag stays ONLY for the promptless shape, which still takes the
    // compiler-owned priming input with no HRC run/input identity to bind it to.
    // With a prompt, `identity.initialInputId` exists and the v2 compile
    // admission requires the execution dispatch request to echo it exactly.
    ...(prompt.length === 0 ? { allowCompilerInitialInputWithoutIdentity: true } : {}),
    ...(options.coldBirthPromptMode !== undefined
      ? { coldBirthPromptMode: options.coldBirthPromptMode }
      : {}),
    responseFormat: options.responseFormat,
    ...dispatchRunPersistence(options),
    onAccepted: (runtime) => {
      const acceptedAt = timestamp()
      const acceptedRun = this.db.runs.getByRunId(runId)
      const submissionId = compilerPrimingSubmissionId(this.db, runtime)
      if (acceptedRun === null) {
        this.db.runs.insert({
          runId,
          hostSessionId: session.hostSessionId,
          runtimeId: runtime.runtimeId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          transport: 'headless',
          status: 'accepted',
          acceptedAt,
          updatedAt: acceptedAt,
          invocationId: runtime.activeInvocationId,
          operationId: runtime.activeOperationId,
          ...(submissionId !== undefined
            ? { brokerSubmissionId: submissionId, dispatchedInputId: submissionId }
            : {}),
          dispatchIdempotencyKey: options.dispatchIdempotencyKey,
          ...dispatchOriginRunFields(options),
        })
      } else if (acceptedRun.status === 'accepted') {
        this.db.runs.update(runId, {
          runtimeId: runtime.runtimeId,
          invocationId: runtime.activeInvocationId,
          operationId: runtime.activeOperationId,
          ...(submissionId !== undefined
            ? { brokerSubmissionId: submissionId, dispatchedInputId: submissionId }
            : {}),
          updatedAt: acceptedAt,
        })
      }
      if (submissionId !== undefined && options.submissionDoor !== undefined) {
        // A cold launch carries the caller's input as the compiler start
        // request's initial input. Persist the same submission identity and
        // origin as an ordinary broker-door submission so external injectors
        // can observe and reconcile its admission.
        this.db.submissionAdmissions.upsertAdmission({
          submissionId,
          runId,
          runtimeId: runtime.runtimeId,
          invocationId: runtime.activeInvocationId,
          door: options.submissionDoor,
          envelopeId: submissionOrigin(session.scopeRef, options).envelopeId,
          admittedAt: acceptedAt,
        })
      }
      // T-07963: nothing is owed any more. T-07944 persisted the caller prompt
      // here so a restart could re-arm the second submission; the prompt now
      // rides the boot's own first input, so there is no deferred submission to
      // make durable and writing one would advertise an obligation that does not
      // exist. `recoverColdBootInputContinuations` is retained for the old-shape
      // runs still in flight across the upgrade restart, and its candidate set
      // drains to empty because this write is the only thing that ever fed it.
      if (this.db.hrcEvents.listByRun(runId, { eventKind: 'turn.accepted' }).length === 0) {
        const acceptedEvent = appendHrcEvent(this.db, 'turn.accepted', {
          ts: acceptedAt,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          runId,
          runtimeId: runtime.runtimeId,
          transport: 'headless',
          payload: {
            promptLength: prompt.length,
            authority: 'durable-start-graph',
          },
        })
        this.notifyEvent(acceptedEvent)
      }
      resolveAccepted(runtime)
    },
  })
    .then((runtime) => {
      // Detached acceptance must not wait for presentation, but completion of
      // the background boot still owns the best-effort presentation publish.
      // The attachability gate that used to stand here is redundant:
      // publishPresentation computes `operatorAttachable` itself and records it
      // either way, and the in-daemon spawn it fronts re-checks the predicate.
      void this.publishPresentation(runtime, {
        signal: this.runtimeStartPresentationSignal,
        birthTimeline: options.birthTimeline,
      })
      if (!acceptedSettled) resolveAccepted(runtime)
      return runtime
    })
    .finally(() => {
      const publishedOperation = runtimeStartOwnership?.operation ?? bootOperation
      if (this.runtimeStartOperations.get(session.hostSessionId) === publishedOperation) {
        this.runtimeStartOperations.delete(session.hostSessionId)
      }
    })
  if (runtimeStartOwnership) {
    void bootOperation.then(runtimeStartOwnership.resolve, runtimeStartOwnership.reject)
  } else {
    recordStartBirth(bootOperation, startBirthOfIntent('headless', intent))
    this.runtimeStartOperations.set(session.hostSessionId, bootOperation)
  }
  void bootOperation.catch((error) => {
    if (!acceptedSettled) rejectAccepted(error)
  })
  if (options.waitForCompletion === false) {
    // T-07963: the wait-priming -> guarded-invoke continuation that used to live
    // here is RETIRED. The prompt is already in the boot's own first input, so
    // there is nothing detached to own and nothing for a daemon stop to abort.
    // That chain is what made a restart inside the priming window strand the
    // sender's obligation: it failed the run, the drive attempt never reached
    // `started`, and nothing ever armed a reminder for what it carried.
    const runtime = await accepted
    const submissionId =
      options.submissionDoor === undefined
        ? undefined
        : await coldBirthDoorSubmissionId(this, runtime, runId)
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
      ...(submissionId !== undefined ? { submissionId, admission: 'admitted' as const } : {}),
    } satisfies DispatchTurnResponseBase)
  }
  const runtime = await bootOperation
  const compiledSubmissionId =
    options.submissionDoor === undefined ? undefined : compilerPrimingSubmissionId(this.db, runtime)
  // A blocking caller waits for the FIRST turn now, because the first turn is the
  // delivery. There is no second submission whose completion it could await.
  await this.waitForHeadlessBrokerRunCompletion(runId, runtime.runtimeId)
  // An argv-carried launch turn is named by the broker once observed, which a
  // completed first turn has been (T-09643).
  const submissionId =
    options.submissionDoor === undefined
      ? undefined
      : (compiledSubmissionId ?? this.db.runs.getByRunId(runId)?.brokerSubmissionId)
  return json({
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'headless',
    status: 'completed',
    supportsInFlightInput: false,
    ...(submissionId !== undefined ? { submissionId, admission: 'admitted' as const } : {}),
  } satisfies DispatchTurnResponseBase)
}

/**
 * Dispose the failure of the detached wait-priming -> submit continuation.
 *
 * Two outcomes, and the distinction is load-bearing (a live e2e on hrcdev is
 * what surfaced it):
 *
 *  - `deferred_to_restart` — this daemon is stopping. `stop()` aborts the
 *    presentation signal, which rejects the priming wait. That is not a lost
 *    continuation; it is the continuation moving to the NEXT process, where
 *    `recoverColdBootInputContinuations` re-arms it from the durable prompt.
 *    Recovery only ever looks at runs still `accepted`, so failing the run here
 *    would bury exactly the case recovery exists for.
 *  - `failed` — anything else. The swallow this replaced left an accepted run
 *    with no continuation and no record of why, and the sweep buried it as a
 *    zombie 30 minutes later.
 */
export function disposeColdBootInputContinuationFailure(
  server: HrcServerInstanceForHandlers,
  runId: string,
  error: unknown
): 'deferred_to_restart' | 'failed' | 'noop' {
  if (server.runtimeStartPresentationSignal.aborted) {
    writeServerLog('INFO', 'broker.cold_boot_input.continuation_deferred_to_restart', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'deferred_to_restart'
  }
  return failColdBootInputContinuation(server, runId, {
    errorCode: HrcErrorCode.COLD_INPUT_CONTINUATION_FAILED,
    phase: 'cold-boot-input-continuation',
    error,
  })
    ? 'failed'
    : 'noop'
}

/**
 * Terminalize a cold-birth accepted run whose owed prompt can no longer be
 * submitted (T-07944).
 *
 * The reason code is POSITIVE — it names what was lost — so the mail drive that
 * is waiting on this run fails truthfully and at once, instead of the sender
 * being told 30 minutes later that the turn "had no events" while the agent had
 * in fact already run.
 *
 * Idempotent by construction: a run that already reached a terminal status, or
 * that got its prompt dispatched after all, is left exactly as it is.
 */
export function failColdBootInputContinuation(
  server: HrcServerInstanceForHandlers,
  runId: string,
  input: {
    errorCode:
      | typeof HrcErrorCode.COLD_INPUT_CONTINUATION_LOST
      | typeof HrcErrorCode.COLD_INPUT_CONTINUATION_FAILED
    phase: string
    error?: unknown
    detail?: Record<string, unknown> | undefined
  }
): boolean {
  try {
    return writeColdBootInputContinuationFailure(server, runId, input)
  } catch (writeError) {
    // The detached continuation can outlive the store: a daemon stop aborts the
    // priming wait, and `stop()` closes the DB without draining this chain. A
    // closed store is not a failure to record — the run stays `accepted`, and
    // the NEXT startup's recovery pass is what disposes it.
    if (isClosedDbError(writeError)) return false
    throw writeError
  }
}

function writeColdBootInputContinuationFailure(
  server: HrcServerInstanceForHandlers,
  runId: string,
  input: {
    errorCode:
      | typeof HrcErrorCode.COLD_INPUT_CONTINUATION_LOST
      | typeof HrcErrorCode.COLD_INPUT_CONTINUATION_FAILED
    phase: string
    error?: unknown
    detail?: Record<string, unknown> | undefined
  }
): boolean {
  const run = server.db.runs.getByRunId(runId)
  if (run === null || run.status !== 'accepted' || run.dispatchedInputId !== undefined) {
    return false
  }
  const message =
    input.error === undefined
      ? 'cold-birth accepted run lost the continuation that owed its prompt'
      : input.error instanceof Error
        ? input.error.message
        : String(input.error)
  const failedAt = timestamp()
  server.db.runs.markCompleted(runId, {
    status: 'failed',
    completedAt: failedAt,
    updatedAt: failedAt,
    errorCode: input.errorCode,
    errorMessage: message,
  })
  writeServerLog('ERROR', 'broker.cold_boot_input.continuation_failed', {
    runId,
    runtimeId: run.runtimeId,
    hostSessionId: run.hostSessionId,
    scopeRef: run.scopeRef,
    errorCode: input.errorCode,
    phase: input.phase,
    error: message,
    ...(input.detail ?? {}),
  })
  const failedEvent = appendHrcEvent(server.db, 'turn.failed', {
    ts: failedAt,
    hostSessionId: run.hostSessionId,
    scopeRef: run.scopeRef,
    laneRef: run.laneRef,
    generation: run.generation,
    runId,
    ...(run.runtimeId !== undefined ? { runtimeId: run.runtimeId } : {}),
    transport: 'headless',
    errorCode: input.errorCode,
    payload: {
      code: input.errorCode,
      message,
      phase: input.phase,
      ...(input.detail ?? {}),
    },
  })
  server.notifyEvent(failedEvent)
  return true
}
