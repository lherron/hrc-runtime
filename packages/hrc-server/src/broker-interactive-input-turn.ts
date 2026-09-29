import { HrcErrorCode, HrcRuntimeUnavailableError, HrcUnprocessableEntityError } from 'hrc-core'
import type { HrcRuntimeSnapshot, HrcSessionRecord, HrcTurnResponseFormat } from 'hrc-core'
import {
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
  shouldBlockForBrokerTurnCompletion,
} from './broker-decisions.js'
import type {
  DispatchTurnResponseBase,
  JsonRepairRunCorrelation,
} from './broker-interactive-shared.js'
import {
  BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
  rejectedBrokerAdoptionPaths,
} from './broker/adoption-root.js'
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { withDirectTmuxDegradedControlState } from './broker/runtime-state.js'
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
import { brokerLeaseIdsMatch, reattachDurableBrokerForDispatch } from './startup-reconcile.js'
import { createTmuxManager } from './tmux.js'
import {
  assertRuntimeSupportsResponseFormat,
  toBrokerResponseFormat,
} from './turn-response-format.js'

export async function executeInteractiveBrokerInputTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: DispatchRunPersistenceOptions & {
    waitForCompletion?: boolean | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  } = {}
): Promise<Response> {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.BROKER_DESCRIPTOR_ABSENT,
      'interactive broker runtime has no active invocation descriptor',
      {
        runtimeId: runtime.runtimeId,
        runId,
        route: 'interactive-broker',
      }
    )
  }
  assertRuntimeSupportsResponseFormat({
    db: this.db,
    runtime,
    responseFormat: options.responseFormat,
    route: 'interactive-broker',
  })

  const preacceptedRun = this.db.runs.getByRunId(runId)
  const now = timestamp()
  if (preacceptedRun) {
    if (preacceptedRun.status !== 'accepted') {
      throw new HrcRuntimeUnavailableError('preaccepted broker input is not dispatchable', {
        runtimeId: runtime.runtimeId,
        runId,
        status: preacceptedRun.status,
        route: 'interactive-broker',
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
      transport: 'tmux',
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
      transport: 'tmux',
      timeoutMsOverride: options.firstTurnTimeoutMs,
      primingDispatchedAt: now,
    })
  }

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
  // The promise always resolves (.catch-wrapped); on failure/absence we fall
  // through to the lazy reattach path below. Never wedges.
  await this.brokerWarmupComplete

  let result = await dispatchToBroker()

  // T-01801: a durable IPC broker that survived a daemon restart has live broker
  // state but no in-memory active client on THIS daemon's freshly-built
  // request-serving controller (startup reconcile attaches on a throwaway
  // controller). The first input therefore fails `broker_runtime_not_active`.
  // Lazily re-attach the persisted durable endpoint onto the request-serving
  // controller and retry on the SAME broker (continuity, no re-alloc) BEFORE
  // falling back to legacy pane-lease reassociation. No-ops for non-durable
  // runtimes, so legacy reassociation still handles them below.
  let adoptionPathRejected = false
  if (
    !result.ok &&
    result.error.code === 'broker_runtime_not_active' &&
    runtime.transport === 'tmux'
  ) {
    const reattachResult = await reattachDurableBrokerForDispatch(this.db, runtime, {
      runtimeRoot: this.options.runtimeRoot,
      controller: this.getHarnessBrokerController(),
      inFlightOperations: this.brokerReattachOperations,
      brokerUnixClientFactory:
        this.brokerUnixClientFactory ??
        ((options) =>
          connectObservedBrokerUnixClient(options) as ReturnType<BrokerUnixClientFactory>),
    })
    adoptionPathRejected = reattachResult.state === 'rejected-outside-runtime-root'
    if (reattachResult.state === 'reattached') {
      result = await dispatchToBroker()
    }
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
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: true,
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
    if (
      result.error.code === 'broker_runtime_not_active' &&
      runtime.transport === 'tmux' &&
      !adoptionPathRejected &&
      (await this.deliverReassociatedBrokerTmuxInput(session, runtime, prompt, runId))
    ) {
      return json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        status: 'started',
        supportsInFlightInput: true,
      } satisfies DispatchTurnResponseBase)
    }
    const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
    const brokerBindingMissing = result.error.code === 'broker_runtime_not_active'
    // T-04297: the lazy reattach above may have just STALED this runtime (lease
    // substrate gone, attach/replay failure, lease identity mismatch). Re-read
    // the row and treat an unavailable status as terminal — writing 'ready'
    // back here would resurrect the zombie the reattach just reaped.
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
    if (brokerInputTimeout) {
      this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)
    }
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
              // control/lastAttachError there.
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
      label: 'interactive',
      errorMessage,
      brokerBindingMissing,
      reprovisionRequired,
    })
    throw new HrcRuntimeUnavailableError(headline, {
      runtimeId: runtime.runtimeId,
      runId,
      invocationId,
      route: 'interactive-broker',
      cause: errorMessage,
      error: errorMessage,
      recommendation,
    })
  }

  // A steer acknowledgement proves admission, not execution. Keep the
  // auxiliary accepted until the broker's durable absorbed/executed disposition
  // settles it; ACK-completing here fabricates a successful execution terminal.

  // T-01770 Phase C: a synchronous caller (ACP/Discord round-trip via
  // dispatchTurnForSession) blocks until the Claude turn completes; the async
  // reply-bridge callers pass waitForCompletion:false and get status:'started'.
  // A steer never blocks, whatever the caller asked for.
  if (!shouldBlockForBrokerTurnCompletion(options.waitForCompletion, options.submissionDoor)) {
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: true,
      submissionId: result.response.submissionId,
      admission: result.response.admission,
    } satisfies DispatchTurnResponseBase)
  }

  await this.waitForInteractiveBrokerRunCompletion(runId, runtime.runtimeId)
  return json({
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'tmux',
    status: 'completed',
    supportsInFlightInput: true,
    submissionId: result.response.submissionId,
    admission: result.response.admission,
  } satisfies DispatchTurnResponseBase)
}

export async function deliverReassociatedBrokerTmuxInput(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string
): Promise<boolean> {
  const rejectedPaths = rejectedBrokerAdoptionPaths(runtime, this.options.runtimeRoot)
  if (rejectedPaths.length > 0) {
    writeServerLog('WARN', 'broker.adoption.direct_tmux_delivery_rejected', {
      runtimeId: runtime.runtimeId,
      runtimeRoot: this.options.runtimeRoot,
      rejectedPaths,
      reason: BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
    })
    return false
  }
  const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
  const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
  if (!socketPath || !sessionName) {
    return false
  }

  const brokerTmux = createTmuxManager({ socketPath })
  const pane = await brokerTmux.inspectSession(sessionName)
  if (!pane || !brokerLeaseIdsMatch(runtime, pane)) {
    return false
  }

  const liveness = await brokerTmux.inspectPaneLiveness(pane.paneId)
  if (!liveness?.alive) {
    return false
  }

  const acceptedAt = timestamp()
  this.notifyEvent(
    appendHrcEvent(this.db, 'turn.accepted', {
      ts: acceptedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        promptLength: prompt.length,
        source: 'reassociated-broker-tmux-fallback',
      },
    })
  )
  this.notifyEvent(
    appendHrcEvent(this.db, 'turn.user_prompt', {
      ts: acceptedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: createUserPromptPayload(prompt),
    })
  )

  await brokerTmux.sendKeys(pane.paneId, prompt)

  const startedAt = timestamp()
  const latestRuntime = this.db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
  this.db.runs.update(runId, {
    status: 'started',
    startedAt,
    updatedAt: startedAt,
  })
  this.db.runtimes.update(runtime.runtimeId, {
    status: 'busy',
    statusChangedAt: startedAt,
    activeRunId: runId,
    ...runtimeActivityPatch(this.db, runtime.runtimeId, {
      source: 'turn',
      occurredAt: startedAt,
      updatedAt: startedAt,
    }),
    runtimeStateJson: withDirectTmuxDegradedControlState(latestRuntime.runtimeStateJson),
  })
  this.notifyEvent(
    appendHrcEvent(this.db, 'turn.started', {
      ts: startedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        source: 'reassociated-broker-tmux-fallback',
      },
    })
  )
  this.notifyEvent(
    appendHrcEvent(this.db, 'turn.degraded_input_delivered', {
      ts: startedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        source: 'reassociated-broker-tmux-fallback',
        controlMode: 'direct-tmux-degraded',
        brokerAttached: false,
        paneId: pane.paneId,
      },
    })
  )

  writeServerLog('INFO', 'interactive_broker.reassociated_tmux_input_fallback', {
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    runId,
    paneId: pane.paneId,
  })
  return true
}
