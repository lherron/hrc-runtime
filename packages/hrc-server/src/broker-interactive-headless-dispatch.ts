import {
  HrcConflictError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
} from 'hrc-core'
import type {
  HrcExecutionFormat,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import {
  assertActuatorSplitRuntimeReuse,
  normalizeActuatorSplitPolicy,
  prepareActuatorSplitIntent,
} from './actuator-split.js'
import { shouldUseHeadlessSdkExecutor } from './broker-decisions.js'
import { waitForCompilerPrimingTerminal } from './broker-headless-handlers.js'
import type {
  DispatchTurnResponseBase,
  JsonRepairRunCorrelation,
} from './broker-interactive-shared.js'
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { compilerPrimingSubmissionId } from './compiler-priming.js'
import { appendHrcEvent, createUserPromptPayload } from './hrc-event-helper.js'
import {
  type RedirectOffBirthJoin,
  assertBirthJoinRoute,
  assertNoOperatorPresentationConflict,
  recordStartBirth,
  requestsOperatorPresentation,
  startBirthOfRuntime,
} from './presentation-operator.js'
import { assertRuntimeNotBusy, isTerminalBrokerInvocationState } from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import {
  assertV2SelectionCompatibleForReuse,
  getDurableHeadlessRuntimeForReattach,
  getReusableHeadlessRuntimeForSession,
} from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import {
  type CoalescedQueuedMember,
  type DispatchRunPersistenceOptions,
  dispatchOriginRunFields,
} from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { automaticContinuationForSession } from './session-continuation-reuse.js'
import { reattachDurableBrokerForDispatch } from './startup-reconcile.js'

type RuntimeStartOwnership = {
  operation: Promise<HrcRuntimeSnapshot>
  resolve(runtime: HrcRuntimeSnapshot): void
  reject(error: unknown): void
}

function createRuntimeStartOwnership(): RuntimeStartOwnership {
  let resolve!: (runtime: HrcRuntimeSnapshot) => void
  let reject!: (error: unknown) => void
  const operation = new Promise<HrcRuntimeSnapshot>((resolveOperation, rejectOperation) => {
    resolve = resolveOperation
    reject = rejectOperation
  })
  // The owner may fail before a crossing caller joins. Keep that legitimate
  // rejection observed while preserving the original promise for later joiners.
  void operation.catch(() => undefined)
  return { operation, resolve, reject }
}

function findBrokerRuntimeMissingDescriptor(input: {
  runtimes: HrcRuntimeSnapshot[]
  provider: HrcRuntimeIntent['harness']['provider']
  harnessId?: HrcRuntimeIntent['harness']['id'] | undefined
}): HrcRuntimeSnapshot | undefined {
  return input.runtimes
    .filter((runtime) => {
      if (
        runtime.transport !== 'headless' ||
        runtime.provider !== input.provider ||
        runtime.controllerKind !== 'harness-broker' ||
        runtime.activeInvocationId !== undefined ||
        isRuntimeUnavailableStatus(runtime.status)
      ) {
        return false
      }
      return input.harnessId === undefined || runtime.harness === input.harnessId
    })
    .at(-1)
}

export async function handleHeadlessDispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: DispatchRunPersistenceOptions & {
    waitForCompletion?: boolean | undefined
  } = {}
): Promise<Response> {
  const established = this.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .filter(
      (runtime) =>
        runtime.controllerKind === 'harness-broker' && !isRuntimeUnavailableStatus(runtime.status)
    )
    .at(-1)
  if (established !== undefined) {
    assertV2SelectionCompatibleForReuse(established, intent)
  }
  const runtime =
    getReusableHeadlessRuntimeForSession(this.db, session.hostSessionId) ??
    this.createHeadlessRuntimeForSession(session, intent)
  assertRuntimeNotBusy(this.db, runtime)

  const continuation = automaticContinuationForSession(this.db, session)
  const now = timestamp()
  this.db.sessions.updateIntent(session.hostSessionId, intent, now)

  const run = this.db.runs.insert({
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
    dispatchIdempotencyKey: options.dispatchIdempotencyKey,
    ...dispatchOriginRunFields(options),
  })

  this.db.runtimes.update(runtime.runtimeId, {
    activeRunId: run.runId,
    status: 'busy',
    statusChangedAt: now,
    ...runtimeActivityPatch(this.db, runtime.runtimeId, {
      source: 'turn',
      occurredAt: now,
      updatedAt: now,
    }),
  })

  const acceptedEvent = appendHrcEvent(this.db, 'turn.accepted', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    payload: {
      promptLength: prompt.length,
      transport: 'headless',
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
    payload: createUserPromptPayload(prompt),
  })
  this.notifyEvent(userPromptEvent)

  const startedAt = timestamp()
  this.db.runs.update(runId, {
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
    payload: {
      transport: 'headless',
    },
  })
  this.notifyEvent(startedEvent)

  const execute = async (): Promise<Response> => {
    if (shouldUseHeadlessSdkExecutor(intent.harness)) {
      return await this.executeHeadlessSdkTurn(
        session,
        runtime,
        intent,
        prompt,
        runId,
        continuation
      )
    }

    throw new HrcRuntimeUnavailableError('headless CLI legacy execution is unavailable', {
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
    })
  }

  if (options.waitForCompletion === false) {
    void execute().catch((err: unknown) => {
      try {
        this.recordDetachedHeadlessTurnFailure(session, runtime.runtimeId, runId, err)
      } catch (failureErr) {
        writeServerLog('WARN', 'headless.detached_turn_failure_record_failed', {
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
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
    } satisfies DispatchTurnResponseBase)
  }

  return await execute()
}

export async function handleHeadlessBrokerDispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string | undefined,
  options: DispatchRunPersistenceOptions & {
    executionFormat?: HrcExecutionFormat | undefined
    waitForCompletion?: boolean | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
    coalescedMembers?: readonly CoalescedQueuedMember[] | undefined
    coldBirthPromptMode?: 'replace-priming' | 'append-to-priming' | undefined
    /** T-08555: a redirect-off crossing re-checks every in-flight start it joins. */
    redirectOffBirthJoin?: RedirectOffBirthJoin | undefined
  } = {}
): Promise<Response> {
  if (options.executionFormat === 'format2') {
    if (runId !== undefined) {
      throw new HrcConflictError(
        HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT,
        'format2 dispatch cannot carry an admission-time run identity',
        { runId, route: 'broker' }
      )
    }
    return await this.executeHeadlessBrokerFormat2DispatchTurn(session, intent, prompt, {
      ...options,
      executionFormat: 'format2',
    })
  }
  if (runId === undefined) {
    throw new HrcConflictError(
      HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT,
      'format1 dispatch requires an admission-time run identity',
      { route: 'broker' }
    )
  }
  const requestedTurnIntent: HrcRuntimeIntent =
    prompt.length > 0 ? { ...intent, initialPrompt: prompt } : intent
  // Re-resolve actuator authority for every turn, including reuse and durable
  // reattach. This prevents a matching write-capable runtime from becoming a
  // route around artifact/base validation or receiving free-form caller text.
  const preparedActuatorSplit = await prepareActuatorSplitIntent(requestedTurnIntent)
  const dispatchIntent = preparedActuatorSplit.intent
  const dispatchPrompt = dispatchIntent.initialPrompt ?? prompt
  const highRiskActuatorSplit =
    normalizeActuatorSplitPolicy(dispatchIntent.execution?.actuatorSplit)?.mode === 'high-risk'

  const joinRuntimeStart = async (
    bootOperation: Promise<HrcRuntimeSnapshot>
  ): Promise<Response> => {
    // Low-risk behavior keeps the established accept-before-wait contract.
    // High-risk work must first prove that the booting runtime has exactly the
    // requested authority; otherwise a rejected request could already be queued.
    // T-08553: an explicit no-viewer request likewise waits to prove the booting
    // runtime does not present a viewer before anything is queued.
    const admitBeforeBoot = !highRiskActuatorSplit && !requestsOperatorPresentation(dispatchIntent)
    if (admitBeforeBoot) {
      this.enqueueDurableHeadlessTurnInput(session, dispatchPrompt, runId, {
        source: 'boot',
        responseFormat: options.responseFormat,
        dispatchIdempotencyKey: options.dispatchIdempotencyKey,
      })
    }
    const bootedRuntime = await bootOperation
    assertActuatorSplitRuntimeReuse(dispatchIntent, bootedRuntime)
    assertNoOperatorPresentationConflict(dispatchIntent, [bootedRuntime])
    const initialInputId = compilerPrimingSubmissionId(this.db, bootedRuntime)
    const bootRun =
      bootedRuntime.activeRunId !== undefined
        ? this.db.runs.getByRunId(bootedRuntime.activeRunId)
        : null
    // A compiler initial input bound to the boot's accepted run is that run's
    // launch-carried user turn, not autonomous priming. Waiting for its
    // terminal state would strand a crossing ordinary v2 submission behind an
    // arbitrarily long provider turn.
    if (initialInputId === undefined || bootRun?.brokerSubmissionId !== initialInputId) {
      await waitForCompilerPrimingTerminal(this, bootedRuntime, this.runtimeStartPresentationSignal)
    }
    if (!admitBeforeBoot) {
      this.enqueueDurableHeadlessTurnInput(session, dispatchPrompt, runId, {
        source: 'boot',
        responseFormat: options.responseFormat,
        dispatchIdempotencyKey: options.dispatchIdempotencyKey,
      })
    }
    return await this.dispatchQueuedHeadlessTurnInput(
      session,
      bootedRuntime,
      dispatchPrompt,
      runId,
      options
    )
  }

  // A lifecycle-only `hrc start` may still be provisioning this session when
  // a prompt-bearing start/turn arrives. Admit the prompt durably before
  // waiting for boot so aborting the client only stops its wait, never the
  // delivery. Reuse the one boot operation; a second broker start would split
  // the session.
  const bootOperation = this.runtimeStartOperations.get(session.hostSessionId)
  if (bootOperation) {
    if (options.redirectOffBirthJoin !== undefined) {
      await assertBirthJoinRoute(dispatchIntent, bootOperation, options.redirectOffBirthJoin)
    }
    return await joinRuntimeStart(bootOperation)
  }

  const establishedRuntime = this.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .filter(
      (runtime) =>
        runtime.controllerKind === 'harness-broker' && !isRuntimeUnavailableStatus(runtime.status)
    )
    .at(-1)
  if (establishedRuntime !== undefined) {
    assertV2SelectionCompatibleForReuse(establishedRuntime, dispatchIntent)
  }
  const reusableRuntime = getReusableHeadlessRuntimeForSession(this.db, session.hostSessionId)
  const missingDescriptorRuntime = findBrokerRuntimeMissingDescriptor({
    runtimes: this.db.runtimes.listByHostSessionId(session.hostSessionId),
    provider: dispatchIntent.harness.provider,
    harnessId: dispatchIntent.harness.id,
  })
  if (missingDescriptorRuntime) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.BROKER_DESCRIPTOR_ABSENT,
      'headless broker runtime has no active invocation descriptor',
      {
        runtimeId: missingDescriptorRuntime.runtimeId,
        runId,
        route: 'broker',
      }
    )
  }
  if (reusableRuntime) {
    assertActuatorSplitRuntimeReuse(dispatchIntent, reusableRuntime)
    assertNoOperatorPresentationConflict(dispatchIntent, [reusableRuntime])
    if (
      reusableRuntime.controllerKind === 'harness-broker' &&
      reusableRuntime.activeInvocationId !== undefined
    ) {
      await this.publishPresentation(reusableRuntime, {
        operatorAttachPending: false,
      })
      if (this.db.runs.getByRunId(runId)?.status === 'queued') {
        return await this.dispatchQueuedHeadlessTurnInput(
          session,
          reusableRuntime,
          dispatchPrompt,
          runId,
          options
        )
      }
      return await this.executeHeadlessBrokerInputTurn(
        session,
        reusableRuntime,
        dispatchPrompt,
        runId,
        options
      )
    }

    this.markRuntimeStaleForBrokerReprovision(session, reusableRuntime, {
      reason: 'headless-broker-nonbroker-reuse-rejected',
      route: 'headless-broker',
    })
  }

  // T-01884: durable HEADLESS reattach BEFORE provisioning a new broker. A durable
  // headless runtime that survived a daemon restart has a live leased-tmux substrate
  // + unix broker, but this daemon's request-serving controller is cold and the row
  // was left stale/broker-ipc-unavailable by startup reconcile — so the reuse
  // selector above excluded it. If we fell straight through to start, we would
  // provision a SECOND broker over the still-live lease, orphaning the first
  // (the Ph4c live failure). Instead, lazily reattach the persisted durable endpoint
  // onto the REQUEST-SERVING controller (ownership) and REUSE the same runtime id.
  // On reattach failure (dead/unreachable broker) reap it before reprovisioning so
  // no second broker tmux session remains (no-silent-duplicate).
  const durableHeadless = getDurableHeadlessRuntimeForReattach(this.db, session.hostSessionId)
  if (durableHeadless) {
    // T-07196: the initial map check above is only a check, not ownership.
    // Claim the host session synchronously before the first durable await and
    // retain the SAME promise through reattach, termination, and any fresh
    // replacement boot. Crossing callers join it instead of replacing it.
    const crossingOperation = this.runtimeStartOperations.get(session.hostSessionId)
    if (crossingOperation) {
      if (options.redirectOffBirthJoin !== undefined) {
        await assertBirthJoinRoute(dispatchIntent, crossingOperation, options.redirectOffBirthJoin)
      }
      return await joinRuntimeStart(crossingOperation)
    }
    const ownership = createRuntimeStartOwnership()
    recordStartBirth(ownership.operation, startBirthOfRuntime(durableHeadless))
    this.runtimeStartOperations.set(session.hostSessionId, ownership.operation)
    const releaseOwnership = (): void => {
      if (this.runtimeStartOperations.get(session.hostSessionId) === ownership.operation) {
        this.runtimeStartOperations.delete(session.hostSessionId)
      }
    }

    try {
      const durableInvocation =
        durableHeadless.activeInvocationId !== undefined
          ? this.db.brokerInvocations.getByInvocationId(durableHeadless.activeInvocationId)
          : null
      if (durableInvocation && isTerminalBrokerInvocationState(durableInvocation.invocationState)) {
        writeServerLog('INFO', 'headless.durable_terminal_invocation.reprovision', {
          hostSessionId: session.hostSessionId,
          runtimeId: durableHeadless.runtimeId,
          invocationId: durableInvocation.invocationId,
          invocationState: durableInvocation.invocationState,
        })
        await this.terminateRuntime(durableHeadless, { dropContinuation: false }).catch(
          (error: unknown) => {
            writeServerLog('WARN', 'headless.durable_terminal_invocation.cleanup_failed', {
              runtimeId: durableHeadless.runtimeId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        )
        return await this.executeHeadlessBrokerStartTurn(
          session,
          dispatchIntent,
          dispatchPrompt,
          runId,
          options,
          ownership
        )
      }

      const reattachResult = await reattachDurableBrokerForDispatch(this.db, durableHeadless, {
        runtimeRoot: this.options.runtimeRoot,
        controller: this.getHarnessBrokerController(),
        inFlightOperations: this.brokerReattachOperations,
        brokerUnixClientFactory:
          this.brokerUnixClientFactory ??
          ((options) =>
            connectObservedBrokerUnixClient(options) as ReturnType<BrokerUnixClientFactory>),
      })
      const recovered =
        reattachResult.state === 'reattached'
          ? this.db.runtimes.getByRuntimeId(durableHeadless.runtimeId)
          : null
      if (recovered && recovered.activeInvocationId !== undefined) {
        writeServerLog('INFO', 'headless.durable_reattach.reused', {
          hostSessionId: session.hostSessionId,
          runtimeId: recovered.runtimeId,
        })
        assertActuatorSplitRuntimeReuse(dispatchIntent, recovered)
        ownership.resolve(recovered)
        releaseOwnership()
        return await this.executeHeadlessBrokerInputTurn(
          session,
          recovered,
          dispatchPrompt,
          runId,
          options
        )
      }
      // Reattach failed or the persisted invocation is gone: terminate the cold
      // durable runtime (reaps its broker dispose path; the orphan sweeper reaps the
      // leased substrate since a terminal runtime no longer claims it) BEFORE we
      // provision a fresh broker below — no second live broker tmux may remain.
      writeServerLog('WARN', 'headless.durable_reattach.failed_reprovision', {
        hostSessionId: session.hostSessionId,
        runtimeId: durableHeadless.runtimeId,
        reattachState: reattachResult.state,
      })
      if (reattachResult.state !== 'rejected-outside-runtime-root') {
        await this.terminateRuntime(durableHeadless, { dropContinuation: true }).catch(
          (error: unknown) => {
            writeServerLog('WARN', 'headless.durable_reattach.reprovision_cleanup_failed', {
              runtimeId: durableHeadless.runtimeId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        )
      }

      return await this.executeHeadlessBrokerStartTurn(
        session,
        dispatchIntent,
        dispatchPrompt,
        runId,
        options,
        ownership
      )
    } catch (error) {
      ownership.reject(error)
      releaseOwnership()
      throw error
    }
  }

  return await this.executeHeadlessBrokerStartTurn(
    session,
    dispatchIntent,
    dispatchPrompt,
    runId,
    options
  )
}
