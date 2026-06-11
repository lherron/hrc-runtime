import { randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'

import { dirname, join } from 'node:path'

import { HrcErrorCode, HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'

import { asBrokerClient } from './agent-spaces-adapter/aspc-facade-client.js'
import { buildHrcCorrelationEnv, mergeEnv } from './agent-spaces-adapter/cli-adapter.js'
import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import {
  type BrokerTmuxAllocation,
  type BrokerTmuxAllocator,
  type BrokerTmuxLease,
  type BrokerUnixClientFactory,
  type BrokerWindowIdentity,
  HarnessBrokerController,
} from './broker/controller.js'
import { BrokerEventMapper } from './broker/event-mapper.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import type {
  BrokerRuntimeEndpoint,
  BrokerRuntimePresentation,
  BrokerRuntimeSubstrate,
} from './broker/runtime-hosting.js'
import { withDirectTmuxDegradedControlState } from './broker/runtime-state.js'
import { appendHrcEvent, createUserPromptPayload } from './hrc-event-helper.js'

import { BrokerClient } from 'spaces-harness-broker-client'
import type { InvocationInput } from 'spaces-harness-broker-protocol'
import {
  decideBrokerDurableInteractiveRoute,
  decideInteractiveTmuxBrokerContinuation,
  decideInteractiveTmuxExecutionRoute,
  filterBrokerDispatchEnvForLockedEnv,
  getBrokerRuntimeTmuxAttachTarget,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
  shouldBlockForBrokerTurnCompletion,
  shouldUseHeadlessSdkExecutor,
  toRuntimeContinuationRef,
} from './broker-decisions.js'
import type { InteractiveTmuxBrokerDriver } from './broker-decisions.js'
import { resolveBrokerDurableIpcEnabled, startAspcFacadeBrokerClient } from './option-resolvers.js'
import {
  assertRuntimeNotBusy,
  classifyBrokerInputFailure,
  isBrokerRuntimeQueueCapable,
  isRunActive,
  isTerminalBrokerInputFailure,
  isTerminalBrokerInvocationState,
} from './require-helpers.js'
import {
  getDurableHeadlessRuntimeForReattach,
  getReusableHeadlessRuntimeForSession,
} from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import type { AttachBeforeInvocationStartOption } from './server-types.js'
import type { HrcServerOptions } from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { brokerLeaseIdsMatch, reattachDurableBrokerForDispatch } from './startup-reconcile.js'
import {
  getBrokerIpcSocketPath,
  getBrokerTmuxSocketPath,
  preflightBrokerIpcSocketPath,
} from './tmux-socket.js'
import { createTmuxManager } from './tmux.js'

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
    continuation,
    updatedAt: now,
    lastActivityAt: now,
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
  this.db.runtimes.updateActivity(runtime.runtimeId, startedAt, startedAt)

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
    } satisfies DispatchTurnResponse)
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
  } = {}
): Promise<Response> {
  const reusableRuntime = getReusableHeadlessRuntimeForSession(
    this.db,
    session.hostSessionId,
    intent.harness.provider,
    intent.harness.id
  )
  if (reusableRuntime) {
    if (
      reusableRuntime.controllerKind === 'harness-broker' &&
      reusableRuntime.activeInvocationId !== undefined
    ) {
      // Broker FIFO queue support: when the active broker invocation's composed
      // capabilities.input.queue is true, a busy runtime can accept a second
      // concurrent turn — the broker queues it (whenBusy:'queue') and drains
      // FIFO after the active turn completes. Skip assertRuntimeNotBusy in
      // that case; the queued path inside executeHeadlessBrokerInputTurn keeps
      // the active run's pointers intact and relies on the event-mapper to
      // flip invocation.runId on input.accepted for the drained input.
      if (!isBrokerRuntimeQueueCapable(this.db, reusableRuntime)) {
        assertRuntimeNotBusy(this.db, reusableRuntime)
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
      if (!isBrokerRuntimeQueueCapable(this.db, recovered)) {
        assertRuntimeNotBusy(this.db, recovered)
      }
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
    spawnHeadlessViewer?: boolean | undefined
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
  })

  // A headless claude turn is coerced into this interactive broker runtime
  // (normalizeClaudeInteractiveBrokerIntent) and otherwise runs in a detached
  // tmux session nobody is watching. Pop a best-effort ghostmux viewer window
  // attached to its TUI so the run is observable. Claude-only, deduped per scope,
  // and fully non-blocking — a ghostmux failure must not break the turn.
  if (
    flagOptions.spawnHeadlessViewer === true &&
    flagOptions.allowedBrokerDriver === 'claude-code-tmux'
  ) {
    await this.spawnHeadlessClaudeViewer(runtime)
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
    } satisfies DispatchTurnResponse)
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
  } satisfies DispatchTurnResponse)
}

export async function executeInteractiveBrokerInputTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: { waitForCompletion?: boolean | undefined } = {}
): Promise<Response> {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcRuntimeUnavailableError('interactive broker runtime has no active invocation', {
      runtimeId: runtime.runtimeId,
      runId,
      route: 'interactive-broker',
    })
  }

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

  if (!queuedMode) {
    this.db.runtimes.update(runtime.runtimeId, {
      activeRunId: runId,
      status: 'busy',
      lastActivityAt: now,
      updatedAt: now,
    })
    this.db.brokerInvocations.update(invocationId, { runId, updatedAt: now })
  }

  const input: InvocationInput = {
    inputId,
    kind: 'user',
    content: [{ type: 'text', text: prompt }],
    metadata: { runId },
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
      } satisfies DispatchTurnResponse)
    }
    const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
    const brokerBindingMissing = !result.ok && result.error.code === 'broker_runtime_not_active'
    const terminalInputFailure =
      isTerminalBrokerInvocationState(invocation?.invocationState) ||
      isTerminalBrokerInputFailure(errorMessage)

    this.db.runs.markCompleted(runId, {
      status: 'failed',
      completedAt,
      updatedAt: completedAt,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage,
    })
    if (!queuedMode) {
      this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)
    }
    this.db.runtimes.update(runtime.runtimeId, {
      status: terminalInputFailure ? 'stale' : 'ready',
      lastActivityAt: completedAt,
      updatedAt: completedAt,
      ...(terminalInputFailure
        ? {
            runtimeStateJson: {
              ...(runtime.runtimeStateJson ?? {}),
              status: 'stale',
              updatedAt: completedAt,
              terminalInvocation: {
                invocationId,
                reason: errorMessage,
              },
            },
          }
        : {}),
    })
    const { headline, recommendation } = classifyBrokerInputFailure({
      label: 'interactive',
      errorMessage,
      brokerBindingMissing,
      terminalInputFailure,
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
    } satisfies DispatchTurnResponse)
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
  } satisfies DispatchTurnResponse)
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
    activeRunId: runId,
    lastActivityAt: startedAt,
    updatedAt: startedAt,
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
  }
): Promise<HrcRuntimeSnapshot> {
  const now = timestamp()
  this.db.sessions.updateIntent(session.hostSessionId, turnIntent, now)

  const client = await startAspcFacadeBrokerClient()
  let handedOffToController = false
  const hrcDispatchEnv = mergeEnv(buildHrcCorrelationEnv(turnIntent), turnIntent.launch)
  try {
    const compiled = await compileBrokerRuntimePlan(
      {
        intent: turnIntent,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        // T-01770 Phase D: arriving here means there is no live TUI to reuse
        // (the reuse predicates return an already-live runtime first). A fresh
        // first launch must NOT attempt continuation — passing session.continuation
        // for codex would emit `codex resume <rollout>` (or `claude --continue`),
        // replaying a transcript and, when the recorded cwd differs, blocking the
        // TUI on a "choose working directory to resume" picker (commit 120eb7a).
        // We REVERSE that disable ONLY for the safe recreate case: claude-code-tmux
        // + a captured Claude session id ⇒ pass the continuation so the adapter
        // emits `--resume <uuid>` (no cwd picker). All other cases stay undefined.
        continuation: toRuntimeContinuationRef(
          decideInteractiveTmuxBrokerContinuation({
            allowedBrokerDriver: flagOptions.allowedBrokerDriver,
            sessionContinuation: session.continuation,
          })
        ),
      },
      {
        compileHarnessInvocation: (request) => client.compileHarnessInvocation(request),
        ids: {
          requestId: () => `req-${randomUUID()}`,
          operationId: () => `op-${randomUUID()}`,
          runtimeId: () => `rt-${randomUUID()}`,
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
      dispatchEnv: filterBrokerDispatchEnvForLockedEnv(hrcDispatchEnv, compiled.startRequest),
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

/**
 * A named-window tmux manager sufficient for the durable broker allocator: it
 * hosts a 'broker' window (launched exec-form with the harness-broker Unix
 * command) and an idempotent 'tui' lease window under ONE per-runtime socket.
 */
export type DurableTmuxManagerLike = {
  initialize(): Promise<void>
  createWindowWithCommand(input: {
    sessionName: string
    windowName: string
    command: string
  }): Promise<BrokerWindowIdentity>
  createOrInspectWindow(input: {
    sessionName: string
    windowName: string
  }): Promise<BrokerWindowIdentity>
  inspectPaneProcess?(
    paneId: string
  ): Promise<{ command: string; pid: number; dead: boolean } | null>
  waitForAttachedClient?(
    target: string,
    options?: {
      timeoutMs?: number | undefined
      intervalMs?: number | undefined
      activeWindowId?: string | undefined
      activeWindowName?: string | undefined
    }
  ): Promise<void>
}

export type BrokerDurableTmuxAllocatorDeps = {
  tmuxManagerFactory: (opts: { socketPath: string }) => DurableTmuxManagerLike
  generateAttachToken: () => string
  now?: () => string
}

/**
 * T-01868 Ph2 — the SUBSTRATE+PRESENTATION-axis allocation primitive.
 *
 * Carves the per-runtime broker SUBSTRATE (a leased btmux server/session hosting
 * a 'broker' window launched EXEC-FORM with `harness-broker … --transport unix
 * <ipcSocket>`, an owner-only 0700 broker-IPC dir, an attach token referenced
 * redacted, and an event ledger), the durable ENDPOINT (unix-jsonrpc-ndjson), and
 * — conditioned on `presentation` — the PRESENTATION:
 *   - presentation='tmux-tui' adds the 'tui' window + operator attach command,
 *     reproducing TODAY's interactive allocation EXACTLY.
 *   - presentation='none' creates NO TUI window and NO attach command (headless
 *     substrate). This arm is wired in code but not yet selected by any route
 *     (headless cutover is Ph3).
 *
 * Returns the canonical {endpoint, substrate, presentation} hosting-state axes
 * plus the in-process extras the legacy flat BrokerTmuxAllocation needs (raw
 * attach token, the TUI pane lease, broker pid/command). The sockaddr_un HARD
 * preflight runs BEFORE any tmux spawn (T-01776) so an over-long path fails early
 * with a readable error, never a later bind/connect errno.
 */
export type BrokerSubstratePresentationKind = BrokerRuntimePresentation['kind']

export type AllocateBrokerSubstrateInput = {
  runtimeId: string
  hostSessionId: string
  generation: number
  driverKind: string
  endpoint: 'unix-jsonrpc-ndjson'
  presentation: BrokerSubstratePresentationKind
}

export type BrokerSubstrateAllocation = {
  endpoint: BrokerRuntimeEndpoint
  /** Always a leased-tmux substrate (the broker process pane). */
  substrate: Extract<BrokerRuntimeSubstrate, { kind: 'leased-tmux' }>
  presentation: BrokerRuntimePresentation
  // ── in-process extras for the legacy flat BrokerTmuxAllocation mapping ──
  allocatedAt: string
  /** Raw attach-token secret — used in-process only, NEVER persisted. */
  attachToken: string
  brokerCommand: string
  brokerPid?: number | undefined
  /** Full broker-window identity (incl. socket/session/window names). */
  brokerWindow: BrokerWindowIdentity
  /** Present only for presentation='tmux-tui'. */
  tuiWindow?: BrokerWindowIdentity | undefined
  /** The TUI pane lease handed to runtime.terminalSurface (tmux-tui only). */
  tuiLease?: BrokerTmuxLease | undefined
}

export async function allocateBrokerSubstrate(
  options: Pick<HrcServerOptions, 'runtimeRoot'>,
  deps: BrokerDurableTmuxAllocatorDeps,
  input: AllocateBrokerSubstrateInput
): Promise<BrokerSubstrateAllocation> {
  const now = deps.now ?? timestamp
  const { runtimeId, hostSessionId, generation, driverKind, presentation } = input

  const brokerIpcSocketPath = getBrokerIpcSocketPath(options, driverKind, runtimeId)
  // HARD preflight BEFORE any tmux spawn / IPC dir creation: an over-long
  // sockaddr_un path fails EARLY with a readable error, never a later
  // bind/connect errno.
  preflightBrokerIpcSocketPath(brokerIpcSocketPath)

  const btmuxSocketPath = getBrokerTmuxSocketPath(
    options as HrcServerOptions,
    driverKind,
    runtimeId
  )
  const ipcDir = dirname(brokerIpcSocketPath)
  await mkdir(dirname(btmuxSocketPath), { recursive: true })
  // Owner-only broker IPC dir (0700). mkdir mode is umask-masked, so chmod the
  // leaf explicitly to guarantee rwx------.
  await mkdir(ipcDir, { recursive: true, mode: 0o700 })
  await chmod(ipcDir, 0o700)

  // Allocate the attach token and persist it by REFERENCE (owner-only file). The
  // raw secret never enters runtime_state_json — only the redacted ref.
  const attachToken = deps.generateAttachToken()
  const attachTokenPath = join(ipcDir, 'attach.token')
  await writeFile(attachTokenPath, attachToken, { mode: 0o600 })

  const tmux = deps.tmuxManagerFactory({ socketPath: btmuxSocketPath })
  await tmux.initialize()

  const sessionName = `hrc-${driverKind}-${runtimeId}`
  // T-01801: wire the broker's durability surface so attach-replay across a daemon
  // restart works. WITHOUT `--event-ledger` the broker still advertises
  // attachReplay:true but has no on-disk ledger, so the post-restart
  // `invocation.eventsSince` replay fails ('no durable ledger configured') and the
  // runtime goes stale. The attach-identity flags (runtime/host-session/generation
  // + token file) arm the broker's latest-valid-attach-wins gate so it validates
  // the controller's attach token instead of accepting any peer.
  const eventLedgerPath = join(ipcDir, 'events.ndjson')
  const brokerCommand =
    `exec harness-broker run --transport unix --socket ${brokerIpcSocketPath}` +
    ` --event-ledger ${eventLedgerPath}` +
    ` --runtime-id ${runtimeId}` +
    ` --host-session-id ${hostSessionId}` +
    ` --generation ${generation}` +
    ` --attach-token-file ${attachTokenPath}`
  const brokerWindow = await tmux.createWindowWithCommand({
    sessionName,
    windowName: 'broker',
    command: brokerCommand,
  })

  // presentation='tmux-tui' adds the operator TUI window; presentation='none'
  // (headless substrate) creates no TUI window. Window-creation order (broker then
  // tui) is preserved from the pre-split allocator.
  const tuiWindow =
    presentation === 'tmux-tui'
      ? await tmux.createOrInspectWindow({ sessionName, windowName: 'tui' })
      : undefined

  // Capture the broker pane's running pid for persisted identity (best effort —
  // pane ids alone are known weak; the pid/command corroborate).
  let brokerPid: number | undefined
  if (typeof tmux.inspectPaneProcess === 'function') {
    const proc = await tmux.inspectPaneProcess(brokerWindow.paneId)
    if (proc && !proc.dead && proc.pid > 0) {
      brokerPid = proc.pid
    }
  }

  const endpoint: BrokerRuntimeEndpoint = {
    kind: 'unix-jsonrpc-ndjson',
    socketPath: brokerIpcSocketPath,
    attachTokenRef: { kind: 'file', path: attachTokenPath, redacted: true },
    protocolVersion: 'harness-broker/0.2',
  }
  const substrate: Extract<BrokerRuntimeSubstrate, { kind: 'leased-tmux' }> = {
    kind: 'leased-tmux',
    tmuxSocketPath: btmuxSocketPath,
    sessionName,
    brokerWindow: {
      sessionId: brokerWindow.sessionId,
      windowId: brokerWindow.windowId,
      paneId: brokerWindow.paneId,
    },
    generation,
    eventLedgerPath,
  }

  const base = {
    endpoint,
    substrate,
    allocatedAt: now(),
    attachToken,
    brokerCommand,
    ...(brokerPid !== undefined ? { brokerPid } : {}),
    brokerWindow,
  }

  if (!tuiWindow) {
    return { ...base, presentation: { kind: 'none' } }
  }

  // The lease handed to runtime.terminalSurface is the TUI pane (operators attach
  // here) — NEVER the broker pane.
  const tuiLease: BrokerTmuxLease = {
    kind: 'tmux-pane',
    ownership: 'hrc',
    socketPath: tuiWindow.socketPath,
    sessionId: tuiWindow.sessionId,
    windowId: tuiWindow.windowId,
    paneId: tuiWindow.paneId,
    sessionName: tuiWindow.sessionName,
    windowName: tuiWindow.windowName,
    allowedOps: {
      inspect: true,
      sendInput: true,
      sendInterrupt: true,
      capture: true,
      resize: false,
    },
  }
  return {
    ...base,
    presentation: {
      kind: 'tmux-tui',
      tuiWindow: {
        sessionId: tuiWindow.sessionId,
        windowId: tuiWindow.windowId,
        paneId: tuiWindow.paneId,
      },
      operatorAttachTarget: true,
      attachCommand: `tmux -S ${btmuxSocketPath} attach -t ${sessionName}:tui`,
    },
    tuiWindow,
    tuiLease,
  }
}

/**
 * T-01812 Phase 3 — durable interactive broker allocator. A thin adapter over
 * {@link allocateBrokerSubstrate} with presentation='tmux-tui': it reproduces
 * today's two-window interactive allocation (broker window over Unix IPC + TUI
 * pane lease) and maps the substrate/presentation axes back to the legacy flat
 * BrokerTmuxAllocation the controller persists. The controller dials
 * `brokerIpcSocketPath` via connectUnix.
 */
export function createBrokerDurableTmuxAllocator(
  options: Pick<HrcServerOptions, 'runtimeRoot'>,
  deps: BrokerDurableTmuxAllocatorDeps
): BrokerTmuxAllocator {
  return {
    allocate: async ({
      runtimeId,
      hostSessionId,
      brokerDriver,
      generation,
    }): Promise<BrokerTmuxAllocation> => {
      const sub = await allocateBrokerSubstrate(options, deps, {
        runtimeId,
        hostSessionId,
        generation,
        driverKind: brokerDriver,
        endpoint: 'unix-jsonrpc-ndjson',
        presentation: 'tmux-tui',
      })
      // tmux-tui always yields a TUI window + lease.
      const tuiWindow = sub.tuiWindow as BrokerWindowIdentity
      const lease = sub.tuiLease as BrokerTmuxLease
      return {
        socketPath: sub.substrate.tmuxSocketPath,
        allocatedAt: sub.allocatedAt,
        generation: sub.substrate.generation,
        lease,
        brokerIpcSocketPath:
          sub.endpoint.kind === 'unix-jsonrpc-ndjson' ? sub.endpoint.socketPath : '',
        attachToken: sub.attachToken,
        ...(sub.endpoint.kind === 'unix-jsonrpc-ndjson'
          ? { attachTokenRef: sub.endpoint.attachTokenRef }
          : {}),
        brokerCommand: sub.brokerCommand,
        ...(sub.brokerPid !== undefined ? { brokerPid: sub.brokerPid } : {}),
        brokerWindow: sub.brokerWindow,
        tuiWindow,
        // Legacy single-pane fields mirror the TUI pane for restart reconcile /
        // teardown that still reads the flat shape.
        sessionId: tuiWindow.sessionId,
        windowId: tuiWindow.windowId,
        paneId: tuiWindow.paneId,
        sessionName: tuiWindow.sessionName,
        windowName: tuiWindow.windowName,
      }
    },
  }
}

/**
 * T-01874 Ph3 — durable HEADLESS broker allocator. A thin adapter over
 * {@link allocateBrokerSubstrate} with presentation='none': it carves the leased
 * broker substrate (broker window over Unix IPC + token + ledger) but creates NO
 * TUI window and NO operator attach command, then maps the substrate/endpoint
 * axes back to the legacy flat BrokerTmuxAllocation the controller persists. The
 * controller dials `brokerIpcSocketPath` via connectUnix. Unlike the interactive
 * allocator it carries NO `lease`/`tuiWindow`, so the controller dispatches no
 * `runtime.terminalSurface` and persists presentation='none'.
 */
export function createBrokerDurableHeadlessAllocator(
  options: Pick<HrcServerOptions, 'runtimeRoot'>,
  deps: BrokerDurableTmuxAllocatorDeps
): BrokerTmuxAllocator {
  return {
    allocate: async ({
      runtimeId,
      hostSessionId,
      brokerDriver,
      generation,
    }): Promise<BrokerTmuxAllocation> => {
      const sub = await allocateBrokerSubstrate(options, deps, {
        runtimeId,
        hostSessionId,
        generation,
        driverKind: brokerDriver,
        endpoint: 'unix-jsonrpc-ndjson',
        presentation: 'none',
      })
      return {
        socketPath: sub.substrate.tmuxSocketPath,
        allocatedAt: sub.allocatedAt,
        generation: sub.substrate.generation,
        // No lease / tuiWindow: presentation='none' has no operator pane.
        brokerIpcSocketPath:
          sub.endpoint.kind === 'unix-jsonrpc-ndjson' ? sub.endpoint.socketPath : '',
        attachToken: sub.attachToken,
        ...(sub.endpoint.kind === 'unix-jsonrpc-ndjson'
          ? { attachTokenRef: sub.endpoint.attachTokenRef }
          : {}),
        brokerCommand: sub.brokerCommand,
        ...(sub.brokerPid !== undefined ? { brokerPid: sub.brokerPid } : {}),
        brokerWindow: sub.brokerWindow,
      }
    },
  }
}

export function getHarnessBrokerController(
  this: HrcServerInstanceForHandlers
): HarnessBrokerController {
  if (this.harnessBrokerController) {
    return this.harnessBrokerController
  }

  const mapper = new BrokerEventMapper({ db: this.db })
  const tmuxManagerFactory = this.brokerTmuxManagerFactory ?? createTmuxManager
  const brokerClientFactories = {
    ...(this.brokerClientFactory ? { brokerClientFactory: this.brokerClientFactory } : {}),
    ...(this.brokerUnixClientFactory
      ? { brokerUnixClientFactory: this.brokerUnixClientFactory }
      : {}),
  }
  const durableRoute = decideBrokerDurableInteractiveRoute({
    durableIpcEnabled: resolveBrokerDurableIpcEnabled(this.options),
    endpointKind: 'unix-jsonrpc-ndjson',
    interactionMode: 'interactive',
  })
  const tmuxAllocator: BrokerTmuxAllocator =
    durableRoute === 'durable-ipc'
      ? createBrokerDurableTmuxAllocator(this.options, {
          tmuxManagerFactory,
          generateAttachToken: this.generateBrokerAttachToken ?? randomUUID,
        })
      : {
          allocate: async ({ runtimeId, brokerDriver, generation }) => {
            const socketPath = getBrokerTmuxSocketPath(this.options, brokerDriver, runtimeId)
            await mkdir(dirname(socketPath), { recursive: true })
            const tmux = tmuxManagerFactory({ socketPath })
            await tmux.initialize()
            // Allocate the runtime-owned tmux pane on its dedicated lease socket and
            // hand the broker a narrow pane lease (it attaches to the pane, never
            // owns the server). Session name is deterministic from runtimeId so
            // restart reconcile can re-scan it (C-02889).
            const sessionName = `hrc-${brokerDriver}-${runtimeId}`
            const pane = await tmux.createLeaseSession(sessionName)
            const lease = {
              kind: 'tmux-pane' as const,
              ownership: 'hrc' as const,
              socketPath,
              sessionId: pane.sessionId,
              windowId: pane.windowId,
              paneId: pane.paneId,
              sessionName: pane.sessionName,
              windowName: pane.windowName,
              allowedOps: {
                inspect: true as const,
                sendInput: true as const,
                sendInterrupt: true as const,
                capture: true,
                resize: false,
              },
            }
            return {
              socketPath,
              allocatedAt: timestamp(),
              lease,
              generation,
              sessionId: pane.sessionId,
              windowId: pane.windowId,
              paneId: pane.paneId,
              sessionName: pane.sessionName,
              windowName: pane.windowName,
            }
          },
        }
  // T-01866 — the durable HEADLESS substrate allocator (presentation='none').
  // Selected by the controller for EVERY headless broker runtime (the cutover is
  // unconditional; there is no legacy-stdio escape hatch).
  const headlessSubstrateAllocator: BrokerTmuxAllocator = createBrokerDurableHeadlessAllocator(
    this.options,
    {
      tmuxManagerFactory,
      generateAttachToken: this.generateBrokerAttachToken ?? randomUUID,
    }
  )
  this.harnessBrokerController = new HarnessBrokerController({
    db: this.db,
    mapper: {
      apply: (envelope) => {
        const result = mapper.apply(envelope)
        // Notify the canonical lifecycle events (hrc_events): these carry hrcSeq
        // so follow-stream subscribers deliver them and notifyEvent finalizes the
        // semantic turn on turn.completed. The raw `events` mirror lacks hrcSeq and
        // is provenance-only, so it is intentionally not notified.
        for (const event of result.lifecycleEvents) {
          this.notifyEvent(event)
        }
        return result
      },
    },
    tmuxAllocator,
    headlessSubstrateAllocator,
    waitForAttachedTerminal: async ({ allocation }) => {
      const sessionName = allocation.lease?.sessionName ?? allocation.sessionName
      const windowName = allocation.lease?.windowName ?? allocation.windowName
      if (!sessionName || !windowName) {
        throw new Error('broker attached launch missing TUI session/window identity')
      }
      const leaseTmux = tmuxManagerFactory({ socketPath: allocation.socketPath })
      if (typeof leaseTmux.waitForAttachedClient !== 'function') {
        return
      }
      await leaseTmux.waitForAttachedClient(sessionName, {
        timeoutMs: 5_000,
        intervalMs: 25,
        activeWindowId:
          typeof allocation.lease?.windowId === 'string' ? allocation.lease.windowId : undefined,
        activeWindowName: windowName,
      })
    },
    reapBrokerTmuxLease: async (runtimeId: string) => {
      // Lever 2 graceful exit: tear the per-runtime broker-tmux lease down after a
      // user-initiated /quit so the operator is not stranded on a live broker pane.
      // The broker owns a dedicated tmux server on its lease socket, so terminate
      // the session then kill the server (removing the lease socket). After the
      // session is gone, run the standard liveness reconcile to mark the runtime
      // terminated (user_initiated_session_end) via its session-missing branch —
      // unless the controller already marked it terminal (clean invocation.exited
      // path), in which case reconcile is a no-op. Mirrors terminateTmuxRuntime's
      // broker teardown minus the controller dispose the terminal paths own.
      const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
      if (!runtime || runtime.controllerKind !== 'harness-broker' || runtime.transport !== 'tmux') {
        return
      }
      const leaseSocket = getBrokerRuntimeTmuxSocketPath(runtime)
      if (leaseSocket === undefined) {
        writeServerLog('WARN', 'broker.user_exit_reap.skipped_no_lease_socket', { runtimeId })
        return
      }
      const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
      const leaseTmux = tmuxManagerFactory({ socketPath: leaseSocket })
      const inspected = await leaseTmux.inspectSession(sessionName)
      if (inspected) {
        await leaseTmux.terminate(sessionName)
      }
      await leaseTmux.killServer()
      writeServerLog('INFO', 'broker.user_exit_reap.session_killed', { runtimeId, sessionName })
      const afterKill = this.db.runtimes.getByRuntimeId(runtimeId)
      if (afterKill && !isRuntimeUnavailableStatus(afterKill.status)) {
        await this.reconcileTmuxRuntimeLiveness(afterKill)
      }
    },
    ...brokerClientFactories,
    env: process.env,
    serverInstanceId: `hrc-server:${process.pid}`,
    logger: {
      info: (message, fields) => writeServerLog('INFO', message, fields),
      warn: (message, fields) => writeServerLog('WARN', message, fields),
      error: (message, fields) => writeServerLog('ERROR', message, fields),
    },
  })
  return this.harnessBrokerController
}

/**
 * Best-effort: open a ghostmux viewer window attached to a freshly-started
 * headless claude broker runtime's TUI. Sends the same `tmux -S <socket>
 * attach-session -t <session>:tui` argv an operator attach uses (the `:tui`
 * target is the 7530bd4 fix — NOT the headless broker window). We send the tmux
 * argv directly rather than `hrc attach <id>`, which only prints the descriptor
 * JSON to a non-interactive invocation instead of attaching. Never throws — the
 * viewer is purely observational and must not gate the dispatch.
 */
export async function spawnHeadlessClaudeViewer(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<void> {
  try {
    const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
    if (!socketPath) {
      writeServerLog('INFO', 'headless_claude_viewer.skipped_no_socket', {
        runtimeId: runtime.runtimeId,
        scopeRef: runtime.scopeRef,
      })
      return
    }
    const attachTarget = getBrokerRuntimeTmuxAttachTarget(runtime)
    // The viewer window's whole lifetime is this one shell command line. HRC
    // never kills the viewer surface itself, so on `/quit` the `tmux attach`
    // exits and whatever follows runs before the window closes. We chain a
    // `hrc session-report --wait-key` (T-01894) so the operator sees the same
    // shutdown report `hrc run` prints — driver/exit/duration/turns + the
    // broker-recorded finalSummary — and the window holds for a keypress instead
    // of vanishing. `hrc` is resolved off the viewer shell's PATH; if absent the
    // shell errors and the window closes (today's behaviour) — graceful fallback.
    // `session-report` is best-effort and always reaches the keypress gate, so a
    // missing/slow summary never closes the window early or hangs it silently.
    const attachCommand = `tmux -S ${socketPath} attach-session -t ${attachTarget}; hrc session-report --runtime ${runtime.runtimeId} --scope '${runtime.scopeRef}' --wait-key; exit`
    const result = await this.ghostmux.ensureHeadlessViewer({
      scopeRef: runtime.scopeRef,
      runtimeId: runtime.runtimeId,
      attachCommand,
      title: `hrc headless ${runtime.scopeRef}`,
    })
    writeServerLog('INFO', `headless_claude_viewer.${result.status}`, {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      ...(result.status === 'failed' ? { error: result.error } : { surfaceId: result.surfaceId }),
    })
  } catch (error) {
    writeServerLog('WARN', 'headless_claude_viewer.unexpected_error', {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export const brokerInteractiveHandlersMethods = {
  handleHeadlessDispatchTurn,
  handleHeadlessBrokerDispatchTurn,
  handleInteractiveTmuxBrokerDispatchTurn,
  executeInteractiveBrokerInputTurn,
  deliverReassociatedBrokerTmuxInput,
  startInteractiveTmuxBrokerRuntime,
  spawnHeadlessClaudeViewer,
  getHarnessBrokerController,
}

export type BrokerInteractiveHandlersMethods = typeof brokerInteractiveHandlersMethods
