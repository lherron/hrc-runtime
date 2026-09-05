import { randomUUID } from 'node:crypto'

import {
  HrcConflictError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
  isExactStartRuntimeRequest,
  isSuffixStartRuntimeRequest,
  validateFence,
} from 'hrc-core'
import type {
  DispatchTurnResponse,
  DispatchTurnTerminalOutcome,
  EnqueueSubmissionRequest,
  HrcBrokerInvocationEventRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcSubmissionDisposition,
  HrcSubmissionResponse,
  HrcTurnResponseFormat,
  InvokeSubmissionRequest,
  OpenBrokerSessionResponse,
  PreemptSubmissionRequest,
  PrepareAttachedRunResponse,
  ResumeAttachedRunResponse,
  StartRuntimeResponse,
  SteerSubmissionRequest,
} from 'hrc-core'
import {
  assertActuatorSplitRouteAdmission,
  assertActuatorSplitRuntimeReuse,
  normalizeActuatorSplitPolicy,
} from './actuator-split.js'
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
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { hasLeasedBrokerSubstrate } from './broker/runtime-hosting.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import { projectSemanticTurnResponse } from './event-notification-handlers.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import {
  brokerRuntimeSupportsAdmissionClass,
  isBrokerRuntimeInputDispatchable,
  isTerminalBrokerInvocationState,
  requireContinuity,
  requireKnownRuntime,
  requireSession,
} from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import {
  findDispatchInteractiveRuntime,
  getDurableHeadlessRuntimeForReattach,
  getReusableHeadlessRuntimeForSession,
} from './runtime-select.js'
import {
  DEFAULT_ATTACHED_RUN_RESUME_TIMEOUT_MS,
  DEFAULT_ATTACHED_START_READY_TIMEOUT_MS,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import {
  parseDispatchTurnRequest,
  parseEnsureRuntimeRequest,
  parseJsonBody,
  parseOpenBrokerSessionRequest,
  parsePrepareAttachedRunRequest,
  parseResumeAttachedRunRequest,
  parseStartRuntimeRequest,
  parseSubmissionRequest,
} from './server-parsers.js'
import type {
  AttachBeforeInvocationStartOption,
  CoalescedQueuedMember,
  DispatchRunPersistenceOptions,
  PendingAttachedRunOperation,
} from './server-types.js'
import { dispatchRunPersistence } from './server-types.js'
import {
  isRuntimeUnavailableStatus,
  json,
  requireDispatchRuntimeId,
  timestamp,
} from './server-util.js'
import {
  type DurableBrokerDispatchReattachResult,
  reattachDurableBrokerForDispatch,
} from './startup-reconcile.js'
import { toEnsureRuntimeResponse, toStartRuntimeResponse } from './status-views.js'
import { findTargetSession } from './target-view.js'

type PublicDispatchWaitStage = 'accepted' | 'turn_started' | 'terminal'

type InFlightIdempotentDispatch = {
  promise: Promise<DispatchTurnResponse>
}

const idempotentDispatches = new WeakMap<
  HrcServerInstanceForHandlers,
  Map<string, InFlightIdempotentDispatch>
>()

type SubmissionDoor = 'steer' | 'enqueue' | 'invoke' | 'preempt'
type SubmissionDoorRequest =
  | SteerSubmissionRequest
  | EnqueueSubmissionRequest
  | InvokeSubmissionRequest
  | PreemptSubmissionRequest

function resolveSubmissionTarget(
  server: HrcServerInstanceForHandlers,
  target: string,
  allowHostSessionId: boolean
): HrcSessionRecord | null {
  if (allowHostSessionId) {
    const exact = server.db.sessions.getByHostSessionId(target)
    if (exact !== null) {
      const continuity = requireContinuity(server.db, exact)
      return requireSession(server.db, continuity.activeHostSessionId)
    }
  }
  return findTargetSession(server.db, target)
}

const OPERATOR_PRINCIPALS = new Set(['agent:lance', 'lance', 'human:lance'])

export function isOperatorPrincipal(principalRef: string): boolean {
  return OPERATOR_PRINCIPALS.has(principalRef)
}

function runOriginFromSubmission(origin: SubmissionDoorRequest['origin']) {
  const kind = isOperatorPrincipal(origin.principalRef)
    ? ('human' as const)
    : origin.principalRef.startsWith('agent:')
      ? ('agent' as const)
      : origin.principalRef.startsWith('human:')
        ? ('human' as const)
        : ('system' as const)
  return { actor: origin.principalRef, kind }
}

function parseBrokerPayload(record: { brokerEventJson: string }): Record<string, unknown> {
  try {
    const value = JSON.parse(record.brokerEventJson) as unknown
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export type StoredAdmissionRequest = {
  submissionId: string
  principalRef: string
  envelopeId?: string | undefined
}

/**
 * Join broker manifest submission ids back to their durable admission origins.
 *
 * Preempt authority depends on this exact join. Keeping it here preserves the
 * source-text invariant around §5 while avoiding two subtly different
 * interpretations of the same stored broker events.
 */
export function storedAdmissionRequestsForSubmissionIds(
  records: ReadonlyArray<Pick<HrcBrokerInvocationEventRecord, 'type' | 'brokerEventJson'>>,
  submissionIds: ReadonlySet<string>
): StoredAdmissionRequest[] {
  const requests: StoredAdmissionRequest[] = []
  for (const record of records) {
    if (record.type !== 'admission.requested') continue
    const payload = parseBrokerPayload(record)
    const submissionId = payload['submissionId']
    const origin = payload['origin']
    if (
      typeof submissionId !== 'string' ||
      !submissionIds.has(submissionId) ||
      origin === null ||
      typeof origin !== 'object'
    ) {
      continue
    }
    const principalRef = (origin as Record<string, unknown>)['principalRef']
    const envelopeId = (origin as Record<string, unknown>)['envelopeId']
    if (typeof principalRef !== 'string') continue
    requests.push({
      submissionId,
      principalRef,
      ...(typeof envelopeId === 'string' ? { envelopeId } : {}),
    })
  }
  return requests
}

function submissionDisposition(
  record: { type: string; brokerEventJson: string },
  submissionId: string
): HrcSubmissionDisposition | undefined {
  const payload = parseBrokerPayload(record)
  if (payload['submissionId'] !== submissionId) return undefined
  const turnId = payload['turnId']
  switch (record.type) {
    case 'submission.executed':
      return typeof turnId === 'string' ? { type: 'executed', turnId } : undefined
    case 'submission.absorbed':
      return typeof turnId === 'string' ? { type: 'absorbed', turnId } : undefined
    case 'submission.rejected':
      return {
        type: 'rejected',
        reason: typeof payload['reason'] === 'string' ? payload['reason'] : 'rejected',
      }
    case 'submission.expired':
      return { type: 'expired' }
    case 'submission.cancelled':
      return { type: 'cancelled' }
    case 'submission.lost':
      return {
        type: 'lost',
        reason: typeof payload['reason'] === 'string' ? payload['reason'] : 'turn-correlation-lost',
      }
    default:
      return undefined
  }
}

function terminalStatus(record: { type: string; brokerEventJson: string }, turnId: string) {
  const payload = parseBrokerPayload(record)
  if (payload['turnId'] !== turnId) return undefined
  switch (record.type) {
    case 'turn.completed':
      return 'completed' as const
    case 'turn.failed':
      return 'failed' as const
    case 'turn.interrupted':
      return 'interrupted' as const
    default:
      return undefined
  }
}

export async function waitForSubmissionTerminal(
  server: HrcServerInstanceForHandlers,
  input: {
    invocationId: string
    runId: string
    submissionId: string
    signal: AbortSignal
    waitForTurnTerminal?: boolean | undefined
  }
): Promise<Pick<HrcSubmissionResponse, 'disposition' | 'terminal'>> {
  const evaluate = (
    records: ReadonlyArray<{ type: string; brokerEventJson: string }>
  ): Pick<HrcSubmissionResponse, 'disposition' | 'terminal'> | undefined => {
    const disposition = records
      .map((record) => submissionDisposition(record, input.submissionId))
      .find((candidate) => candidate !== undefined)
    if (disposition === undefined) return undefined
    if (disposition.type !== 'executed' || input.waitForTurnTerminal === false) {
      return { disposition }
    }
    const status = records
      .map((record) => terminalStatus(record, disposition.turnId))
      .find((candidate) => candidate !== undefined)
    if (status === undefined) return undefined
    const finalMessage = projectSemanticTurnResponse(server.db, input.runId).body
    return {
      disposition,
      terminal: {
        turnId: disposition.turnId,
        status,
        ...(finalMessage.length > 0 ? { finalMessage } : {}),
      },
    }
  }

  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: Pick<HrcSubmissionResponse, 'disposition' | 'terminal'>) => {
      if (settled) return
      settled = true
      server.rawBrokerSubscribers.delete(subscriber)
      input.signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      server.rawBrokerSubscribers.delete(subscriber)
      reject(new HrcRuntimeUnavailableError('submission wait aborted', { input }))
    }
    const subscriber = (notification: {
      record: { invocationId: string; type: string; brokerEventJson: string }
    }) => {
      if (notification.record.invocationId !== input.invocationId) return
      const value = evaluate(
        server.db.brokerInvocationEvents.listByInvocationId(input.invocationId)
      )
      if (value !== undefined) finish(value)
    }
    server.rawBrokerSubscribers.add(subscriber)
    input.signal.addEventListener('abort', onAbort, { once: true })
    const existing = evaluate(
      server.db.brokerInvocationEvents.listByInvocationId(input.invocationId)
    )
    if (existing !== undefined) finish(existing)
  })
}

function resolvePublicWaitStage(input: {
  waitFor?: PublicDispatchWaitStage | undefined
  waitForCompletion?: boolean | undefined
}): PublicDispatchWaitStage {
  if (input.waitFor !== undefined) return input.waitFor
  return input.waitForCompletion === true ? 'terminal' : 'accepted'
}

function terminalOutcome(status: string): DispatchTurnTerminalOutcome | undefined {
  return status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'zombie'
    ? status
    : undefined
}

export async function preemptAuthorized(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  request: PreemptSubmissionRequest
): Promise<boolean> {
  if (isOperatorPrincipal(request.origin.principalRef)) return true
  if (request.origin.envelopeId === undefined) return false
  const runtime = server.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .filter(
      (candidate) =>
        candidate.controllerKind === 'harness-broker' &&
        candidate.activeInvocationId !== undefined &&
        !isRuntimeUnavailableStatus(candidate.status)
    )
    .at(-1)
  if (runtime === undefined || runtime.activeInvocationId === undefined) return false
  const probe = await server.getHarnessBrokerController().seatProbe(runtime.runtimeId)
  if (!probe.ok || probe.response.seat.state !== 'turn-active') return false
  const manifest = await server
    .getHarnessBrokerController()
    .turnManifest(runtime.runtimeId, probe.response.seat.turnId)
  if (!manifest.ok) return false
  const manifestIds = new Set(manifest.response.submissionIds)
  return storedAdmissionRequestsForSubmissionIds(
    server.db.brokerInvocationEvents.listByInvocationId(runtime.activeInvocationId),
    manifestIds
  ).some(
    (origin) =>
      origin.principalRef === request.origin.principalRef && origin.envelopeId !== undefined
  )
}

export async function handleSubmission(
  this: HrcServerInstanceForHandlers,
  request: Request,
  door: SubmissionDoor
): Promise<Response> {
  const raw = await parseJsonBody(request)
  const body: SubmissionDoorRequest =
    door === 'steer'
      ? parseSubmissionRequest(raw, 'steer')
      : door === 'enqueue'
        ? parseSubmissionRequest(raw, 'enqueue')
        : door === 'invoke'
          ? parseSubmissionRequest(raw, 'invoke')
          : parseSubmissionRequest(raw, 'preempt')
  let session = resolveSubmissionTarget(this, body.target, door !== 'steer')
  if (session === null) {
    throw new HrcRuntimeUnavailableError('submission target is unavailable', {
      target: body.target,
      door,
    })
  }
  if (door !== 'steer') {
    const staleRotation = await this.maybeAutoRotateStaleSession(session, {
      trigger: `submission-${door}`,
    })
    session = staleRotation.session
  }
  if (
    door === 'preempt' &&
    !(await preemptAuthorized(this, session, body as PreemptSubmissionRequest))
  ) {
    return json({
      submissionId: `hrc-rejected-${randomUUID()}`,
      admission: 'rejected',
      reason: 'authority-denied',
      disposition: { type: 'rejected', reason: 'authority-denied' },
    } satisfies HrcSubmissionResponse)
  }
  if (body.freshContext === true) {
    const rotation = await this.rotateSessionContext(session, {
      relaunch: false,
      dropContinuation: true,
      reason: `submission-${door}-fresh-context`,
    })
    session = requireSession(this.db, rotation.hostSessionId)
  }
  const runId = `run-${randomUUID()}`
  const sessionBoundBody =
    door === 'steer'
      ? undefined
      : (body as EnqueueSubmissionRequest | InvokeSubmissionRequest | PreemptSubmissionRequest)
  const intent =
    door === 'steer'
      ? session.lastAppliedIntentJson
      : normalizeDispatchIntent(
          sessionBoundBody?.runtimeIntent ?? session.lastAppliedIntentJson,
          session,
          runId
        )
  if (intent === undefined) {
    throw new HrcRuntimeUnavailableError('submission target has no runtime intent', {
      target: body.target,
      door,
    })
  }
  const publicResponse = await dispatchPublicSubmission(this, session, intent, body.body, {
    runId,
    // The door response is not complete until the broker has minted its
    // submission identity. This may include provisioning a cold seat, but it
    // never waits for turn execution; disposition waiting remains below.
    waitForCompletion: true,
    submissionDoor: door,
    submissionOrigin: body.origin,
    origin: runOriginFromSubmission(body.origin),
    responseFormat: body.responseFormat,
    freshContext: body.freshContext,
    ...('ttlMs' in body && body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
    ...('turnPolicy' in body && body.turnPolicy !== undefined
      ? { turnPolicy: body.turnPolicy }
      : {}),
    ...(sessionBoundBody?.establishedBrokerInvocationId !== undefined
      ? { establishedBrokerInvocationId: sessionBoundBody.establishedBrokerInvocationId }
      : {}),
    requireSubmissionIdentity: true,
  })
  const wait = 'wait' in body && body.wait === true
  return await waitForPublicDispatchStage(
    this,
    publicResponse,
    wait ? 'terminal' : 'accepted',
    false,
    request.signal,
    true
  )
}

function publicDispatchBody(
  body: Omit<DispatchTurnResponse, 'stage' | 'status' | 'outcome' | 'replayed' | 'error'> & {
    status?: string | undefined
  },
  stage: DispatchTurnResponse['stage'],
  options: {
    replayed: boolean
    outcome?: DispatchTurnTerminalOutcome | undefined
    errorCode?: string | undefined
    errorMessage?: string | undefined
  }
): DispatchTurnResponse {
  const status =
    stage === 'accepted'
      ? 'accepted'
      : stage === 'turn_started'
        ? 'started'
        : (options.outcome ?? 'failed')
  return {
    ...body,
    stage,
    status,
    replayed: options.replayed,
    ...(options.outcome !== undefined ? { outcome: options.outcome } : {}),
    ...(options.errorMessage !== undefined
      ? {
          error: {
            ...(options.errorCode !== undefined ? { code: options.errorCode } : {}),
            message: options.errorMessage,
          },
        }
      : {}),
  } as DispatchTurnResponse
}

async function dispatchPublicSubmission(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  options: DispatchTurnForSessionOptions & { requireSubmissionIdentity?: boolean | undefined }
): Promise<DispatchTurnResponse> {
  const { requireSubmissionIdentity = false, ...dispatchOptions } = options
  const response = await server.dispatchTurnForSession(session, intent, prompt, dispatchOptions)
  const dispatched = (await response.json()) as DispatchTurnResponse
  if (
    requireSubmissionIdentity &&
    (dispatched.submissionId === undefined || dispatched.admission === undefined)
  ) {
    throw new HrcRuntimeUnavailableError('broker submission returned no admission identity', {
      hostSessionId: session.hostSessionId,
      runId: dispatchOptions.runId,
      door: dispatchOptions.submissionDoor,
    })
  }
  const run =
    dispatchOptions.runId !== undefined
      ? server.db.runs.getByRunId(dispatchOptions.runId)
      : undefined
  const outcome = run ? terminalOutcome(run.status) : undefined
  return publicDispatchBody(dispatched, outcome === undefined ? 'accepted' : 'terminal', {
    replayed: false,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(run?.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
    ...(run?.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
  })
}

function replayDispatchBody(
  server: HrcServerInstanceForHandlers,
  run: NonNullable<ReturnType<HrcServerInstanceForHandlers['db']['runs']['getByRunId']>>
): DispatchTurnResponse {
  const runtime =
    run.runtimeId !== undefined ? server.db.runtimes.getByRuntimeId(run.runtimeId) : null
  const invocationId = run.invocationId ?? runtime?.activeInvocationId
  const firstLifecycleSeq =
    server.db.hrcEvents.listByRun(run.runId).map((event) => event.hrcSeq)[0] ??
    server.db.hrcEvents.maxHrcSeq() + 1
  const base = {
    runId: run.runId,
    hostSessionId: run.hostSessionId,
    generation: run.generation,
    ...(run.runtimeId !== undefined ? { runtimeId: run.runtimeId } : {}),
    transport: (runtime?.transport ?? run.transport) as DispatchTurnResponse['transport'],
    // Broker-headless runtime rows remain queue-capable internally, but the
    // public in-flight endpoint is SDK-only. Preserve the same truthful
    // capability projection on idempotent replay as on the original response.
    supportsInFlightInput:
      runtime === null || runtime.transport === 'headless' ? false : runtime.supportsInflightInput,
    ...(invocationId !== undefined
      ? { startIdentity: { kind: 'broker', invocationId } as const }
      : runtime !== null
        ? { startIdentity: { kind: 'sdk' } as const }
        : {}),
    observation: {
      lifecycle: {
        selector: {
          runId: run.runId,
          ...(run.runtimeId !== undefined ? { runtimeId: run.runtimeId } : {}),
          generation: run.generation,
        },
        fromSeq: firstLifecycleSeq,
      },
      ...(invocationId !== undefined && run.runtimeId !== undefined
        ? {
            broker: {
              selector: {
                invocationId,
                runId: run.runId,
                runtimeId: run.runtimeId,
                generation: run.generation,
              },
              afterSeq: 0,
            },
          }
        : {}),
    },
  }
  const outcome = terminalOutcome(run.status)
  return publicDispatchBody(base, outcome === undefined ? 'accepted' : 'terminal', {
    replayed: true,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
    ...(run.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
  })
}

async function waitForPublicDispatchStage(
  server: HrcServerInstanceForHandlers,
  base: DispatchTurnResponse,
  requested: PublicDispatchWaitStage,
  replayed: boolean,
  signal: AbortSignal = new AbortController().signal,
  requireSubmissionIdentity = false
): Promise<Response> {
  if (requested === 'accepted' || base.stage === 'terminal') {
    const dispatch = { ...base, replayed }
    return json(
      projectSubmissionResponse(dispatch, {}, requireSubmissionIdentity),
      base.stage === 'accepted' && base.admission !== 'rejected' ? 202 : 200
    )
  }

  const invocationId = base.observation?.broker?.selector.invocationId
  if (base.submissionId === undefined || invocationId === undefined) {
    throw new HrcRuntimeUnavailableError('dispatch wait requires broker submission identity', {
      runId: base.runId,
      requested,
    })
  }
  const projection = await waitForSubmissionTerminal(server, {
    invocationId,
    runId: base.runId,
    submissionId: base.submissionId,
    signal,
    waitForTurnTerminal: requested === 'terminal',
  })
  const run = server.db.runs.getByRunId(base.runId)
  const outcome = run === null ? undefined : terminalOutcome(run.status)
  const dispatch = publicDispatchBody(base, requested, {
    replayed,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(run?.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
    ...(run?.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
  })
  return json(projectSubmissionResponse(dispatch, projection, requireSubmissionIdentity), 200)
}

export function projectSubmissionResponse(
  dispatch: DispatchTurnResponse,
  projection: Pick<HrcSubmissionResponse, 'disposition' | 'terminal'> = {},
  requireSubmissionIdentity = false
): DispatchTurnResponse | HrcSubmissionResponse {
  if (dispatch.submissionId === undefined || dispatch.admission === undefined) {
    if (requireSubmissionIdentity) {
      throw new HrcRuntimeUnavailableError('broker submission returned no admission identity', {
        runId: dispatch.runId,
      })
    }
    return dispatch
  }
  const disposition = projection.disposition
  if (dispatch.admission === 'rejected') {
    return {
      submissionId: dispatch.submissionId,
      admission: 'rejected',
      ...(dispatch.reason !== undefined ? { reason: dispatch.reason } : {}),
      disposition: disposition ?? {
        type: 'rejected',
        reason: dispatch.reason ?? 'rejected',
      },
    } satisfies HrcSubmissionResponse
  }
  if (
    disposition?.type === 'rejected' ||
    disposition?.type === 'expired' ||
    disposition?.type === 'cancelled' ||
    disposition?.type === 'lost'
  ) {
    return {
      submissionId: dispatch.submissionId,
      admission: 'admitted',
      ...(dispatch.reason !== undefined ? { reason: dispatch.reason } : {}),
      disposition,
    } satisfies HrcSubmissionResponse
  }
  return {
    ...dispatch,
    submissionId: dispatch.submissionId,
    admission: 'admitted',
    ...(dispatch.reason !== undefined ? { reason: dispatch.reason } : {}),
    ...projection,
  }
}

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
  assertActuatorSplitRouteAdmission(intent, route)
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
  const idempotencyKey = body.idempotencyKey

  if (idempotencyKey !== undefined) {
    const existing = this.db.runs.getByDispatchIdempotencyKey(session.hostSessionId, idempotencyKey)
    if (existing !== null) {
      return await waitForPublicDispatchStage(
        this,
        replayDispatchBody(this, existing),
        waitFor,
        true
      )
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
      runId,
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
      ...(body.repair !== undefined
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
  intent: HrcRuntimeIntent
): Promise<HrcRuntimeSnapshot> {
  const reusableRuntime = getReusableHeadlessRuntimeForSession(
    this.db,
    session.hostSessionId,
    intent.harness.provider,
    intent.harness.id
  )
  if (reusableRuntime) {
    assertActuatorSplitRuntimeReuse(intent, reusableRuntime)
    return await finalizeHeadlessBrokerSessionOpen(this, reusableRuntime)
  }

  const durableHeadless = getDurableHeadlessRuntimeForReattach(
    this.db,
    session.hostSessionId,
    intent.harness.provider,
    intent.harness.id
  )
  if (durableHeadless) {
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

type AttachedRunResult = StartRuntimeResponse | DispatchTurnResponse

async function dispatchTurnResponseJson(response: Response) {
  return (await response.json()) as DispatchTurnResponse
}

function runtimeIdFromAttachedRunResult(result: AttachedRunResult): string {
  if ('runId' in result) {
    return requireDispatchRuntimeId(result)
  }
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
  const runtimeId = requireDispatchRuntimeId(body)

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
          runtimeId,
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
                runtimeId,
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

  const pendingOperation: PendingAttachedRunOperation = { result: operation }
  this.attachedRunOperations.set(pendingStartId, pendingOperation)
  void operation.catch(() => undefined)

  try {
    const winner = await Promise.race([
      controller
        .waitForAttachedStartReady(pendingStartId, DEFAULT_ATTACHED_START_READY_TIMEOUT_MS)
        .then(
          (ready: { pendingStartId: string; runtime: HrcRuntimeSnapshot }) => ({
            kind: 'prepared' as const,
            ready,
          }),
          (error: unknown) => ({ kind: 'ready_timeout' as const, error })
        ),
      operation.then((result) => ({ kind: 'started' as const, result })),
    ])

    if (winner.kind === 'ready_timeout') {
      throw new HrcRuntimeUnavailableError(
        `attached broker start did not become ready within ${DEFAULT_ATTACHED_START_READY_TIMEOUT_MS}ms`,
        { pendingStartId, timeoutMs: DEFAULT_ATTACHED_START_READY_TIMEOUT_MS }
      )
    }

    if (winner.kind === 'prepared') {
      pendingOperation.resumeDeadlineTimer = setTimeout(() => {
        if (this.attachedRunOperations.get(pendingStartId) !== pendingOperation) return
        this.attachedRunOperations.delete(pendingStartId)
        controller.cancelAttachedStart(
          pendingStartId,
          `attached run resume deadline expired: ${pendingStartId}`
        )
      }, DEFAULT_ATTACHED_RUN_RESUME_TIMEOUT_MS)
      pendingOperation.resumeDeadlineTimer.unref?.()
      return json({
        status: 'prepared',
        pendingStartId,
        hostSessionId: winner.ready.runtime.hostSessionId,
        runtimeId: winner.ready.runtime.runtimeId,
        attach: await attachDescriptorBody(this, winner.ready.runtime),
      } satisfies PrepareAttachedRunResponse)
    }

    this.attachedRunOperations.delete(pendingStartId)
    controller.cancelAttachedStart(pendingStartId, 'attached run completed without a pending start')
    const runtime = requireKnownRuntime(this.db, runtimeIdFromAttachedRunResult(winner.result))
    return json({
      status: 'started',
      result: winner.result,
      attach: await attachDescriptorBody(this, runtime),
    } satisfies PrepareAttachedRunResponse)
  } catch (error) {
    this.attachedRunOperations.delete(pendingStartId)
    if (pendingOperation.resumeDeadlineTimer) {
      clearTimeout(pendingOperation.resumeDeadlineTimer)
    }
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
  const pendingOperation = this.attachedRunOperations.get(body.pendingStartId)
  if (!pendingOperation) {
    throw new HrcRuntimeUnavailableError('attached run is not pending', {
      pendingStartId: body.pendingStartId,
      route: 'attached-run',
    })
  }
  this.attachedRunOperations.delete(body.pendingStartId)
  if (pendingOperation.resumeDeadlineTimer) {
    clearTimeout(pendingOperation.resumeDeadlineTimer)
  }

  const resumed = this.getHarnessBrokerController().resumeAttachedStart(body.pendingStartId)
  if (!resumed.ok) {
    throw new HrcRuntimeUnavailableError(resumed.error.message, {
      pendingStartId: body.pendingStartId,
      code: resumed.error.code,
      route: 'attached-run',
    })
  }

  const result = (await pendingOperation.result) as AttachedRunResult
  return json({
    status: 'started',
    result,
  } satisfies ResumeAttachedRunResponse)
}

type DispatchTurnForSessionOptions = DispatchRunPersistenceOptions & {
  runId?: string | undefined
  ensureInteractiveRuntime?: boolean | undefined
  waitForCompletion?: boolean | undefined
  joinInFlightRuntimeStart?: boolean | undefined
  attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
  repairCorrelation?: JsonRepairRunCorrelation | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
  coalescedMembers?: readonly CoalescedQueuedMember[] | undefined
  /** T-07397 surface-ownership proof; see DispatchTurnRequest. */
  establishedBrokerInvocationId?: string | undefined
  /**
   * A mail summons that is itself birthing an interactive launch-primed seat
   * rides that seat's launch turn. Ignored by reuse, headless, SDK, and
   * non-launch-primed routes (T-07920).
   */
  launchPromptOnColdBirth?: boolean | undefined
}

export async function dispatchTurnForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  inputIntent: HrcRuntimeIntent,
  prompt: string,
  options: DispatchTurnForSessionOptions = {}
): Promise<Response> {
  const existingRun = options.runId ? this.db.runs.getByRunId(options.runId) : null
  const releaseAdmission = this.turnAdmissionGate.admit({
    existingAcceptedRun: existingRun?.status === 'accepted',
  })
  try {
    return await dispatchAdmittedTurnForSession.call(this, session, inputIntent, prompt, options)
  } finally {
    releaseAdmission()
  }
}

async function dispatchAdmittedTurnForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  inputIntent: HrcRuntimeIntent,
  prompt: string,
  options: DispatchTurnForSessionOptions
): Promise<Response> {
  assertLocalPersonaAllowed(this, session.scopeRef)
  const runId = options.runId ?? `run-${randomUUID()}`
  const normalizedInputIntent = normalizeDispatchIntent(inputIntent, session, runId)
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
  //
  // T-07397: a caller's surface-reuse refusal does NOT veto this redirect. The
  // redirect selects a claude-code-tmux BROKER PANE (HRC-leased, not a user
  // TTY); it is not, by itself, delivery into anyone's existing surface. Vetoing
  // it here did not route the turn somewhere safer — it dropped every
  // refusal-stamped claude dispatch onto the retired legacy-exec route (a hard
  // 503, and the whole of T-07397). Refusal is enforced where reuse is actually
  // decided: `decideInteractiveBrokerAdmission` via `refusesSurfaceReuse`, which
  // is normalization-invariant and therefore survives the rewrite below.
  const callerSurfaceReuseRefusal = disallowsInteractiveSurfaceReuse(normalizedInputIntent)
  const highRiskActuatorSplit =
    normalizeActuatorSplitPolicy(normalizedInputIntent.execution?.actuatorSplit)?.mode ===
    'high-risk'
  const intent =
    this.claudeCodeTmuxBrokerEnabled &&
    !highRiskActuatorSplit &&
    shouldRedirectClaudeToInteractiveBroker(normalizedInputIntent)
      ? normalizeClaudeInteractiveBrokerIntent(normalizedInputIntent)
      : normalizedInputIntent
  let latestRuntime = findDispatchInteractiveRuntime(this.db, session.hostSessionId)
  // T-01873: route the durable-tmux liveness gate through the runtime-hosting
  // choke point. hasLeasedBrokerSubstrate replaces the `transport==='tmux' &&
  // getBrokerRuntimeTmuxSocketPath !== undefined` durability proxy — it is true
  // exactly when the broker process lives in a leased tmux session (the
  // precondition reconcileTmuxRuntimeLiveness needs), and false for an external
  // broker (no tmux substrate), preserving today's tmux-only reconcile.
  if (
    latestRuntime?.controllerKind === 'harness-broker' &&
    hasLeasedBrokerSubstrate(latestRuntime)
  ) {
    latestRuntime = await this.reconcileTmuxRuntimeLiveness(latestRuntime)
  }

  const dispatchIntent = normalizeRuntimeProvisionIntent(intent)
  if (highRiskActuatorSplit && !shouldUseHeadlessTransport(intent)) {
    assertActuatorSplitRouteAdmission(intent, 'interactive-broker')
  }

  // A live, idle interactive broker runtime is the agent's real
  // session — the TUI a human may be watching. A DM/turn for that scope must be
  // delivered INTO it via the broker-reuse path, never spawned as a competing
  // headless run: a headless codex-app-server start resumes the SAME continuation
  // thread the live TUI already owns, finds no rollout in its (re-derived) codex
  // home, and wedges at `starting` — the turn silently dies. The SDK branch below
  // already defers to a live idle interactive runtime; the headless-codex branch
  // must do the same so codex DMs land in the open TUI (broker-reuse) instead of
  // a parallel headless run. When no such runtime exists (cron/autonomous
  // dispatch), the Wave C headless route is still taken.
  const liveInteractiveBrokerReusable =
    !highRiskActuatorSplit &&
    shouldDeferHeadlessToInteractiveBrokerReuse(
      intent,
      toLiveInteractiveRuntimeReuseView(latestRuntime)
    )

  if (shouldUseHeadlessTransport(intent) && !liveInteractiveBrokerReusable) {
    const route = decideHeadlessExecutionRoute(intent, {
      brokerFlagEnabled: this.headlessCodexBrokerEnabled,
    })
    assertActuatorSplitRouteAdmission(intent, route)
    if (route === 'broker') {
      return await withObservation(
        await this.handleHeadlessBrokerDispatchTurn(session, intent, prompt, runId, {
          waitForCompletion: options.waitForCompletion,
          repairCorrelation: options.repairCorrelation,
          responseFormat: options.responseFormat,
          coalescedMembers: options.coalescedMembers,
          ...dispatchRunPersistence(options),
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
          ...dispatchRunPersistence(options),
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
    assertActuatorSplitRouteAdmission(intent, 'sdk')
    // Prefer a live idle interactive runtime over SDK when one is available (spec §11.3.3:
    // headless for CLI/headless-capable targets, SDK only as fallback)
    const liveInteractiveRuntime = latestRuntime
    const interactiveSeat =
      !callerSurfaceReuseRefusal &&
      liveInteractiveRuntime?.controllerKind === 'harness-broker' &&
      liveInteractiveRuntime.activeInvocationId !== undefined
        ? await this.getHarnessBrokerController().seatProbe(liveInteractiveRuntime.runtimeId)
        : undefined
    const interactiveAvailableAndIdle =
      !callerSurfaceReuseRefusal &&
      liveInteractiveRuntime &&
      liveInteractiveRuntime.transport === 'tmux' &&
      liveInteractiveRuntime.tmuxJson !== undefined &&
      !isRuntimeUnavailableStatus(liveInteractiveRuntime.status) &&
      // T-05358: never reuse an interactive runtime whose broker invocation is
      // transitioning (starting/stopping) — row status alone admits `stopping`.
      isBrokerRuntimeInputDispatchable(this.db, liveInteractiveRuntime) &&
      interactiveSeat?.ok === true &&
      interactiveSeat.response.seat.state === 'idle'
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

  // T-07693: a runtime whose BIRTH is still in flight is being born, not stuck.
  // The admission below cannot tell those apart — T-05358 routes every
  // non-input-dispatchable `starting` interactive runtime to
  // stale-and-reprovision — so a second wake landing inside the boot window
  // marked the newborn stale and minted a SECOND seat on the one host session.
  // Two agents, one worktree (observed live on T-07688).
  //
  // Join the birth instead. `runtimeStartOperations` is the same in-flight-start
  // registration that IS predicate (b) of `isClaimScopeFree`, so this is the
  // T-07302 exact-scope invariant enforced one layer down, at the runtime rather
  // than the claim: one live seat per exact scope, whichever source wakes it.
  //
  // T-07202 added this join for the crossing-DM case, but placed it INSIDE
  // `handleInteractiveTmuxBrokerDispatchTurn` — downstream of the admission, so
  // it could not prevent the reprovision — and made it opt-in, so the wrkq wake
  // path never reached it. That guard stays where it is; this one is the fence.
  //
  // Scoped OUT of the attach path deliberately: `attachBeforeInvocationStart` is
  // a promise to the operator that they get the pane before the invocation runs,
  // and an already-accepted birth is past that point. Attached start has its own
  // ready-wait (T-07304); silently dropping the attach here would trade a
  // visible double-seat for an invisible broken promise.
  const invokeRendezvous =
    options.attachBeforeInvocationStart === undefined && options.submissionDoor === 'invoke'
      ? this.invokeFirstTurnRendezvous.get(session.hostSessionId)
      : undefined
  const inFlightBirth =
    options.attachBeforeInvocationStart === undefined
      ? (invokeRendezvous?.operation ?? this.runtimeStartOperations.get(session.hostSessionId))
      : undefined
  if (inFlightBirth !== undefined) {
    // An invoke crossing a launch-carried first turn has no durable accepted
    // row yet. Register it before the await so owner-scoped completion cleanup
    // can preserve the shared runtime across that pre-persistence interval.
    invokeRendezvous?.crossingRunIds.add(runId)
    try {
      const bornRuntime = await inFlightBirth
      // The headless broker registers its boot in the SAME map for the same host
      // session, and a headless runtime is not deliverable through the
      // interactive executor. Only an interactive broker seat is joined here;
      // anything else falls through to the ordinary route with the runtime
      // re-read, since awaiting the birth is exactly what made the old snapshot
      // stale.
      if (bornRuntime.transport === 'tmux' && bornRuntime.controllerKind === 'harness-broker') {
        // Same authority re-check the broker-reuse branch below makes, against
        // the caller's own intent: joining a birth is a reuse, and a
        // write-capable newborn must not become a route around actuator-split
        // validation.
        assertActuatorSplitRuntimeReuse(intent, bornRuntime)
        return await withObservation(
          await this.executeInteractiveBrokerInputTurn(session, bornRuntime, prompt, runId, {
            waitForCompletion: options.waitForCompletion,
            repairCorrelation: options.repairCorrelation,
            responseFormat: options.responseFormat,
            ...dispatchRunPersistence(options),
          })
        )
      }
      latestRuntime = findDispatchInteractiveRuntime(this.db, session.hostSessionId)
    } finally {
      if (invokeRendezvous !== undefined) {
        invokeRendezvous.crossingRunIds.delete(runId)
        if (
          invokeRendezvous.settled &&
          invokeRendezvous.crossingRunIds.size === 0 &&
          this.invokeFirstTurnRendezvous.get(session.hostSessionId) === invokeRendezvous
        ) {
          this.invokeFirstTurnRendezvous.delete(session.hostSessionId)
        }
      }
    }
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
      agentHarnessTmuxBrokerEnabled: this.agentHarnessTmuxBrokerEnabled,
      // T-07397: the caller's proof that it owns this surface. Compared by
      // exact identity against the runtime's ACTIVE invocation; absent means
      // "owns nothing", which can only ever refuse.
      ...(options.establishedBrokerInvocationId !== undefined
        ? { establishedBrokerInvocationId: options.establishedBrokerInvocationId }
        : {}),
    }
  )

  if (admission.decision === 'runtime-unavailable') {
    // T-07397: carry the admission reason into the detail so a caller can tell
    // "scope occupied and you refused reuse — use a fresh scope or drop the
    // refusal" apart from generic unavailability. This throw happens BEFORE the
    // broker-reuse and stale-and-reprovision branches, so a refusal never
    // reaches markRuntimeStaleForBrokerReprovision: zero mutation of the live
    // operator runtime.
    throw new HrcRuntimeUnavailableError(admission.reason, {
      hostSessionId: session.hostSessionId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
      route: 'interactive-broker',
      reason: admission.reason,
    })
  }

  if (
    admission.decision === 'broker-start' &&
    isProviderOnlyOpenAiInteractiveIntent(normalizedInputIntent)
  ) {
    throw new HrcRuntimeUnavailableError('runtime intent is not broker-admissible', {
      hostSessionId: session.hostSessionId,
      provider: normalizedInputIntent.harness.provider,
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
    assertActuatorSplitRuntimeReuse(intent, latestRuntime)
    await this.publishPresentation(latestRuntime, {
      operatorAttachPending: options.attachBeforeInvocationStart !== undefined,
    })
    return await withObservation(
      await this.executeInteractiveBrokerInputTurn(session, latestRuntime, prompt, runId, {
        waitForCompletion:
          admission.allowedBrokerDriver === 'codex-cli-tmux' ||
          admission.allowedBrokerDriver === 'pi-tui-tmux'
            ? false
            : options.waitForCompletion,
        repairCorrelation: options.repairCorrelation,
        responseFormat: options.responseFormat,
        ...dispatchRunPersistence(options),
      })
    )
  }

  if (admission.decision === 'stale-and-reprovision' && latestRuntime) {
    this.markRuntimeStaleForBrokerReprovision(session, latestRuntime, {
      reason: 'interactive-broker-admission-reprovision',
      allowedBrokerDriver: admission.allowedBrokerDriver,
    })
    if (isProviderOnlyInteractiveIntent(normalizedInputIntent)) {
      throw new HrcRuntimeUnavailableError('runtime intent is not broker-admissible', {
        hostSessionId: session.hostSessionId,
        provider: normalizedInputIntent.harness.provider,
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
          joinInFlightRuntimeStart: options.joinInFlightRuntimeStart,
          coldBirthPromptMode: options.launchPromptOnColdBirth
            ? 'replace-priming'
            : options.submissionDoor === 'invoke'
              ? 'append-to-priming'
              : undefined,
          responseFormat: options.responseFormat,
          ...dispatchRunPersistence(options),
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

/**
 * Mode-ENTANGLED surface-reuse reading, kept for the headless/SDK route gate
 * only. T-07397: do NOT use this to decide interactive-broker reuse — it is
 * evaluated against a pre-redirect intent and flips to false once
 * `normalizeClaudeInteractiveBrokerIntent` rewrites `preferredMode`/
 * `harness.interactive`. `refusesSurfaceReuse` (broker-decisions.ts) is the
 * normalization-invariant predicate that governs admission.
 */
function disallowsInteractiveSurfaceReuse(intent: HrcRuntimeIntent): boolean {
  if (intent.execution?.allowInteractiveSurfaceReuse !== false) {
    return false
  }
  return (
    intent.execution?.preferredMode === 'headless' ||
    intent.execution?.preferredMode === 'nonInteractive' ||
    intent.harness.interactive === false
  )
}

export function markRuntimeStaleForBrokerReprovision(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  payload: Record<string, unknown>
): void {
  if (isExternalLifecycleOwner(runtime) || isRuntimeUnavailableStatus(runtime.status)) {
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
    statusChangedAt: now,
    ...runtimeActivityPatch(this.db, runtime.runtimeId, {
      source: 'housekeeping',
      updatedAt: now,
    }),
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
    runtime.transport === 'headless'
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
  handleSubmission,
  handlePrepareAttachedRun,
  handleResumeAttachedRun,
  dispatchTurnForSession,
  openHeadlessBrokerSessionForSession,
  reattachDurableBrokerSessionForOpen,
  waitForBrokerSessionOpenReady,
  markRuntimeStaleForBrokerReprovision,
}

export type TurnDispatchHandlersMethods = typeof turnDispatchHandlersMethods
