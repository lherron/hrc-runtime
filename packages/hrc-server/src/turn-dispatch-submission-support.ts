import { HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  DispatchTurnResponse,
  DispatchTurnTerminalOutcome,
  EnqueueSubmissionRequest,
  HrcBrokerInvocationEventRecord,
  HrcEventEnvelope,
  HrcExecutionFormat,
  HrcLifecycleEvent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcSubmissionDisposition,
  HrcSubmissionDoor,
  HrcSubmissionDoorReport,
  HrcSubmissionResponse,
  InvokeSubmissionRequest,
  PreemptAdmission,
  PreemptAdmissionResponse,
  PreemptSubmissionRequest,
  SteerSubmissionRequest,
} from 'hrc-core'
import { refuseAppScopedSession } from './app-session-identity.js'
import { projectSemanticTurnResponse } from './event-notification-handlers.js'
import {
  brokerRuntimeRefusesAdmissionClass,
  requireContinuity,
  requireSession,
} from './require-helpers.js'
import { canonicalRequestHash } from './scope-claim-core.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { parseJsonBody, parseSubmissionRequest } from './server-parsers.js'
import { isRuntimeUnavailableStatus, json } from './server-util.js'
import { findTargetSession } from './target-view.js'

export type PublicDispatchWaitStage = 'accepted' | 'turn_started' | 'terminal'

export type InFlightIdempotentDispatch = {
  promise: Promise<DispatchTurnResponse>
}

export const idempotentDispatches = new WeakMap<
  HrcServerInstanceForHandlers,
  Map<string, InFlightIdempotentDispatch>
>()

export type SubmissionDoor = HrcSubmissionDoor
export type SubmissionDoorRequest =
  | SteerSubmissionRequest
  | EnqueueSubmissionRequest
  | InvokeSubmissionRequest
  | PreemptSubmissionRequest

export function resolveSubmissionTarget(
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

export function runOriginFromSubmission(origin: SubmissionDoorRequest['origin']) {
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

export function assertIdempotencyExecutionFormat(
  frozenExecutionFormat: HrcExecutionFormat,
  selectedExecutionFormat: HrcExecutionFormat,
  detail: { hostSessionId: string; idempotencyKey: string; source: 'run' | 'preparation' }
): void {
  if (frozenExecutionFormat === selectedExecutionFormat) return
  throw new HrcRuntimeUnavailableError(
    `idempotency key is frozen to ${frozenExecutionFormat}; this request selected ${selectedExecutionFormat}`,
    {
      code: 'execution_format_mismatch',
      ...detail,
      frozenExecutionFormat,
      selectedExecutionFormat,
    }
  )
}

/** Stable format-2 identity excludes wait controls but includes every admission input. */
export function format2RequestHash(value: Record<string, unknown>): string {
  return canonicalRequestHash({ executionFormat: 'format2', ...value })
}

export function resolvePublicWaitStage(input: {
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
export function joinedOutcome(
  projection: Pick<HrcSubmissionResponse, 'disposition' | 'terminal'>
): DispatchTurnTerminalOutcome | undefined {
  if (projection.disposition?.type !== 'absorbed' || projection.terminal === undefined) {
    return undefined
  }
  const status = projection.terminal.status
  return status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled'
}

export function terminalOutcome(status: string): DispatchTurnTerminalOutcome | undefined {
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
export function activeBrokerRuntimeForSession(
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
export function publicDoorReport(
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
