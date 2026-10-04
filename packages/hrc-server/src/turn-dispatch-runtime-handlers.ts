import { randomUUID } from 'node:crypto'
import {
  HrcConflictError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  isExactStartRuntimeRequest,
  isSuffixStartRuntimeRequest,
  validateFence,
} from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcExecutionFormat,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  OpenBrokerSessionResponse,
  StartRuntimeResponse,
} from 'hrc-core'
import {
  assertActuatorSplitRouteAdmission,
  assertActuatorSplitRuntimeReuse,
} from './actuator-split.js'
import {
  assertPreparedAspdAttemptFormat,
  findPreparedAspdAttemptForFormatRetry,
  readAspdPreparation,
} from './aspd-headless-start.js'
import {
  decideHeadlessExecutionRoute,
  isProducerSelectedOrdinaryBirth,
  shouldUseHeadlessTransport,
} from './broker-decisions.js'
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { withFrozenOperatorPresentation } from './presentation-operator.js'
import {
  brokerRuntimeSupportsAdmissionClass,
  isTerminalBrokerInvocationState,
  requireContinuity,
  requireSession,
} from './require-helpers.js'
import {
  assertV2SelectionCompatibleForReuse,
  getDurableHeadlessRuntimeForReattach,
  getReusableHeadlessRuntimeForSession,
} from './runtime-select.js'
import { omitPersistedSelectionForReuse } from './selector-message-handlers/selection-request.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import {
  parseDispatchTurnRequest,
  parseEnsureRuntimeRequest,
  parseJsonBody,
  parseOpenBrokerSessionRequest,
  parseStartRuntimeRequest,
} from './server-parsers.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import {
  type DurableBrokerDispatchReattachResult,
  reattachDurableBrokerForDispatch,
} from './startup-reconcile.js'
import { toEnsureRuntimeResponse, toStartRuntimeResponse } from './status-views.js'
import { normalizeJsonRepairCorrelation } from './turn-dispatch-attached-run-handlers.js'
import {
  dispatchPublicSubmission,
  replayDispatchBody,
  waitForPublicDispatchStage,
} from './turn-dispatch-submission-handlers.js'
import {
  type InFlightIdempotentDispatch,
  assertIdempotencyExecutionFormat,
  format2RequestHash,
  idempotentDispatches,
  resolvePublicWaitStage,
} from './turn-dispatch-submission-support.js'

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
  // Suffix-roster START (T-07118): the daemon picks, claims, and starts the slot
  // inside this one request, so the caller never holds a claim it could replay
  // against a different start. Reports the ACTUAL claimed scope back.
  if (isSuffixStartRuntimeRequest(body)) {
    return json(await this.startRoutedSuffixRosterRuntime(body))
  }
  // Exact-scope START (T-07302): same one-request claim-and-start discipline for
  // the ONE scope the caller named, refusing rather than reusing when it is
  // occupied. Shares the roster namespace mutex, so the two cannot race.
  if (isExactStartRuntimeRequest(body)) {
    return json(await this.startRoutedExactScopeRuntime(body))
  }
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
    body.runtimeIntent ?? omitPersistedSelectionForReuse(session.lastAppliedIntentJson),
    session
  )

  if (isProducerSelectedOrdinaryBirth(intent)) {
    // The public broker-session-open door is an ordinary v2 birth: ASP, not
    // HRC's historical headless route classifier, selects execution/hosting.
    assertActuatorSplitRouteAdmission(intent, 'broker')
  } else {
    // Explicit interactive/operator surfaces remain on their protected legacy
    // admission path until their own producer-selected attachment migration.
    if (!shouldUseHeadlessTransport(intent)) {
      throw new HrcRuntimeUnavailableError(
        'broker session open requires a headless runtime intent',
        {
          hostSessionId: session.hostSessionId,
          provider: intent.harness.provider,
          harnessId: intent.harness.id,
          route: 'broker-session-open',
        }
      )
    }

    const route = decideHeadlessExecutionRoute(intent, {
      brokerFlagEnabled: this.headlessCodexBrokerEnabled,
      museBrokerFlagEnabled: this.headlessMuseBrokerEnabled,
    })
    assertActuatorSplitRouteAdmission(intent, route)
    if (route !== 'broker') {
      throw new HrcRuntimeUnavailableError(
        'broker session open requires the headless broker route',
        {
          hostSessionId: session.hostSessionId,
          provider: intent.harness.provider,
          harnessId: intent.harness.id,
          route,
        }
      )
    }
  }

  const runtime = await this.openHeadlessBrokerSessionForSession(session, intent, {
    executionFormat: body.executionFormat ?? 'format1',
  })
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcRuntimeUnavailableError('broker session open produced no active invocation', {
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      route: 'broker-session-open',
    })
  }
  const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
  if (invocation === null) {
    throw new HrcRuntimeUnavailableError('broker session open has no persisted invocation format', {
      code: 'execution_format_unproved',
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      invocationId,
    })
  }

  return json({
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'headless',
    status: runtime.status,
    executionFormat: invocation.executionFormat ?? 'format1',
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
    supportsInputQueue: brokerRuntimeSupportsAdmissionClass(this.db, runtime, 'queue'),
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
  const waitFor = resolvePublicWaitStage(body)
  const executionFormat = body.executionFormat ?? 'format1'
  let runId: string | undefined = executionFormat === 'format2' ? undefined : `run-${randomUUID()}`
  const parsedIntent = normalizeDispatchIntent(
    body.runtimeIntent ?? omitPersistedSelectionForReuse(session.lastAppliedIntentJson),
    session,
    runId
  )
  let intent =
    body.attachments !== undefined
      ? { ...parsedIntent, attachments: body.attachments }
      : parsedIntent
  const idempotencyKey = body.idempotencyKey

  if (idempotencyKey !== undefined) {
    const existing = this.db.runs.getByDispatchIdempotencyKey(session.hostSessionId, idempotencyKey)
    if (existing !== null) {
      assertIdempotencyExecutionFormat(existing.executionFormat ?? 'format1', executionFormat, {
        hostSessionId: session.hostSessionId,
        idempotencyKey,
        source: 'run',
      })
      return await waitForPublicDispatchStage(
        this,
        replayDispatchBody(this, existing),
        waitFor,
        true
      )
    }
  }

  // A same-key retry must preserve the format frozen before P. Format2 rows
  // intentionally have no run; format1 resumes its recorded admission run.
  if (idempotencyKey !== undefined) {
    const resumable = findPreparedAspdAttemptForFormatRetry(
      this,
      session.hostSessionId,
      idempotencyKey
    )
    if (resumable !== undefined) {
      assertPreparedAspdAttemptFormat(resumable, executionFormat, session.hostSessionId)
      assertIdempotencyExecutionFormat(resumable.executionFormat, executionFormat, {
        hostSessionId: session.hostSessionId,
        idempotencyKey,
        source: 'preparation',
      })
      if (executionFormat === 'format1') {
        if (resumable.runId === undefined) {
          throw new HrcRuntimeUnavailableError('format1 preparation has no admission-time run id', {
            code: 'execution_format_mismatch',
            hostSessionId: session.hostSessionId,
            operationId: resumable.operationId,
          })
        }
        runId = resumable.runId
        // T-08553: the frozen preparation already fixed its presentation. Carry
        // its recorded choice so node defaults are not re-evaluated on retry.
        intent = withFrozenOperatorPresentation(
          intent,
          readAspdPreparation(this, resumable.operationId).record.intent
        )
      }
    }
  }

  const operationKey =
    idempotencyKey !== undefined ? `${session.hostSessionId}\u0000${idempotencyKey}` : undefined
  const operations = idempotentDispatches.get(this) ?? new Map<string, InFlightIdempotentDispatch>()
  if (!idempotentDispatches.has(this)) {
    idempotentDispatches.set(this, operations)
  }
  const pending = operationKey !== undefined ? operations.get(operationKey) : undefined
  if (pending !== undefined) {
    return await waitForPublicDispatchStage(this, await pending.promise, waitFor, true)
  }

  const dispatch = async (): Promise<DispatchTurnResponse> => {
    return await dispatchPublicSubmission(this, session, intent, body.prompt, {
      ...(runId !== undefined ? { runId } : {}),
      executionFormat,
      ...(executionFormat === 'format2'
        ? {
            format2RequestHash: format2RequestHash({
              hostSessionId: session.hostSessionId,
              request: body,
            }),
          }
        : {}),
      // Accepted requests detach at the durable acceptance boundary. Later
      // stages first obtain broker submission identity, then wait on its ledger.
      waitForCompletion: waitFor !== 'accepted',
      submissionDoor: 'invoke',
      turnPolicy: 'guarded',
      responseFormat: body.responseFormat,
      ...(body.establishedBrokerInvocationId !== undefined
        ? { establishedBrokerInvocationId: body.establishedBrokerInvocationId }
        : {}),
      ...(body.firstTurnTimeoutMs !== undefined
        ? { firstTurnTimeoutMs: body.firstTurnTimeoutMs }
        : {}),
      ...(body.origin !== undefined ? { origin: body.origin } : {}),
      ...(idempotencyKey !== undefined
        ? {
            dispatchIdempotencyKey: idempotencyKey,
          }
        : {}),
      ...(body.repair !== undefined && runId !== undefined
        ? { repairCorrelation: normalizeJsonRepairCorrelation(body.repair, runId) }
        : {}),
    })
  }

  const dispatchPromise = dispatch()
  if (operationKey !== undefined) {
    operations.set(operationKey, { promise: dispatchPromise })
  }
  try {
    return await waitForPublicDispatchStage(this, await dispatchPromise, waitFor, false)
  } finally {
    if (operationKey !== undefined && operations.get(operationKey)?.promise === dispatchPromise) {
      operations.delete(operationKey)
    }
  }
}

export async function openHeadlessBrokerSessionForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  options: { executionFormat?: HrcExecutionFormat | undefined } = {}
): Promise<HrcRuntimeSnapshot> {
  const executionFormat = options.executionFormat ?? 'format1'
  const reusableRuntime = getReusableHeadlessRuntimeForSession(this.db, session.hostSessionId)
  if (reusableRuntime) {
    assertV2SelectionCompatibleForReuse(reusableRuntime, intent)
    assertActuatorSplitRuntimeReuse(intent, reusableRuntime)
    assertBrokerRuntimeExecutionFormat(this, reusableRuntime, executionFormat, 'open')
    return await finalizeHeadlessBrokerSessionOpen(this, reusableRuntime)
  }

  const durableHeadless = getDurableHeadlessRuntimeForReattach(this.db, session.hostSessionId)
  if (durableHeadless) {
    assertV2SelectionCompatibleForReuse(durableHeadless, intent)
    const durableInvocation =
      durableHeadless.activeInvocationId !== undefined
        ? this.db.brokerInvocations.getByInvocationId(durableHeadless.activeInvocationId)
        : null
    const terminalInvocation =
      durableInvocation !== null &&
      isTerminalBrokerInvocationState(durableInvocation.invocationState)
    let shouldCleanUp = terminalInvocation
    if (!terminalInvocation) {
      const reattachResult = await this.reattachDurableBrokerSessionForOpen(durableHeadless)
      const recovered =
        reattachResult.state === 'reattached'
          ? this.db.runtimes.getByRuntimeId(durableHeadless.runtimeId)
          : null
      if (recovered && recovered.activeInvocationId !== undefined) {
        assertActuatorSplitRuntimeReuse(intent, recovered)
        assertBrokerRuntimeExecutionFormat(this, recovered, executionFormat, 'open')
        return await finalizeHeadlessBrokerSessionOpen(this, recovered)
      }
      shouldCleanUp = reattachResult.state !== 'rejected-outside-runtime-root'
    }

    if (shouldCleanUp) {
      await this.terminateRuntime(durableHeadless, {
        dropContinuation: !terminalInvocation,
      }).catch((error: unknown) => {
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
      })
    }
  }

  const runtime = await this.startHeadlessBrokerRuntime(
    session,
    intent,
    '',
    executionFormat === 'format2' ? undefined : `broker-session-open-${randomUUID()}`,
    {
      allowCompilerInitialInputWithoutIdentity: true,
      executionFormat,
      // Format 2 session-open creates no user input. Compile its empty broker
      // start without profile priming, or Codex observes priming as a native turn.
      ...(executionFormat === 'format2' ? { coldBirthPromptMode: 'replace-priming' } : {}),
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

/** A request cannot silently join an invocation frozen to another format. */
export function assertBrokerRuntimeExecutionFormat(
  server: Pick<HrcServerInstanceForHandlers, 'db'>,
  runtime: HrcRuntimeSnapshot,
  selectedExecutionFormat: HrcExecutionFormat,
  operation: 'dispatch' | 'open' = 'dispatch'
): void {
  const invocationId = runtime.activeInvocationId
  const frozenExecutionFormat =
    invocationId === undefined
      ? 'format1'
      : (server.db.brokerInvocations.getByInvocationId(invocationId)?.executionFormat ?? 'format1')
  if (frozenExecutionFormat === selectedExecutionFormat) return
  throw new HrcRuntimeUnavailableError(
    `broker invocation is frozen to ${frozenExecutionFormat}; this ${operation} selected ${selectedExecutionFormat}`,
    {
      code: 'execution_format_mismatch',
      runtimeId: runtime.runtimeId,
      invocationId,
      frozenExecutionFormat,
      selectedExecutionFormat,
    }
  )
}

async function finalizeHeadlessBrokerSessionOpen(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<HrcRuntimeSnapshot> {
  // Session-open is a provisioning surface just like managed start and first-turn
  // dispatch. Publish the presentation decision for the external viewer.
  void server.publishPresentation(runtime)
  return runtime
}

export async function reattachDurableBrokerSessionForOpen(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<DurableBrokerDispatchReattachResult> {
  return await reattachDurableBrokerForDispatch(this.db, runtime, {
    runtimeRoot: this.options.runtimeRoot,
    controller: this.getHarnessBrokerController(),
    inFlightOperations: this.brokerReattachOperations,
    brokerUnixClientFactory:
      this.brokerUnixClientFactory ??
      ((options) =>
        connectObservedBrokerUnixClient(options) as ReturnType<BrokerUnixClientFactory>),
  })
}

export async function waitForBrokerSessionOpenReady(
  this: HrcServerInstanceForHandlers,
  runtimeId: string,
  invocationId: string
): Promise<HrcRuntimeSnapshot> {
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
  if (
    isTerminalBrokerInvocationState(invocation.invocationState) ||
    isRuntimeUnavailableStatus(runtime.status) ||
    runtime.status === 'failed'
  ) {
    throw new HrcRuntimeUnavailableError('broker session open invocation unavailable', {
      runtimeId,
      invocationId,
      invocationState: invocation.invocationState,
      runtimeStatus: runtime.status,
      route: 'broker-session-open',
    })
  }
  const probe = await this.getHarnessBrokerController().seatProbe(runtimeId)
  if (!probe.ok || probe.response.seat.state !== 'idle') {
    throw new HrcRuntimeUnavailableError('broker session open seat is not idle', {
      runtimeId,
      invocationId,
      seat: probe.ok ? probe.response.seat : undefined,
      brokerHeldDepth: probe.ok ? probe.response.brokerHeldDepth : undefined,
      brokerError: probe.ok ? undefined : probe.error,
      route: 'broker-session-open',
    })
  }
  return runtime
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
        generation: session.generation,
      },
    },
  }
  // Session-open has no caller/user turn, but must allow ASPC bundle/profile
  // priming fallback to initialize the broker invocation.
  normalized.initialPrompt = undefined
  normalized.attachments = undefined
  return normalized
}
