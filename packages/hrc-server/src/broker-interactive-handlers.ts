import { randomUUID } from 'node:crypto'

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
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import { withDirectTmuxDegradedControlState } from './broker/runtime-state.js'
import { appendHrcEvent, createUserPromptPayload } from './hrc-event-helper.js'
import { runtimeActivityPatch } from './runtime-activity.js'

import { BrokerClient } from 'spaces-harness-broker-client'
import type { InvocationInput } from 'spaces-harness-broker-protocol'
import {
  decideBrokerDurableInteractiveRoute,
  decideInteractiveTmuxBrokerContinuation,
  decideInteractiveTmuxExecutionRoute,
  filterBrokerDispatchEnvForLockedEnv,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
  shouldBlockForBrokerTurnCompletion,
  shouldUseHeadlessSdkExecutor,
  toRuntimeContinuationRef,
} from './broker-decisions.js'
import type { InteractiveTmuxBrokerDriver } from './broker-decisions.js'
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
import type { AttachBeforeInvocationStartOption } from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { brokerLeaseIdsMatch, reattachDurableBrokerForDispatch } from './startup-reconcile.js'
import { createTmuxManager } from './tmux.js'
import {
  assertRuntimeSupportsResponseFormat,
  toBrokerResponseFormat,
} from './turn-response-format.js'

// Imported for the brokerInteractiveHandlersMethods table below and re-exported
// (export-list at end of file) so the public surface is preserved.
import {
  getHarnessBrokerController,
  spawnBrokerHeadlessViewer,
  spawnHeadlessClaudeViewer,
} from './broker-interactive-handlers/controller-factory.js'

type DispatchTurnResponseBase = Omit<DispatchTurnResponse, 'startIdentity' | 'observation'>

type JsonRepairRunCorrelation = {
  kind: 'json_repair'
  sourceRunId: string
  failedValidationRunId: string
  repairRunId: string
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
export { getHarnessBrokerController, spawnBrokerHeadlessViewer, spawnHeadlessClaudeViewer }

export async function handleHeadlessDispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: {
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
  options: {
    waitForCompletion?: boolean | undefined
    whenBusy?: 'reject' | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  } = {}
): Promise<Response> {
  // A lifecycle-only `hrc start` may still be provisioning this session when
  // a prompt-bearing start/turn arrives. Admit the prompt durably before
  // waiting for boot so aborting the client only stops its wait, never the
  // delivery. Reuse the one boot operation; a second broker start would split
  // the session.
  const bootOperation = this.runtimeStartOperations.get(session.hostSessionId)
  if (bootOperation) {
    this.enqueueDurableHeadlessTurnInput(session, prompt, runId, {
      source: 'boot',
      responseFormat: options.responseFormat,
    })
    const bootedRuntime = await bootOperation
    return await this.dispatchQueuedHeadlessTurnInput(
      session,
      bootedRuntime,
      prompt,
      runId,
      options
    )
  }

  const reusableRuntime = getReusableHeadlessRuntimeForSession(
    this.db,
    session.hostSessionId,
    intent.harness.provider,
    intent.harness.id
  )
  const missingDescriptorRuntime = findBrokerRuntimeMissingDescriptor({
    runtimes: this.db.runtimes.listByHostSessionId(session.hostSessionId),
    provider: intent.harness.provider,
    harnessId: intent.harness.id,
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
    if (
      reusableRuntime.controllerKind === 'harness-broker' &&
      reusableRuntime.activeInvocationId !== undefined
    ) {
      assertBrokerRuntimeReusableAdmission(this.db, reusableRuntime, options)
      if (this.db.runs.getByRunId(runId)?.status === 'queued') {
        return await this.dispatchQueuedHeadlessTurnInput(
          session,
          reusableRuntime,
          prompt,
          runId,
          options
        )
      }
      return await this.executeHeadlessBrokerInputTurn(
        session,
        reusableRuntime,
        prompt,
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
    intent.harness.provider,
    intent.harness.id
  )
  if (durableHeadless) {
    const reattached = await reattachDurableBrokerForDispatch(this.db, durableHeadless, {
      controller: this.getHarnessBrokerController(),
      brokerUnixClientFactory:
        this.brokerUnixClientFactory ??
        ((options) => BrokerClient.connectUnix(options) as ReturnType<BrokerUnixClientFactory>),
    })
    const recovered = reattached ? this.db.runtimes.getByRuntimeId(durableHeadless.runtimeId) : null
    if (recovered && recovered.activeInvocationId !== undefined) {
      writeServerLog('INFO', 'headless.durable_reattach.reused', {
        hostSessionId: session.hostSessionId,
        runtimeId: recovered.runtimeId,
      })
      assertBrokerRuntimeReusableAdmission(this.db, recovered, options)
      return await this.executeHeadlessBrokerInputTurn(session, recovered, prompt, runId, options)
    }
    // Reattach failed or the persisted invocation is gone: terminate the cold
    // durable runtime (reaps its broker dispose path; the orphan sweeper reaps the
    // leased substrate since a terminal runtime no longer claims it) BEFORE we
    // provision a fresh broker below — no second live broker tmux may remain.
    writeServerLog('WARN', 'headless.durable_reattach.failed_reprovision', {
      hostSessionId: session.hostSessionId,
      runtimeId: durableHeadless.runtimeId,
      reattached,
    })
    await this.terminateRuntime(durableHeadless, { dropContinuation: true }).catch(
      (error: unknown) => {
        writeServerLog('WARN', 'headless.durable_reattach.reprovision_cleanup_failed', {
          runtimeId: durableHeadless.runtimeId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    )
  }

  return await this.executeHeadlessBrokerStartTurn(session, intent, prompt, runId, options)
}

export async function handleInteractiveTmuxBrokerDispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  flagOptions: {
    flagEnvName: string
    allowedBrokerDriver: InteractiveTmuxBrokerDriver
    waitForCompletion?: boolean | undefined
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): Promise<Response> {
  const turnIntent: HrcRuntimeIntent =
    prompt.length > 0 ? { ...intent, initialPrompt: prompt } : intent
  const runtime = await this.startInteractiveTmuxBrokerRuntime(session, turnIntent, runId, {
    flagEnvName: flagOptions.flagEnvName,
    allowedBrokerDriver: flagOptions.allowedBrokerDriver,
    ...(flagOptions.attachBeforeInvocationStart
      ? { attachBeforeInvocationStart: flagOptions.attachBeforeInvocationStart }
      : {}),
    responseFormat: flagOptions.responseFormat,
  })

  // Claude broker dispatch through non-attached surfaces (hrcchat, agent-loop)
  // starts a tmux TUI with no operator terminal watching it. Pop a best-effort
  // viewer; spawnBrokerHeadlessViewer owns the global policy gate and dedupe.
  if (flagOptions.allowedBrokerDriver === 'claude-code-tmux') {
    await this.spawnBrokerHeadlessViewer(runtime, {
      operatorAttachPending: flagOptions.attachBeforeInvocationStart !== undefined,
    })
  }

  // T-01770 Phase C: block the synchronous caller on the first broker turn
  // (the start delivers the initial prompt under diagnosticRunId). Async
  // reply-bridge callers pass waitForCompletion:false to get status:'started'.
  if (!shouldBlockForBrokerTurnCompletion(flagOptions.waitForCompletion)) {
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
  options: {
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

  const activeRun =
    runtime.activeRunId !== undefined ? this.db.runs.getByRunId(runtime.activeRunId) : null
  const queuedMode = activeRun !== null && isRunActive(activeRun) && activeRun.runId !== runId
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
  })
  if (options.repairCorrelation !== undefined) {
    this.db.runs.setCorrelationJson(runId, JSON.stringify(options.repairCorrelation))
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
  if (
    !result.ok &&
    result.error.code === 'broker_runtime_not_active' &&
    runtime.transport === 'tmux' &&
    (await reattachDurableBrokerForDispatch(this.db, runtime, {
      controller: this.getHarnessBrokerController(),
      brokerUnixClientFactory:
        this.brokerUnixClientFactory ??
        ((options) => BrokerClient.connectUnix(options) as ReturnType<BrokerUnixClientFactory>),
    }))
  ) {
    result = await dispatchToBroker()
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
  } satisfies DispatchTurnResponseBase)
}

export async function deliverReassociatedBrokerTmuxInput(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string
): Promise<boolean> {
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
  flagOptions: {
    flagEnvName: string
    allowedBrokerDriver: InteractiveTmuxBrokerDriver
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): Promise<HrcRuntimeSnapshot> {
  const now = timestamp()
  const runtimeId = `rt-${randomUUID()}`
  const timing = createPrecompileLaunchTimingContext('interactive', runtimeId)
  this.db.sessions.updateIntent(session.hostSessionId, turnIntent, now, timing)

  const client = await startAspcFacadeBrokerClient(timing)
  let handedOffToController = false
  const hrcDispatchEnv = mergeEnv(buildHrcCorrelationEnv(turnIntent), turnIntent.launch)
  try {
    const compiled = await compileBrokerRuntimePlan(
      {
        intent: turnIntent,
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
        compileHarnessInvocation: (request) => client.compileHarnessInvocation(request),
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
        harnessProvider: turnIntent.harness.provider,
        harnessId: turnIntent.harness.id,
        harnessInteractive: turnIntent.harness.interactive,
        preferredMode: turnIntent.execution?.preferredMode,
        cwd: turnIntent.placement.cwd,
        projectRoot: turnIntent.placement.projectRoot,
        runMode: turnIntent.placement.runMode,
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

    const route = decideInteractiveTmuxExecutionRoute(turnIntent, compiled.profile, {
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

    const durableInteractiveRoute = decideBrokerDurableInteractiveRoute({
      durableIpcEnabled: resolveBrokerDurableIpcEnabled(this.options),
      endpointKind: 'unix-jsonrpc-ndjson',
      interactionMode: 'interactive',
    })
    const brokerClient =
      durableInteractiveRoute === 'durable-ipc' ? undefined : asBrokerClient(client)
    if (durableInteractiveRoute === 'durable-ipc') {
      await client.close().catch(() => undefined)
    }

    handedOffToController = true
    const result = await this.getHarnessBrokerController().start({
      plan: compiled.plan,
      profile: compiled.profile,
      startRequest: compiled.startRequest,
      specHash: compiled.specHash,
      startRequestHash: compiled.startRequestHash,
      identity: compiled.identity,
      requestedResponseFormat: toBrokerResponseFormat(flagOptions.responseFormat),
      dispatchEnv: filterBrokerDispatchEnvForLockedEnv(
        mergeEnv(compiled.dispatchEnv ?? {}, hrcDispatchEnv),
        compiled.startRequest
      ),
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
    })

    if (!result.ok) {
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
      throw new HrcRuntimeUnavailableError('interactive broker start failed', {
        hostSessionId: session.hostSessionId,
        runId: diagnosticRunId,
        code: result.error.code,
        message: result.error.message,
        route: 'interactive-broker',
        flag: flagOptions.flagEnvName,
      })
    }

    return result.runtime
  } catch (error) {
    if (!handedOffToController) {
      await client.close().catch(() => undefined)
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
  spawnBrokerHeadlessViewer,
  spawnHeadlessClaudeViewer,
  getHarnessBrokerController,
}

export type BrokerInteractiveHandlersMethods = typeof brokerInteractiveHandlersMethods
