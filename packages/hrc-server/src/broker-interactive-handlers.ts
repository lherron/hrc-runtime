import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  HRC_QUEUED_TO_LIVE_HARNESS_WARNING,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
} from 'hrc-core'
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
import { buildDirectInteractiveAgentHarnessPlan } from './agent-spaces-adapter/direct-agent-harness.js'
import {
  BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
  rejectedBrokerAdoptionPaths,
} from './broker/adoption-root.js'
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import { withDirectTmuxDegradedControlState } from './broker/runtime-state.js'
import { armFirstTurnWatch } from './first-turn-watch.js'
import { appendHrcEvent, createUserPromptPayload } from './hrc-event-helper.js'
import { buildManagedBrokerDispatchEnv } from './managed-broker-runtime-env.js'
import { runtimeActivityPatch } from './runtime-activity.js'

import type { InvocationInput } from 'spaces-harness-broker-protocol'
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
  assertBrokerRuntimeReusableAdmission,
  assertRuntimeNotBusy,
  classifyBrokerInputFailure,
  isBrokerRuntimeQueueCapable,
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
  dispatchOriginRunFields,
  dispatchRunPersistence,
} from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
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

  const continuation = runtime.continuation ?? session.continuation
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
    whenBusy?: 'reject' | 'steer' | 'steer_else_queue' | undefined
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
      assertBrokerRuntimeReusableAdmission(this.db, reusableRuntime, options)
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
        assertBrokerRuntimeReusableAdmission(this.db, recovered, options)
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
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): Promise<Response> {
  const turnIntent: HrcRuntimeIntent =
    prompt.length > 0 ? { ...intent, initialPrompt: prompt } : intent
  // T-07202: persisted semantic DMs can enter this interactive cold-start
  // branch concurrently. T-06313 protected only the headless broker branch;
  // this branch published its boot but never joined an existing one, so each
  // crossing DM started and then overwrote the same map entry. Join the
  // already-published host-session boot and deliver this caller's own input
  // through the winner. Keep this route opt-in so reattach and non-DM dispatch
  // policy remain outside this cold-provision fix.
  const existingBootOperation = flagOptions.joinInFlightRuntimeStart
    ? this.runtimeStartOperations?.get(session.hostSessionId)
    : undefined
  if (existingBootOperation) {
    const runtime = await existingBootOperation
    assertActuatorSplitRuntimeReuse(turnIntent, runtime)
    return await this.executeInteractiveBrokerInputTurn(session, runtime, prompt, runId, {
      waitForCompletion: flagOptions.waitForCompletion,
      responseFormat: flagOptions.responseFormat,
      ...dispatchRunPersistence(flagOptions),
    })
  }
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
  const bootOperation = this.startInteractiveTmuxBrokerRuntime(session, turnIntent, runId, {
    flagEnvName: flagOptions.flagEnvName,
    allowedBrokerDriver: flagOptions.allowedBrokerDriver,
    ...(flagOptions.attachBeforeInvocationStart
      ? { attachBeforeInvocationStart: flagOptions.attachBeforeInvocationStart }
      : {}),
    responseFormat: flagOptions.responseFormat,
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
  })
    .then((runtime) => {
      // Claude broker dispatch through non-attached surfaces (hrcchat,
      // agent-loop) starts a tmux TUI with no operator terminal watching it.
      // Presentation stays best-effort and outside the acceptance boundary.
      if (flagOptions.allowedBrokerDriver === 'claude-code-tmux') {
        void this.publishPresentation(runtime, {
          operatorAttachPending: flagOptions.attachBeforeInvocationStart !== undefined,
        })
      }
      if (!acceptedSettled) resolveAccepted(runtime)
      return runtime
    })
    .finally(() => {
      this.runtimeStartOperations?.delete(session.hostSessionId)
    })
  this.runtimeStartOperations?.set(session.hostSessionId, bootOperation)
  void bootOperation.catch((error) => {
    if (!acceptedSettled) rejectAccepted(error)
  })

  if (!shouldBlockForBrokerTurnCompletion(flagOptions.waitForCompletion)) {
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
  // T-01770 Phase C: block the synchronous caller on the first broker turn
  // (the start delivers the initial prompt under diagnosticRunId). Async
  // reply-bridge callers pass waitForCompletion:false to get status:'started'.
  await this.waitForInteractiveBrokerRunCompletion(runId, runtime.runtimeId)
  return json({
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'tmux',
    status: 'completed',
    supportsInFlightInput: true,
  } satisfies DispatchTurnResponseBase)
}

export async function executeInteractiveBrokerInputTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: DispatchRunPersistenceOptions & {
    waitForCompletion?: boolean | undefined
    whenBusy?: 'reject' | 'steer' | 'steer_else_queue' | undefined
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

  const activeRun =
    runtime.activeRunId !== undefined ? this.db.runs.getByRunId(runtime.activeRunId) : null
  const queuedMode = activeRun !== null && isRunActive(activeRun) && activeRun.runId !== runId
  if (options.whenBusy === 'reject' && queuedMode) {
    assertRuntimeNotBusy(this.db, runtime)
  }
  // T-07203 (spec r7): steer-class dispatches run the shared two-phase flow —
  // capability gate, reject-probe, write-ahead ledger, honest disposition map.
  // The interactive route reports presented_to_live_harness, never admission.
  // T-07214: the best-effort class shares the flow; a 'floor' result falls
  // through to the ordinary dispatch below (broker queue + honest warning).
  if (options.whenBusy === 'steer' || options.whenBusy === 'steer_else_queue') {
    const steered = await this.executeSteerClassDispatch(session, runtime, prompt, {
      route: 'interactive',
      responseFormat: options.responseFormat,
      bestEffort: options.whenBusy === 'steer_else_queue',
      ...(options.dispatchIdempotencyKey !== undefined
        ? { dispatchIdempotencyKey: options.dispatchIdempotencyKey }
        : {}),
    })
    if (steered !== 'floor') return steered
  }
  const queueCapable = isBrokerRuntimeQueueCapable(this.db, runtime)
  const inputId = `input-${randomUUID()}` as InvocationInput['inputId']
  const now = timestamp()

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
    dispatchedInputId: inputId,
    dispatchIdempotencyKey: options.dispatchIdempotencyKey,
    ...dispatchOriginRunFields(options),
  })
  if (options.repairCorrelation !== undefined) {
    this.db.runs.setCorrelationJson(runId, JSON.stringify(options.repairCorrelation))
  }

  // T-07235 — a prompt dispatched to an ALREADY-LIVE generation (a DM to a
  // runtime that was started promptless). armFirstTurnWatch itself no-ops once
  // the generation has produced a turn; the queued guard is the other half:
  // a prompt sitting behind an active turn is not yet before the harness, so
  // its turn.started is legitimately deferred and must not start a clock. No
  // coverage is lost — a fresh wedged runtime is armed by the START path, and
  // a runtime with an active turn has by definition already produced one.
  if (!queuedMode) {
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

  if (!queuedMode) {
    this.db.runtimes.update(runtime.runtimeId, {
      activeRunId: runId,
      status: 'busy',
      statusChangedAt: now,
      ...runtimeActivityPatch(this.db, runtime.runtimeId, {
        source: 'turn',
        occurredAt: now,
        updatedAt: now,
      }),
    })
    this.db.brokerInvocations.update(invocationId, { runId, updatedAt: now })
  }

  const input: InvocationInput = {
    inputId,
    kind: 'user',
    content: [{ type: 'text', text: prompt }],
    ...(toBrokerResponseFormat(options.responseFormat) !== undefined
      ? { responseFormat: toBrokerResponseFormat(options.responseFormat) }
      : {}),
    metadata: {
      runId,
      ...(options.repairCorrelation !== undefined
        ? { repairCorrelationJson: JSON.stringify(options.repairCorrelation) }
        : {}),
    },
  }

  const dispatchToBroker = () =>
    this.getHarnessBrokerController().dispatchInput({
      runtimeId: runtime.runtimeId,
      input,
      ...(queueCapable ? { policy: { whenBusy: 'queue' as const } } : {}),
    })

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

  if (!result.ok || !result.response.accepted) {
    const completedAt = timestamp()
    const errorMessage = result.ok
      ? (result.response.reason ?? 'broker rejected invocation input')
      : result.error.message
    const brokerErrorCode = result.ok ? undefined : result.error.code
    const brokerInputTimeout = brokerErrorCode === 'broker_input_timeout'
    if (
      !result.ok &&
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
    const brokerBindingMissing = !result.ok && result.error.code === 'broker_runtime_not_active'
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
    if (brokerInputTimeout || !queuedMode) {
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
                ...(brokerInputTimeout ? { code: 'broker_input_timeout', inputId } : {}),
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
      ...(queuedMode ? { warnings: [HRC_QUEUED_TO_LIVE_HARNESS_WARNING] } : {}),
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
    ...(queuedMode ? { warnings: [HRC_QUEUED_TO_LIVE_HARNESS_WARNING] } : {}),
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
              intent: effectiveTurnIntent,
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
                  sessionContinuation: session.continuation,
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

    const route = decideInteractiveTmuxExecutionRoute(effectiveTurnIntent, compiled.profile, {
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
