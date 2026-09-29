import { HrcErrorCode, HrcRuntimeUnavailableError, HrcUnprocessableEntityError } from 'hrc-core'
import type { HrcRuntimeSnapshot, HrcSessionRecord, HrcTurnResponseFormat } from 'hrc-core'
import type { DispatchTurnResponseBase, JsonRepairRunCorrelation } from './broker-headless-types.js'
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { submissionOrigin, submitThroughBrokerDoor } from './broker/submission-doors.js'
import { armFirstTurnWatch } from './first-turn-watch.js'
import { appendHrcEvent, createUserPromptPayload } from './hrc-event-helper.js'
import {
  classifyBrokerInputFailure,
  isTerminalBrokerInputFailure,
  isTerminalBrokerInvocationState,
  isTransientBrokerInputStateFailure,
  isTransitionalBrokerInvocationState,
} from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { type DispatchRunPersistenceOptions, dispatchOriginRunFields } from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { reattachDurableBrokerForDispatch } from './startup-reconcile.js'
import {
  assertRuntimeSupportsResponseFormat,
  toBrokerResponseFormat,
} from './turn-response-format.js'

export async function executeHeadlessBrokerInputTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: DispatchRunPersistenceOptions & {
    waitForCompletion?: boolean | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): Promise<Response> {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.BROKER_DESCRIPTOR_ABSENT,
      'headless broker runtime has no active invocation descriptor',
      {
        runtimeId: runtime.runtimeId,
        runId,
        route: 'broker',
      }
    )
  }
  assertRuntimeSupportsResponseFormat({
    db: this.db,
    runtime,
    responseFormat: options.responseFormat,
    route: 'broker',
  })

  const preacceptedRun = this.db.runs.getByRunId(runId)
  const now = timestamp()
  if (preacceptedRun) {
    if (preacceptedRun.status !== 'accepted') {
      throw new HrcRuntimeUnavailableError('preaccepted broker input is not dispatchable', {
        runtimeId: runtime.runtimeId,
        runId,
        status: preacceptedRun.status,
        route: 'broker',
      })
    }
    this.db.runs.update(runId, {
      runtimeId: runtime.runtimeId,
      invocationId,
      operationId: runtime.activeOperationId,
      updatedAt: now,
    })
  } else {
    this.db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
      invocationId,
      operationId: runtime.activeOperationId,
      dispatchIdempotencyKey: options.dispatchIdempotencyKey,
      ...dispatchOriginRunFields(options),
    })
  }
  if (options.repairCorrelation !== undefined) {
    this.db.runs.setCorrelationJson(runId, JSON.stringify(options.repairCorrelation))
  }
  // A STEER joins the running turn or starts one (T-08533); when it joins it
  // originates no turn, so arming the first-turn watch for it would trip on a
  // healthy delivery. T-08094 made steer a hot path (the kicker's default door
  // into a live seat), which is what turned a latent wrong arming into one
  // that would fire constantly.
  if (options.submissionDoor !== 'enqueue' && options.submissionDoor !== 'steer') {
    armFirstTurnWatch(this.db, {
      runtimeId: runtime.runtimeId,
      generation: session.generation,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      runId,
      invocationId,
      transport: 'headless',
      timeoutMsOverride: options.firstTurnTimeoutMs,
      primingDispatchedAt: now,
    })
  }
  const userPromptEvent = appendHrcEvent(this.db, 'turn.user_prompt', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    transport: 'headless',
    payload: createUserPromptPayload(prompt),
  })
  this.notifyEvent(userPromptEvent)

  const dispatchToBroker = () =>
    submitThroughBrokerDoor(
      this.getHarnessBrokerController(),
      options.submissionDoor ?? 'enqueue',
      {
        runtimeId: runtime.runtimeId,
        runId,
        body: prompt,
        origin: submissionOrigin(session.scopeRef, options),
        ...(toBrokerResponseFormat(options.responseFormat) !== undefined
          ? { responseFormat: toBrokerResponseFormat(options.responseFormat) }
          : {}),
        ...(options.freshContext !== undefined ? { freshContext: options.freshContext } : {}),
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
        ...(options.turnPolicy !== undefined ? { turnPolicy: options.turnPolicy } : {}),
      }
    )

  // T-01996: wait for the post-restart serving-controller warmup so the first
  // dispatch sees the broker already bound instead of racing a cold controller.
  // The promise is `.catch`-wrapped to always resolve; if warmup failed/absent we
  // fall through to the lazy reattach path below. Never wedges.
  await this.brokerWarmupComplete

  let result = await dispatchToBroker()

  // T-01884: a durable HEADLESS broker that survived a daemon restart has live
  // broker state, but this daemon's request-serving controller is COLD —
  // startup reconcile attaches on a throwaway controller (ownership gap), so the
  // first input fails `broker_runtime_not_active` even when the runtime row is
  // 'ready'. Lazily reattach the persisted durable endpoint onto the
  // request-serving controller and retry on the SAME broker (continuity, no
  // re-alloc). Reports unavailable for non-durable runtimes. Mirrors the interactive
  // path's reattach-on-dispatch (broker-interactive-handlers), minus the
  // transport==='tmux' gate so durable HEADLESS benefits.
  if (
    !result.ok &&
    result.error.code === 'broker_runtime_not_active' &&
    (
      await reattachDurableBrokerForDispatch(this.db, runtime, {
        runtimeRoot: this.options.runtimeRoot,
        controller: this.getHarnessBrokerController(),
        inFlightOperations: this.brokerReattachOperations,
        brokerUnixClientFactory:
          this.brokerUnixClientFactory ??
          ((options) =>
            connectObservedBrokerUnixClient(options) as ReturnType<BrokerUnixClientFactory>),
      })
    ).state === 'reattached'
  ) {
    writeServerLog('INFO', 'headless.durable_reattach.dispatch_recovered', {
      runtimeId: runtime.runtimeId,
      runId,
    })
    result = await dispatchToBroker()
  }

  if (result.ok) {
    this.db.runs.update(runId, {
      brokerSubmissionId: result.response.submissionId,
      dispatchedInputId: result.response.submissionId,
      updatedAt: timestamp(),
    })
    // T-08611 admission edge: the durable per-submission row. Door comes from
    // the HRC request and envelope_id from origin — never the disposition.
    this.db.submissionAdmissions.upsertAdmission({
      submissionId: result.response.submissionId,
      runId,
      runtimeId: runtime.runtimeId,
      invocationId,
      door: options.submissionDoor ?? 'enqueue',
      envelopeId: submissionOrigin(session.scopeRef, options).envelopeId,
      admittedAt: timestamp(),
    })
  }

  if (result.ok && result.response.admission === 'rejected') {
    const completedAt = timestamp()
    this.db.runs.markCompleted(runId, {
      status: 'failed',
      completedAt,
      updatedAt: completedAt,
      errorMessage: result.response.reason ?? 'broker rejected submission',
    })
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
      submissionId: result.response.submissionId,
      admission: result.response.admission,
      ...(result.response.reason !== undefined ? { reason: result.response.reason } : {}),
    } satisfies DispatchTurnResponseBase)
  }

  if (!result.ok) {
    const completedAt = timestamp()
    const errorMessage = result.error.message
    const brokerErrorCode = result.error.code
    const brokerInputTimeout = brokerErrorCode.endsWith('_timeout')
    const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
    const brokerBindingMissing = result.error.code === 'broker_runtime_not_active'
    // T-04297: the lazy reattach above may have just STALED this runtime (lease
    // substrate gone after a host reboot, attach/replay failure, lease identity
    // mismatch). Re-read the row and treat an unavailable status as terminal —
    // writing 'ready' back here would resurrect the zombie the reattach just
    // reaped, and the "usually transient — just retry" recommendation would
    // loop the identical failure forever.
    const currentRuntime = this.db.runtimes.getByRuntimeId(runtime.runtimeId)
    const runtimeReapedByReattach =
      currentRuntime != null && isRuntimeUnavailableStatus(currentRuntime.status)
    // T-05358: a rejection in a transient non-dispatchable state (starting/
    // stopping) is reprovision-worthy too — keeping the runtime `ready` here
    // re-arms it for the next reuse and loops the identical failure.
    const reprovisionRequired =
      runtimeReapedByReattach ||
      isTerminalBrokerInvocationState(invocation?.invocationState) ||
      isTransitionalBrokerInvocationState(invocation?.invocationState) ||
      brokerInputTimeout ||
      isTerminalBrokerInputFailure(errorMessage) ||
      isTransientBrokerInputStateFailure(errorMessage)
    if (brokerInputTimeout) {
      this.db.runs.fenceBrokerInput(runId, {
        fencedAt: completedAt,
        reason: brokerErrorCode,
      })
    }
    this.db.runs.markCompleted(runId, {
      status: 'failed',
      completedAt,
      updatedAt: completedAt,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage,
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)
    this.db.runtimes.update(runtime.runtimeId, {
      status: reprovisionRequired ? 'stale' : 'ready',
      statusChangedAt: completedAt,
      ...runtimeActivityPatch(this.db, runtime.runtimeId, {
        source: 'turn',
        occurredAt: completedAt,
        updatedAt: completedAt,
      }),
      ...(reprovisionRequired
        ? {
            runtimeStateJson: {
              // Spread the FRESH row state — the reattach may have just written
              // control/lastAttachError there; the stale in-memory snapshot
              // would clobber it.
              ...(currentRuntime?.runtimeStateJson ?? runtime.runtimeStateJson ?? {}),
              status: 'stale',
              updatedAt: completedAt,
              terminalInvocation: {
                invocationId,
                reason: errorMessage,
                ...(brokerInputTimeout ? { code: brokerErrorCode } : {}),
              },
            },
          }
        : {}),
    })
    const { headline, recommendation } = classifyBrokerInputFailure({
      label: 'headless',
      errorMessage,
      brokerBindingMissing,
      reprovisionRequired,
    })
    throw new HrcRuntimeUnavailableError(headline, {
      runtimeId: runtime.runtimeId,
      runId,
      invocationId,
      route: 'broker',
      cause: errorMessage,
      error: errorMessage,
      recommendation,
    })
  }

  if (options.waitForCompletion === false) {
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
      submissionId: result.response.submissionId,
      admission: result.response.admission,
    } satisfies DispatchTurnResponseBase)
  }

  await this.waitForHeadlessBrokerRunCompletion(runId, runtime.runtimeId)
  return json({
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'headless',
    status: 'completed',
    supportsInFlightInput: false,
    submissionId: result.response.submissionId,
    admission: result.response.admission,
  } satisfies DispatchTurnResponseBase)
}
