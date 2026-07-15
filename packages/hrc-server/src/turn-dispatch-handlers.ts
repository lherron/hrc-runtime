import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  HrcConflictError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
  validateFence,
} from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
  OpenBrokerSessionResponse,
  PrepareAttachedRunResponse,
  ResumeAttachedRunResponse,
  StartRuntimeResponse,
} from 'hrc-core'
import { BrokerClient } from 'spaces-harness-broker-client'
import {
  decideHeadlessExecutionRoute,
  decideInteractiveBrokerAdmission,
  normalizeClaudeInteractiveBrokerIntent,
  normalizeRuntimeProvisionIntent,
  runInteractiveTmuxRoute,
  shouldDeferHeadlessToInteractiveBrokerReuse,
  shouldRedirectClaudeToInteractiveBroker,
  shouldUseHeadlessTransport,
  shouldUseSdkTransport,
  toLatestRuntimeAdmissionView,
  toLiveInteractiveRuntimeReuseView,
} from './broker-decisions.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { hasLeasedBrokerSubstrate } from './broker/runtime-hosting.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import {
  assertBrokerRuntimeReusableAdmission,
  assertRuntimeNotBusy,
  isBrokerRuntimeInputDispatchable,
  isBrokerRuntimeQueueCapable,
  isTerminalBrokerInvocationState,
  requireContinuity,
  requireKnownRuntime,
  requireSession,
} from './require-helpers.js'
import {
  findDispatchInteractiveRuntime,
  getDurableHeadlessRuntimeForReattach,
  getReusableHeadlessRuntimeForSession,
} from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import {
  parseDispatchTurnRequest,
  parseEnsureRuntimeRequest,
  parseJsonBody,
  parseOpenBrokerSessionRequest,
  parsePrepareAttachedRunRequest,
  parseResumeAttachedRunRequest,
  parseStartRuntimeRequest,
} from './server-parsers.js'
import type { AttachBeforeInvocationStartOption } from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { reattachDurableBrokerForDispatch } from './startup-reconcile.js'
import { toEnsureRuntimeResponse, toStartRuntimeResponse } from './status-views.js'

export async function handleEnsureRuntime(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseEnsureRuntimeRequest(await parseJsonBody(request))
  const requested = requireSession(this.db, body.hostSessionId)
  const { session } = await this.maybeAutoRotateStaleSession(requested, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'runtime-ensure',
  })
  const runtime = await this.ensureRuntimeForSession(
    session,
    body.intent,
    body.restartStyle ?? 'reuse_pty'
  )
  return json(toEnsureRuntimeResponse(runtime))
}

export async function handleStartRuntime(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseStartRuntimeRequest(await parseJsonBody(request))
  const requested = requireSession(this.db, body.hostSessionId)
  const { session } = await this.maybeAutoRotateStaleSession(requested, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'runtime-start',
  })
  const runtime = await this.startRuntimeForSession(
    session,
    body.intent,
    body.restartStyle ?? 'reuse_pty'
  )
  return json(toStartRuntimeResponse(runtime) satisfies StartRuntimeResponse)
}

export async function handleOpenBrokerSession(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseOpenBrokerSessionRequest(await parseJsonBody(request))
  const requestedSession = requireSession(this.db, body.hostSessionId)
  const continuity = requireContinuity(this.db, requestedSession)
  const activeSession = requireSession(this.db, continuity.activeHostSessionId)
  const fence = validateFence(body.fences, {
    activeHostSessionId: activeSession.hostSessionId,
    generation: activeSession.generation,
  })

  if (!fence.ok) {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, fence.message, fence.detail)
  }

  const resolved = requireSession(this.db, fence.resolvedHostSessionId)
  const { session } = await this.maybeAutoRotateStaleSession(resolved, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'broker-session-open',
  })
  const intent = normalizeBrokerSessionOpenIntent(
    body.runtimeIntent ?? session.lastAppliedIntentJson,
    session
  )

  if (!shouldUseHeadlessTransport(intent)) {
    throw new HrcRuntimeUnavailableError('broker session open requires a headless runtime intent', {
      hostSessionId: session.hostSessionId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
      route: 'broker-session-open',
    })
  }

  const route = decideHeadlessExecutionRoute(intent, {
    brokerFlagEnabled: this.headlessCodexBrokerEnabled,
  })
  if (route !== 'broker') {
    throw new HrcRuntimeUnavailableError('broker session open requires the headless broker route', {
      hostSessionId: session.hostSessionId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
      route,
    })
  }

  const runtime = await this.openHeadlessBrokerSessionForSession(session, intent)
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcRuntimeUnavailableError('broker session open produced no active invocation', {
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      route: 'broker-session-open',
    })
  }

  return json({
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'headless',
    status: runtime.status,
    startIdentity: { kind: 'broker', invocationId },
    observation: {
      broker: {
        selector: {
          invocationId,
          runtimeId: runtime.runtimeId,
          generation: runtime.generation,
        },
        afterSeq: this.db.brokerInvocationEvents.maxBrokerSeq(invocationId),
      },
    },
    supportsInputQueue: isBrokerRuntimeQueueCapable(this.db, runtime),
  } satisfies OpenBrokerSessionResponse)
}

export async function handleDispatchTurn(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseDispatchTurnRequest(await parseJsonBody(request))
  const requestedSession = requireSession(this.db, body.hostSessionId)
  const continuity = requireContinuity(this.db, requestedSession)
  const activeSession = requireSession(this.db, continuity.activeHostSessionId)
  const fence = validateFence(body.fences, {
    activeHostSessionId: activeSession.hostSessionId,
    generation: activeSession.generation,
  })

  if (!fence.ok) {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, fence.message, fence.detail)
  }

  const resolved = requireSession(this.db, fence.resolvedHostSessionId)
  // Stale-generation guard runs after fence validation so that a caller
  // pinning a specific generation via `fences` gets a predictable
  // STALE_CONTEXT error instead of silent rotation.
  const { session } = await this.maybeAutoRotateStaleSession(resolved, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'dispatch-turn',
  })
  const runId = `run-${randomUUID()}`
  const parsedIntent = normalizeDispatchIntent(
    body.runtimeIntent ?? session.lastAppliedIntentJson,
    session,
    runId
  )
  const intent =
    body.attachments !== undefined
      ? { ...parsedIntent, attachments: body.attachments }
      : parsedIntent

  return await this.dispatchTurnForSession(session, intent, body.prompt, {
    runId,
    waitForCompletion: body.waitForCompletion,
    whenBusy: body.whenBusy,
    responseFormat: body.responseFormat,
    ...(body.repair !== undefined
      ? { repairCorrelation: normalizeJsonRepairCorrelation(body.repair, runId) }
      : {}),
  })
}

export async function openHeadlessBrokerSessionForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent
): Promise<HrcRuntimeSnapshot> {
  const reusableRuntime = getReusableHeadlessRuntimeForSession(
    this.db,
    session.hostSessionId,
    intent.harness.provider,
    intent.harness.id
  )
  if (reusableRuntime) {
    assertBrokerRuntimeReusableAdmission(this.db, reusableRuntime)
    return await finalizeHeadlessBrokerSessionOpen(this, reusableRuntime)
  }

  const durableHeadless = getDurableHeadlessRuntimeForReattach(
    this.db,
    session.hostSessionId,
    intent.harness.provider,
    intent.harness.id
  )
  if (durableHeadless) {
    const reattached = await this.reattachDurableBrokerSessionForOpen(durableHeadless)
    const recovered = reattached ? this.db.runtimes.getByRuntimeId(durableHeadless.runtimeId) : null
    if (recovered && recovered.activeInvocationId !== undefined) {
      assertBrokerRuntimeReusableAdmission(this.db, recovered)
      return await finalizeHeadlessBrokerSessionOpen(this, recovered)
    }

    await this.terminateRuntime(durableHeadless, { dropContinuation: true }).catch(
      (error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appendHrcEvent(this.db, 'runtime.stale', {
          ts: timestamp(),
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          runtimeId: durableHeadless.runtimeId,
          transport: 'headless',
          payload: {
            reason: 'broker-session-open-reattach-cleanup-failed',
            error: errorMessage,
          },
        })
      }
    )
  }

  const runtime = await this.startHeadlessBrokerRuntime(
    session,
    intent,
    '',
    `broker-session-open-${randomUUID()}`,
    {
      allowCompilerInitialInputWithoutIdentity: true,
    }
  )
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcRuntimeUnavailableError('broker session open produced no active invocation', {
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      route: 'broker-session-open',
    })
  }
  const readyRuntime = await this.waitForBrokerSessionOpenReady(runtime.runtimeId, invocationId)
  return await finalizeHeadlessBrokerSessionOpen(this, readyRuntime)
}

async function finalizeHeadlessBrokerSessionOpen(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<HrcRuntimeSnapshot> {
  // Session-open is a provisioning surface just like managed start and first-turn
  // dispatch. Keep the viewer observational: the existing helper owns feature,
  // socket, presentation, and Ghostmux failure gates and never fails the session.
  await server.spawnBrokerHeadlessViewer(runtime)
  return runtime
}

export async function reattachDurableBrokerSessionForOpen(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<boolean> {
  return await reattachDurableBrokerForDispatch(this.db, runtime, {
    controller: this.getHarnessBrokerController(),
    brokerUnixClientFactory:
      this.brokerUnixClientFactory ??
      ((options) => BrokerClient.connectUnix(options) as ReturnType<BrokerUnixClientFactory>),
  })
}

export async function waitForBrokerSessionOpenReady(
  this: HrcServerInstanceForHandlers,
  runtimeId: string,
  invocationId: string
): Promise<HrcRuntimeSnapshot> {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
    if (!runtime) {
      throw new HrcRuntimeUnavailableError('broker session open runtime disappeared', {
        runtimeId,
        invocationId,
        route: 'broker-session-open',
      })
    }
    if (!invocation) {
      throw new HrcRuntimeUnavailableError('broker session open invocation disappeared', {
        runtimeId,
        invocationId,
        route: 'broker-session-open',
      })
    }
    if (isTerminalBrokerInvocationState(invocation.invocationState)) {
      throw new HrcRuntimeUnavailableError('broker session open invocation failed', {
        runtimeId,
        invocationId,
        invocationState: invocation.invocationState,
        route: 'broker-session-open',
      })
    }
    if (isRuntimeUnavailableStatus(runtime.status) || runtime.status === 'failed') {
      throw new HrcRuntimeUnavailableError('broker session open runtime unavailable', {
        runtimeId,
        invocationId,
        status: runtime.status,
        route: 'broker-session-open',
      })
    }
    const invocationCanAcceptFollowup =
      invocation.invocationState === 'ready' || isBrokerRuntimeQueueCapable(this.db, runtime)
    if (
      runtime.status === 'ready' &&
      runtime.activeRunId === undefined &&
      invocationCanAcceptFollowup
    ) {
      return runtime
    }
    await delay(100)
  }

  throw new HrcRuntimeUnavailableError('broker session open timed out waiting for readiness', {
    runtimeId,
    invocationId,
    route: 'broker-session-open',
  })
}

function normalizeBrokerSessionOpenIntent(
  intent: HrcRuntimeIntent | undefined,
  session: HrcSessionRecord
): HrcRuntimeIntent {
  if (!intent) {
    throw new HrcRuntimeUnavailableError(
      'runtimeIntent is required when the session has no prior intent',
      {
        hostSessionId: session.hostSessionId,
        route: 'broker-session-open',
      }
    )
  }

  const cwd =
    intent.placement?.cwd ??
    intent.placement?.projectRoot ??
    intent.placement?.agentRoot ??
    process.cwd()
  const projectRoot = intent.placement?.projectRoot ?? cwd
  const agentRoot = intent.placement?.agentRoot ?? projectRoot

  const normalized: HrcRuntimeIntent = {
    ...intent,
    placement: {
      ...intent.placement,
      agentRoot,
      projectRoot,
      cwd,
      runMode: intent.placement?.runMode ?? 'task',
      bundle: intent.placement?.bundle ?? { kind: 'compose', compose: [] },
      dryRun: intent.placement?.dryRun ?? true,
      correlation: {
        sessionRef: {
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
        },
        hostSessionId: session.hostSessionId,
      },
    },
  }
  // Session-open has no caller/user turn, but must allow ASPC bundle/profile
  // priming fallback to initialize the broker invocation.
  normalized.initialPrompt = undefined
  normalized.attachments = undefined
  return normalized
}

type AttachedRunResult = StartRuntimeResponse | DispatchTurnResponse

async function dispatchTurnResponseJson(response: Response) {
  return (await response.json()) as DispatchTurnResponse
}

function runtimeIdFromAttachedRunResult(result: AttachedRunResult): string {
  return result.runtimeId
}

async function attachDescriptorBody(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
) {
  return (await server.attachRuntime(runtime).json()) as PrepareAttachedRunResponse['attach']
}

type DispatchTurnObservationContext = {
  lifecycleFromSeq: number
  brokerAfterSeqByInvocation: Map<string, number>
}

type JsonRepairRunCorrelation = {
  kind: 'json_repair'
  sourceRunId: string
  failedValidationRunId: string
  repairRunId: string
}

function normalizeJsonRepairCorrelation(
  repair: NonNullable<ReturnType<typeof parseDispatchTurnRequest>['repair']>,
  repairRunId: string
): JsonRepairRunCorrelation {
  return {
    kind: 'json_repair',
    sourceRunId: repair.sourceRunId,
    failedValidationRunId: repair.failedValidationRunId ?? repair.sourceRunId,
    repairRunId,
  }
}

function captureBrokerAfterSeqByInvocation(
  server: HrcServerInstanceForHandlers,
  hostSessionId: string
): Map<string, number> {
  const cursors = new Map<string, number>()
  for (const runtime of server.db.runtimes.listByHostSessionId(hostSessionId)) {
    if (runtime.controllerKind !== 'harness-broker' || runtime.activeInvocationId === undefined) {
      continue
    }
    cursors.set(
      runtime.activeInvocationId,
      server.db.brokerInvocationEvents.maxBrokerSeq(runtime.activeInvocationId)
    )
  }
  return cursors
}

async function enrichDispatchTurnResponse(
  server: HrcServerInstanceForHandlers,
  response: Response,
  context: DispatchTurnObservationContext
): Promise<Response> {
  const body = (await response.json()) as Omit<
    DispatchTurnResponse,
    'startIdentity' | 'observation'
  > &
    Partial<Pick<DispatchTurnResponse, 'startIdentity' | 'observation'>>
  const run = server.db.runs.getByRunId(body.runId)
  const invocationId = run?.invocationId

  const enriched = {
    ...body,
    startIdentity:
      invocationId !== undefined
        ? ({ kind: 'broker', invocationId } as const)
        : ({ kind: 'sdk' } as const),
    observation: {
      lifecycle: {
        selector: {
          runId: body.runId,
          runtimeId: body.runtimeId,
          generation: body.generation,
        },
        fromSeq: context.lifecycleFromSeq,
      },
      ...(invocationId !== undefined
        ? {
            broker: {
              selector: {
                invocationId,
                runId: body.runId,
                runtimeId: body.runtimeId,
                generation: body.generation,
              },
              afterSeq: context.brokerAfterSeqByInvocation.get(invocationId) ?? 0,
            },
          }
        : {}),
    },
  } satisfies DispatchTurnResponse

  return json(enriched, response.status)
}

export async function handlePrepareAttachedRun(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parsePrepareAttachedRunRequest(await parseJsonBody(request))
  const requested = requireSession(this.db, body.hostSessionId)
  const { session } = await this.maybeAutoRotateStaleSession(requested, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'prepare-attached-run',
  })
  const pendingStartId = `attached-${randomUUID()}`
  const controller = this.getHarnessBrokerController()

  const operation = (async (): Promise<AttachedRunResult> => {
    if (body.prompt && body.prompt.length > 0) {
      const response = await this.dispatchTurnForSession(session, body.intent, body.prompt, {
        runId: `run-${randomUUID()}`,
        waitForCompletion: false,
        attachBeforeInvocationStart: { pendingStartId },
      })
      return await dispatchTurnResponseJson(response)
    }

    const runtime = await this.startRuntimeForSession(
      session,
      body.intent,
      body.restartStyle ?? 'reuse_pty',
      { attachBeforeInvocationStart: { pendingStartId } }
    )
    return toStartRuntimeResponse(runtime)
  })()

  this.attachedRunOperations.set(pendingStartId, operation)
  void operation
    .finally(() => {
      this.attachedRunOperations.delete(pendingStartId)
    })
    .catch(() => undefined)

  try {
    const winner = await Promise.race([
      controller
        .waitForAttachedStartReady(pendingStartId)
        .then((ready: { pendingStartId: string; runtime: HrcRuntimeSnapshot }) => ({
          kind: 'prepared' as const,
          ready,
        })),
      operation.then((result) => ({ kind: 'started' as const, result })),
    ])

    if (winner.kind === 'prepared') {
      return json({
        status: 'prepared',
        pendingStartId,
        hostSessionId: winner.ready.runtime.hostSessionId,
        runtimeId: winner.ready.runtime.runtimeId,
        attach: await attachDescriptorBody(this, winner.ready.runtime),
      } satisfies PrepareAttachedRunResponse)
    }

    controller.cancelAttachedStart(pendingStartId, 'attached run completed without a pending start')
    const runtime = requireKnownRuntime(this.db, runtimeIdFromAttachedRunResult(winner.result))
    return json({
      status: 'started',
      result: winner.result,
      attach: await attachDescriptorBody(this, runtime),
    } satisfies PrepareAttachedRunResponse)
  } catch (error) {
    controller.cancelAttachedStart(
      pendingStartId,
      error instanceof Error ? error.message : String(error)
    )
    throw error
  }
}

export async function handleResumeAttachedRun(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseResumeAttachedRunRequest(await parseJsonBody(request))
  const operation = this.attachedRunOperations.get(body.pendingStartId) as
    | Promise<AttachedRunResult>
    | undefined
  if (!operation) {
    throw new HrcRuntimeUnavailableError('attached run is not pending', {
      pendingStartId: body.pendingStartId,
      route: 'attached-run',
    })
  }

  const resumed = this.getHarnessBrokerController().resumeAttachedStart(body.pendingStartId)
  if (!resumed.ok) {
    throw new HrcRuntimeUnavailableError(resumed.error.message, {
      pendingStartId: body.pendingStartId,
      code: resumed.error.code,
      route: 'attached-run',
    })
  }

  const result = await operation
  return json({
    status: 'started',
    result,
  } satisfies ResumeAttachedRunResponse)
}

export async function dispatchTurnForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  inputIntent: HrcRuntimeIntent,
  prompt: string,
  options: {
    runId?: string | undefined
    ensureInteractiveRuntime?: boolean | undefined
    waitForCompletion?: boolean | undefined
    whenBusy?: 'reject' | undefined
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  } = {}
): Promise<Response> {
  const runId = options.runId ?? `run-${randomUUID()}`
  const observationContext: DispatchTurnObservationContext = {
    lifecycleFromSeq: this.db.hrcEvents.maxHrcSeq() + 1,
    brokerAfterSeqByInvocation: captureBrokerAfterSeqByInvocation(this, session.hostSessionId),
  }
  const withObservation = async (response: Response): Promise<Response> =>
    enrichDispatchTurnResponse(this, response, observationContext)

  // T-01770 Phase B: admit ariadne-class (explicit id:claude-code dispatched
  // headless) and SDK-shaped Claude intents into the claude-code-tmux broker
  // path BEFORE the headless/SDK branches. Without this they fall onto legacy
  // exec.ts (fresh conversation each turn) or the hard-failing SDK executor.
  // Normalizing to an interactive claude-code intent makes the predicates
  // below route them to the broker branch (and NOT runSdkTurn / the retired
  // headless CLI exec path). Flag-gated so a disabled broker is unchanged.
  const intent =
    this.claudeCodeTmuxBrokerEnabled && shouldRedirectClaudeToInteractiveBroker(inputIntent)
      ? normalizeClaudeInteractiveBrokerIntent(inputIntent)
      : inputIntent
  let latestRuntime = findDispatchInteractiveRuntime(this.db, session.hostSessionId)
  // T-01873: route the durable-tmux liveness gate through the runtime-hosting
  // choke point. hasLeasedBrokerSubstrate replaces the `transport==='tmux' &&
  // getBrokerRuntimeTmuxSocketPath !== undefined` durability proxy — it is true
  // exactly when the broker process lives in a leased tmux session (the
  // precondition reconcileTmuxRuntimeLiveness needs), and false for a ghostty
  // broker (no tmux substrate), preserving today's tmux-only reconcile.
  if (
    latestRuntime?.controllerKind === 'harness-broker' &&
    hasLeasedBrokerSubstrate(latestRuntime)
  ) {
    latestRuntime = await this.reconcileTmuxRuntimeLiveness(latestRuntime)
  }

  const dispatchIntent = normalizeRuntimeProvisionIntent(intent)

  // A live, idle interactive (tmux/ghostty) broker runtime is the agent's real
  // session — the TUI a human may be watching. A DM/turn for that scope must be
  // delivered INTO it via the broker-reuse path, never spawned as a competing
  // headless run: a headless codex-app-server start resumes the SAME continuation
  // thread the live TUI already owns, finds no rollout in its (re-derived) codex
  // home, and wedges at `starting` — the turn silently dies. The SDK branch below
  // already defers to a live idle interactive runtime; the headless-codex branch
  // must do the same so codex DMs land in the open TUI (broker-reuse) instead of
  // a parallel headless run. When no such runtime exists (cron/autonomous
  // dispatch), the Wave C headless route is still taken.
  const liveInteractiveBrokerReusable = shouldDeferHeadlessToInteractiveBrokerReuse(
    intent,
    toLiveInteractiveRuntimeReuseView(latestRuntime)
  )

  if (shouldUseHeadlessTransport(intent) && !liveInteractiveBrokerReusable) {
    const route = decideHeadlessExecutionRoute(intent, {
      brokerFlagEnabled: this.headlessCodexBrokerEnabled,
    })
    if (route === 'broker') {
      return await withObservation(
        await this.handleHeadlessBrokerDispatchTurn(session, intent, prompt, runId, {
          waitForCompletion: options.waitForCompletion,
          whenBusy: options.whenBusy,
          repairCorrelation: options.repairCorrelation,
          responseFormat: options.responseFormat,
        })
      )
    }
    if (route === 'sdk') {
      assertJsonSchemaResponseFormatSupported(options.responseFormat, {
        route: 'sdk',
        provider: intent.harness.provider,
        harnessId: intent.harness.id,
      })
      return await withObservation(
        await this.handleHeadlessDispatchTurn(session, dispatchIntent, prompt, runId, {
          waitForCompletion: options.waitForCompletion,
        })
      )
    }

    assertJsonSchemaResponseFormatSupported(options.responseFormat, {
      route,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
    })
    throw new HrcRuntimeUnavailableError('headless legacy execution is unavailable', {
      hostSessionId: session.hostSessionId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
      route,
    })
  }

  if (shouldUseSdkTransport(intent)) {
    // Prefer a live idle interactive runtime over SDK when one is available (spec §11.3.3:
    // headless for CLI/headless-capable targets, SDK only as fallback)
    const liveInteractiveRuntime = latestRuntime
    const interactiveAvailableAndIdle =
      liveInteractiveRuntime &&
      (liveInteractiveRuntime.transport === 'tmux' ||
        liveInteractiveRuntime.transport === 'ghostty') &&
      (liveInteractiveRuntime.tmuxJson !== undefined ||
        liveInteractiveRuntime.surfaceJson !== undefined) &&
      !isRuntimeUnavailableStatus(liveInteractiveRuntime.status) &&
      // T-05358: never reuse an interactive runtime whose broker invocation is
      // transitioning (starting/stopping) — row status alone admits `stopping`.
      isBrokerRuntimeInputDispatchable(this.db, liveInteractiveRuntime) &&
      liveInteractiveRuntime.activeRunId === undefined
    if (!interactiveAvailableAndIdle) {
      assertJsonSchemaResponseFormatSupported(options.responseFormat, {
        route: 'sdk',
        provider: intent.harness.provider,
        harnessId: intent.harness.id,
      })
      return await withObservation(
        await this.handleSdkDispatchTurn(session, intent, prompt, runId, {
          waitForCompletion: options.waitForCompletion,
        })
      )
    }
    // Fall through to tmux/headless path with the idle runtime
  }

  const admission = decideInteractiveBrokerAdmission(
    intent,
    // T-05358: pass input-dispatchability so a `stopping`/`starting` interactive
    // runtime is routed to stale-and-reprovision (fresh) rather than broker-reuse.
    toLatestRuntimeAdmissionView(
      latestRuntime,
      latestRuntime ? isBrokerRuntimeInputDispatchable(this.db, latestRuntime) : true
    ),
    {
      claudeCodeTmuxBrokerEnabled: this.claudeCodeTmuxBrokerEnabled,
      codexCliTmuxBrokerEnabled: this.codexCliTmuxBrokerEnabled,
      piTuiTmuxBrokerEnabled: this.piTuiTmuxBrokerEnabled,
    }
  )

  if (admission.decision === 'runtime-unavailable') {
    throw new HrcRuntimeUnavailableError(admission.reason, {
      hostSessionId: session.hostSessionId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
      route: 'interactive-broker',
    })
  }

  if (admission.decision === 'broker-start' && isProviderOnlyOpenAiInteractiveIntent(inputIntent)) {
    throw new HrcRuntimeUnavailableError('runtime intent is not broker-admissible', {
      hostSessionId: session.hostSessionId,
      provider: inputIntent.harness.provider,
      route: 'interactive-broker',
    })
  }

  if (admission.decision === 'broker-reuse') {
    if (!latestRuntime) {
      throw new HrcRuntimeUnavailableError('interactive broker runtime is unavailable', {
        hostSessionId: session.hostSessionId,
        route: 'interactive-broker',
      })
    }
    if (!isBrokerRuntimeQueueCapable(this.db, latestRuntime)) {
      assertRuntimeNotBusy(this.db, latestRuntime)
    }
    return await withObservation(
      await this.executeInteractiveBrokerInputTurn(session, latestRuntime, prompt, runId, {
        waitForCompletion:
          admission.allowedBrokerDriver === 'codex-cli-tmux' ||
          admission.allowedBrokerDriver === 'pi-tui-tmux'
            ? false
            : options.waitForCompletion,
        repairCorrelation: options.repairCorrelation,
        responseFormat: options.responseFormat,
      })
    )
  }

  if (admission.decision === 'stale-and-reprovision' && latestRuntime) {
    this.markRuntimeStaleForBrokerReprovision(session, latestRuntime, {
      reason: 'interactive-broker-admission-reprovision',
      allowedBrokerDriver: admission.allowedBrokerDriver,
    })
    if (isProviderOnlyInteractiveIntent(inputIntent)) {
      throw new HrcRuntimeUnavailableError('runtime intent is not broker-admissible', {
        hostSessionId: session.hostSessionId,
        provider: inputIntent.harness.provider,
        route: 'interactive-broker',
      })
    }
  }

  return await withObservation(
    await runInteractiveTmuxRoute('broker', {
      broker: async () =>
        this.handleInteractiveTmuxBrokerDispatchTurn(session, intent, prompt, runId, {
          flagEnvName: admission.flagEnvName,
          allowedBrokerDriver: admission.allowedBrokerDriver,
          ...(options.attachBeforeInvocationStart
            ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
            : {}),
          waitForCompletion:
            admission.allowedBrokerDriver === 'codex-cli-tmux' ||
            admission.allowedBrokerDriver === 'pi-tui-tmux'
              ? false
              : options.waitForCompletion,
          responseFormat: options.responseFormat,
        }),
    })
  )
}

function assertJsonSchemaResponseFormatSupported(
  responseFormat: HrcTurnResponseFormat | undefined,
  detail: Record<string, unknown>
): void {
  if (responseFormat?.kind !== 'json_schema') {
    return
  }
  throw new HrcUnprocessableEntityError(
    HrcErrorCode.UNSUPPORTED_CAPABILITY,
    'responseFormat json_schema is unsupported for the selected route',
    {
      capability: 'finalResponse.jsonSchema',
      responseFormat: { kind: responseFormat.kind },
      required: { jsonSchema: true, perTurn: true },
      actual: null,
      ...detail,
    }
  )
}

function isProviderOnlyInteractiveIntent(intent: HrcRuntimeIntent): boolean {
  return intent.harness.interactive === true && intent.harness.id === undefined
}

function isProviderOnlyOpenAiInteractiveIntent(intent: HrcRuntimeIntent): boolean {
  return isProviderOnlyInteractiveIntent(intent) && intent.harness.provider === 'openai'
}

export function markRuntimeStaleForBrokerReprovision(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  payload: Record<string, unknown>
): void {
  if (isRuntimeUnavailableStatus(runtime.status)) {
    return
  }

  const now = timestamp()
  if (runtime.activeRunId !== undefined) {
    this.db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: 'runtime staled for harness-broker reprovision',
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
  }

  this.db.runtimes.update(runtime.runtimeId, {
    status: 'stale',
    updatedAt: now,
    lastActivityAt: now,
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'stale',
      updatedAt: now,
      staleReason: payload['reason'],
      stalePayload: payload,
    },
  })
  const event = appendHrcEvent(this.db, 'runtime.stale', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    ...(runtime.transport === 'sdk' ||
    runtime.transport === 'tmux' ||
    runtime.transport === 'headless' ||
    runtime.transport === 'ghostty'
      ? { transport: runtime.transport }
      : {}),
    payload,
  })
  this.notifyEvent(event)
}

export const turnDispatchHandlersMethods = {
  handleEnsureRuntime,
  handleStartRuntime,
  handleOpenBrokerSession,
  handleDispatchTurn,
  handlePrepareAttachedRun,
  handleResumeAttachedRun,
  dispatchTurnForSession,
  openHeadlessBrokerSessionForSession,
  reattachDurableBrokerSessionForOpen,
  waitForBrokerSessionOpenReady,
  markRuntimeStaleForBrokerReprovision,
}

export type TurnDispatchHandlersMethods = typeof turnDispatchHandlersMethods
