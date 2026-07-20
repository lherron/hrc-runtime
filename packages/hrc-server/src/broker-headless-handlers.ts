import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { HrcErrorCode, HrcRuntimeUnavailableError, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcRunRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import { buildHrcCorrelationEnv, mergeEnv } from './agent-spaces-adapter/cli-adapter.js'
import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import { injectRuntimeBirthCredential } from './federation/birth-credential.js'
import { appendHrcEvent, createUserPromptPayload } from './hrc-event-helper.js'
import { runtimeActivityPatch } from './runtime-activity.js'

import { BrokerClient } from 'spaces-harness-broker-client'
import type { InvocationInput } from 'spaces-harness-broker-protocol'
import {
  decideCodexAppServerPresentation,
  filterBrokerDispatchEnvForLockedEnv,
  shouldSpawnGhosttyViewer,
  toRuntimeContinuationRef,
} from './broker-decisions.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { canOperatorAttach } from './broker/runtime-hosting.js'
import { startAspcFacadeBrokerClient } from './option-resolvers.js'
import { createPrecompileLaunchTimingContext } from './precompile-launch-timing.js'
import {
  assertRuntimeNotBusy,
  classifyBrokerInputFailure,
  isBrokerRuntimeQueueCapable,
  isRunActive,
  isTerminalBrokerInputFailure,
  isTerminalBrokerInvocationState,
  isTransientBrokerInputStateFailure,
  isTransitionalBrokerInvocationState,
  requireSession,
} from './require-helpers.js'
import {
  HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION_ENV,
  HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { reattachDurableBrokerForDispatch } from './startup-reconcile.js'
import {
  assertRuntimeSupportsResponseFormat,
  toBrokerResponseFormat,
} from './turn-response-format.js'

type DispatchTurnResponseBase = Omit<DispatchTurnResponse, 'startIdentity' | 'observation'>

type JsonRepairRunCorrelation = {
  kind: 'json_repair'
  sourceRunId: string
  failedValidationRunId: string
  repairRunId: string
}

type DurableHeadlessTurnInput = {
  kind: 'durable_headless_turn_input'
  prompt: string
  source: 'boot' | 'semantic_dm'
  sourceMessageId?: string | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
}

function parseDurableHeadlessTurnInput(value: string | null): DurableHeadlessTurnInput | undefined {
  if (value === null) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<DurableHeadlessTurnInput>
    if (parsed.kind !== 'durable_headless_turn_input' || typeof parsed.prompt !== 'string') {
      return undefined
    }
    if (parsed.source !== 'boot' && parsed.source !== 'semantic_dm') return undefined
    return parsed as DurableHeadlessTurnInput
  } catch {
    return undefined
  }
}

export function enqueueDurableHeadlessTurnInput(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  prompt: string,
  runId: string,
  options: {
    source: DurableHeadlessTurnInput['source']
    runtimeId?: string | undefined
    sourceMessageId?: string | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): void {
  if (this.db.runs.getByRunId(runId)) return

  const now = timestamp()
  this.db.runs.insert({
    runId,
    hostSessionId: session.hostSessionId,
    ...(options.runtimeId !== undefined ? { runtimeId: options.runtimeId } : {}),
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'headless',
    status: 'queued',
    acceptedAt: now,
    updatedAt: now,
    dispatchedInputId: `input-${randomUUID()}`,
  })
  this.db.runs.setCorrelationJson(
    runId,
    JSON.stringify({
      kind: 'durable_headless_turn_input',
      prompt,
      source: options.source,
      ...(options.sourceMessageId !== undefined
        ? { sourceMessageId: options.sourceMessageId }
        : {}),
      ...(options.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
    } satisfies DurableHeadlessTurnInput)
  )
}

export async function dispatchQueuedHeadlessTurnInput(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: {
    waitForCompletion?: boolean | undefined
    whenBusy?: 'reject' | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): Promise<Response> {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcRuntimeUnavailableError('queued turn runtime has no broker invocation', {
      runtimeId: runtime.runtimeId,
      runId,
      route: 'broker-queued-input',
    })
  }

  const queued = this.db.runs.getByRunId(runId)
  const inputId = queued?.dispatchedInputId
  if (queued?.status !== 'queued' || inputId === undefined) {
    throw new HrcRuntimeUnavailableError('queued turn input is no longer dispatchable', {
      runtimeId: runtime.runtimeId,
      runId,
      status: queued?.status,
      route: 'broker-queued-input',
    })
  }

  const claimed = this.db.runs.claimQueued(runId, {
    runtimeId: runtime.runtimeId,
    invocationId,
    operationId: runtime.activeOperationId,
    dispatchedInputId: inputId,
    updatedAt: timestamp(),
  })
  if (!claimed) {
    throw new HrcRuntimeUnavailableError('queued turn input was already claimed', {
      runtimeId: runtime.runtimeId,
      runId,
      route: 'broker-queued-input',
    })
  }

  return await this.executeHeadlessBrokerInputTurn(session, runtime, prompt, runId, options)
}

export async function drainDurableHeadlessTurnInputs(
  this: HrcServerInstanceForHandlers,
  hostSessionId: string
): Promise<void> {
  if (this.queuedTurnInputDrains.has(hostSessionId)) return
  this.queuedTurnInputDrains.add(hostSessionId)
  const queued = this.db.runs.listQueuedByHostSessionId(hostSessionId)[0]
  const delivery = queued
    ? parseDurableHeadlessTurnInput(this.db.runs.getCorrelationJson(queued.runId))
    : undefined

  try {
    if (!queued) return
    if (!delivery) return

    const session = requireSession(this.db, hostSessionId)
    const intent = session.lastAppliedIntentJson
    if (!intent) {
      throw new HrcRuntimeUnavailableError('queued turn has no runtime intent', {
        hostSessionId,
        runId: queued.runId,
        route: 'broker-queued-input',
      })
    }

    const response = await this.dispatchTurnForSession(session, intent, delivery.prompt, {
      runId: queued.runId,
      waitForCompletion: false,
      responseFormat: delivery.responseFormat,
    })
    const result = (await response.json()) as DispatchTurnResponse
    if (delivery.sourceMessageId !== undefined) {
      this.db.messages.updateExecution(delivery.sourceMessageId, {
        state: result.status === 'completed' ? 'completed' : 'started',
        mode: 'headless',
        sessionRef: `${session.scopeRef}/lane:${session.laneRef}`,
        hostSessionId: result.hostSessionId,
        generation: result.generation,
        runtimeId: result.runtimeId,
        runId: result.runId,
        transport: 'headless',
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (queued) {
      const now = timestamp()
      this.db.runs.markCompleted(queued.runId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage: message,
      })
    }
    if (delivery?.sourceMessageId !== undefined) {
      this.db.messages.updateExecution(delivery.sourceMessageId, {
        state: 'failed',
        errorCode: 'delivery_not_guaranteed',
        errorMessage: `input ${delivery.sourceMessageId} was not delivered: ${message}`,
      })
    }
    writeServerLog('WARN', 'turn_input_queue.drain_failed', {
      hostSessionId,
      runId: queued?.runId,
      error: message,
    })
  } finally {
    this.queuedTurnInputDrains.delete(hostSessionId)
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

export async function startHeadlessBrokerRuntime(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: {
    allowCompilerInitialInputWithoutIdentity?: boolean | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  } = {}
): Promise<HrcRuntimeSnapshot> {
  const turnIntent: HrcRuntimeIntent =
    prompt.length > 0 ? { ...intent, initialPrompt: prompt } : intent
  const now = timestamp()
  const runtimeId = `rt-${randomUUID()}`
  const timing = createPrecompileLaunchTimingContext('headless', runtimeId)
  this.db.sessions.updateIntent(session.hostSessionId, turnIntent, now, timing)

  const client = await startAspcFacadeBrokerClient(timing)
  let handedOffToController = false
  const hrcDispatchEnv = injectRuntimeBirthCredential(
    mergeEnv(buildHrcCorrelationEnv(turnIntent), turnIntent.launch),
    runtimeId
  )
  try {
    const compiled = await compileBrokerRuntimePlan(
      {
        intent: turnIntent,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        dispatchEnv: hrcDispatchEnv,
        continuation: toRuntimeContinuationRef(session.continuation ?? undefined),
        allowCompilerInitialInputWithoutIdentity: options.allowCompilerInitialInputWithoutIdentity,
        responseFormat: options.responseFormat,
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
          runId: () => runId,
          traceId: () => `trace-${randomUUID()}`,
        },
      }
    )

    if (!compiled.admitted) {
      throw new HrcRuntimeUnavailableError('headless broker compile/admission rejected', {
        hostSessionId: session.hostSessionId,
        runId,
        code: compiled.code,
        diagnostics: compiled.diagnostics,
        route: 'broker',
      })
    }

    assertBrokerPermissionPolicyAdmitted({
      mode: compiled.profile.policy.permissionPolicy.mode,
      hostSessionId: session.hostSessionId,
      runId,
      route: 'broker',
    })

    // T-01866 — headless durable cutover is UNCONDITIONAL. Every headless broker
    // runtime goes through the controller's leased-tmux + Unix-IPC allocation, so
    // HRC must NOT hand the controller a pre-created stdio broker client (that
    // bypasses substrate allocation and reintroduces the daemon-child lifecycle —
    // spec §10.4). The ASPC facade is used ONLY for compile; it is closed and
    // dropped here before handing off. There is no legacy-stdio route and no
    // HRC_HEADLESS_BROKER_LEGACY_STDIO escape hatch: the controller always
    // allocates a leased substrate + Unix v0.2 endpoint.
    await client.close().catch(() => undefined)

    const controller = this.getHarnessBrokerController()
    handedOffToController = true
    // T-04921 (T-04905 Phase A) — HRC-owned operator-presentation policy for the
    // codex-app-server dual-tmux viewer route. The DEFAULT policy is sourced from
    // an env var (unset → ordinary headless, behaviour-preserving); the decision
    // gates on driver applicability (codex-app-server only) and honours an env
    // kill switch. The trigger is the POLICY, never the driver name alone.
    const operatorPresentation = decideCodexAppServerPresentation({
      operatorPresentation: process.env[HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION_ENV],
      brokerDriver: compiled.profile.brokerDriver,
      ghosttyViewersEnabled: shouldSpawnGhosttyViewer(),
    })
    const result = await controller.start({
      plan: compiled.plan,
      profile: compiled.profile,
      startRequest: compiled.startRequest,
      specHash: compiled.specHash,
      startRequestHash: compiled.startRequestHash,
      identity: compiled.identity,
      requestedResponseFormat: toBrokerResponseFormat(options.responseFormat),
      dispatchEnv: filterBrokerDispatchEnvForLockedEnv(
        { ...(compiled.dispatchEnv ?? {}), ...hrcDispatchEnv },
        compiled.startRequest
      ),
      routeDecision: {
        route: 'broker',
        flag: HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
        selectedBy: 'decideHeadlessExecutionRoute',
        headlessRoute: 'durable-leased',
        brokerTransport: 'unix-jsonrpc-ndjson',
        // The presenter policy the controller routes on: 'tmux-tui' selects the
        // headless-viewer allocator + observer socket; 'none' is ordinary headless.
        operatorPresentation,
      },
      lifecyclePolicy: resolveLifecyclePolicyOverlay({
        routeId: `headless-broker:${compiled.profile.brokerDriver}`,
        brokerRoute: true,
      }),
    })

    if (!result.ok) {
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
      throw new HrcRuntimeUnavailableError('headless broker start failed', {
        hostSessionId: session.hostSessionId,
        runId,
        code: result.error.code,
        message: result.error.message,
        route: 'broker',
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

export async function executeHeadlessBrokerStartTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: {
    waitForCompletion?: boolean | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): Promise<Response> {
  // Publish the runtime-producing promise before yielding so crossing dispatches
  // join this boot through handleHeadlessBrokerDispatchTurn's deferral branch.
  const bootOperation = this.startHeadlessBrokerRuntime(session, intent, prompt, runId, {
    responseFormat: options.responseFormat,
  }).finally(() => {
    this.runtimeStartOperations.delete(session.hostSessionId)
  })
  this.runtimeStartOperations.set(session.hostSessionId, bootOperation)
  const runtime = await bootOperation
  if (canOperatorAttach(runtime)) {
    void this.spawnBrokerHeadlessViewer(runtime)
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
  } satisfies DispatchTurnResponseBase)
}

export async function executeHeadlessBrokerInputTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: {
    waitForCompletion?: boolean | undefined
    whenBusy?: 'reject' | undefined
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

  // Queued-mode detection: a runtime is "busy" iff it has an active run still
  // in a non-terminal state. In that case the active run keeps the runtime
  // and invocation pointers (HRC must NOT clobber them with this new runId);
  // the broker queues the new input (whenBusy:'queue') and the event-mapper
  // flips invocation.runId + runtime.activeRunId onto this run on the
  // drained input.accepted envelope.
  const activeRun =
    runtime.activeRunId !== undefined ? this.db.runs.getByRunId(runtime.activeRunId) : null
  const queuedMode = activeRun !== null && isRunActive(activeRun) && activeRun.runId !== runId
  if (options.whenBusy === 'reject' && queuedMode) {
    assertRuntimeNotBusy(this.db, runtime)
  }
  const queueCapable = isBrokerRuntimeQueueCapable(this.db, runtime)

  const preacceptedRun = this.db.runs.getByRunId(runId)
  const inputId = (preacceptedRun?.dispatchedInputId ??
    `input-${randomUUID()}`) as InvocationInput['inputId']
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
      dispatchedInputId: inputId,
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
      // Persist HRC's inputId on the run row so the broker event-mapper can
      // correlate a drained input.accepted envelope back to this run and flip
      // invocation.runId before turn.* events project. Set on every dispatch
      // (immediate and queued) for uniform reasoning; a no-op flip is harmless.
      dispatchedInputId: inputId,
    })
  }
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
      // Always send whenBusy:'queue' when the active invocation supports
      // FIFO queueing: the broker applies it only when its invocation state
      // is turn_active; if the invocation became 'ready' in between, the
      // broker applies the input immediately and ignores policy (per
      // harness-broker invocation-manager). The event-mapper flip on
      // input.accepted is the unconditional safety net in either case.
      ...(queueCapable ? { policy: { whenBusy: 'queue' as const } } : {}),
    })

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
  // re-alloc). No-ops to false for non-durable runtimes. Mirrors the interactive
  // path's reattach-on-dispatch (broker-interactive-handlers), minus the
  // transport==='tmux' gate so durable HEADLESS benefits.
  if (
    !result.ok &&
    result.error.code === 'broker_runtime_not_active' &&
    (await reattachDurableBrokerForDispatch(this.db, runtime, {
      controller: this.getHarnessBrokerController(),
      brokerUnixClientFactory:
        this.brokerUnixClientFactory ??
        ((options) => BrokerClient.connectUnix(options) as ReturnType<BrokerUnixClientFactory>),
    }))
  ) {
    writeServerLog('INFO', 'headless.durable_reattach.dispatch_recovered', {
      runtimeId: runtime.runtimeId,
      runId,
    })
    result = await dispatchToBroker()
  }

  if (!result.ok || !result.response.accepted) {
    const completedAt = timestamp()
    const errorMessage = result.ok
      ? (result.response.reason ?? 'broker rejected invocation input')
      : result.error.message
    const brokerErrorCode = result.ok ? undefined : result.error.code
    const brokerInputTimeout = brokerErrorCode === 'broker_input_timeout'
    const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
    const brokerBindingMissing = !result.ok && result.error.code === 'broker_runtime_not_active'
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
                ...(brokerInputTimeout ? { code: 'broker_input_timeout', inputId } : {}),
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
  } satisfies DispatchTurnResponseBase)
}

export async function waitForInteractiveBrokerRunCompletion(
  this: HrcServerInstanceForHandlers,
  runId: string,
  runtimeId: string
): Promise<HrcRunRecord> {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    const run = this.db.runs.getByRunId(runId)
    if (run && !isRunActive(run)) {
      if (run.status !== 'completed') {
        throw new HrcRuntimeUnavailableError('interactive broker turn failed', {
          runtimeId,
          runId,
          status: run.status,
          errorCode: run.errorCode,
          errorMessage: run.errorMessage,
        })
      }
      return run
    }
    await delay(100)
  }

  throw new HrcRuntimeUnavailableError('interactive broker turn timed out', {
    runtimeId,
    runId,
    route: 'interactive-broker',
  })
}

export async function waitForHeadlessBrokerRunCompletion(
  this: HrcServerInstanceForHandlers,
  runId: string,
  runtimeId: string
): Promise<HrcRunRecord> {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    const run = this.db.runs.getByRunId(runId)
    if (run && !isRunActive(run)) {
      // Guarded cleanup: only clear runtime.activeRunId / set status='ready'
      // when the runtime's active run is STILL this one. With broker FIFO
      // queueing, the event-mapper may have already flipped activeRunId to
      // a drained queued run on input.accepted; unconditionally clearing
      // would clobber that pointer and re-introduce the T-01711 hang class.
      const currentRuntime = this.db.runtimes.getByRuntimeId(runtimeId)
      if (currentRuntime?.activeRunId === runId) {
        const now = timestamp()
        this.db.runtimes.updateRunId(runtimeId, undefined, now)
        this.db.runtimes.update(runtimeId, {
          status: 'ready',
          statusChangedAt: run.completedAt ?? now,
          ...runtimeActivityPatch(this.db, runtimeId, {
            source: 'housekeeping',
            updatedAt: now,
          }),
        })
      }
      if (run.status !== 'completed') {
        throw new HrcRuntimeUnavailableError('headless broker turn failed', {
          runtimeId,
          runId,
          status: run.status,
          errorCode: run.errorCode,
          errorMessage: run.errorMessage,
        })
      }
      return run
    }
    await delay(100)
  }

  throw new HrcRuntimeUnavailableError('headless broker turn timed out', {
    runtimeId,
    runId,
    route: 'broker',
  })
}

export function recordDetachedHeadlessTurnFailure(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtimeId: string,
  runId: string,
  err: unknown
): void {
  const errorMessage = err instanceof Error ? err.message : String(err)
  writeServerLog('WARN', 'headless.detached_turn_failed', {
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
    errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
    payload: {
      success: false,
      transport: 'headless',
    },
  })
  this.notifyEvent(completedEvent)
}

export const brokerHeadlessHandlersMethods = {
  startHeadlessBrokerRuntime,
  executeHeadlessBrokerStartTurn,
  executeHeadlessBrokerInputTurn,
  enqueueDurableHeadlessTurnInput,
  dispatchQueuedHeadlessTurnInput,
  drainDurableHeadlessTurnInputs,
  waitForInteractiveBrokerRunCompletion,
  waitForHeadlessBrokerRunCompletion,
  recordDetachedHeadlessTurnFailure,
}

export type BrokerHeadlessHandlersMethods = typeof brokerHeadlessHandlersMethods
