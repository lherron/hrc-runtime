import {
  HrcBadRequestError,
  HrcConflictError,
  HrcErrorCode,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
  parseAppSessionScopeRef,
} from 'hrc-core'
import type {
  HrcContinuationRef,
  HrcRuntimeIntent,
  HrcSessionRecord,
  HrcTargetAmbiguityCandidateView,
  HrcTargetView,
} from 'hrc-core'
import { resolveNodeLocalPlacement } from './federation/summon-capability.js'
import { withSummonAuthority } from './federation/summon-gate-server.js'
import { formatSessionRef, normalizeTargetLane } from './messages.js'
import { assertReservedAddressAllowsBirth } from './participant-address-provisioning.js'
import { requireSession } from './require-helpers.js'
import { omitPersistedSelectionForReuse } from './selector-message-handlers/selection-request.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { normalizeOptionalQuery, parseJsonBody } from './server-parsers.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { selectResumeContinuationCandidate } from './session-resume-continuation.js'
import { createSessionSuccessorFromContinuation } from './session-successor.js'
import { isObjectRecord } from './target-message-shared.js'
import {
  findTargetSession,
  isActiveTargetSession,
  toTargetView,
  toTargetViewWithArtifactProbe,
} from './target-view.js'

export function handleListTargets(this: HrcServerInstanceForHandlers, url: URL): Response {
  const projectId = normalizeOptionalQuery(url.searchParams.get('projectId'))
  const laneRef = normalizeTargetLane(normalizeOptionalQuery(url.searchParams.get('lane')))
  const includeDormant = url.searchParams.get('includeDormant') === 'true'
  const views: HrcTargetView[] = []

  for (const session of this.listAllSessions()) {
    // T-08576 D6: app-scope sessions are not addressable targets.
    if (parseAppSessionScopeRef(session.scopeRef) !== null) {
      continue
    }
    if (!includeDormant && !isActiveTargetSession(this.db, session)) {
      continue
    }
    if (includeDormant && session.status === 'archived' && !session.continuation?.key) {
      continue
    }
    if (
      includeDormant &&
      session.status !== 'archived' &&
      !isActiveTargetSession(this.db, session)
    ) {
      continue
    }
    if (projectId && session.identity?.projectId !== projectId) {
      continue
    }
    if (laneRef && normalizeTargetLane(session.laneRef) !== laneRef) {
      continue
    }

    const view = toTargetView(this.db, session)
    views.push(view)
  }

  const targets = new Map<string, HrcTargetView>()
  const candidatesBySessionRef = new Map<string, HrcTargetView[]>()

  for (const view of views) {
    const candidates = candidatesBySessionRef.get(view.sessionRef)
    if (candidates) candidates.push(view)
    else candidatesBySessionRef.set(view.sessionRef, [view])

    const existing = targets.get(view.sessionRef)
    if (!existing || (view.generation ?? 0) >= (existing.generation ?? 0)) {
      targets.set(view.sessionRef, view)
    }
  }

  for (const view of targets.values()) {
    const candidates = candidatesBySessionRef.get(view.sessionRef) ?? []
    const concreteCandidates = candidates.filter(
      (candidate) => candidate.runtime !== undefined || candidate.activeHostSessionId !== undefined
    )
    if (concreteCandidates.length > 1) {
      view.ambiguityCandidates = concreteCandidates.map(toAmbiguityCandidateView)
    }
  }

  return json(Array.from(targets.values()).sort((a, b) => a.sessionRef.localeCompare(b.sessionRef)))
}

function toAmbiguityCandidateView(view: HrcTargetView): HrcTargetAmbiguityCandidateView {
  return {
    sessionRef: view.sessionRef,
    scopeRef: view.scopeRef,
    laneRef: view.laneRef,
    state: view.state,
    activeHostSessionId: view.activeHostSessionId,
    generation: view.generation,
    runtime: view.runtime,
  }
}

export async function handleGetTarget(
  this: HrcServerInstanceForHandlers,
  url: URL
): Promise<Response> {
  const sessionRef = normalizeOptionalQuery(url.searchParams.get('sessionRef'))
  if (!sessionRef) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required', {
      field: 'sessionRef',
    })
  }

  const session = findTargetSession(this.db, sessionRef)
  if (!session) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_SESSION, `unknown session "${sessionRef}"`, {
      sessionRef,
    })
  }

  return json(await toTargetViewWithArtifactProbe(this.db, session, 'scan'))
}

export async function handleCreateSessionSuccessor(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isObjectRecord(body)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const sessionRef = body['sessionRef']
  if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required', {
      field: 'sessionRef',
    })
  }

  const priorHostSessionId = body['priorHostSessionId']
  if (priorHostSessionId !== undefined && typeof priorHostSessionId !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'priorHostSessionId must be a string',
      {
        field: 'priorHostSessionId',
      }
    )
  }

  const prior =
    priorHostSessionId !== undefined
      ? requireSession(this.db, priorHostSessionId)
      : findTargetSession(this.db, sessionRef)
  if (!prior) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_SESSION, `unknown session "${sessionRef}"`, {
      sessionRef,
    })
  }
  if (!prior.continuation?.key) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'session has no continuation to resume',
      { hostSessionId: prior.hostSessionId }
    )
  }

  // Raw successor mint (POST /v1/sessions/create-successor) — a summon path in
  // its own right, not reachable through ensureTargetSession.
  const successor = await createNotifiedSessionSuccessor(this, prior, undefined)

  return json({
    hostSessionId: successor.hostSessionId,
    status: successor.status,
    generation: successor.generation,
    priorHostSessionId: successor.priorHostSessionId,
    continuation: successor.continuation,
    scopeRef: successor.scopeRef,
    laneRef: successor.laneRef,
    session: successor,
  })
}

/**
 * T-07899 — `POST /v1/sessions/resume-continuation`.
 *
 * Policy authority for `hrc resume`: select the latest recorded provider
 * continuation for the normalized target (status-neutral — archived/dormant/
 * removed-orphaned all count), mint an active successor that inherits it, and
 * return the successor so the CLI starts/prepares/dispatches ONLY against it.
 *
 * Never fresh-launches: a target with no captured continuation fails with a
 * structured non-2xx error and creates no successor. A selected prior whose
 * runtime is still live (not an unavailable status), or a conflicting current
 * successor, returns a 409 conflict and creates no successor.
 */
export async function handleResumeContinuation(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isObjectRecord(body)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const sessionRef = body['sessionRef']
  if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required', {
      field: 'sessionRef',
    })
  }

  const priorHostSessionId = body['priorHostSessionId']
  if (priorHostSessionId !== undefined && typeof priorHostSessionId !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'priorHostSessionId must be a string',
      { field: 'priorHostSessionId' }
    )
  }

  const intent = body['intent'] as HrcRuntimeIntent | undefined
  const selection = selectResumeContinuationCandidate(this.db, {
    sessionRef,
    ...(priorHostSessionId !== undefined ? { priorHostSessionId } : {}),
  })

  if (selection.outcome === 'none') {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.NO_RESUMABLE_CONTINUATION,
      `cannot resume "${sessionRef}": no captured continuation to resume. \`hrc resume\` only picks up an existing continuation; use \`hrc run\` to start fresh.`,
      { sessionRef }
    )
  }

  const prior = selection.session

  // Reject a selected prior that still has a live (non-unavailable) runtime —
  // resuming would fork a second live runtime for the same continuation.
  const liveRuntime = this.db.runtimes
    .listByHostSessionId(prior.hostSessionId)
    .find((runtime) => !isRuntimeUnavailableStatus(runtime.status))
  if (liveRuntime) {
    throw new HrcConflictError(
      HrcErrorCode.RESUME_RUNTIME_LIVE,
      `cannot resume "${sessionRef}": its runtime is still live; use \`hrc attach\`, or terminate/kill it before resume.`,
      {
        sessionRef,
        hostSessionId: prior.hostSessionId,
        runtimeId: liveRuntime.runtimeId,
        runtimeStatus: liveRuntime.status,
      }
    )
  }

  const successor = await createNotifiedSessionSuccessor(
    this,
    prior,
    intent,
    'local',
    prior.continuation
  )

  return json({
    hostSessionId: successor.hostSessionId,
    status: successor.status,
    generation: successor.generation,
    priorHostSessionId: successor.priorHostSessionId,
    continuation: successor.continuation,
    scopeRef: successor.scopeRef,
    laneRef: successor.laneRef,
    session: successor,
  })
}

export async function handleArchiveAbandonedSessions(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isObjectRecord(body)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const rawIdleThresholdDays = body['idleThresholdDays']
  const idleThresholdDays =
    rawIdleThresholdDays === undefined
      ? 7
      : typeof rawIdleThresholdDays === 'number' && Number.isFinite(rawIdleThresholdDays)
        ? rawIdleThresholdDays
        : undefined
  if (idleThresholdDays === undefined || idleThresholdDays < 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'idleThresholdDays must be a non-negative number',
      { field: 'idleThresholdDays' }
    )
  }

  return json({ ...archiveIdleSessions(this, idleThresholdDays), idleThresholdDays })
}

export type ArchiveIdleSessionsResult = {
  archived: number
  skippedPrimary: number
  skippedNotIdle: number
  skippedNoContinuation: number
  skippedApp: number
}

/**
 * T-07575 — the idle-archive pass, callable without an HTTP request so the
 * recurring sweep and `POST /v1/sessions/archive-abandoned` run exactly the
 * same code.
 *
 * This writes `sessions.status` and nothing else. It never deletes a row and
 * never touches `continuation_json` — Lance's binding condition on the
 * retention policy (2026-08-25) is that no path introduced here deletes.
 */
export function archiveIdleSessions(
  server: HrcServerInstanceForHandlers,
  idleThresholdDays: number
): ArchiveIdleSessionsResult {
  const activeSince = new Date(Date.now() - idleThresholdDays * 24 * 60 * 60 * 1000).toISOString()
  const now = timestamp()
  // Recency comes from `listIdleSessionCandidates`, which reads the same
  // authoritative expression as the bounded projection. Deriving it here from
  // `session.updatedAt` instead is the trap this design was rejected for once:
  // `updateStatus` writes `updated_at`, so a sweep that sensed on it would mark
  // every row it archived as active-this-second and defeat its own outcome.
  const idle = server.listIdleSessionCandidates(activeSince)
  let archived = 0
  let skippedPrimary = 0
  let skippedNotIdle = 0
  let skippedNoContinuation = 0
  let skippedApp = 0

  for (const session of server.listAllSessions()) {
    if (session.status !== 'active') {
      continue
    }
    // T-08576 D6: app identity is owned by the app surface, never archived here.
    if (parseAppSessionScopeRef(session.scopeRef) !== null) {
      skippedApp += 1
      continue
    }
    if (session.identity?.taskId === undefined || session.identity.taskId === 'primary') {
      skippedPrimary += 1
      continue
    }
    if (!idle.has(session.hostSessionId)) {
      skippedNotIdle += 1
      continue
    }
    // A session with no continuation key must NOT be archived. `toTargetState`
    // reports archived-without-a-key as 'broken', and `handleListTargets` drops
    // it from dormant listings outright. That is a capability change, not a
    // view change, and this sweep is only licensed to make the view honest.
    if (!session.continuation?.key) {
      skippedNoContinuation += 1
      continue
    }

    server.db.sessions.updateStatus(session.hostSessionId, 'archived', now)
    archived += 1
  }

  return { archived, skippedPrimary, skippedNotIdle, skippedNoContinuation, skippedApp }
}

async function normalizeLocalProjectSuccessorIntent(
  scopeRef: string,
  projectId: string | undefined,
  intent: HrcRuntimeIntent | undefined,
  origin: 'local' | 'federated-ingress'
): Promise<HrcRuntimeIntent | undefined> {
  if (intent === undefined || origin === 'federated-ingress' || projectId === undefined) {
    return intent
  }

  const resolved = await resolveNodeLocalPlacement(scopeRef, {
    env: process.env,
    cwd: process.cwd(),
  })
  if (resolved.placement === undefined) {
    const detail = resolved.unresolvableProjectPath
      ? `project root could not be resolved from ${resolved.unresolvableProjectPath}`
      : `agent home could not be resolved (${resolved.missingAgentPath ?? 'unknown search path'})`
    throw new HrcRuntimeUnavailableError(
      `cannot create local successor for ${scopeRef}: ${detail}`,
      {
        scopeRef,
        reason: resolved.unresolvableProjectPath
          ? 'project-root-unresolvable'
          : 'agent-home-unresolvable',
      }
    )
  }

  return {
    ...intent,
    placement: resolved.placement,
  }
}

export async function createNotifiedSessionSuccessor(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent | undefined,
  origin: 'local' | 'federated-ingress' = 'local',
  requiredContinuation?: HrcContinuationRef | undefined
): Promise<HrcSessionRecord> {
  // Covers hrc resume, archived-target turn-handoff, and archived-target DM.
  // Locally inherited placement is stale evidence, not a capability. Resolve
  // it again at this spawn boundary and persist the normalized intent on the
  // new generation. Federated ingress remains verbatim because its placement
  // contract is localized separately from origin-node absolute paths.
  // R-4.3.2. A reserved host address is never given a substitute birth: the
  // address belongs to its own incarnation whether or not one is attached, and
  // mail to an absent host stays a truthful open obligation (R-4.3.3).
  assertReservedAddressAllowsBirth(server, session.scopeRef, session.laneRef)
  const capabilityIntent = await normalizeLocalProjectSuccessorIntent(
    session.scopeRef,
    session.identity?.projectId,
    intent ??
      (session.lastAppliedIntentJson === undefined
        ? undefined
        : omitPersistedSelectionForReuse(session.lastAppliedIntentJson)),
    origin
  )
  return await withSummonAuthority(
    server,
    {
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      path: 'archived-successor',
      intent: 'implicit',
      knownSession: true,
      origin,
      ...(capabilityIntent === undefined
        ? {}
        : {
            capabilityHint: {
              placement: capabilityIntent.placement,
            },
            // T-07398: the successor's birth reads the same directive block.
            ...(capabilityIntent.provision === undefined
              ? {}
              : { provision: capabilityIntent.provision }),
          }),
    },
    () => {
      const raced = findTargetSession(
        server.db,
        formatSessionRef(session.scopeRef, session.laneRef)
      )
      if (raced !== null && raced.hostSessionId !== session.hostSessionId) {
        if (requiredContinuation === undefined) return raced
        if (
          raced.continuation !== undefined &&
          !sameContinuation(raced.continuation, requiredContinuation)
        ) {
          return createHistoricalResumeSuccessor(
            server,
            session,
            raced,
            requiredContinuation,
            capabilityIntent
          )
        }
        return bindResumeContinuationToSuccessor(server, raced, requiredContinuation)
      }
      const successor = server.db.sqlite.transaction(() => {
        const created = createSessionSuccessorFromContinuation(server.db, session, {
          ...(capabilityIntent ? { lastAppliedIntentJson: capabilityIntent } : {}),
        })
        return created
      })()
      server.notifyEvent(
        server.appendEvent(successor, 'session.created', {
          created: true,
          priorHostSessionId: session.hostSessionId,
          reason: 'successor-from-continuation',
        })
      )
      return successor
    }
  )
}

/**
 * An explicit historical resume is allowed to branch away from a newer stored
 * continuation. Keep generations monotonic for the target while linking the
 * new row directly to the session whose provider continuation was selected.
 */
function createHistoricalResumeSuccessor(
  server: HrcServerInstanceForHandlers,
  selected: HrcSessionRecord,
  current: HrcSessionRecord,
  requiredContinuation: HrcContinuationRef,
  capabilityIntent: HrcRuntimeIntent | undefined
): HrcSessionRecord {
  // R-4.3.2, the historical-resume door.
  assertReservedAddressAllowsBirth(server, current.scopeRef, current.laneRef)
  const liveRuntime = server.db.runtimes
    .listByHostSessionId(current.hostSessionId)
    .find((runtime) => !isRuntimeUnavailableStatus(runtime.status))
  if (liveRuntime !== undefined) {
    throw new HrcConflictError(
      HrcErrorCode.RESUME_RUNTIME_LIVE,
      `cannot resume historical session "${selected.hostSessionId}": the current successor already has a live runtime`,
      {
        hostSessionId: current.hostSessionId,
        runtimeId: liveRuntime.runtimeId,
        runtimeStatus: liveRuntime.status,
      }
    )
  }

  const successor = server.db.sqlite.transaction(() => {
    const created = createSessionSuccessorFromContinuation(
      server.db,
      { ...selected, continuation: requiredContinuation },
      {
        generation: Math.max(selected.generation, current.generation) + 1,
        ...(capabilityIntent ? { lastAppliedIntentJson: capabilityIntent } : {}),
      }
    )
    return created
  })()
  server.notifyEvent(
    server.appendEvent(successor, 'session.created', {
      created: true,
      priorHostSessionId: selected.hostSessionId,
      displacedHostSessionId: current.hostSessionId,
      reason: 'successor-from-historical-continuation',
    })
  )
  return successor
}

function sameContinuation(left: HrcContinuationRef, right: HrcContinuationRef): boolean {
  return left.key === right.key && left.provider === right.provider && left.kind === right.kind
}

/**
 * A clear-context-with-drop may already have minted the target's active,
 * keyless successor. Explicit resume must bind the selected historical key to
 * that successor under the same scope/lane mint lock; returning it unchanged
 * would turn resume into a cold start (Daedalus T-07899 review).
 */
function bindResumeContinuationToSuccessor(
  server: HrcServerInstanceForHandlers,
  successor: HrcSessionRecord,
  selected: HrcContinuationRef
): HrcSessionRecord {
  return server.db.sqlite.transaction(() => {
    const current = requireSession(server.db, successor.hostSessionId)
    const liveRuntime = server.db.runtimes
      .listByHostSessionId(current.hostSessionId)
      .find((runtime) => !isRuntimeUnavailableStatus(runtime.status))
    if (liveRuntime !== undefined) {
      throw new HrcConflictError(
        HrcErrorCode.RESUME_RUNTIME_LIVE,
        `cannot bind resumed continuation to "${formatSessionRef(
          current.scopeRef,
          current.laneRef
        )}": its active successor already has a live runtime`,
        {
          hostSessionId: current.hostSessionId,
          runtimeId: liveRuntime.runtimeId,
          runtimeStatus: liveRuntime.status,
        }
      )
    }

    if (current.continuation !== undefined && !sameContinuation(current.continuation, selected)) {
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        `cannot bind resumed continuation to "${formatSessionRef(
          current.scopeRef,
          current.laneRef
        )}": its active successor carries a different continuation`,
        { hostSessionId: current.hostSessionId }
      )
    }

    const now = timestamp()
    const bound =
      current.continuation === undefined
        ? server.db.sessions.updateContinuation(current.hostSessionId, selected, now)
        : server.db.sessions.setContinuationReuseDisabled(current.hostSessionId, false, now)
    if (
      bound === null ||
      bound.continuation === undefined ||
      !sameContinuation(bound.continuation, selected)
    ) {
      throw new Error(`failed to bind resume continuation to ${current.hostSessionId}`)
    }
    return bound
  })()
}
