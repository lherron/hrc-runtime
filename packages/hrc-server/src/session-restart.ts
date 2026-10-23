/**
 * T-10850 — operator session restart (ADR hrc-ios
 * architecture/adr/2026-10-14-semantic-session-restart.md).
 *
 * Ends a seat's conversation and relaunches the same scope fresh: rotate to
 * generation + 1 with the continuation dropped, then start the successor from
 * the inherited intent. It is the semantic form of `/quit` + `hrc start`, for a
 * seat whose large context is no longer in the provider's prompt cache.
 *
 * Phase A checks home authority, freshness, eligibility and idle, and every
 * refusal there mutates nothing. Idle comes from the broker seat (the same probe
 * restartme uses), never `runs.activeRunId`: a human-typed turn has a broker
 * turnId and no run. Anything but an observed `idle` refuses; unknown fails
 * closed. Phase B launches the successor; once phase A commits the response is
 * always 200 and carries the successor's identity with the launch disposition,
 * so a failed launch is recoverable by any summon or `hrc start`.
 *
 * Accepted risks (Lance, 2026-10-14): a turn admitted between the probe and the
 * broker dispose is lost, and concurrent rotations of one generation are not
 * serialized.
 */
import {
  HrcBadRequestError,
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  type HrcRuntimeSnapshot,
  type HrcSessionRecord,
  HrcUnprocessableEntityError,
  type RestartSessionLaunch,
  type RestartSessionRequest,
  type RestartSessionResponse,
} from 'hrc-core'

import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { assertScopeNotRetired } from './federation/summon-gate-server.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import { parseJsonBody } from './parsers/common.js'
import {
  participantRotationUnsupported,
  resolveParticipantDelivery,
} from './participant-delivery.js'
import { requireContinuity, requireSession } from './require-helpers.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { isRuntimeUnavailableStatus, json } from './server-util.js'
import { admitRuntimeStartPrompt } from './turn-admission/start-prompt.js'

type SeatProbeResult =
  | { ok: true; response: { seat: { state: string | null; turnId?: string } } }
  | { ok: false; error: { message: string } }

function parseRestartSessionRequest(raw: unknown): RestartSessionRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'body must be a JSON object')
  }
  const body = raw as Record<string, unknown>
  for (const key of Object.keys(body)) {
    if (key !== 'hostSessionId' && key !== 'expectedGeneration' && key !== 'force') {
      throw new HrcUnprocessableEntityError(HrcErrorCode.UNKNOWN_FIELD, `unknown field "${key}"`, {
        field: key,
      })
    }
  }
  const hostSessionId = body['hostSessionId']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim() === '') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }
  const expectedGeneration = body['expectedGeneration']
  if (typeof expectedGeneration !== 'number' || !Number.isInteger(expectedGeneration)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'expectedGeneration is required and must be an integer',
      { field: 'expectedGeneration' }
    )
  }
  const force = body['force']
  if (force !== undefined && typeof force !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'force must be a boolean', {
      field: 'force',
    })
  }
  return { hostSessionId: hostSessionId.trim(), expectedGeneration, ...(force ? { force } : {}) }
}

function assertFresh(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  expectedGeneration: number
): void {
  const continuity = requireContinuity(server.db, session)
  if (
    continuity.activeHostSessionId === session.hostSessionId &&
    session.generation === expectedGeneration
  ) {
    return
  }
  const active = server.db.sessions.getByHostSessionId(continuity.activeHostSessionId)
  throw new HrcConflictError(
    HrcErrorCode.STALE_CONTEXT,
    'the session moved on; restart the active generation',
    {
      requestedHostSessionId: session.hostSessionId,
      expectedGeneration,
      activeHostSessionId: continuity.activeHostSessionId,
      ...(active ? { activeGeneration: active.generation } : {}),
    }
  )
}

/** Refuse unless every live runtime on the host session reports an idle broker seat. */
async function assertIdle(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord
): Promise<void> {
  for (const runtime of server.db.runtimes.listByHostSessionId(session.hostSessionId)) {
    if (isRuntimeUnavailableStatus(runtime.status)) continue
    const unobservable = (observed: string): never => {
      throw new HrcConflictError(
        HrcErrorCode.SEAT_UNOBSERVABLE,
        `cannot confirm the seat is idle (${observed}); not restarted`,
        { runtimeId: runtime.runtimeId, observed }
      )
    }
    if (runtime.controllerKind !== 'harness-broker') {
      unobservable(`controller ${runtime.controllerKind ?? 'unknown'} has no broker seat`)
    }
    let probe: SeatProbeResult
    try {
      const controller = server.getHarnessBrokerController() as {
        seatProbe(runtimeId: string): Promise<SeatProbeResult>
      }
      probe = await controller.seatProbe(runtime.runtimeId)
    } catch (error) {
      return unobservable(
        `seat probe threw: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!probe.ok) return unobservable(`seat probe failed: ${probe.error.message}`)
    const seat = probe.response.seat
    if (seat.state === 'idle') continue
    if (seat.state === null) return unobservable('seat state is unknown')
    throw new HrcConflictError(HrcErrorCode.RUNTIME_BUSY, `seat is ${seat.state}; not restarted`, {
      runtimeId: runtime.runtimeId,
      seatState: seat.state,
      ...(seat.turnId !== undefined ? { turnId: seat.turnId } : {}),
    })
  }
}

/** `POST /v1/sessions/restart` */
export async function handleRestartSession(
  server: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseRestartSessionRequest(await parseJsonBody(request))
  const session = requireSession(server.db, body.hostSessionId)

  // Phase A: every refusal below mutates nothing.
  assertLocalPersonaAllowed(server, session.scopeRef)
  await assertScopeNotRetired(server, { scopeRef: session.scopeRef, path: 'resolve-session' })
  assertFresh(server, session, body.expectedGeneration)
  const intent = session.lastAppliedIntentJson
  if (intent === undefined) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.MISSING_RUNTIME_INTENT,
      'cannot restart a session with no prior runtime intent',
      { hostSessionId: session.hostSessionId }
    )
  }
  const external = server.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .some((runtime) => isExternalLifecycleOwner(runtime))
  if (external || resolveParticipantDelivery(server, session) !== null) {
    throw participantRotationUnsupported(session, 'session restart')
  }
  if (body.force !== true) await assertIdle(server, session)

  const rotation = await server.rotateSessionContext(session, {
    relaunch: false,
    dropContinuation: true,
    reason: body.force === true ? 'operator-restart-forced' : 'operator-restart',
  })
  const successor = requireSession(server.db, rotation.hostSessionId)

  // Phase B: the rotation is committed; the response reports the launch either way.
  let launch: RestartSessionLaunch
  try {
    const successorIntent = successor.lastAppliedIntentJson ?? intent
    // Inherited input is a prompted START: admit its launch carry so the
    // broker's first turn belongs to this run. Observe completion outside the
    // runtime-producing singleflight, just as /v1/runtimes/start does.
    const delivery =
      (successorIntent.initialPrompt ?? '').length > 0
        ? await admitRuntimeStartPrompt(server, successor, successorIntent, 'fresh_pty', {
            signal: request.signal,
          })
        : undefined
    const started: HrcRuntimeSnapshot =
      delivery === undefined
        ? await server.startRuntimeForSession(successor, successorIntent, 'fresh_pty')
        : await delivery.waitForCompletion()
    launch = { status: 'started', runtimeId: started.runtimeId }
  } catch (error) {
    launch = {
      status: 'failed',
      ...(error instanceof HrcDomainError ? { code: error.code } : {}),
      message: error instanceof Error ? error.message : String(error),
    }
    writeServerLog('WARN', 'session.restart_launch_failed', {
      scopeRef: successor.scopeRef,
      hostSessionId: successor.hostSessionId,
      generation: successor.generation,
      error: launch.message,
    })
  }

  return json({
    priorHostSessionId: session.hostSessionId,
    hostSessionId: successor.hostSessionId,
    generation: successor.generation,
    launch,
  } satisfies RestartSessionResponse)
}
