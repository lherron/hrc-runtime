import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { HrcErrorCode, HrcRuntimeUnavailableError, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import { asBrokerClient } from './agent-spaces-adapter/aspc-facade-client.js'
import { buildHrcCorrelationEnv, mergeEnv } from './agent-spaces-adapter/cli-adapter.js'
import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import { isInteractiveTmuxBrokerProfile } from './agent-spaces-adapter/compile-profile-selector.js'
import { buildDirectInteractiveAgentHarnessPlan } from './agent-spaces-adapter/direct-agent-harness.js'
import { waitForCompilerPrimingTerminal } from './broker-headless-handlers.js'
import {
  BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
  rejectedBrokerAdoptionPaths,
} from './broker/adoption-root.js'
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import { withDirectTmuxDegradedControlState } from './broker/runtime-state.js'
import { submissionOrigin, submitThroughBrokerDoor } from './broker/submission-doors.js'
import { armFirstTurnWatch } from './first-turn-watch.js'
import { appendHrcEvent, createUserPromptPayload } from './hrc-event-helper.js'
import { buildManagedBrokerDispatchEnv } from './managed-broker-runtime-env.js'
import { runtimeActivityPatch } from './runtime-activity.js'

import {
  actuatorSplitRuntimeAuthority,
  assertActuatorSplitAdmission,
  assertActuatorSplitRuntimeReuse,
  normalizeActuatorSplitPolicy,
  prepareActuatorSplitIntent,
} from './actuator-split.js'
import {
  decideBrokerDurableInteractiveRoute,
  decideInteractiveTmuxBrokerContinuation,
  decideInteractiveTmuxExecutionRoute,
  extractPiSdkBrokerCredentialEnv,
  filterBrokerDispatchEnvForLockedEnv,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
  shouldBlockForBrokerTurnCompletion,
  shouldUseHeadlessSdkExecutor,
  toRuntimeContinuationRef,
} from './broker-decisions.js'
import type { InteractiveTmuxBrokerDriver } from './broker-decisions.js'
import { resolveBrokerBinary } from './broker-interactive-handlers/substrate-allocator.js'
import { resolveBrokerDurableIpcEnabled, startAspcFacadeBrokerClient } from './option-resolvers.js'
import { createPrecompileLaunchTimingContext } from './precompile-launch-timing.js'
import {
  assertRuntimeNotBusy,
  classifyBrokerInputFailure,
  isRunActive,
  isTerminalBrokerInputFailure,
  isTerminalBrokerInvocationState,
  isTransientBrokerInputStateFailure,
  isTransitionalBrokerInvocationState,
} from './require-helpers.js'
import {
  getDurableHeadlessRuntimeForReattach,
  getReusableHeadlessRuntimeForSession,
} from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import {
  type AttachBeforeInvocationStartOption,
  type CoalescedQueuedMember,
  type DispatchRunPersistenceOptions,
  type InvokeFirstTurnRendezvous,
  dispatchOriginRunFields,
  dispatchRunPersistence,
} from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import {
  automaticContinuationForRuntime,
  automaticContinuationForSession,
} from './session-continuation-reuse.js'
import { brokerLeaseIdsMatch, reattachDurableBrokerForDispatch } from './startup-reconcile.js'
import { createTmuxManager } from './tmux.js'
import {
  assertRuntimeSupportsResponseFormat,
  toBrokerResponseFormat,
} from './turn-response-format.js'

import { getHarnessBrokerController } from './broker-interactive-handlers/controller-factory.js'

type DispatchTurnResponseBase = Omit<
  DispatchTurnResponse,
  'startIdentity' | 'observation' | 'stage' | 'status' | 'outcome' | 'replayed' | 'error'
> & { status: 'started' | 'completed' }

export const buildInteractiveBrokerDispatchEnv = buildManagedBrokerDispatchEnv

type JsonRepairRunCorrelation = {
  kind: 'json_repair'
  sourceRunId: string
  failedValidationRunId: string
  repairRunId: string
}

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

function cleanupInvokeFirstTurnRendezvous(
  server: HrcServerInstanceForHandlers,
  hostSessionId: string,
  rendezvous: InvokeFirstTurnRendezvous
): void {
  if (
    rendezvous.settled &&
    rendezvous.crossingRunIds.size === 0 &&
    server.invokeFirstTurnRendezvous.get(hostSessionId) === rendezvous
  ) {
    server.invokeFirstTurnRendezvous.delete(hostSessionId)
  }
}

function assertBrokerPermissionPolicyAdmitted(input: {
  mode: unknown
  hostSessionId: string
  runId: string
  route: string
}): void {
  if (input.mode === 'ask-client') {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.ASK_CLIENT_UNSUPPORTED,
      'ask-client permission mode is unsupported for HRC-owned broker dispatch',
      {
        hostSessionId: input.hostSessionId,
        runId: input.runId,
        route: input.route,
        permissionMode: 'ask-client',
      }
    )
  }
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

// Re-exported so the public surface of this module is preserved after the
// substrate-allocator + controller-factory split (no downstream import changes
// required).
export {
  allocateBrokerSubstrate,
  type AllocateBrokerSubstrateInput,
  type BrokerDurableTmuxAllocatorDeps,
  type BrokerSubstrateAllocation,
  type BrokerSubstratePresentationKind,
  BrokerTuiAllocationError,
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  type DurableTmuxManagerLike,
} from './broker-interactive-handlers/substrate-allocator.js'
export { getHarnessBrokerController }

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
  const runtime =
    getReusableHeadlessRuntimeForSession(
      this.db,
      session.hostSessionId,
      intent.harness.provider,
      intent.harness.id
    ) ?? this.createHeadlessRuntimeForSession(session, intent)
  assertRuntimeNotBusy(this.db, runtime)

  const continuation = automaticContinuationForRuntime(this.db, session, runtime)
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
    continuation,
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
  runId: string,
  options: DispatchRunPersistenceOptions & {
    waitForCompletion?: boolean | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
    coalescedMembers?: readonly CoalescedQueuedMember[] | undefined
  } = {}
): Promise<Response> {
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
    if (!highRiskActuatorSplit) {
      this.enqueueDurableHeadlessTurnInput(session, dispatchPrompt, runId, {
        source: 'boot',
        responseFormat: options.responseFormat,
        dispatchIdempotencyKey: options.dispatchIdempotencyKey,
      })
    }
    const bootedRuntime = await bootOperation
    assertActuatorSplitRuntimeReuse(dispatchIntent, bootedRuntime)
    await waitForCompilerPrimingTerminal(this, bootedRuntime, this.runtimeStartPresentationSignal)
    if (highRiskActuatorSplit) {
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
    return await joinRuntimeStart(bootOperation)
  }

  const reusableRuntime = getReusableHeadlessRuntimeForSession(
    this.db,
    session.hostSessionId,
    dispatchIntent.harness.provider,
    dispatchIntent.harness.id
  )
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
  const durableHeadless = getDurableHeadlessRuntimeForReattach(
    this.db,
    session.hostSessionId,
    dispatchIntent.harness.provider,
    dispatchIntent.harness.id
  )
  if (durableHeadless) {
    // T-07196: the initial map check above is only a check, not ownership.
    // Claim the host session synchronously before the first durable await and
    // retain the SAME promise through reattach, termination, and any fresh
    // replacement boot. Crossing callers join it instead of replacing it.
    const crossingOperation = this.runtimeStartOperations.get(session.hostSessionId)
    if (crossingOperation) {
      return await joinRuntimeStart(crossingOperation)
    }
    const ownership = createRuntimeStartOwnership()
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

export async function handleInteractiveTmuxBrokerDispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  flagOptions: DispatchRunPersistenceOptions & {
    flagEnvName: string
    allowedBrokerDriver: InteractiveTmuxBrokerDriver
    waitForCompletion?: boolean | undefined
    joinInFlightRuntimeStart?: boolean | undefined
    coldBirthPromptMode?: 'replace-priming' | 'append-to-priming' | undefined
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): Promise<Response> {
  const { initialPrompt: _initialPrompt, ...turnIntent } = intent
  let promptRodeLaunch = false
  // T-07202: persisted semantic DMs can enter this interactive cold-start
  // branch concurrently. T-06313 protected only the headless broker branch;
  // this branch published its boot but never joined an existing one, so each
  // crossing DM started and then overwrote the same map entry. Join the
  // already-published host-session boot and deliver this caller's own input
  // through the winner. Keep this route opt-in so reattach and non-DM dispatch
  // policy remain outside this cold-provision fix.
  const existingInvokeRendezvous =
    flagOptions.joinInFlightRuntimeStart && flagOptions.submissionDoor === 'invoke'
      ? this.invokeFirstTurnRendezvous.get(session.hostSessionId)
      : undefined
  const existingBootOperation = flagOptions.joinInFlightRuntimeStart
    ? (existingInvokeRendezvous?.operation ??
      this.runtimeStartOperations?.get(session.hostSessionId))
    : undefined
  if (existingBootOperation) {
    existingInvokeRendezvous?.crossingRunIds.add(runId)
    try {
      const runtime = await existingBootOperation
      assertActuatorSplitRuntimeReuse(turnIntent, runtime)
      return await this.executeInteractiveBrokerInputTurn(session, runtime, prompt, runId, {
        waitForCompletion: flagOptions.waitForCompletion,
        responseFormat: flagOptions.responseFormat,
        ...dispatchRunPersistence(flagOptions),
      })
    } finally {
      if (existingInvokeRendezvous !== undefined) {
        existingInvokeRendezvous.crossingRunIds.delete(runId)
        cleanupInvokeFirstTurnRendezvous(this, session.hostSessionId, existingInvokeRendezvous)
      }
    }
  }
  let resolveAccepted!: (runtime: HrcRuntimeSnapshot) => void
  let rejectAccepted!: (error: unknown) => void
  let acceptedSettled = false
  const accepted = new Promise<HrcRuntimeSnapshot>((resolve, reject) => {
    resolveAccepted = (runtime) => {
      acceptedSettled = true
      resolve(runtime)
    }
    rejectAccepted = (error) => {
      acceptedSettled = true
      reject(error)
    }
  })
  // A blocking caller awaits bootOperation directly, so the early-acceptance
  // promise has no consumer on that route. Observe its legitimate startup
  // rejection here; detached callers still await the original promise below.
  void accepted.catch(() => undefined)
  const bootOperation = this.startInteractiveTmuxBrokerRuntime(session, turnIntent, runId, {
    flagEnvName: flagOptions.flagEnvName,
    allowedBrokerDriver: flagOptions.allowedBrokerDriver,
    ...(flagOptions.attachBeforeInvocationStart
      ? { attachBeforeInvocationStart: flagOptions.attachBeforeInvocationStart }
      : {}),
    responseFormat: flagOptions.responseFormat,
    ...(flagOptions.coldBirthPromptMode !== undefined
      ? {
          coldBirthPrompt: prompt,
          includePrimingForColdBirthPrompt: flagOptions.coldBirthPromptMode === 'append-to-priming',
          onColdBirthPromptRoute: (rodeLaunch: boolean) => {
            promptRodeLaunch = rodeLaunch
          },
        }
      : {}),
    ...dispatchRunPersistence(flagOptions),
    onAccepted: (runtime) => {
      if (this.db.hrcEvents.listByRun(runId, { eventKind: 'turn.accepted' }).length === 0) {
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
              authority: 'durable-start-graph',
            },
          })
        )
      }
      resolveAccepted(runtime)
    },
  }).then((runtime) => {
    // Claude broker dispatch through non-attached surfaces (hrcchat,
    // agent-loop) starts a tmux TUI with no operator terminal watching it.
    // Presentation stays best-effort and outside the acceptance boundary.
    if (flagOptions.allowedBrokerDriver === 'claude-code-tmux') {
      void this.publishPresentation(runtime, {
        operatorAttachPending: flagOptions.attachBeforeInvocationStart !== undefined,
        signal: this.runtimeStartPresentationSignal,
      })
    }
    if (!acceptedSettled) resolveAccepted(runtime)
    return runtime
  })
  // The ordinary birth singleflight is shared by every admission door and must
  // end at bare boot. In particular, enqueue/mail deliberately reaches the
  // newborn broker while the launch-carried turn is live so its existing
  // steer/merge semantics remain intact.
  const publishedBootOperation = bootOperation.finally(() => {
    if (this.runtimeStartOperations?.get(session.hostSessionId) === publishedBootOperation) {
      this.runtimeStartOperations.delete(session.hostSessionId)
    }
  })
  this.runtimeStartOperations?.set(session.hostSessionId, publishedBootOperation)
  void publishedBootOperation.catch(() => undefined)

  // T-08012: request-response invokes need a stronger, door-local projection.
  // The runtime is born before its argv-carried first turn owns a terminal
  // bracket, so a crossing invoke must not submit until that bracket closes.
  // Keep this promise out of runtimeStartOperations: sharing it there also
  // fenced enqueue/mail, contrary to their intentional live-turn steering.
  if (flagOptions.submissionDoor === 'invoke') {
    const invokeOperation = bootOperation.then(async (runtime) => {
      if (promptRodeLaunch) {
        await waitForLaunchCarriedFirstTurnTerminal(this, runId)
      }
      return this.db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
    })
    const rendezvous: InvokeFirstTurnRendezvous = {
      ownerRunId: runId,
      operation: invokeOperation,
      crossingRunIds: new Set(),
      settled: false,
    }
    this.invokeFirstTurnRendezvous.set(session.hostSessionId, rendezvous)
    void invokeOperation
      .then((runtime) => {
        rendezvous.runtimeId = runtime.runtimeId
      })
      .catch(() => undefined)
      .finally(() => {
        rendezvous.settled = true
        cleanupInvokeFirstTurnRendezvous(this, session.hostSessionId, rendezvous)
      })
  }
  void bootOperation.catch((error) => {
    if (!acceptedSettled) rejectAccepted(error)
  })
  if (flagOptions.waitForCompletion === false) {
    void bootOperation
      .then(async (runtime) => {
        if (promptRodeLaunch) return
        await this.executeInteractiveBrokerInputTurn(session, runtime, prompt, runId, {
          waitForCompletion: false,
          responseFormat: flagOptions.responseFormat,
          ...dispatchRunPersistence(flagOptions),
        })
      })
      .catch(() => undefined)
    const runtime = await accepted
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
  const runtime = await bootOperation
  if (promptRodeLaunch) {
    const submissionId =
      flagOptions.submissionDoor === 'invoke'
        ? await waitForLaunchCarriedInvokeSubmission(this, runId, runtime.runtimeId)
        : undefined
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: true,
      ...(submissionId === undefined ? {} : { submissionId, admission: 'admitted' as const }),
    } satisfies DispatchTurnResponseBase)
  }
  return await this.executeInteractiveBrokerInputTurn(session, runtime, prompt, runId, {
    waitForCompletion: false,
    responseFormat: flagOptions.responseFormat,
    ...dispatchRunPersistence(flagOptions),
  })
}

async function waitForLaunchCarriedInvokeSubmission(
  server: HrcServerInstanceForHandlers,
  runId: string,
  runtimeId: string
): Promise<string> {
  const deadline = Date.now() + 2 * 60 * 1000
  while (Date.now() < deadline) {
    const run = server.db.runs.getByRunId(runId)
    if (run?.brokerSubmissionId !== undefined) return run.brokerSubmissionId
    if (run !== null && !isRunActive(run)) {
      throw new HrcRuntimeUnavailableError(
        'launch-carried invoke ended without broker submission identity',
        {
          runtimeId,
          runId,
          status: run.status,
          errorCode: run.errorCode,
          errorMessage: run.errorMessage,
        }
      )
    }
    await delay(25)
  }
  throw new HrcRuntimeUnavailableError('launch-carried invoke admission timed out', {
    runtimeId,
    runId,
    route: 'interactive-broker',
  })
}

async function waitForLaunchCarriedFirstTurnTerminal(
  server: HrcServerInstanceForHandlers,
  runId: string
): Promise<void> {
  while (true) {
    const run = server.db.runs.getByRunId(runId)
    // The real launch path persists the run before resolving boot. Keep this
    // tolerant for a controller/start failure that removed or never committed
    // the graph: there is then no owned first turn for the fence to protect.
    if (run === null || !isRunActive(run)) return
    await delay(25)
  }
}

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

  if (options.submissionDoor !== 'enqueue') {
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

  // T-01770 Phase C: a synchronous caller (ACP/Discord round-trip via
  // dispatchTurnForSession) blocks until the Claude turn completes; the async
  // reply-bridge callers pass waitForCompletion:false and get status:'started'.
  if (!shouldBlockForBrokerTurnCompletion(options.waitForCompletion)) {
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

export async function startInteractiveTmuxBrokerRuntime(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  turnIntent: HrcRuntimeIntent,
  diagnosticRunId: string,
  flagOptions: DispatchRunPersistenceOptions & {
    flagEnvName: string
    allowedBrokerDriver: InteractiveTmuxBrokerDriver
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
    onAccepted?: ((runtime: HrcRuntimeSnapshot) => Promise<void> | void) | undefined
    coldBirthPrompt?: string | undefined
    includePrimingForColdBirthPrompt?: boolean | undefined
    onColdBirthPromptRoute?: ((rodeLaunch: boolean) => void) | undefined
  }
): Promise<HrcRuntimeSnapshot> {
  const preparedActuatorSplit = await prepareActuatorSplitIntent(turnIntent)
  const effectiveTurnIntent = preparedActuatorSplit.intent
  const now = timestamp()
  const runtimeId = `rt-${randomUUID()}`
  const timing = createPrecompileLaunchTimingContext(
    'interactive',
    runtimeId,
    this.options.stateRoot
  )

  const hrcDispatchEnv = buildInteractiveBrokerDispatchEnv({
    baseEnv: mergeEnv(buildHrcCorrelationEnv(effectiveTurnIntent), effectiveTurnIntent.launch),
    db: this.db,
    runtimeRoot: this.options.runtimeRoot,
    hostSessionId: session.hostSessionId,
    runtimeId,
    mailStopSocket: this.options.socketPath,
  })
  const directPlan =
    effectiveTurnIntent.harness.id === 'agent-harness'
      ? await buildDirectInteractiveAgentHarnessPlan({
          intent: effectiveTurnIntent,
          session,
          runtimeId,
          runId: diagnosticRunId,
          responseFormat: flagOptions.responseFormat,
          dispatchEnv: hrcDispatchEnv,
          now,
          agentHarnessCommand: resolveBrokerBinary('agent-harness-tmux'),
        })
      : undefined
  // Only compiler-selected interactive tmux profiles own launch prompt
  // material. Direct agent-harness uses broker initialInput, so it keeps a
  // promptless boot and the caller prompt takes the ordinary admission door
  // afterwards. This compile-only intent is deliberately not persisted below.
  const compileIntent =
    flagOptions.coldBirthPrompt !== undefined && directPlan === undefined
      ? {
          ...effectiveTurnIntent,
          initialPrompt: flagOptions.coldBirthPrompt,
          ...(flagOptions.includePrimingForColdBirthPrompt ? {} : { omitPriming: true }),
        }
      : effectiveTurnIntent
  if (directPlan !== undefined && hrcDispatchEnv['HARNESS_PI_AUTH_STORE'] === undefined) {
    hrcDispatchEnv['HARNESS_PI_AUTH_STORE'] = join(homedir(), '.pi', 'agent', 'auth.json')
  }
  const client = directPlan === undefined ? await startAspcFacadeBrokerClient(timing) : undefined
  let handedOffToController = false
  try {
    const compiled =
      directPlan === undefined
        ? await compileBrokerRuntimePlan(
            {
              intent: compileIntent,
              hostSessionId: session.hostSessionId,
              generation: session.generation,
              dispatchEnv: hrcDispatchEnv,
              // T-01770 Phase D: arriving here means there is no live TUI to reuse
              // (the reuse predicates return an already-live runtime first). A fresh
              // first launch must NOT attempt continuation — passing session.continuation
              // for codex would emit `codex resume <rollout>` (or `claude --continue`),
              // replaying a transcript and, when the recorded cwd differs, blocking the
              // TUI on a "choose working directory to resume" picker (commit 120eb7a).
              // We REVERSE that disable ONLY for the safe recreate cases (T-04836):
              //   - claude-code-tmux + a captured Claude session id ⇒ `--resume <uuid>`
              //   - codex-cli-tmux + an openai/kind:session/UUID continuation ⇒
              //     `codex resume <uuid>` (explicit-id form; NOT no-arg picker resume).
              // decideInteractiveTmuxBrokerContinuation enforces those gates; all other
              // cases (incl. pi-tui-tmux, non-UUID/non-session codex keys) stay undefined.
              continuation: toRuntimeContinuationRef(
                decideInteractiveTmuxBrokerContinuation({
                  allowedBrokerDriver: flagOptions.allowedBrokerDriver,
                  sessionContinuation: automaticContinuationForSession(this.db, session),
                })
              ),
              responseFormat: flagOptions.responseFormat,
            },
            {
              compileHarnessInvocation: (request) => {
                if (client === undefined) {
                  throw new Error('ASPC facade client is unavailable for compiler-backed launch')
                }
                return client.compileHarnessInvocation(request)
              },
              timing,
              ids: {
                requestId: () => `req-${randomUUID()}`,
                operationId: () => `op-${randomUUID()}`,
                runtimeId: () => runtimeId,
                invocationId: () => `inv-${randomUUID()}`,
                initialInputId: () => `input-${randomUUID()}`,
                runId: () => diagnosticRunId,
                traceId: () => `trace-${randomUUID()}`,
              },
            }
          )
        : {
            admitted: true as const,
            ...directPlan,
            dispatchEnv: hrcDispatchEnv,
            diagnostics: [],
          }

    if (!compiled.admitted) {
      writeServerLog('WARN', 'broker.compile_admission_rejected', {
        hostSessionId: session.hostSessionId,
        hostId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runId: diagnosticRunId,
        allocatedRunId: compiled.identity.runId,
        runtimeId: compiled.identity.runtimeId,
        invocationId: compiled.identity.invocationId,
        requestId: compiled.identity.requestId,
        operationId: compiled.identity.operationId,
        traceId: compiled.identity.traceId,
        code: compiled.code,
        diagnostics: compiled.diagnostics,
        route: 'interactive-broker',
        flag: flagOptions.flagEnvName,
        harnessProvider: effectiveTurnIntent.harness.provider,
        harnessId: effectiveTurnIntent.harness.id,
        harnessInteractive: effectiveTurnIntent.harness.interactive,
        preferredMode: effectiveTurnIntent.execution?.preferredMode,
        cwd: effectiveTurnIntent.placement.cwd,
        projectRoot: effectiveTurnIntent.placement.projectRoot,
        runMode: effectiveTurnIntent.placement.runMode,
        brokerDriver: flagOptions.allowedBrokerDriver,
      })
      throw new HrcRuntimeUnavailableError('interactive broker compile/admission rejected', {
        hostSessionId: session.hostSessionId,
        runId: diagnosticRunId,
        code: compiled.code,
        diagnostics: compiled.diagnostics,
        route: 'interactive-broker',
        flag: flagOptions.flagEnvName,
      })
    }

    assertBrokerPermissionPolicyAdmitted({
      mode: compiled.profile.policy.permissionPolicy.mode,
      hostSessionId: session.hostSessionId,
      runId: diagnosticRunId,
      route: 'interactive-broker',
    })
    const actuatorSplitAuthority = await assertActuatorSplitAdmission({
      intent: effectiveTurnIntent,
      route: 'interactive-broker',
      startRequest: compiled.startRequest,
      preparedAuthority: preparedActuatorSplit.authority,
    })

    const route = decideInteractiveTmuxExecutionRoute(compileIntent, compiled.profile, {
      brokerFlagEnabled: true,
      allowedBrokerDriver: flagOptions.allowedBrokerDriver,
    })
    if (route !== 'broker') {
      throw new HrcRuntimeUnavailableError(
        `interactive broker profile did not resolve to ${flagOptions.allowedBrokerDriver}`,
        {
          hostSessionId: session.hostSessionId,
          runId: diagnosticRunId,
          brokerDriver: compiled.profile.brokerDriver,
          brokerTerminal: compiled.profile.brokerTerminal,
          route: 'interactive-broker',
          flag: flagOptions.flagEnvName,
        }
      )
    }
    const coldBirthPromptRodeLaunch =
      flagOptions.coldBirthPrompt !== undefined &&
      directPlan === undefined &&
      isInteractiveTmuxBrokerProfile(compiled.profile)
    flagOptions.onColdBirthPromptRoute?.(coldBirthPromptRodeLaunch)

    const durableInteractiveRoute =
      directPlan !== undefined
        ? ('durable-ipc' as const)
        : decideBrokerDurableInteractiveRoute({
            durableIpcEnabled: resolveBrokerDurableIpcEnabled(this.options),
            endpointKind: 'unix-jsonrpc-ndjson',
            interactionMode: 'interactive',
          })
    let brokerClient: ReturnType<typeof asBrokerClient> | undefined
    if (durableInteractiveRoute === 'durable-ipc') {
      await client?.close().catch(() => undefined)
    } else {
      if (client === undefined) {
        throw new Error('ASPC facade client is unavailable for legacy interactive broker launch')
      }
      brokerClient = asBrokerClient(client)
    }

    handedOffToController = true
    const mergedDispatchEnv = { ...(compiled.dispatchEnv ?? {}), ...hrcDispatchEnv }
    const result = await this.getHarnessBrokerController().start({
      plan: compiled.plan,
      profile: compiled.profile,
      startRequest: compiled.startRequest,
      specHash: compiled.specHash,
      startRequestHash: compiled.startRequestHash,
      identity: compiled.identity,
      runtimeAuthority: actuatorSplitRuntimeAuthority(actuatorSplitAuthority),
      requestedResponseFormat: toBrokerResponseFormat(flagOptions.responseFormat),
      ...dispatchRunPersistence(flagOptions),
      dispatchEnv: filterBrokerDispatchEnvForLockedEnv(mergedDispatchEnv, compiled.startRequest),
      brokerEnv: extractPiSdkBrokerCredentialEnv(mergedDispatchEnv, compiled.startRequest),
      ...(brokerClient ? { brokerClient } : {}),
      ...(flagOptions.attachBeforeInvocationStart
        ? { attachBeforeInvocationStart: flagOptions.attachBeforeInvocationStart }
        : {}),
      routeDecision: {
        route: 'broker',
        flag: flagOptions.flagEnvName,
        selectedBy: 'decideInteractiveTmuxExecutionRoute',
        durableInteractiveRoute,
        brokerTransport:
          durableInteractiveRoute === 'durable-ipc'
            ? 'unix-jsonrpc-ndjson'
            : 'stdio-jsonrpc-ndjson',
        durableRouteSelectedBy: 'decideBrokerDurableInteractiveRoute',
      },
      lifecyclePolicy: resolveLifecyclePolicyOverlay({
        routeId: `interactive-broker:${compiled.profile.brokerDriver}`,
        brokerRoute: true,
      }),
      ...(flagOptions.onAccepted
        ? {
            onAccepted: async (graph) => {
              await flagOptions.onAccepted?.(graph.runtime)
            },
          }
        : {}),
    })

    if (!result.ok) {
      const acceptedRun = this.db.runs.getByRunId(diagnosticRunId)
      if (acceptedRun !== null && isRunActive(acceptedRun)) {
        const failedAt = timestamp()
        this.db.runs.markCompleted(diagnosticRunId, {
          status: 'failed',
          completedAt: failedAt,
          updatedAt: failedAt,
          errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
          errorMessage: result.error.message,
        })
        this.db.brokerInvocations.update(String(compiled.identity.invocationId), {
          invocationState: 'failed',
          updatedAt: failedAt,
        })
        this.db.runtimeOperations.update(String(compiled.identity.operationId), {
          status: 'failed',
          completedAt: failedAt,
          updatedAt: failedAt,
          errorCode: result.error.code,
          errorMessage: result.error.message,
        })
        this.db.runtimes.update(runtimeId, {
          status: 'failed',
          statusChangedAt: failedAt,
          activeRunId: diagnosticRunId,
          updatedAt: failedAt,
          runtimeStateJson: {
            ...(this.db.runtimes.getByRuntimeId(runtimeId)?.runtimeStateJson ?? {}),
            status: 'failed',
            updatedAt: failedAt,
            startFailure: {
              code: result.error.code,
              message: result.error.message,
            },
          },
        })
        this.notifyEvent(
          appendHrcEvent(this.db, 'turn.failed', {
            ts: failedAt,
            hostSessionId: session.hostSessionId,
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
            generation: session.generation,
            runId: diagnosticRunId,
            runtimeId,
            transport: 'tmux',
            errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
            payload: {
              code: result.error.code,
              message: result.error.message,
              phase: 'broker-invocation-start',
            },
          })
        )
      }
      if (
        result.error.code === 'unsupported_capability' &&
        flagOptions.responseFormat?.kind === 'json_schema'
      ) {
        throw new HrcUnprocessableEntityError(
          HrcErrorCode.UNSUPPORTED_CAPABILITY,
          result.error.message,
          result.error.detail
        )
      }
      const externalToolchainFailure = typeof result.error.detail['toolchainSource'] === 'string'
      throw new HrcRuntimeUnavailableError(
        externalToolchainFailure ? result.error.message : 'interactive broker start failed',
        {
          hostSessionId: session.hostSessionId,
          runId: diagnosticRunId,
          code: result.error.code,
          message: result.error.message,
          route: 'interactive-broker',
          flag: flagOptions.flagEnvName,
          ...result.error.detail,
        }
      )
    }

    // Match the headless authority invariant: rejected compilation, policy,
    // route selection, and controller starts must not become the implicit plan
    // used by later automatic dispatches.
    this.db.sessions.updateIntent(session.hostSessionId, effectiveTurnIntent, timestamp(), timing)
    return result.runtime
  } catch (error) {
    if (!handedOffToController) {
      await client?.close().catch(() => undefined)
    }
    throw error
  }
}

export const brokerInteractiveHandlersMethods = {
  handleHeadlessDispatchTurn,
  handleHeadlessBrokerDispatchTurn,
  handleInteractiveTmuxBrokerDispatchTurn,
  executeInteractiveBrokerInputTurn,
  deliverReassociatedBrokerTmuxInput,
  startInteractiveTmuxBrokerRuntime,
  getHarnessBrokerController,
}

export type BrokerInteractiveHandlersMethods = typeof brokerInteractiveHandlersMethods
