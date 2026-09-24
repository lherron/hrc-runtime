import { randomUUID } from 'node:crypto'

import {
  HrcConflictError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
  createPhaseRecorder,
  isExactStartRuntimeRequest,
  isSuffixStartRuntimeRequest,
  validateFence,
} from 'hrc-core'
import type {
  ColdBirthPromptMode,
  DispatchTurnResponse,
  DispatchTurnTerminalOutcome,
  EnqueueSubmissionRequest,
  HrcBrokerInvocationEventRecord,
  HrcEventEnvelope,
  HrcLifecycleEvent,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcSubmissionDisposition,
  HrcSubmissionDoor,
  HrcSubmissionDoorReport,
  HrcSubmissionResponse,
  HrcTurnResponseFormat,
  InvokeSubmissionRequest,
  OpenBrokerSessionResponse,
  PhaseRecord,
  PreemptAdmission,
  PreemptAdmissionResponse,
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
  assertAppIdentityOwner,
  assertAppRunIdUnused,
  isAppScopedSession,
  issueAppBirthRunGrant,
  refuseAppScopedSession,
} from './app-session-identity.js'
import { findPreparedAspdAttemptForRetry, readAspdPreparation } from './aspd-headless-start.js'
import {
  CALLER_SURFACE_REUSE_REFUSAL,
  decideHeadlessExecutionRoute,
  decideInteractiveBrokerAdmission,
  getBrokerRuntimeDriver,
  isProducerSelectedOrdinaryBirth,
  normalizeClaudeInteractiveBrokerIntent,
  normalizeCodexInteractiveBrokerIntent,
  normalizeRuntimeProvisionIntent,
  refusesSurfaceReuse,
  runInteractiveTmuxRoute,
  shouldDeferHeadlessToInteractiveBrokerReuse,
  shouldRedirectClaudeToInteractiveBroker,
  shouldRedirectCodexToInteractiveBroker,
  shouldUseHeadlessTransport,
  shouldUseSdkTransport,
  toLatestRuntimeAdmissionView,
  toLiveInteractiveRuntimeReuseView,
} from './broker-decisions.js'
import { BROKER_PREEMPT_UNSUPPORTED_REASON } from './broker/capabilities.js'
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { hasLeasedBrokerSubstrate } from './broker/runtime-hosting.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import { projectSemanticTurnResponse } from './event-notification-handlers.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import {
  type ParticipantDeliveryTarget,
  participantDeliveryUnavailable,
  participantRotationUnsupported,
  resolveParticipantDelivery,
} from './participant-delivery.js'
import { reconnectParticipantAttachment } from './participant-establishment.js'
import {
  type RedirectOffBirthJoin,
  type RedirectOffCodexRoute,
  assertBirthJoinAdmitted,
  assertBirthJoinRoute,
  assertNoOperatorPresentationConflict,
  assertOperatorPresentationRoutable,
  decideCrossingBirthRoute,
  decideRedirectOffCodexRoute,
  isAttachedRunAspdCodexIntent,
  isOmittedChoiceCodexRequest,
  requestsOperatorPresentation,
  scopeHasLiveHeadlessBrokerRuntime,
  startBirthOf,
  withFrozenOperatorPresentation,
} from './presentation-operator.js'
import { projectHrcReleaseIdentity } from './release-provenance.js'
import {
  brokerRuntimeRefusesAdmissionClass,
  brokerRuntimeSupportsAdmissionClass,
  isBrokerRuntimeInputDispatchable,
  isTerminalBrokerInvocationState,
  requireContinuity,
  requireKnownRuntime,
  requireSession,
} from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import {
  assertV2SelectionCompatibleForReuse,
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
  AttachedRunObservation,
  CoalescedQueuedMember,
  DispatchRunPersistenceOptions,
  PendingAttachedRunOperation,
} from './server-types.js'
import { dispatchRunPersistence, submissionDoorCarriesColdLaunch } from './server-types.js'
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

type SubmissionDoor = HrcSubmissionDoor
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
    records: ReadonlyArray<{ type: string; brokerEventJson: string; runId?: string | undefined }>
  ): Pick<HrcSubmissionResponse, 'disposition' | 'terminal'> | undefined => {
    const disposition = records
      .map((record) => submissionDisposition(record, input.submissionId))
      .find((candidate) => candidate !== undefined)
    if (disposition === undefined) return undefined
    // An executed submission started its own turn; an absorbed one (a steer
    // that joined the running turn) has that turn to wait on too.
    if (
      (disposition.type !== 'executed' && disposition.type !== 'absorbed') ||
      input.waitForTurnTerminal === false
    ) {
      return { disposition }
    }
    const terminalRecord = records.find(
      (record) => terminalStatus(record, disposition.turnId) !== undefined
    )
    const status = terminalRecord && terminalStatus(terminalRecord, disposition.turnId)
    if (status === undefined) return undefined
    // A joined turn's messages belong to the run that owns it, not to this one.
    const finalRunId =
      disposition.type === 'absorbed' ? (terminalRecord?.runId ?? input.runId) : input.runId
    const finalMessage = projectSemanticTurnResponse(server.db, finalRunId).body
    return {
      disposition,
      terminal: {
        turnId: disposition.turnId,
        status,
        ...(finalMessage.length > 0 ? { finalMessage } : {}),
      },
    }
  }

  // A run HRC failed before the broker recorded any disposition (a broker whose
  // start failed, a first_turn_missing trip) writes no submission.* rows, so
  // the broker ledger alone never settles it (T-08865). Its own failure does.
  const runFailedUndisposed = ():
    | Pick<HrcSubmissionResponse, 'disposition' | 'terminal'>
    | undefined => {
    const run = server.db.runs.getByRunId(input.runId)
    return run !== null && terminalOutcome(run.status) !== undefined ? {} : undefined
  }

  return await new Promise((resolve, reject) => {
    let settled = false
    const detach = () => {
      server.rawBrokerSubscribers.delete(subscriber)
      server.followSubscribers.delete(runSubscriber)
      input.signal.removeEventListener('abort', onAbort)
    }
    const finish = (value: Pick<HrcSubmissionResponse, 'disposition' | 'terminal'>) => {
      if (settled) return
      settled = true
      detach()
      resolve(value)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      detach()
      reject(new HrcRuntimeUnavailableError('submission wait aborted', { input }))
    }
    const settleFromLedger = (): boolean => {
      const value = evaluate(
        server.db.brokerInvocationEvents.listByInvocationId(input.invocationId)
      )
      if (value !== undefined) finish(value)
      return value !== undefined
    }
    const subscriber = (notification: {
      record: { invocationId: string; type: string; brokerEventJson: string }
    }) => {
      if (notification.record.invocationId !== input.invocationId) return
      settleFromLedger()
    }
    const runSubscriber = (event: HrcEventEnvelope | HrcLifecycleEvent) => {
      if (!('hrcSeq' in event) || event.runId !== input.runId) return
      if (event.eventKind !== 'turn.failed' && event.eventKind !== 'first_turn_missing') return
      if (settleFromLedger()) return
      const failed = runFailedUndisposed()
      if (failed !== undefined) finish(failed)
    }
    server.rawBrokerSubscribers.add(subscriber)
    server.followSubscribers.add(runSubscriber)
    input.signal.addEventListener('abort', onAbort, { once: true })
    if (settleFromLedger()) return
    const failed = runFailedUndisposed()
    if (failed !== undefined) finish(failed)
  })
}

function resolvePublicWaitStage(input: {
  waitFor?: PublicDispatchWaitStage | undefined
  waitForCompletion?: boolean | undefined
}): PublicDispatchWaitStage {
  if (input.waitFor !== undefined) return input.waitFor
  return input.waitForCompletion === true ? 'terminal' : 'accepted'
}

/**
 * A steer that joined a running turn is settled `coalesced` into the owner run,
 * which is not a terminal status of its own; its outcome is the joined turn's
 * (T-08533). Without this the public body reported `failed` for a join whose
 * turn completed.
 */
function joinedOutcome(
  projection: Pick<HrcSubmissionResponse, 'disposition' | 'terminal'>
): DispatchTurnTerminalOutcome | undefined {
  if (projection.disposition?.type !== 'absorbed' || projection.terminal === undefined) {
    return undefined
  }
  const status = projection.terminal.status
  return status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled'
}

function terminalOutcome(status: string): DispatchTurnTerminalOutcome | undefined {
  return status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'zombie'
    ? status
    : undefined
}

/**
 * Resolve the seat the preempt would actually interrupt.
 *
 * Hoisted out of the authority walk because the capability question is asked of
 * the SEAT, not of the caller — including for an operator, who outranks the
 * authority check but cannot grant a driver an interrupt it does not implement.
 */
function activeBrokerRuntimeForSession(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord
): HrcRuntimeSnapshot | undefined {
  return server.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .filter(
      (candidate) =>
        candidate.controllerKind === 'harness-broker' &&
        candidate.activeInvocationId !== undefined &&
        !isRuntimeUnavailableStatus(candidate.status)
    )
    .at(-1)
}

/**
 * The one gate both preempt entry paths pass through — the operator HTTP door
 * (`handleSubmission`) and the mail-kicker hold (`mail-kicker-adapter`).
 *
 * Capability is asked FIRST and of everyone. A preempt is an interruption
 * request, and unlike `invoke` it cannot be honestly degraded to a queue: a
 * queued body reported as an interrupt reports an interrupt that never happened.
 * So when the driver has declared it does not serve the preempt class, the door
 * is refused for an operator principal exactly as for anyone else.
 */
export async function preemptAdmission(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  request: PreemptSubmissionRequest
): Promise<PreemptAdmission> {
  const runtime = activeBrokerRuntimeForSession(server, session)
  if (runtime !== undefined && brokerRuntimeRefusesAdmissionClass(server.db, runtime, 'preempt')) {
    return 'preempt-unsupported'
  }
  if (isOperatorPrincipal(request.origin.principalRef)) return 'authorized'
  if (request.origin.envelopeId === undefined) return 'authority-denied'
  const invocationId = runtime?.activeInvocationId
  if (runtime === undefined || invocationId === undefined) return 'authority-denied'
  return (await preemptOriginOwnsActiveTurn(server, runtime.runtimeId, invocationId, request))
    ? 'authorized'
    : 'authority-denied'
}

/**
 * Generic injector read: resolve the same preempt target and report whether
 * its current authority/capability gate permits an interruption. No rotation,
 * broker admission, or dispatch occurs here; `handleSubmission` rechecks this
 * predicate before the preempt door actuates.
 */
export async function handlePreemptAdmission(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseSubmissionRequest(await parseJsonBody(request), 'preempt')
  const session = resolveSubmissionTarget(this, body.target, true)
  if (session === null) {
    throw new HrcRuntimeUnavailableError('submission target is unavailable', {
      target: body.target,
      door: 'preempt',
    })
  }
  admitSubmissionTarget(session, 'preempt')
  return json({
    admission: await preemptAdmission(this, session, body),
  } satisfies PreemptAdmissionResponse)
}

/**
 * The authority walk proper: does this caller already own a submission in the
 * turn it is asking to interrupt? Unchanged by T-08337 — only its callers moved.
 */
async function preemptOriginOwnsActiveTurn(
  server: HrcServerInstanceForHandlers,
  runtimeId: string,
  activeInvocationId: string,
  request: PreemptSubmissionRequest
): Promise<boolean> {
  const probe = await server.getHarnessBrokerController().seatProbe(runtimeId)
  if (!probe.ok || probe.response.seat.state !== 'turn-active') return false
  const manifest = await server
    .getHarnessBrokerController()
    .turnManifest(runtimeId, probe.response.seat.turnId)
  if (!manifest.ok) return false
  const manifestIds = new Set(manifest.response.submissionIds)
  return storedAdmissionRequestsForSubmissionIds(
    server.db.brokerInvocationEvents.listByInvocationId(activeInvocationId),
    manifestIds
  ).some(
    (origin) =>
      origin.principalRef === request.origin.principalRef && origin.envelopeId !== undefined
  )
}

/**
 * The steer door fails open (T-08536). When the seat's active invocation
 * POSITIVELY advertised admission classes without `steer`, the body goes
 * through enqueue instead of being relayed into the broker's `unsupported:steer`
 * capability rejection. One behavior, no strict mode: the caller asked for
 * "now" and gets "after", and the response and the ledger say so.
 *
 * Silence is not refusal (`brokerRuntimeRefusesAdmissionClass`): an invocation
 * that never declared its classes, and a cold seat with no invocation at all,
 * keep the steer. A cold steer rides the launch turn, which every driver serves.
 */
export function submissionDoorReport(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  requestedDoor: SubmissionDoor
): HrcSubmissionDoorReport & { runtime?: HrcRuntimeSnapshot | undefined } {
  if (requestedDoor !== 'steer') return { effectiveDoor: requestedDoor }
  const runtime = activeBrokerRuntimeForSession(server, session)
  if (runtime === undefined || !brokerRuntimeRefusesAdmissionClass(server.db, runtime, 'steer')) {
    return { effectiveDoor: requestedDoor }
  }
  return {
    effectiveDoor: 'enqueue',
    requestedDoor,
    downgradeReason: 'steer_not_supported',
    runtime,
  }
}

/**
 * Only the steer door reports its door: it is the one door that can change.
 * Every other door's body stays exactly as ratified (T-07880: `/v1/turns` is a
 * deep-equal alias of the invoke door).
 */
function publicDoorReport(
  requestedDoor: SubmissionDoor,
  report: ReturnType<typeof submissionDoorReport>
): HrcSubmissionDoorReport | undefined {
  if (requestedDoor !== 'steer') return undefined
  return report.requestedDoor === undefined
    ? { effectiveDoor: report.effectiveDoor }
    : {
        effectiveDoor: report.effectiveDoor,
        requestedDoor: report.requestedDoor,
        downgradeReason: report.downgradeReason,
      }
}

/**
 * T-08576 G1: the post-resolution entry step for every submission door. App
 * sessions are app-route-only, refused before participant, admission, rotation
 * or dispatch effects. Steer resolves through a strict parser that cannot reach
 * an app scope today; this is its defense in depth.
 */
export function admitSubmissionTarget(session: HrcSessionRecord, door: SubmissionDoor): void {
  refuseAppScopedSession(session, `submission-${door}`)
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
  admitSubmissionTarget(session, door)
  // R7.6: the participant target is resolved BEFORE generic rotation. Rotating
  // a participant's session would move the address off the incarnation that
  // holds it, so an external participant is exempt from the stale sweep and a
  // fresh-context request against one is refused rather than honored quietly.
  const participantSession = resolveParticipantDelivery(this, session) !== null
  if (door !== 'steer' && !participantSession) {
    const staleRotation = await this.maybeAutoRotateStaleSession(session, {
      trigger: `submission-${door}`,
    })
    session = staleRotation.session
  }
  if (participantSession && body.freshContext === true) {
    throw participantRotationUnsupported(session, 'fresh-context rotation')
  }
  if (door === 'preempt') {
    const admission = await preemptAdmission(this, session, body as PreemptSubmissionRequest)
    if (admission !== 'authorized') {
      // The reason is the whole point of the refusal: `unsupported:preempt` says
      // this seat's driver does not implement interruption, `authority-denied`
      // says this caller may not interrupt it. Both are rejections; only one is
      // fixable by the caller.
      const reason =
        admission === 'preempt-unsupported' ? BROKER_PREEMPT_UNSUPPORTED_REASON : 'authority-denied'
      return json({
        submissionId: `hrc-rejected-${randomUUID()}`,
        admission: 'rejected',
        reason,
        disposition: { type: 'rejected', reason },
      } satisfies HrcSubmissionResponse)
    }
  }
  const sessionBoundBody =
    door === 'steer'
      ? undefined
      : (body as EnqueueSubmissionRequest | InvokeSubmissionRequest | PreemptSubmissionRequest)
  if (body.freshContext === true) {
    const rotation = await this.rotateSessionContext(session, {
      relaunch: false,
      dropContinuation: true,
      ...(sessionBoundBody?.runtimeIntent !== undefined
        ? { runtimeIntent: sessionBoundBody.runtimeIntent }
        : {}),
      reason: `submission-${door}-fresh-context`,
    })
    session = requireSession(this.db, rotation.hostSessionId)
  }
  // Read AFTER every session choice above (steer: no stale rotation, last
  // applied intent), so the classes checked belong to the incarnation the body
  // lands on. Those steer-only choices stay on the REQUESTED door on purpose.
  const doorReport = submissionDoorReport(this, session, door)
  const effectiveDoor = doorReport.effectiveDoor
  const idempotencyKey = sessionBoundBody?.idempotencyKey
  const wait = 'wait' in body && body.wait === true
  const invokeColdBirthPromptMode =
    door === 'invoke' ? (body as InvokeSubmissionRequest).coldBirth?.promptMode : undefined
  // A non-waiting cold invoke needs only the durable launch receipt. The
  // provider's invocation.start RPC may remain open for the whole first turn;
  // waiting for it here turns upstream model latency into an injector timeout.
  const allowLaunchReceipt = door === 'invoke' && !wait && invokeColdBirthPromptMode !== undefined
  if (idempotencyKey !== undefined) {
    const existing = this.db.runs.getByDispatchIdempotencyKey(session.hostSessionId, idempotencyKey)
    if (existing !== null) {
      return await waitForPublicDispatchStage(
        this,
        replayDispatchBody(this, existing),
        wait ? 'terminal' : 'accepted',
        true,
        request.signal,
        true,
        publicDoorReport(door, doorReport)
      )
    }
  }
  const runId = `run-${randomUUID()}`
  // R7.6: resolution precedes runtime-intent validation, and this is where that
  // validation actually lives. A participant is routed by its durable linkage,
  // so it has no intent to validate and must not be asked for one -- that
  // question is what answered `missing_runtime_intent` to every queue, and what
  // birthed a substitute when a caller answered it.
  const intent = participantSession
    ? undefined
    : door === 'steer'
      ? session.lastAppliedIntentJson
      : normalizeDispatchIntent(
          sessionBoundBody?.runtimeIntent ?? session.lastAppliedIntentJson,
          session,
          runId
        )
  if (!participantSession && intent === undefined) {
    throw new HrcRuntimeUnavailableError('submission target has no runtime intent', {
      target: body.target,
      door,
    })
  }
  const operationKey =
    idempotencyKey !== undefined ? `${session.hostSessionId}\u0000${idempotencyKey}` : undefined
  const operations = idempotentDispatches.get(this) ?? new Map<string, InFlightIdempotentDispatch>()
  if (!idempotentDispatches.has(this)) idempotentDispatches.set(this, operations)
  const pending = operationKey !== undefined ? operations.get(operationKey) : undefined
  if (pending !== undefined) {
    return await waitForPublicDispatchStage(
      this,
      await pending.promise,
      wait ? 'terminal' : 'accepted',
      true,
      request.signal,
      true,
      publicDoorReport(door, doorReport)
    )
  }
  const dispatchPromise = dispatchPublicSubmission(this, session, intent, body.body, {
    runId,
    // An ordinary submission response is not complete until the broker has
    // minted its identity. A non-waiting cold invoke instead ends at the
    // durable start graph so provider execution cannot hold the launch RPC.
    waitForCompletion: !allowLaunchReceipt,
    submissionDoor: effectiveDoor,
    submissionOrigin: body.origin,
    origin: runOriginFromSubmission(body.origin),
    responseFormat: body.responseFormat,
    freshContext: body.freshContext,
    ...(invokeColdBirthPromptMode !== undefined
      ? { coldBirthPromptMode: invokeColdBirthPromptMode }
      : {}),
    ...('ttlMs' in body && body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
    ...('turnPolicy' in body && body.turnPolicy !== undefined
      ? { turnPolicy: body.turnPolicy }
      : {}),
    ...(sessionBoundBody?.establishedBrokerInvocationId !== undefined
      ? { establishedBrokerInvocationId: sessionBoundBody.establishedBrokerInvocationId }
      : {}),
    ...(idempotencyKey !== undefined ? { dispatchIdempotencyKey: idempotencyKey } : {}),
    requireSubmissionIdentity: true,
  })
  if (operationKey !== undefined) operations.set(operationKey, { promise: dispatchPromise })
  let publicResponse: DispatchTurnResponse
  try {
    publicResponse = await dispatchPromise
  } finally {
    if (operationKey !== undefined && operations.get(operationKey)?.promise === dispatchPromise) {
      operations.delete(operationKey)
    }
  }
  if (doorReport.requestedDoor !== undefined) {
    const runtimeId = publicResponse.runtimeId ?? doorReport.runtime?.runtimeId
    const invocationId =
      publicResponse.observation?.broker?.selector.invocationId ??
      doorReport.runtime?.activeInvocationId
    const payload = {
      ...(runtimeId !== undefined ? { runtimeId } : {}),
      ...(invocationId !== undefined ? { invocationId } : {}),
      ...(publicResponse.submissionId !== undefined
        ? { submissionId: publicResponse.submissionId }
        : {}),
      requestedDoor: doorReport.requestedDoor,
      effectiveDoor,
      reason: doorReport.downgradeReason,
      ...(body.origin.envelopeId !== undefined ? { envelopeId: body.origin.envelopeId } : {}),
    }
    appendHrcEvent(this.db, 'submission.door_downgraded', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      ...(runtimeId !== undefined ? { runtimeId } : {}),
      runId,
      payload,
    })
  }
  return await waitForPublicDispatchStage(
    this,
    publicResponse,
    wait ? 'terminal' : 'accepted',
    false,
    request.signal,
    true,
    publicDoorReport(door, doorReport)
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
  /** Absent for a participant, which is routed by durable linkage (R7.6). */
  intent: HrcRuntimeIntent | undefined,
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
    ...(run.brokerSubmissionId !== undefined
      ? { submissionId: run.brokerSubmissionId, admission: 'admitted' as const }
      : {}),
  }
  const outcome = terminalOutcome(run.status)
  return publicDispatchBody(base, outcome === undefined ? 'accepted' : 'terminal', {
    replayed: true,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
    ...(run.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
  })
}

export async function waitForPublicDispatchStage(
  server: HrcServerInstanceForHandlers,
  base: DispatchTurnResponse,
  requested: PublicDispatchWaitStage,
  replayed: boolean,
  signal: AbortSignal = new AbortController().signal,
  requireSubmissionIdentity = false,
  /** Submission doors only: which door the body actually went through (T-08536). */
  doorReport: HrcSubmissionDoorReport | undefined = undefined
): Promise<Response> {
  const invocationId = base.observation?.broker?.selector.invocationId
  // Legacy drivers can report terminal without broker identity. Preserve their
  // projection-less success; identified submissions can be projected from the
  // durable ledger even when completion won the race with waiter attachment.
  if (
    requested === 'accepted' ||
    (base.stage === 'terminal' && (base.submissionId === undefined || invocationId === undefined))
  ) {
    const dispatch = { ...base, replayed }
    return json(
      { ...projectSubmissionResponse(dispatch, {}, requireSubmissionIdentity), ...doorReport },
      base.stage === 'accepted' && base.admission !== 'rejected' ? 202 : 200
    )
  }

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
  const outcome =
    run === null ? undefined : (terminalOutcome(run.status) ?? joinedOutcome(projection))
  const dispatch = publicDispatchBody(base, requested, {
    replayed,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(run?.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
    ...(run?.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
  })
  return json(
    {
      ...projectSubmissionResponse(dispatch, projection, requireSubmissionIdentity),
      ...doorReport,
    },
    200
  )
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
  refuseAppScopedSession(requested, 'runtime-ensure')
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
  refuseAppScopedSession(requested, 'runtime-start')
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
  refuseAppScopedSession(requestedSession, 'broker-session-open')
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
  refuseAppScopedSession(requestedSession, 'dispatch-turn')
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
  let runId = `run-${randomUUID()}`
  const parsedIntent = normalizeDispatchIntent(
    body.runtimeIntent ?? session.lastAppliedIntentJson,
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
      return await waitForPublicDispatchStage(
        this,
        replayDispatchBody(this, existing),
        waitFor,
        true
      )
    }
  }

  // T-08542: a same-key retry of a never-submitted aspd preparation carries its
  // frozen run identity, so the launch resumes that attempt instead of preparing
  // a new one. No run row exists yet for a prepared attempt.
  if (idempotencyKey !== undefined) {
    const resumable = findPreparedAspdAttemptForRetry(this, session.hostSessionId, idempotencyKey)
    if (resumable !== undefined) {
      runId = resumable.runId
      // T-08553: the frozen preparation already fixed its presentation. Carry
      // its recorded choice so node defaults (Codex redirect, viewer policy) are
      // not re-evaluated on the way back to it.
      intent = withFrozenOperatorPresentation(
        intent,
        readAspdPreparation(this, resumable.operationId).record.intent
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
  const reusableRuntime = getReusableHeadlessRuntimeForSession(this.db, session.hostSessionId)
  if (reusableRuntime) {
    assertV2SelectionCompatibleForReuse(reusableRuntime, intent)
    assertActuatorSplitRuntimeReuse(intent, reusableRuntime)
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
  refuseAppScopedSession(requested, 'prepare-attached-run')
  const { session } = await this.maybeAutoRotateStaleSession(requested, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'prepare-attached-run',
  })
  const pendingStartId = `attached-${randomUUID()}`
  const controller = this.getHarnessBrokerController()
  const phases: PhaseRecord[] = []
  const startedAt = performance.now()
  const elapsed = (since: number): number =>
    Math.max(0, Number((performance.now() - since).toFixed(1)))
  // T-08708: the preparation records its real compile + admission here and
  // names the execution and releases it admitted. They are their own rows ahead
  // of broker-start, whose existing measurement still spans them.
  const observation: AttachedRunObservation = { phases: createPhaseRecorder() }
  const attach = { pendingStartId, observation }
  const hrcRelease = projectHrcReleaseIdentity(this.capturedRelease)
  const diagnostics = (runtimeId?: string) => ({
    releases: {
      ...(hrcRelease === undefined ? {} : { hrc: hrcRelease }),
      ...observation.releases,
    },
    ids: {
      pendingStartId,
      hostSessionId: session.hostSessionId,
      ...(runtimeId === undefined ? {} : { runtimeId }),
    },
    ...(observation.execution === undefined ? {} : { execution: observation.execution }),
    phases: structuredClone(phases),
  })

  const brokerStartAt = performance.now()
  const pushBrokerStart = (
    status: 'ok' | 'error',
    extra: Pick<PhaseRecord, 'reason'> = {}
  ): void => {
    const clientPhases = phases.splice(0)
    phases.push(...observation.phases.records(), ...clientPhases, {
      id: 'broker-start',
      status,
      ms: elapsed(brokerStartAt),
      ...extra,
    })
  }
  const operation = (async (): Promise<AttachedRunResult> => {
    // T-08556 (§1.4): on a node that declares an aspd endpoint, a Codex attached
    // run selects its runtime only through the start singleflight (join first,
    // registered before its first await), with or without a prompt, and the
    // prompt is delivered once after that start settles into the runtime it chose.
    if (isAttachedRunAspdCodexIntent(body.intent)) {
      const { initialPrompt: _initialPrompt, ...startIntent } = body.intent
      let delivered: Response | undefined
      const runtime = await this.startRuntimeForSession(
        session,
        startIntent,
        body.restartStyle ?? 'reuse_pty',
        {
          attachBeforeInvocationStart: attach,
          attachedRunDoor: true,
          ...(body.prompt && body.prompt.length > 0
            ? {
                attachedRunPrompt: {
                  prompt: body.prompt,
                  runId: `run-${randomUUID()}`,
                  onDelivered: (response: Response) => {
                    delivered = response
                  },
                },
              }
            : {}),
        }
      )
      return delivered !== undefined
        ? await dispatchTurnResponseJson(delivered)
        : toStartRuntimeResponse(runtime)
    }
    if (body.prompt && body.prompt.length > 0) {
      const response = await this.dispatchTurnForSession(session, body.intent, body.prompt, {
        runId: `run-${randomUUID()}`,
        waitForCompletion: false,
        attachBeforeInvocationStart: attach,
      })
      return await dispatchTurnResponseJson(response)
    }

    const runtime = await this.startRuntimeForSession(
      session,
      body.intent,
      body.restartStyle ?? 'reuse_pty',
      { attachBeforeInvocationStart: attach }
    )
    return toStartRuntimeResponse(runtime)
  })()

  const pendingOperation: PendingAttachedRunOperation = { result: operation }
  const savePreparationAt = performance.now()
  this.attachedRunOperations.set(pendingStartId, pendingOperation)
  phases.push({ id: 'save-preparation', status: 'ok', ms: elapsed(savePreparationAt) })
  void operation.catch(() => undefined)

  try {
    const brokerReadyAt = performance.now()
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
      phases.push({
        id: 'broker-ready',
        status: 'error',
        ms: elapsed(brokerReadyAt),
        limitMs: DEFAULT_ATTACHED_START_READY_TIMEOUT_MS,
        reason: winner.error instanceof Error ? winner.error.message : String(winner.error),
      })
      throw new HrcRuntimeUnavailableError(
        `attached broker start did not become ready within ${DEFAULT_ATTACHED_START_READY_TIMEOUT_MS}ms`,
        { pendingStartId, timeoutMs: DEFAULT_ATTACHED_START_READY_TIMEOUT_MS }
      )
    }

    if (winner.kind === 'prepared') {
      pushBrokerStart('ok')
      phases.push({
        id: 'broker-ready',
        status: 'ok',
        ms: elapsed(brokerReadyAt),
        limitMs: DEFAULT_ATTACHED_START_READY_TIMEOUT_MS,
      })
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
        diagnostics: diagnostics(winner.ready.runtime.runtimeId),
      } satisfies PrepareAttachedRunResponse)
    }

    pushBrokerStart('ok')
    phases.push({
      id: 'broker-ready',
      status: 'skipped',
      reason: 'start completed without an attach gate',
    })
    this.attachedRunOperations.delete(pendingStartId)
    controller.cancelAttachedStart(pendingStartId, 'attached run completed without a pending start')
    const runtime = requireKnownRuntime(this.db, runtimeIdFromAttachedRunResult(winner.result))
    return json({
      status: 'started',
      result: winner.result,
      attach: await attachDescriptorBody(this, runtime),
      diagnostics: diagnostics(runtime.runtimeId),
    } satisfies PrepareAttachedRunResponse)
  } catch (error) {
    if (!phases.some((phase) => phase.id === 'broker-start')) {
      pushBrokerStart('error', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    if (!phases.some((phase) => phase.id === 'broker-ready')) {
      phases.push({ id: 'broker-ready', status: 'not-reached', reason: 'broker start failed' })
    }
    this.attachedRunOperations.delete(pendingStartId)
    if (pendingOperation.resumeDeadlineTimer) {
      clearTimeout(pendingOperation.resumeDeadlineTimer)
    }
    controller.cancelAttachedStart(
      pendingStartId,
      error instanceof Error ? error.message : String(error)
    )
    if (error instanceof HrcRuntimeUnavailableError) {
      error.detail['phases'] = structuredClone(phases)
      error.detail['ids'] = diagnostics().ids
      error.detail['failingPhase'] ??= innermostFailingPhase(phases)
      error.detail['elapsedMs'] = elapsed(startedAt)
    }
    throw error
  }
}

/** The deepest failed phase along the first failing branch. */
function innermostFailingPhase(phases: readonly PhaseRecord[]): string | undefined {
  const failed = phases.find((phase) => phase.status === 'error')
  if (failed === undefined) return undefined
  return innermostFailingPhase(failed.children ?? []) ?? failed.id
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
  /**
   * Requested cold-launch prompt carriage (T-08610): an explicit per-request
   * override of the `launchPromptOnColdBirth` derivation below. Carried from
   * `POST /v1/submissions/invoke`'s `coldBirth.promptMode`, which is an option
   * on the invoke class method, not an admission-class selector.
   */
  coldBirthPromptMode?: ColdBirthPromptMode | undefined
}

export async function dispatchTurnForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  /** Absent only for a participant, which is routed by durable linkage (R7.6). */
  inputIntent: HrcRuntimeIntent | undefined,
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

/**
 * T-08716: the scope's latest live broker runtime, when that runtime was born
 * under v2. Producer-selected rows carry no HRC provider projection; that
 * absence, not the request's intent, is what marks them. A tmux seat is
 * reconciled first, and one that reconciled dead is not returned, so the
 * dispatch falls through to an ordinary v2 birth. A birth in flight is joined
 * by the cold route instead.
 */
async function findReusableProducerSelectedRuntime(
  this: HrcServerInstanceForHandlers,
  hostSessionId: string
): Promise<HrcRuntimeSnapshot | undefined> {
  if (this.runtimeStartOperations.has(hostSessionId)) return undefined
  const live = this.db.runtimes
    .listByHostSessionId(hostSessionId)
    .filter(
      (runtime) =>
        runtime.controllerKind === 'harness-broker' &&
        runtime.status !== 'failed' &&
        !isRuntimeUnavailableStatus(runtime.status)
    )
    .at(-1)
  if (live === undefined || live.provider !== undefined) return undefined
  if (live.transport !== 'tmux' || !hasLeasedBrokerSubstrate(live)) return live
  const reconciled = await this.reconcileTmuxRuntimeLiveness(live)
  return isRuntimeUnavailableStatus(reconciled.status) ? undefined : reconciled
}

// Drivers whose interactive input turn is delivered without waiting for the
// provider turn, exactly as the legacy broker-reuse branch treats them.
const NON_BLOCKING_TMUX_BROKER_DRIVERS = new Set(['codex-cli-tmux', 'pi-tui-tmux', 'muse-cli-tmux'])

/**
 * T-08716: deliver an ordinary dispatch into a live v2 tmux seat. HRC owns
 * reuse (aspd-prepared-execution-release): the frozen selection is the only
 * reuse identity, and the guards of legacy broker-reuse still apply. A refusal
 * here mutates nothing: the live seat is never stale-marked or replaced.
 */
async function dispatchIntoProducerSelectedTmuxRuntime(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: DispatchTurnForSessionOptions
): Promise<Response> {
  assertV2SelectionCompatibleForReuse(runtime, intent)
  assertActuatorSplitRuntimeReuse(intent, runtime)
  assertNoOperatorPresentationConflict(intent, [runtime])
  // T-07397/T-08540: a refusal to reuse, or a claimed ownership proof, admits
  // only the caller's own active invocation, by exact identity.
  if (refusesSurfaceReuse(intent) || options.establishedBrokerInvocationId !== undefined) {
    const carried = options.establishedBrokerInvocationId
    if (carried === undefined || carried !== runtime.activeInvocationId) {
      throw new HrcRuntimeUnavailableError(CALLER_SURFACE_REUSE_REFUSAL, {
        hostSessionId: session.hostSessionId,
        runtimeId: runtime.runtimeId,
        route: 'producer-selected-reuse',
        reason: CALLER_SURFACE_REUSE_REFUSAL,
      })
    }
  }
  // T-05358: a starting/stopping invocation cannot take input. Unlike the
  // legacy branch this does not reprovision: the seat is still the scope's
  // writer, and the caller retries once it settles.
  if (!isBrokerRuntimeInputDispatchable(this.db, runtime)) {
    throw new HrcRuntimeUnavailableError('broker runtime is transitioning and cannot take input', {
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      route: 'producer-selected-reuse',
      reason: 'broker_runtime_transitioning',
    })
  }
  await this.publishPresentation(runtime, {
    operatorAttachPending: options.attachBeforeInvocationStart !== undefined,
  })
  const driver = getBrokerRuntimeDriver(runtime)
  return await this.executeInteractiveBrokerInputTurn(session, runtime, prompt, runId, {
    waitForCompletion:
      driver !== undefined && NON_BLOCKING_TMUX_BROKER_DRIVERS.has(driver)
        ? false
        : options.waitForCompletion,
    repairCorrelation: options.repairCorrelation,
    responseFormat: options.responseFormat,
    ...dispatchRunPersistence(options),
  })
}

/**
 * Submit into the participant's own existing runtime through the existing
 * broker input-turn path.
 *
 * The transport decides which of the two established executors runs, and both
 * take a runtime that already exists. Nothing new is queued, accounted or
 * receipted here: run persistence, the user-prompt event, first-turn watch,
 * broker admission, wait and replay all remain the ones every other turn uses.
 */
async function deliverIntoAttachedParticipant(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  target: ParticipantDeliveryTarget,
  prompt: string,
  options: DispatchTurnForSessionOptions
): Promise<Response> {
  const runId = options.runId ?? `run-${randomUUID()}`
  const { runtime } = target
  const inputTurnOptions = {
    // The submission doors pass `waitForCompletion: true` to mean "do not
    // return until the broker mints a submission identity" -- their own comment
    // says they never wait for turn EXECUTION. The broker input-turn executors
    // read the same flag as "wait for the turn to finish". Passing it through
    // unchanged made a real enqueue return only after 31,442ms, by which point
    // the host journal already showed turn_started AND turn_completed, so
    // steering into that turn was impossible by construction.
    //
    // Three things make `false` correct here rather than merely shorter. The
    // executors' early return carries `submissionId` and `admission`, so the
    // identity still exists when the door answers. `handleSubmission` performs
    // its OWN terminal wait afterwards via `waitForPublicDispatchStage`, so an
    // explicit `wait: true` still completes only at terminal. And the
    // interactive route already does exactly this for its live drivers. Only
    // door-originated calls are affected; a direct caller (the mail kicker,
    // app sessions) keeps whatever it asked for.
    waitForCompletion: options.submissionDoor === undefined ? options.waitForCompletion : false,
    repairCorrelation: options.repairCorrelation,
    responseFormat: options.responseFormat,
    ...dispatchRunPersistence(options),
  }
  return runtime.transport === 'tmux'
    ? await this.executeInteractiveBrokerInputTurn(
        session,
        runtime,
        prompt,
        runId,
        inputTurnOptions
      )
    : await this.executeHeadlessBrokerInputTurn(session, runtime, prompt, runId, inputTurnOptions)
}

/**
 * T-08555 (§1.3 rules 3–5) — route an omitted-choice Codex dispatch on a
 * redirect-off node, or undefined when the request is not one. A start in
 * flight contributes the birth it has chosen (its decision is awaited, never its
 * boot, so a same-harness headless boot still queues this prompt); a start that
 * recorded no birth is awaited in full, never treated as absent. Rows are judged
 * after tmux reconcile. The result is the authority every later join re-checks.
 */
async function classifyRedirectOffCodexDispatch(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  options: { establishedBrokerInvocationId?: string | undefined }
): Promise<RedirectOffBirthJoin | undefined> {
  if (!isOmittedChoiceCodexRequest(intent)) return undefined
  const inFlightStart = this.runtimeStartOperations.get(session.hostSessionId)
  const inFlightBirth = inFlightStart ? await startBirthOf(inFlightStart) : undefined
  let route: RedirectOffCodexRoute
  if (inFlightBirth !== undefined) {
    route = decideCrossingBirthRoute(intent, inFlightBirth)
  } else {
    if (inFlightStart !== undefined) await inFlightStart.catch(() => undefined)
    const dispatchRuntime = findDispatchInteractiveRuntime(this.db, session.hostSessionId)
    if (
      dispatchRuntime?.controllerKind === 'harness-broker' &&
      hasLeasedBrokerSubstrate(dispatchRuntime)
    ) {
      await this.reconcileTmuxRuntimeLiveness(dispatchRuntime)
    }
    route = decideRedirectOffCodexRoute(
      intent,
      this.db.runtimes.listByHostSessionId(session.hostSessionId)
    )
  }
  return {
    route,
    claudeCodeTmuxBrokerEnabled: this.claudeCodeTmuxBrokerEnabled,
    piTuiTmuxBrokerEnabled: this.piTuiTmuxBrokerEnabled,
    museCliTmuxBrokerEnabled: this.museCliTmuxBrokerEnabled,
    ...(options.establishedBrokerInvocationId !== undefined
      ? { establishedBrokerInvocationId: options.establishedBrokerInvocationId }
      : {}),
  }
}

async function dispatchAdmittedTurnForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  inputIntent: HrcRuntimeIntent | undefined,
  prompt: string,
  options: DispatchTurnForSessionOptions
): Promise<Response> {
  assertLocalPersonaAllowed(this, session.scopeRef)
  if (isAppScopedSession(session)) {
    // T-08576 D5 backstop: an app run id that is already named cannot identify a
    // new turn. Then the app dispatch must hold the selector owner, and its run
    // is reserved under a single-use birth grant before any effect.
    assertAppRunIdUnused(this.db, options.runId)
    assertAppIdentityOwner(session)
  }
  const runId = options.runId ?? `run-${randomUUID()}`
  if (isAppScopedSession(session)) {
    issueAppBirthRunGrant(this.db, session, runId)
  }
  // Built before the participant branch so its response is enriched the same
  // way every other route's is. Without the observation block a caller's
  // explicit `wait: true` cannot find the broker selector and fails with
  // "dispatch wait requires broker submission identity" -- which is exactly
  // what my first cut did, because it returned unenriched.
  const observationContext: DispatchTurnObservationContext = {
    lifecycleFromSeq: this.db.hrcEvents.maxHrcSeq() + 1,
    brokerAfterSeqByInvocation: captureBrokerAfterSeqByInvocation(this, session.hostSessionId),
  }
  const withObservation = async (response: Response): Promise<Response> =>
    enrichDispatchTurnResponse(this, response, observationContext)

  // R7.6: resolve a participant BEFORE the runtime-intent requirement. This is
  // the door every caller shares -- the public submission doors, the addressed
  // mail kicker, the selector and target message paths -- so routing here is
  // what keeps one door from being fixed while the next still births.
  let participantDelivery = resolveParticipantDelivery(this, session)
  if (participantDelivery !== null) {
    // Join the one recovery operation, then RE-READ and fence: the linkage that
    // was current before the await may not be after it, and submitting against
    // the stale read is exactly how input reaches a different writer.
    if (participantDelivery.outcome === 'reconnect') {
      await reconnectParticipantAttachment(
        this,
        participantDelivery.registration,
        participantDelivery.attempt
      )
      participantDelivery = resolveParticipantDelivery(this, session)
    }
    if (participantDelivery === null || participantDelivery.outcome === 'reconnect') {
      // Still not restored. Typed pending keeps the mail eligible; it never
      // falls through to a generic birth.
      throw new HrcRuntimeUnavailableError(
        'participant attachment is being restored on this controller; addressed work stays pending',
        { scopeRef: session.scopeRef, laneRef: session.laneRef, reason: 'participant_reconnecting' }
      )
    }
    if (participantDelivery.outcome === 'refused') {
      throw participantDeliveryUnavailable(session, participantDelivery)
    }
    return await withObservation(
      await deliverIntoAttachedParticipant.call(this, session, participantDelivery, prompt, {
        ...options,
        runId,
      })
    )
  }
  const normalizedInputIntent = normalizeDispatchIntent(inputIntent, session, runId)

  // Fresh ordinary v2 turns compile through ASP before HRC knows anything
  // about a harness, provider, driver or hosting. Existing runtimes continue
  // through their lifecycle/reuse gates below; a cold scope goes directly to
  // the broker admission that persists ASP's frozen execution.
  //
  // T-08716: an ordinary dispatch into a scope whose live broker runtime was
  // itself born under v2 reuses that runtime. It has no HRC provider/driver
  // projection, and the session's stored intent carries no selectors (or stale
  // v1 ones HRC must not interpret), so the legacy interactive admission below
  // could only refuse it or start a second writer beside it.
  const ordinaryV2 = isProducerSelectedOrdinaryBirth(normalizedInputIntent)
  const producerSelected = ordinaryV2
    ? await findReusableProducerSelectedRuntime.call(this, session.hostSessionId)
    : undefined
  if (producerSelected?.transport === 'tmux') {
    return await withObservation(
      await dispatchIntoProducerSelectedTmuxRuntime.call(
        this,
        session,
        producerSelected,
        normalizedInputIntent,
        prompt,
        runId,
        options
      )
    )
  }
  const hasLiveBrokerRuntime = this.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .some(
      (runtime) =>
        runtime.controllerKind === 'harness-broker' &&
        runtime.status !== 'failed' &&
        !isRuntimeUnavailableStatus(runtime.status)
    )
  if (
    ordinaryV2 &&
    (!hasLiveBrokerRuntime ||
      this.runtimeStartOperations.has(session.hostSessionId) ||
      // The headless broker door already reuses, reattaches or reprovisions a
      // v2 headless runtime under the v2 selection-compatibility gate.
      producerSelected !== undefined)
  ) {
    assertActuatorSplitRouteAdmission(normalizedInputIntent, 'broker')
    return await withObservation(
      await this.handleHeadlessBrokerDispatchTurn(session, normalizedInputIntent, prompt, runId, {
        // Submission doors wait at the public projection layer after the
        // durable broker admission exists. Do not make the fresh v2 birth wait
        // for the first provider turn merely to mint that receipt.
        waitForCompletion: options.submissionDoor === undefined ? options.waitForCompletion : false,
        repairCorrelation: options.repairCorrelation,
        responseFormat: options.responseFormat,
        coalescedMembers: options.coalescedMembers,
        ...dispatchRunPersistence(options),
        coldBirthPromptMode:
          options.coldBirthPromptMode ??
          (options.launchPromptOnColdBirth
            ? 'replace-priming'
            : submissionDoorCarriesColdLaunch(options.submissionDoor)
              ? 'append-to-priming'
              : undefined),
      })
    )
  }

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
  const claudeRedirect =
    this.claudeCodeTmuxBrokerEnabled &&
    !highRiskActuatorSplit &&
    shouldRedirectClaudeToInteractiveBroker(normalizedInputIntent)
  // T-08338: responseFormat is per-turn input. A schema-bearing cold Codex
  // dispatch stays on the headless app-server route, whose turn/start request
  // is the schema vehicle. The stock TUI queue protocol has no schema field.
  // T-08553: an explicit per-request no-viewer choice keeps the dispatch
  // headless, exactly as a responseFormat does; an omitted one is delivered into
  // the scope's live headless runtime rather than redirected past it.
  //
  // T-08555: with the redirect off, the scope's established broker runtime (or
  // in-flight birth) selects the admission BEFORE responseFormat, actuator split
  // or node defaults; see classifyRedirectOffCodexDispatch.
  const redirectOffBirthJoin =
    !this.codexCliTmuxBrokerEnabled && !claudeRedirect
      ? await classifyRedirectOffCodexDispatch.call(this, session, normalizedInputIntent, options)
      : undefined
  const redirectOffRoute = redirectOffBirthJoin?.route
  const codexRedirect = this.codexCliTmuxBrokerEnabled
    ? !highRiskActuatorSplit &&
      options.responseFormat === undefined &&
      !requestsOperatorPresentation(normalizedInputIntent) &&
      shouldRedirectCodexToInteractiveBroker(normalizedInputIntent) &&
      !scopeHasLiveHeadlessBrokerRuntime(this.db, session.hostSessionId)
    : redirectOffRoute === 'interactive'
  const intent = claudeRedirect
    ? normalizeClaudeInteractiveBrokerIntent(normalizedInputIntent)
    : codexRedirect
      ? normalizeCodexInteractiveBrokerIntent(normalizedInputIntent)
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

  // T-08553: an explicit no-viewer choice is refused, before any delivery,
  // stale-marking or reprovision, when it cannot be honored or when the scope's
  // live runtime already presents a viewer or an interactive surface.
  if (requestsOperatorPresentation(intent)) {
    assertOperatorPresentationRoutable(intent, {
      claudeRedirect,
      headlessTransport: shouldUseHeadlessTransport(intent),
      headlessRoute: shouldUseHeadlessTransport(intent)
        ? decideHeadlessExecutionRoute(intent, {
            brokerFlagEnabled: this.headlessCodexBrokerEnabled,
            museBrokerFlagEnabled: this.headlessMuseBrokerEnabled,
          })
        : undefined,
    })
    assertNoOperatorPresentationConflict(
      intent,
      this.db.runtimes.listByHostSessionId(session.hostSessionId)
    )
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
    // T-08555: on a redirect-off node an established headless runtime owns the
    // scope; the older tmux deferral must not route past it.
    redirectOffRoute !== 'headless' &&
    !highRiskActuatorSplit &&
    shouldDeferHeadlessToInteractiveBrokerReuse(
      intent,
      toLiveInteractiveRuntimeReuseView(latestRuntime)
    )

  if (shouldUseHeadlessTransport(intent) && !liveInteractiveBrokerReusable) {
    const route = decideHeadlessExecutionRoute(intent, {
      brokerFlagEnabled: this.headlessCodexBrokerEnabled,
      museBrokerFlagEnabled: this.headlessMuseBrokerEnabled,
    })
    assertActuatorSplitRouteAdmission(intent, route)
    if (route === 'broker') {
      return await withObservation(
        await this.handleHeadlessBrokerDispatchTurn(session, intent, prompt, runId, {
          ...(redirectOffBirthJoin !== undefined ? { redirectOffBirthJoin } : {}),
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
      // T-08555: the birth joined here must be the one the route was taken from.
      if (redirectOffBirthJoin !== undefined) {
        await assertBirthJoinRoute(intent, inFlightBirth, redirectOffBirthJoin)
      }
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
        // T-08555: a redirect-off crossing joins a newborn only through
        // interactive admission (T-07397 caller policy, driver and provider).
        if (redirectOffBirthJoin !== undefined) {
          assertBirthJoinAdmitted(intent, bornRuntime, redirectOffBirthJoin)
        }
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
      piTuiTmuxBrokerEnabled: this.piTuiTmuxBrokerEnabled,
      museCliTmuxBrokerEnabled: this.museCliTmuxBrokerEnabled,
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
          admission.allowedBrokerDriver === 'pi-tui-tmux' ||
          admission.allowedBrokerDriver === 'muse-cli-tmux'
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
            admission.allowedBrokerDriver === 'pi-tui-tmux' ||
            admission.allowedBrokerDriver === 'muse-cli-tmux'
              ? false
              : options.waitForCompletion,
          joinInFlightRuntimeStart: options.joinInFlightRuntimeStart,
          ...(redirectOffBirthJoin !== undefined ? { redirectOffBirthJoin } : {}),
          coldBirthPromptMode:
            options.coldBirthPromptMode ??
            (options.launchPromptOnColdBirth
              ? 'replace-priming'
              : submissionDoorCarriesColdLaunch(options.submissionDoor)
                ? 'append-to-priming'
                : undefined),
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
  handlePreemptAdmission,
  handlePrepareAttachedRun,
  handleResumeAttachedRun,
  dispatchTurnForSession,
  openHeadlessBrokerSessionForSession,
  reattachDurableBrokerSessionForOpen,
  waitForBrokerSessionOpenReady,
  markRuntimeStaleForBrokerReprovision,
}

export type TurnDispatchHandlersMethods = typeof turnDispatchHandlersMethods
