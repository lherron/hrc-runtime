import { randomUUID } from 'node:crypto'

import {
  HRC_QUEUED_BEHIND_BUSY_TURN_WARNING,
  HrcBadRequestError,
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
  hrcAdmittedIntoActiveTurn,
  isCodexAppOwnedScopeRef,
} from 'hrc-core'
import type {
  DispatchTurnBySelectorResponse,
  DispatchTurnResponse,
  HrcDeliveryOutcome,
  HrcDeliveryWarning,
  HrcDispatchOrigin,
  HrcDmRuntimeIntent,
  HrcMessageAddress,
  HrcMessageRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTargetAmbiguityCandidateView,
  HrcTargetView,
  HrcTurnResponseFormat,
  ListMessagesResponse,
  SemanticDmRequest,
  SemanticDmResponse,
  SemanticTurnHandoffRequest,
  SemanticTurnHandoffStartedResponse,
  TraceMessageRequest,
  TraceMessageResponse,
  WaitMessageResponse,
} from 'hrc-core'
import { dispatchOriginFromMessageAddress } from './acp-event-bridge.js'
import { shouldUseSdkTransport } from './broker-decisions.js'
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import {
  hasLeasedBrokerSubstrate,
  parseBrokerRuntimeHostingState,
} from './broker/runtime-hosting.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import { resolveNodeLocalPlacement } from './federation/summon-capability.js'
import {
  assertProvisionDirectiveAdmissible,
  assertScopeNotRetired,
  persistSessionTaskClaimAuthority,
  withSummonAuthority,
} from './federation/summon-gate-server.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import { buildMessageTrace } from './message-trace.js'
import {
  type CompleteSemanticDmRequest,
  extractProjectId,
  formatDmPayload,
  formatSessionRef,
  normalizeTargetLane,
  parseMessageFilter,
  parseSemanticDmRequest,
} from './messages.js'
import {
  assertRuntimeNotBusy,
  isBrokerRuntimeInputDispatchable,
  isBrokerRuntimeQueueCapable,
  requireSession,
} from './require-helpers.js'
import { findBusyHeadlessRuntimeForSession, findLatestRuntime } from './runtime-select.js'
import {
  HRC_BUSY_HEADLESS_DM_REJECTION_CODE,
  HRC_BUSY_HEADLESS_DM_REJECTION_MESSAGE,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { isLiveProcess } from './server-lock.js'
import { writeServerLog } from './server-log.js'
import { normalizeOptionalQuery, parseJsonBody } from './server-parsers.js'
import {
  isRuntimeUnavailableStatus,
  json,
  requireDispatchRuntimeId,
  timestamp,
} from './server-util.js'
import { selectResumeContinuationCandidate } from './session-resume-continuation.js'
import { createSessionSuccessorFromContinuation } from './session-successor.js'
import {
  type DurableBrokerDispatchReattachResult,
  reattachDurableBrokerForDispatch,
} from './startup-reconcile.js'
import {
  findTargetSession,
  isActiveTargetSession,
  toTargetView,
  toTargetViewWithArtifactProbe,
} from './target-view.js'
import { createTmuxManager } from './tmux.js'

/**
 * Spreadable dispatch option carrying the DM sender's recorded identity
 * (T-07236). Absent when the sender's scope cannot be parsed — an unattributed
 * run is the honest answer there, and a fabricated actor is not.
 */
function originDispatchOption(from: HrcMessageAddress): { origin?: HrcDispatchOrigin } {
  const origin = dispatchOriginFromMessageAddress(from)
  return origin === undefined ? {} : { origin }
}

export function handleListTargets(this: HrcServerInstanceForHandlers, url: URL): Response {
  const projectId = normalizeOptionalQuery(url.searchParams.get('projectId'))
  const laneRef = normalizeTargetLane(normalizeOptionalQuery(url.searchParams.get('lane')))
  const includeDormant = url.searchParams.get('includeDormant') === 'true'
  const views: HrcTargetView[] = []

  for (const session of this.listAllSessions()) {
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
    if (projectId && extractProjectId(session.scopeRef) !== projectId) {
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
  const successor = await createNotifiedSessionSuccessor(this, prior, undefined, undefined)

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
 * T-04836 Part A — `POST /v1/sessions/resume-continuation`.
 *
 * Policy authority for `hrc resume`: select the latest non-invalidated provider
 * continuation for the normalized target (status-neutral — archived/dormant/
 * removed-orphaned all count), mint an active successor that inherits it, and
 * return the successor so the CLI starts/prepares/dispatches ONLY against it.
 *
 * Never fresh-launches: a target with no valid captured continuation, or a
 * newer explicit invalidation barrier, fails with a structured non-2xx error
 * and creates no successor. A selected prior whose runtime is still live (not
 * an unavailable status) returns a 409 conflict and creates no successor.
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
  const parsedScopeJson = isObjectRecord(body['parsedScope'])
    ? (body['parsedScope'] as Record<string, unknown>)
    : undefined
  const selection = selectResumeContinuationCandidate(this.db, {
    sessionRef,
    ...(priorHostSessionId !== undefined ? { priorHostSessionId } : {}),
  })

  if (selection.outcome === 'barrier') {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.NO_RESUMABLE_CONTINUATION,
      `cannot resume "${sessionRef}": the latest continuation was explicitly invalidated (${selection.barrier.kind}). Start a fresh session with \`hrc run\`.`,
      { sessionRef, barrier: selection.barrier }
    )
  }

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

  const successor = await createNotifiedSessionSuccessor(this, prior, intent, parsedScopeJson)

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

  for (const session of server.listAllSessions()) {
    if (session.status !== 'active') {
      continue
    }
    if (isPrimaryScopeRef(session.scopeRef)) {
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

  return { archived, skippedPrimary, skippedNotIdle, skippedNoContinuation }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function federationOriginNodeId(record: HrcMessageRecord): string | undefined {
  const ingress = record.metadataJson?.['federationIngress']
  if (!isObjectRecord(ingress)) return undefined
  const nodeId = ingress['authenticatedNodeId']
  return typeof nodeId === 'string' ? nodeId : undefined
}

function isPrimaryScopeRef(scopeRef: string): boolean {
  return scopeRef.endsWith(':task:primary') || !scopeRef.includes(':task:')
}

function normalizeLocalProjectSuccessorIntent(
  scopeRef: string,
  intent: HrcRuntimeIntent | undefined,
  origin: 'local' | 'federated-ingress'
): HrcRuntimeIntent | undefined {
  if (
    intent === undefined ||
    origin === 'federated-ingress' ||
    extractProjectId(scopeRef) === undefined
  ) {
    return intent
  }

  const resolved = resolveNodeLocalPlacement(scopeRef, {
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

async function createNotifiedSessionSuccessor(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent | undefined,
  parsedScopeJson: Record<string, unknown> | undefined,
  origin: 'local' | 'federated-ingress' = 'local'
): Promise<HrcSessionRecord> {
  // Covers hrc resume, archived-target turn-handoff, and archived-target DM.
  // Locally inherited placement is stale evidence, not a capability. Resolve
  // it again at this spawn boundary and persist the normalized intent on the
  // new generation. Federated ingress remains verbatim because its placement
  // contract is localized separately from origin-node absolute paths.
  const capabilityIntent = normalizeLocalProjectSuccessorIntent(
    session.scopeRef,
    intent ?? session.lastAppliedIntentJson,
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
              harness: capabilityIntent.harness,
            },
            // T-07398: the successor's birth reads the same directive block.
            ...(capabilityIntent.provision === undefined
              ? {}
              : { provision: capabilityIntent.provision }),
          }),
    },
    (claimAuthority) => {
      const raced = findTargetSession(
        server.db,
        formatSessionRef(session.scopeRef, session.laneRef)
      )
      if (raced !== null && raced.hostSessionId !== session.hostSessionId) return raced
      const successor = server.db.sqlite.transaction(() => {
        const created = createSessionSuccessorFromContinuation(server.db, session, {
          ...(capabilityIntent ? { lastAppliedIntentJson: capabilityIntent } : {}),
          ...(parsedScopeJson ? { parsedScopeJson } : {}),
        })
        if (claimAuthority !== undefined) {
          persistSessionTaskClaimAuthority(
            server,
            created.hostSessionId,
            claimAuthority,
            created.createdAt
          )
        } else {
          server.db.sessionTaskClaimAuthorities.copy(
            session.hostSessionId,
            created.hostSessionId,
            created.createdAt
          )
        }
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

export async function handleQueryMessages(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  const filter = parseMessageFilter(body)
  if (this.collectiveHistory !== undefined) {
    return json(await this.collectiveHistory.query(filter))
  }
  return json({
    messages: this.db.messages.query(filter),
    history: {
      source: 'local',
      complete: false,
      authorityNodeId: 'svc',
      queriedNodeId: 'unknown-node',
      cursorKind: 'node-local',
      pendingReplicationCount: 0,
      degraded: {
        code: 'collective_not_configured',
        message: 'collective history is unavailable in this daemon mode',
      },
    },
  } satisfies ListMessagesResponse)
}

export async function handleTraceMessage(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isObjectRecord(body)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const messageId = typeof body['messageId'] === 'string' ? body['messageId'].trim() : undefined
  const messageSeq = body['messageSeq']
  if (
    (messageId === undefined) === (messageSeq === undefined) ||
    (messageId !== undefined && messageId.length === 0) ||
    (messageSeq !== undefined && (!Number.isSafeInteger(messageSeq) || (messageSeq as number) < 1))
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'exactly one of messageId or positive messageSeq is required'
    )
  }
  const traceRequest: TraceMessageRequest =
    messageId === undefined ? { messageSeq: messageSeq as number } : { messageId }
  const localRecord =
    'messageId' in traceRequest
      ? this.db.messages.getById(traceRequest.messageId)
      : this.db.messages.getBySeq(traceRequest.messageSeq)
  const resolvedMessageId =
    'messageId' in traceRequest ? traceRequest.messageId : localRecord?.messageId
  if (resolvedMessageId === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `message not found: ${traceRequest.messageSeq}`
    )
  }

  const localNodeId =
    this.collectiveHistory?.localNodeId ?? this.options.federationConfig?.nodeId ?? 'local'
  const queried =
    this.collectiveHistory === undefined
      ? ({
          messages: localRecord === undefined ? [] : [localRecord],
          history: {
            source: 'local',
            complete: false,
            authorityNodeId: 'svc',
            queriedNodeId: localNodeId,
            cursorKind: 'node-local',
            pendingReplicationCount: 0,
            degraded: {
              code: 'collective_not_configured',
              message: 'collective history is unavailable in this daemon mode',
            },
          },
        } satisfies ListMessagesResponse)
      : await this.collectiveHistory.query({ messageId: resolvedMessageId, limit: 1 })
  const message = queried.messages.find((candidate) => candidate.messageId === resolvedMessageId)
  if (message === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `message not found: ${resolvedMessageId}`
    )
  }
  const history =
    queried.history ??
    ({
      source: 'local',
      complete: false,
      authorityNodeId: 'svc',
      queriedNodeId: localNodeId,
      cursorKind: 'node-local',
      pendingReplicationCount: 0,
      degraded: {
        code: 'collective_not_configured',
        message: 'trace source did not report collective-history status',
      },
    } as const)
  const acceptance = this.db.federationPeerAcceptances.get(resolvedMessageId)
  const outbox = this.db.federationOutbox.getByMessageId(resolvedMessageId)
  const response = buildMessageTrace({
    localNodeId,
    message,
    ...(localRecord === undefined ? {} : { localRecord }),
    ...(outbox === undefined ? {} : { outbox }),
    ...(acceptance === undefined
      ? {}
      : {
          acceptance: {
            acceptedByNodeId: acceptance.acceptedByNodeId,
            phase: acceptance.phase,
            ...(acceptance.requestEpoch === undefined
              ? {}
              : { requestEpoch: acceptance.requestEpoch }),
            acceptedAt: acceptance.acceptedAt,
            ...(acceptance.ackOutcome === undefined ? {} : { outcome: acceptance.ackOutcome }),
          },
        }),
    history,
  } satisfies Parameters<typeof buildMessageTrace>[0])
  return json(response satisfies TraceMessageResponse)
}

/** Extract the lane-stripped scopeRef from a canonical `<scopeRef>/lane:<lane>` ref. */
function scopeRefOf(sessionRef: string): string {
  const idx = sessionRef.indexOf('/lane:')
  return idx === -1 ? sessionRef : sessionRef.slice(0, idx)
}

/**
 * Guard against a `--reply-to` anchor that threads into a different conversation
 * scope than the outgoing target (T-04767). A threaded reply must stay within the
 * scope of one of the parent message's session participants; otherwise the reply
 * silently lands in the wrong conversation — as happened when a completion for
 * `clod@agent-loop:refacwrk` was threaded into `clod@agent-loop:primary`.
 *
 * Throws REPLY_TO_SCOPE_MISMATCH (409) before the message is persisted, unless the
 * caller opted in via `allowCrossScopeReply`. The error names both scopes and the
 * remedies so the calling agent can self-correct.
 */
export function assertReplyScopeMatches(
  parent: HrcMessageRecord,
  to: HrcMessageAddress,
  allowCrossScopeReply: boolean | undefined
): void {
  if (allowCrossScopeReply || to.kind !== 'session') return

  const targetScope = scopeRefOf(to.sessionRef)
  const participantScopes = [parent.from, parent.to]
    .filter((a): a is Extract<HrcMessageAddress, { kind: 'session' }> => a.kind === 'session')
    .map((a) => scopeRefOf(a.sessionRef))

  // No session participant to anchor against (e.g. a human↔human thread): nothing to guard.
  if (participantScopes.length === 0 || participantScopes.includes(targetScope)) return

  const anchorScope = participantScopes[0]
  const message = [
    'cross-scope reply blocked — not sent.',
    `  --reply-to ${parent.messageId} belongs to scope  ${anchorScope}`,
    `  but you are sending to               scope  ${targetScope}`,
    'A threaded reply must stay in the same conversation. To self-correct:',
    "  • send to the reply-to message's scope, or",
    '  • drop --reply-to to start a new thread in the target scope, or',
    '  • pass --cross-scope-reply if you really mean to thread across scopes',
  ].join('\n')
  throw new HrcConflictError(HrcErrorCode.REPLY_TO_SCOPE_MISMATCH, message, {
    replyToMessageId: parent.messageId,
    replyToScope: anchorScope,
    replyToScopes: participantScopes,
    targetScope,
  })
}

export async function handleSemanticTurnHandoff(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const parsedBody = parseSemanticDmRequest(await parseJsonBody(request))
  const body: SemanticTurnHandoffRequest = {
    ...parsedBody,
    runtimeIntent: requireCompleteRuntimeIntent(parsedBody.runtimeIntent),
  }
  // T-07214: the best-effort class is a /v1/messages/dm surface only — the
  // own-turn handoff primitive stays unambiguous.
  if (body.whenBusy === 'steer_else_queue') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'steer_else_queue is only supported by /v1/messages/dm',
      { field: 'whenBusy', route: 'semantic-turn-handoff' }
    )
  }
  if (body.to.kind !== 'session') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'semantic turn handoff requires a session target',
      { field: 'to' }
    )
  }
  const targetSessionRef = body.to.sessionRef
  const sessionBody: SemanticTurnHandoffRequest & {
    to: Extract<HrcMessageAddress, { kind: 'session' }>
  } = { ...body, to: body.to }
  const targetScopeRef = scopeRefOf(targetSessionRef)
  // T-07612 §10: the federation MESSAGE path is deleted, so every turn target
  // this daemon admits is local. Cross-node work travels the wrkq ledger.
  assertLocalPersonaAllowed(this, targetScopeRef)
  await assertScopeNotRetired(this, {
    scopeRef: targetScopeRef,
    path: 'archived-successor',
    advisoryCoveredByDownstreamGate: () => {
      const session = findTargetSession(this.db, targetSessionRef)
      if (session?.status === 'archived' && session.continuation?.key) return true
      return (
        session === undefined &&
        body.createIfMissing !== false &&
        body.runtimeIntent !== undefined &&
        !isCodexAppOwnedScopeRef(targetSessionRef)
      )
    },
  })

  const parent =
    body.replyToMessageId !== undefined
      ? this.db.messages.getById(body.replyToMessageId)
      : undefined

  if (body.replyToMessageId !== undefined && !parent) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `unknown replyToMessageId "${body.replyToMessageId}"`,
      {
        field: 'replyToMessageId',
        replyToMessageId: body.replyToMessageId,
      }
    )
  }

  if (parent) assertReplyScopeMatches(parent, body.to, body.allowCrossScopeReply)

  const respondTo = body.respondTo ?? body.from
  const record = this.insertAndNotifyMessage({
    messageId: `msg-${randomUUID()}`,
    kind: 'dm',
    phase: 'request',
    from: body.from,
    to: body.to,
    body: body.body,
    ...(body.replyToMessageId !== undefined ? { replyToMessageId: body.replyToMessageId } : {}),
    ...(parent ? { rootMessageId: parent.rootMessageId } : {}),
    execution: {
      state: 'not_applicable',
      ...(body.mode && body.mode !== 'auto' ? { mode: body.mode } : {}),
    },
    // T-04025: the turn-response finalizer lives in an in-memory map that does
    // not survive a daemon restart, while a durable-broker turn does. This
    // marker lets finalizeSemanticTurnResponse rebuild the finalizer from the
    // durable request row, so turn.completed always yields a persisted
    // response. DM-path requests carry no marker and are never auto-finalized.
    metadataJson: {
      semanticTurnHandoff: {
        respondTo,
        ...(body.freshContext === true ? { freshContext: true } : {}),
      },
    },
  })

  return json(await deliverPersistedSemanticTurnHandoff.call(this, sessionBody, record, respondTo))
}

export async function deliverPersistedSemanticTurnHandoff(
  this: HrcServerInstanceForHandlers,
  body: SemanticTurnHandoffRequest & { to: Extract<HrcMessageAddress, { kind: 'session' }> },
  record: HrcMessageRecord,
  respondTo: HrcMessageAddress
): Promise<SemanticTurnHandoffStartedResponse> {
  assertLocalPersonaAllowed(this, scopeRefOf(body.to.sessionRef))
  const summonOrigin = federationOriginNodeId(record) === undefined ? 'local' : 'federated-ingress'
  let session = findTargetSession(this.db, body.to.sessionRef)
  if (
    !session &&
    body.createIfMissing !== false &&
    body.runtimeIntent &&
    // T-05161: never summon a local runtime for a Codex.app-owned address.
    !isCodexAppOwnedScopeRef(body.to.sessionRef)
  ) {
    session = await this.ensureTargetSession(
      body.to.sessionRef,
      body.runtimeIntent,
      body.parsedScopeJson,
      summonOrigin
    )
  }

  if (!session) {
    this.db.messages.updateExecution(record.messageId, {
      state: 'failed',
      errorCode: HrcErrorCode.UNKNOWN_SESSION,
      errorMessage: `unknown session "${body.to.sessionRef}"`,
    })
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_SESSION,
      `unknown session "${body.to.sessionRef}"`,
      { sessionRef: body.to.sessionRef }
    )
  }

  if (session.status === 'archived' && session.continuation?.key) {
    session = await createNotifiedSessionSuccessor(
      this,
      session,
      body.runtimeIntent,
      body.parsedScopeJson,
      summonOrigin
    )
  }

  if (body.freshContext === true) {
    const rotation = await this.rotateSessionContext(session, {
      relaunch: false,
      dropContinuation: true,
      reason: 'semantic-turn-fresh-context',
    })
    session = requireSession(this.db, rotation.hostSessionId)
  } else {
    const rotationResult = await this.maybeAutoRotateStaleSession(session, {
      allowStaleGeneration: body.allowStaleGeneration,
      trigger: 'semantic-turn-handoff',
    })
    session = rotationResult.session
  }

  const sessionRef = formatSessionRef(session.scopeRef, session.laneRef)
  this.db.messages.updateExecution(record.messageId, {
    sessionRef,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
  })

  const intent = body.runtimeIntent ?? session.lastAppliedIntentJson
  const runId = `run-${randomUUID()}`
  const fromSeq = this.db.hrcEvents.maxHrcSeq() + 1

  try {
    const normalizedIntent = normalizeDispatchIntent(intent, session, runId)
    const payload = formatDmPayload(
      body.from,
      body.to,
      body.body,
      record.messageSeq,
      record.messageId,
      record.createdAt
    )

    let liveTmuxRuntime = findLatestRuntime(this.db, session.hostSessionId)
    // T-01873: route the durable-tmux liveness gate through the runtime-hosting
    // choke point (hasLeasedBrokerSubstrate) instead of the `transport==='tmux'
    // && getBrokerRuntimeTmuxSocketPath` durability proxy. True iff the broker
    // lives in a leased tmux session.
    if (
      liveTmuxRuntime?.controllerKind === 'harness-broker' &&
      hasLeasedBrokerSubstrate(liveTmuxRuntime)
    ) {
      liveTmuxRuntime = await this.reconcileTmuxRuntimeLiveness(liveTmuxRuntime)
    }
    if (
      liveTmuxRuntime &&
      liveTmuxRuntime.transport === 'tmux' &&
      !isRuntimeUnavailableStatus(liveTmuxRuntime.status) &&
      // T-05358: row status `ready/stopping` are both non-unavailable, so add the
      // invocation-state gate — never deliver input to a runtime whose broker
      // invocation is transitioning (starting/stopping); fall through to reprovision.
      isBrokerRuntimeInputDispatchable(this.db, liveTmuxRuntime)
    ) {
      const liveBrokerRuntime =
        liveTmuxRuntime.controllerKind === 'harness-broker' &&
        liveTmuxRuntime.activeInvocationId !== undefined
      if (liveBrokerRuntime) {
        this.turnResponseFinalizers.set(runId, {
          requestMessageId: record.messageId,
          from: body.to,
          to: respondTo,
          mode: 'interactive',
          sessionRef,
        })

        const delivered = await this.tryDeliverSemanticTurnToInteractiveRuntime({
          session,
          runtime: liveTmuxRuntime,
          request: record,
          payload,
          runId,
          sessionRef,
          fromSeq,
          responseFormat: body.responseFormat,
        })
        if (delivered) {
          return delivered
        }
        this.turnResponseFinalizers.delete(runId)
      } else {
        this.markRuntimeStaleForBrokerReprovision(session, liveTmuxRuntime, {
          reason: 'semantic-turn-nonbroker-reuse-rejected',
          route: 'semantic-turn-handoff',
        })
      }
    }

    this.turnResponseFinalizers.set(runId, {
      requestMessageId: record.messageId,
      from: body.to,
      to: respondTo,
      mode: shouldUseSdkTransport(normalizedIntent) ? 'nonInteractive' : 'headless',
      sessionRef,
    })

    const turnResponse = await this.dispatchTurnForSession(session, normalizedIntent, payload, {
      runId,
      waitForCompletion: false,
      responseFormat: body.responseFormat,
      // T-07236: the DM sender IS the recorded initiating principal. Derived
      // here rather than asked for on the wire — the identity is already
      // durable on the message — so an agent-caused trip reaches ACP labelled
      // `agent` instead of falling to the unattributed residue.
      ...originDispatchOption(body.from),
      // T-07155: carry the urgent class down to the broker dispatch. Without
      // this the request would parse cleanly and then deliver as an ordinary
      // deferred DM — the exact silent downgrade the design forbids.
      ...(body.whenBusy !== undefined ? { whenBusy: body.whenBusy } : {}),
    })
    const turnBody = (await turnResponse.json()) as DispatchTurnResponse
    const transport = turnBody.transport as 'sdk' | 'tmux' | 'headless'
    // T-01770 Phase B/C: a harness-broker tmux turn here means
    // dispatchTurnForSession admitted an ariadne-class/SDK-shaped Claude intent
    // into the claude-code-tmux broker (no live runtime existed yet, so this is
    // the first/recreate start). The reply bridge
    // (maybeCompleteInteractiveSemanticTurn) only finalizes a broker turn when
    // the request execution mode is 'interactive', so the started broker tmux
    // turn must be recorded as interactive — not 'headless'. Scoped to broker
    // runtimes so legacy-tmux DM behavior (out of scope) is unchanged.
    const startedRuntime =
      turnBody.runtimeId !== undefined ? this.db.runtimes.getByRuntimeId(turnBody.runtimeId) : null
    const startedInteractiveBroker =
      transport === 'tmux' && startedRuntime?.controllerKind === 'harness-broker'
    const mode = startedInteractiveBroker
      ? 'interactive'
      : transport === 'sdk'
        ? 'nonInteractive'
        : 'headless'

    const updatedFinalizer = this.turnResponseFinalizers.get(runId)
    if (updatedFinalizer) {
      this.turnResponseFinalizers.set(runId, { ...updatedFinalizer, mode })
    }

    this.db.messages.updateExecution(record.messageId, {
      state: turnBody.status === 'completed' ? 'completed' : 'started',
      mode,
      sessionRef,
      hostSessionId: turnBody.hostSessionId,
      generation: turnBody.generation,
      runtimeId: requireDispatchRuntimeId(turnBody),
      runId: turnBody.runId,
      transport,
    })

    return {
      messageId: record.messageId,
      sessionRef,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      hostSessionId: turnBody.hostSessionId,
      runtimeId: requireDispatchRuntimeId(turnBody),
      runId: turnBody.runId,
      generation: turnBody.generation,
      fromSeq,
      ...(turnBody.warnings !== undefined ? { warnings: turnBody.warnings } : {}),
      ...(turnBody.delivery !== undefined ? { delivery: turnBody.delivery } : {}),
    } satisfies SemanticTurnHandoffStartedResponse
  } catch (err) {
    this.turnResponseFinalizers.delete(runId)
    const errorMessage = err instanceof Error ? err.message : String(err)
    const errorCode = err instanceof HrcDomainError ? err.code : HrcErrorCode.RUNTIME_UNAVAILABLE
    this.db.messages.updateExecution(record.messageId, {
      state: 'failed',
      errorCode,
      errorMessage,
    })
    throw err
  }
}

export async function tryDeliverSemanticTurnToInteractiveRuntime(
  this: HrcServerInstanceForHandlers,
  input: {
    session: HrcSessionRecord
    runtime: HrcRuntimeSnapshot
    request: HrcMessageRecord
    payload: string
    runId: string
    sessionRef: string
    fromSeq: number
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): Promise<SemanticTurnHandoffStartedResponse | undefined> {
  const { session, runtime, request, payload, runId, sessionRef, fromSeq, responseFormat } = input
  if (runtime.transport !== 'tmux') {
    return undefined
  }

  if (runtime.controllerKind === 'harness-broker' && runtime.activeInvocationId !== undefined) {
    if (!isBrokerRuntimeQueueCapable(this.db, runtime)) {
      assertRuntimeNotBusy(this.db, runtime)
    }

    // Async reply-bridge delivery: do NOT block here. The Claude reply is
    // bridged back as a separate DM via maybeCompleteInteractiveSemanticTurn
    // (8a0979b), so the semantic-turn handoff returns 'started' immediately.
    const turnResponse = await this.executeInteractiveBrokerInputTurn(
      session,
      runtime,
      payload,
      runId,
      { waitForCompletion: false, responseFormat }
    )
    const turnBody = (await turnResponse.json()) as DispatchTurnResponse
    const brokerTransport = turnBody.transport as 'tmux'

    const finalizer = this.turnResponseFinalizers.get(runId)
    if (finalizer) {
      this.turnResponseFinalizers.set(runId, {
        ...finalizer,
        mode: 'interactive',
      })
    }

    this.db.messages.updateExecution(request.messageId, {
      state: turnBody.status === 'completed' ? 'completed' : 'started',
      mode: 'interactive',
      sessionRef,
      hostSessionId: turnBody.hostSessionId,
      generation: turnBody.generation,
      runtimeId: requireDispatchRuntimeId(turnBody),
      runId: turnBody.runId,
      transport: brokerTransport,
    })

    writeServerLog('INFO', 'semantic_turn.interactive_broker_selected', {
      messageId: request.messageId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      runId,
    })

    return {
      messageId: request.messageId,
      sessionRef,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      hostSessionId: turnBody.hostSessionId,
      runtimeId: requireDispatchRuntimeId(turnBody),
      runId: turnBody.runId,
      generation: turnBody.generation,
      fromSeq,
      ...(turnBody.warnings !== undefined ? { warnings: turnBody.warnings } : {}),
      ...(turnBody.delivery !== undefined ? { delivery: turnBody.delivery } : {}),
    }
  }

  return undefined
}

/**
 * `POST /v1/messages/dm` — local semantic DM.
 *
 * T-07612 flag day (T-07616): agent-to-agent TALK left this route. `hrcchat dm`
 * forwards to `wrkc say`, ACP writes the wrkq ledger, and the federated half of
 * this path is deleted, so nothing in the collective addresses it any more.
 *
 * The route itself is NOT fenced this wave, deliberately. It carries the
 * daedalus-ratified steer-class contract (T-07203 r7 / T-07214) that the wrkq
 * kicker's `--urgent` actuation is built on, and fencing a route no caller
 * reaches would buy nothing observable while stranding that contract's
 * coverage. It retires in wave 5 (T-07617) together with the delivery machinery
 * below it and the `messages` table itself.
 */
export async function handleSemanticDm(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const parsedBody = parseSemanticDmRequest(await parseJsonBody(request))
  if (parsedBody.freshContext !== undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'freshContext is only supported by /v1/messages/turn-handoff',
      { field: 'freshContext', route: 'semantic-dm' }
    )
  }
  // T-07398 cycle 1 (D3): an INADMISSIBLE directive is refused here, before the
  // message row, the routing decision and any session mint — and regardless of
  // whether the target is live. Shape and the deny-list were already re-checked
  // in the parser; this is the half that needs the TARGET (its pin, its home,
  // and this node's peer registry), so it cannot live in the parser.
  if (parsedBody.to.kind === 'session' && parsedBody.runtimeIntent?.provision !== undefined) {
    await assertProvisionDirectiveAdmissible(this, {
      scopeRef: scopeRefOf(parsedBody.to.sessionRef),
      provision: parsedBody.runtimeIntent.provision,
    })
  }

  // T-07398 cycle 2: a dm to an ALREADY-EXISTING scope carries its directive
  // block as a provision-only intent — deliberately without placement, so
  // existing-scope delivery keeps working against a drifted checkout (T-07151).
  // Complete it HERE, once, before any consumer that needs a whole intent:
  // downstream this value becomes the dispatch intent, the auto-summon intent
  // and the archived-successor intent, none of which can run on a fragment.
  const body: CompleteSemanticDmRequest =
    parsedBody.to.kind === 'session'
      ? {
          ...parsedBody,
          runtimeIntent: completeDirectiveOnlyIntent(
            this,
            parsedBody.to.sessionRef,
            parsedBody.runtimeIntent
          ),
        }
      : { ...parsedBody, runtimeIntent: requireCompleteRuntimeIntent(parsedBody.runtimeIntent) }

  const parent =
    body.replyToMessageId !== undefined
      ? this.db.messages.getById(body.replyToMessageId)
      : undefined

  if (body.replyToMessageId !== undefined && !parent) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `unknown replyToMessageId "${body.replyToMessageId}"`,
      {
        field: 'replyToMessageId',
        replyToMessageId: body.replyToMessageId,
      }
    )
  }

  if (parent) assertReplyScopeMatches(parent, body.to, body.allowCrossScopeReply)

  if (body.responseFormat !== undefined && body.to.kind !== 'session') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'responseFormat requires a session turn target',
      {
        field: 'responseFormat',
        route: 'semantic-dm',
        reason: 'responseFormat requires a session turn target',
      }
    )
  }

  if (body.to.kind === 'session') {
    const targetSessionRef = body.to.sessionRef
    const scopeRef = scopeRefOf(targetSessionRef)
    const assertLocalTargetNotRetired = () =>
      assertScopeNotRetired(this, {
        scopeRef,
        path: 'archived-successor',
        advisoryCoveredByDownstreamGate: () => {
          const session = findTargetSession(this.db, targetSessionRef)
          if (session?.status === 'archived' && session.continuation?.key) return true
          return (
            session === undefined &&
            body.createIfMissing !== false &&
            body.runtimeIntent !== undefined &&
            !isCodexAppOwnedScopeRef(targetSessionRef)
          )
        },
      })

    // A loser-node retirement fence forbids local execution; it does not
    // retire the active binding held by another node. Resolve the authoritative
    // route first so a reconciled loser can originate a DM to the winner. If
    // routing is unavailable/unbound, preserve the more specific local
    // retirement refusal before surfacing the routing error.
    // T-07612 §10 (flag day T-07616): the federation MESSAGE path is deleted,
    // so there is no remote branch left — every target this daemon admits is
    // local, and cross-node work travels the wrkq ledger.
    assertLocalPersonaAllowed(this, scopeRef)
    await assertLocalTargetNotRetired()
  }

  // T-07398 — provisioning is decided at BIRTH. A directive block arriving at a
  // scope that is already live cannot take effect (no hot-swap), so the honest
  // answer is to deliver anyway and say so: the sender learns the block did not
  // apply instead of reading a delivered reply as proof that it did. Observed
  // BEFORE delivery, because delivery is exactly what can create the runtime
  // that would otherwise make a birth look like a live scope.
  const directivesApplied =
    body.runtimeIntent?.provision === undefined ? undefined : !targetHasLiveRuntime(this, body.to)

  const respondTo = body.respondTo ?? body.from
  const record = this.insertAndNotifyMessage({
    messageId: `msg-${randomUUID()}`,
    kind: 'dm',
    phase: parent !== undefined ? 'response' : body.to.kind === 'session' ? 'request' : 'oneway',
    from: body.from,
    to: body.to,
    body: body.body,
    ...(body.replyToMessageId !== undefined ? { replyToMessageId: body.replyToMessageId } : {}),
    ...(parent ? { rootMessageId: parent.rootMessageId } : {}),
    execution: {
      state: 'not_applicable',
      ...(body.mode && body.mode !== 'auto' ? { mode: body.mode } : {}),
    },
  })

  const { execution, reply, warnings, delivery } = await this.deliverPersistedSemanticDm(
    body,
    record,
    respondTo
  )

  // Handle --wait
  let waited: WaitMessageResponse | undefined
  if (body.wait?.enabled && record.phase === 'request') {
    const timeoutMs = body.wait.timeoutMs ?? 30_000
    waited = await this.waitForMessage(
      {
        thread: { rootMessageId: record.rootMessageId },
        to: respondTo,
        kinds: ['dm'],
        phases: ['response'],
        afterSeq: record.messageSeq,
      },
      timeoutMs,
      record.messageId
    )
  }

  // Re-read the record to pick up execution updates written by the durable
  // correlation join and tmux-literal delivery path (updateExecution calls
  // modify the DB but not the in-memory record object).
  const freshRecord = this.db.messages.getById(record.messageId) ?? record

  return json({
    request: freshRecord,
    ...(execution ? { execution } : {}),
    ...(reply ? { reply } : {}),
    ...(waited ? { waited } : {}),
    ...(warnings ? { warnings } : {}),
    ...(delivery ? { delivery } : {}),
    ...(directivesApplied === undefined ? {} : { directivesApplied }),
  } satisfies SemanticDmResponse)
}

export function completeDirectiveOnlyIntent(
  server: HrcServerInstanceForHandlers,
  sessionRef: string,
  intent: HrcDmRuntimeIntent | undefined
): HrcRuntimeIntent | undefined {
  if (intent === undefined) return undefined
  if (intent.placement !== undefined) return intent
  // Truthiness, not `=== undefined`: a persisted-but-null intent would spread
  // to `{}` and silently rebuild the very fragment this function exists to
  // remove.
  const base = findTargetSession(server.db, sessionRef)?.lastAppliedIntentJson
  if (!base) return undefined
  return { ...base, ...(intent.provision === undefined ? {} : { provision: intent.provision }) }
}

function requireCompleteRuntimeIntent(
  intent: HrcDmRuntimeIntent | undefined
): HrcRuntimeIntent | undefined {
  if (intent === undefined || intent.placement !== undefined) return intent
  throw new HrcUnprocessableEntityError(
    HrcErrorCode.MISSING_RUNTIME_INTENT,
    'runtimeIntent must be complete before dispatch',
    { reason: 'directive_only_runtime_intent' }
  )
}

/**
 * Whether the DM's target already has a live runtime — i.e. whether this
 * dispatch is a delivery into an existing runtime rather than a birth.
 *
 * Non-session targets (entity/selector addressing) are treated as births: they
 * resolve to a scope through the ordinary summon path, where a directive is
 * applied at mint time like any other birth.
 */
function targetHasLiveRuntime(
  server: HrcServerInstanceForHandlers,
  to: HrcMessageAddress
): boolean {
  if (to.kind !== 'session') return false
  const session = findTargetSession(server.db, to.sessionRef)
  if (session === null) return false
  return server.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .some((runtime) => !isRuntimeUnavailableStatus(runtime.status))
}

/** Filterable durable delivery projection consumed by the F3 operator CLI. */
export async function deliverPersistedSemanticDm(
  this: HrcServerInstanceForHandlers,
  body: CompleteSemanticDmRequest,
  record: HrcMessageRecord,
  respondTo: HrcMessageAddress
): Promise<{
  execution?: DispatchTurnBySelectorResponse | undefined
  reply?: HrcMessageRecord | undefined
  warnings?: HrcDeliveryWarning[] | undefined
  delivery?: HrcDeliveryOutcome | undefined
}> {
  let execution: DispatchTurnBySelectorResponse | undefined
  let reply: HrcMessageRecord | undefined
  let warnings: HrcDeliveryWarning[] | undefined
  let delivery: HrcDeliveryOutcome | undefined
  const summonOrigin = federationOriginNodeId(record) === undefined ? 'local' : 'federated-ingress'

  // T-05161: a DM to a Codex.app-owned address (task segment `codex-<uuid7>`)
  // must be persisted (Cody-in-codex.app live-polls the DM list) but must NOT
  // summon a session, spawn a local codex-cli runtime, or live-deliver. Skip
  // the entire session/dispatch block; the message is returned as-is below.
  const codexAppOwnedTarget =
    body.to.kind === 'session' && isCodexAppOwnedScopeRef(body.to.sessionRef)
  if (codexAppOwnedTarget && body.to.kind === 'session') {
    writeServerLog('INFO', 'semantic_dm.codex_app_owned_no_dispatch', {
      messageId: record.messageId,
      sessionRef: body.to.sessionRef,
    })
  }

  if (body.to.kind === 'session' && !codexAppOwnedTarget) {
    assertLocalPersonaAllowed(this, scopeRefOf(body.to.sessionRef))
    // Auto-summon if needed
    let session = findTargetSession(this.db, body.to.sessionRef)
    if (!session && body.createIfMissing !== false) {
      const intent = body.runtimeIntent
      if (intent) {
        session = await this.ensureTargetSession(
          body.to.sessionRef,
          intent,
          body.parsedScopeJson,
          summonOrigin
        )
      }
    }

    if (session) {
      if (session.status === 'archived' && session.continuation?.key) {
        session = await createNotifiedSessionSuccessor(
          this,
          session,
          body.runtimeIntent,
          body.parsedScopeJson,
          summonOrigin
        )
      }

      // Rotate before delivery if the target session is stale and the
      // caller did not opt in to stale reuse. This both prevents DMs from
      // silently dispatching into corrupted legacy sessions and keeps the
      // tmux-literal path using a fresh continuation for future turns.
      const rotationResult = await this.maybeAutoRotateStaleSession(session, {
        allowStaleGeneration: body.allowStaleGeneration,
        trigger: 'semantic-dm',
      })
      session = rotationResult.session

      // Durable correlation join (F2e): persist session-level correlation at
      // insert time so that `hrc monitor wait msg:<id>` can resolve the
      // target session even if no turn is dispatched (e.g. unsummoned target,
      // no runtimeIntent). This survives the originating dm-process exit.
      this.db.messages.updateExecution(record.messageId, {
        sessionRef: formatSessionRef(session.scopeRef, session.laneRef),
        hostSessionId: session.hostSessionId,
        generation: session.generation,
      })

      const busyHeadlessRuntime = findBusyHeadlessRuntimeForSession(this.db, session.hostSessionId)
      if (busyHeadlessRuntime) {
        let bestEffortFloored = false
        if (body.whenBusy === 'steer' || body.whenBusy === 'steer_else_queue') {
          // T-07191: an urgent DM against a busy target either joins the
          // ACTIVE turn or fails typed. It must never fall through to the
          // deferred-queue branch below — that is the silent downgrade the
          // whenBusy contract forbids. T-07214: the best-effort class may
          // fall to the floor below, but ONLY on provably non-actuated
          // outcomes (the flow returns a floor signal instead of throwing).
          const steered = await this.steerBusyHeadlessSemanticDm(
            session,
            record,
            busyHeadlessRuntime,
            body
          )
          if (steered === 'floor') {
            bestEffortFloored = true
          } else {
            delivery = steered
          }
        }
        if (delivery !== undefined) {
          // steered successfully; nothing further to do on this branch
        } else if (
          busyHeadlessRuntime.controllerKind !== 'harness-broker' ||
          busyHeadlessRuntime.activeInvocationId === undefined
        ) {
          if (bestEffortFloored) {
            writeServerLog('INFO', 'semantic_dm.best_effort_floor', {
              messageId: record.messageId,
              floor: 'legacy_busy_reject',
            })
          }
          // A legacy headless process has no durable broker endpoint HRC can
          // target after the active turn. Fail honestly instead of accepting
          // an input whose eventual delivery cannot be guaranteed.
          this.rejectBusyHeadlessSemanticDm(session, record, busyHeadlessRuntime)
        } else {
          const runId = `run-${randomUUID()}`
          const payload = formatDmPayload(
            body.from,
            body.to,
            body.body,
            record.messageSeq,
            record.messageId,
            record.createdAt
          )
          this.enqueueDurableHeadlessTurnInput(session, payload, runId, {
            source: 'semantic_dm',
            runtimeId: busyHeadlessRuntime.runtimeId,
            sourceMessageId: record.messageId,
            responseFormat: body.responseFormat,
          })
          this.db.messages.updateExecution(record.messageId, {
            state: 'accepted',
            mode: 'headless',
            sessionRef: formatSessionRef(session.scopeRef, session.laneRef),
            hostSessionId: session.hostSessionId,
            generation: session.generation,
            runtimeId: busyHeadlessRuntime.runtimeId,
            runId,
            transport: 'headless',
          })
          writeServerLog('INFO', 'semantic_dm.busy_headless_queued', {
            messageId: record.messageId,
            hostSessionId: session.hostSessionId,
            runtimeId: busyHeadlessRuntime.runtimeId,
            activeRunId: busyHeadlessRuntime.activeRunId,
            queuedRunId: runId,
          })
          warnings = [HRC_QUEUED_BEHIND_BUSY_TURN_WARNING]
        }
      } else {
        // Semantic DMs are harness input. During broker cutover they must not
        // literal-deliver into legacy tmux runtimes; dispatch below
        // will reuse only matching broker runtimes or reprovision.
        const liveInteractiveRuntime = findLatestRuntime(this.db, session.hostSessionId)
        if (
          liveInteractiveRuntime &&
          liveInteractiveRuntime.transport === 'tmux' &&
          !isRuntimeUnavailableStatus(liveInteractiveRuntime.status)
        ) {
          if (liveInteractiveRuntime.controllerKind !== 'harness-broker') {
            this.markRuntimeStaleForBrokerReprovision(session, liveInteractiveRuntime, {
              reason: 'semantic-dm-nonbroker-reuse-rejected',
              route: 'semantic-dm',
            })
          }
        }

        const result = await this.executeSemanticTurn(session, body, record, respondTo, {
          waitForCompletion: body.wait?.enabled === true,
        })
        execution = result.execution
        reply = result.reply
        warnings = result.warnings
        delivery = result.delivery
      }
    }
  }

  return { execution, reply, warnings, delivery }
}

export function rejectBusyHeadlessSemanticDm(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  record: HrcMessageRecord,
  runtime: HrcRuntimeSnapshot
): void {
  const sessionRef = formatSessionRef(session.scopeRef, session.laneRef)
  const activeRunId = runtime.activeRunId

  this.db.messages.updateExecution(record.messageId, {
    state: 'failed',
    mode: 'headless',
    sessionRef,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    ...(activeRunId ? { runId: activeRunId } : {}),
    transport: 'headless',
    errorCode: HRC_BUSY_HEADLESS_DM_REJECTION_CODE,
    errorMessage: HRC_BUSY_HEADLESS_DM_REJECTION_MESSAGE,
  })

  const event = appendHrcEvent(this.db, 'input.rejected', {
    ts: timestamp(),
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    ...(activeRunId ? { runId: activeRunId } : {}),
    transport: 'headless',
    errorCode: HRC_BUSY_HEADLESS_DM_REJECTION_CODE,
    payload: {
      reason: 'busy-headless-runtime',
      delivery: 'semantic-dm',
      messageId: record.messageId,
      sessionRef,
      runtimeId: runtime.runtimeId,
      ...(activeRunId ? { activeRunId } : {}),
      bodyLength: record.body.length,
      recommendation: 'retry after current turn completes or use hrcchat turn',
    },
  })
  this.notifyEvent(event)

  writeServerLog('INFO', 'semantic_dm.busy_headless_rejected', {
    messageId: record.messageId,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    activeRunId,
  })
}

/**
 * T-07191 — urgent (`whenBusy: 'steer'`) semantic DM against a BUSY headless
 * runtime. Routes the order into the target's ACTIVE turn through the same
 * steer executor the turn-handoff route uses (executeHeadlessBrokerSteer), or
 * fails typed with the URGENT_DELIVERY_* vocabulary. Nothing here ever falls
 * back to the deferred queue: a sender must never believe an urgent order
 * landed when it merely queued behind the turn it was meant to preempt.
 */
export async function steerBusyHeadlessSemanticDm(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  record: HrcMessageRecord,
  runtime: HrcRuntimeSnapshot,
  body: SemanticDmRequest
): Promise<HrcDeliveryOutcome | 'floor'> {
  const sessionRef = formatSessionRef(session.scopeRef, session.laneRef)
  try {
    const payload = formatDmPayload(
      body.from,
      body.to,
      body.body,
      record.messageSeq,
      record.messageId,
      record.createdAt
    )
    // T-07203: the shared steer-class flow owns capability gating, the
    // reject-probe, the write-ahead ledger, and the disposition mapping.
    // T-07214: in best-effort mode the flow returns 'floor' on provably
    // non-actuated failures instead of throwing; the caller delivers the
    // route's ordinary floor.
    const steerResponse = await this.executeSteerClassDispatch(session, runtime, payload, {
      route: 'headless',
      responseFormat: body.responseFormat,
      bestEffort: body.whenBusy === 'steer_else_queue',
    })
    if (steerResponse === 'floor') return 'floor'
    const steerBody = (await steerResponse.json()) as {
      runId: string
      delivery?: HrcDeliveryOutcome | undefined
    }
    const delivery =
      steerBody.delivery ?? hrcAdmittedIntoActiveTurn({ mergedIntoRunId: steerBody.runId })
    const startedFresh = delivery.code === 'started_fresh_turn'
    // admitted: the input merged into the active turn and will never have a
    // turn or reply of its own — delivery of THIS message is terminal here.
    // started_fresh_turn: the dispatch raced to an idle target and this
    // message began an ordinary turn; it keeps normal started-DM semantics
    // (no reply bridge is registered on this path — steer already rejects
    // --wait, so nothing hangs on a reply).
    this.db.messages.updateExecution(record.messageId, {
      state: startedFresh ? 'started' : 'completed',
      mode: 'headless',
      sessionRef,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      runId: steerBody.runId,
      transport: 'headless',
    })
    writeServerLog('INFO', 'semantic_dm.busy_headless_steered', {
      messageId: record.messageId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      deliveryCode: delivery.code,
      runId: steerBody.runId,
    })
    return delivery
  } catch (error) {
    const errorCode = error instanceof HrcDomainError ? error.code : 'internal_error'
    const errorMessage = error instanceof Error ? error.message : String(error)
    this.db.messages.updateExecution(record.messageId, {
      state: 'failed',
      mode: 'headless',
      sessionRef,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      ...(runtime.activeRunId !== undefined ? { runId: runtime.activeRunId } : {}),
      transport: 'headless',
      errorCode,
      errorMessage,
    })
    const event = appendHrcEvent(this.db, 'input.rejected', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      ...(runtime.activeRunId !== undefined ? { runId: runtime.activeRunId } : {}),
      transport: 'headless',
      errorCode,
      payload: {
        reason: 'urgent-steer-failed',
        delivery: 'semantic-dm',
        messageId: record.messageId,
        sessionRef,
        runtimeId: runtime.runtimeId,
      },
    })
    this.notifyEvent(event)
    writeServerLog('WARN', 'semantic_dm.busy_headless_steer_failed', {
      messageId: record.messageId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      errorCode,
    })
    throw error
  }
}

export async function executeSemanticTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  body: {
    runtimeIntent?: HrcRuntimeIntent | undefined
    body: string
    from: HrcMessageAddress
    to: HrcMessageAddress
    responseFormat?: HrcTurnResponseFormat | undefined
    whenBusy?: 'reject' | 'steer' | 'steer_else_queue' | undefined
  },
  record: HrcMessageRecord,
  respondTo: HrcMessageAddress,
  options: {
    waitForCompletion?: boolean | undefined
  } = {}
): Promise<{
  execution?: DispatchTurnBySelectorResponse
  reply?: HrcMessageRecord | undefined
  warnings?: HrcDeliveryWarning[] | undefined
  delivery?: HrcDeliveryOutcome | undefined
}> {
  const baseIntent = body.runtimeIntent ?? session.lastAppliedIntentJson
  if (!baseIntent) return {}

  try {
    const latestRuntime = this.db.runtimes.listByHostSessionId(session.hostSessionId).at(-1)
    if (
      latestRuntime?.controllerKind === 'harness-broker' &&
      (latestRuntime.status === 'crashed' || latestRuntime.status === 'stale') &&
      hasLeasedBrokerSubstrate(latestRuntime)
    ) {
      await this.reattachLiveSemanticDmSubstrate(latestRuntime)
    }

    const runId = `run-${randomUUID()}`
    const normalizedIntent = normalizeDispatchIntent(baseIntent, session, runId)
    const payload = formatDmPayload(
      body.from,
      body.to,
      body.body,
      record.messageSeq,
      record.messageId,
      record.createdAt
    )
    const turnResponse = await this.dispatchTurnForSession(session, normalizedIntent, payload, {
      runId,
      waitForCompletion: options.waitForCompletion,
      responseFormat: body.responseFormat,
      // T-07236: see above — provenance from the durable DM sender.
      ...originDispatchOption(body.from),
      // T-07202: a semantic DM can cross another DM while an interactive
      // broker is still cold-provisioning. Join that host-session boot and
      // deliver this DM through its winning runtime instead of minting a
      // second runtime. Other dispatch sources retain their current policy.
      joinInFlightRuntimeStart: true,
      // T-07191: the busy check in deliverPersistedSemanticDm races the
      // dispatch. If the target turns busy in that window, the broker layer
      // must still honor steer instead of silently queueing.
      ...(body.whenBusy !== undefined ? { whenBusy: body.whenBusy } : {}),
    })
    const turnBody = (await turnResponse.json()) as DispatchTurnResponse
    const transport = turnBody.transport as 'sdk' | 'tmux' | 'headless'

    // T-07203: a steer outcome means this message's text joined (or was
    // presented into) ANOTHER run. Delivery of THIS message is terminal, and
    // reply synthesis must be skipped — the active turn's runtimeBuffers are
    // that turn's output, not a reply to the steer sender.
    const steerDelivery =
      turnBody.delivery?.code === 'admitted_into_active_turn' ||
      turnBody.delivery?.code === 'presented_to_live_harness'
        ? turnBody.delivery
        : undefined
    if (steerDelivery !== undefined) {
      const steeredRunId =
        steerDelivery.code === 'admitted_into_active_turn'
          ? steerDelivery.mergedIntoRunId
          : steerDelivery.presentedDuringRunId
      this.db.messages.updateExecution(record.messageId, {
        state: 'completed',
        mode: transport === 'sdk' ? 'nonInteractive' : 'headless',
        sessionRef: formatSessionRef(session.scopeRef, session.laneRef),
        hostSessionId: turnBody.hostSessionId,
        generation: turnBody.generation,
        runtimeId: requireDispatchRuntimeId(turnBody),
        runId: steeredRunId,
        transport,
      })
      return { warnings: turnBody.warnings, delivery: steerDelivery }
    }

    let finalOutput: string | undefined
    if (transport !== 'tmux') {
      const bufferedOutput = this.db.runtimeBuffers
        .listByRunId(turnBody.runId)
        .map((chunk) => chunk.text)
        .join('')
      if (bufferedOutput.length > 0) {
        finalOutput = bufferedOutput
      }
    }

    const turnStatus = turnBody.status as 'completed' | 'started'
    const execution: DispatchTurnBySelectorResponse = {
      runId: turnBody.runId,
      sessionRef: formatSessionRef(session.scopeRef, session.laneRef),
      hostSessionId: turnBody.hostSessionId,
      generation: turnBody.generation,
      runtimeId: requireDispatchRuntimeId(turnBody),
      transport,
      mode: transport === 'sdk' ? 'nonInteractive' : 'headless',
      status: turnStatus,
      finalOutput,
      continuationUpdated: turnStatus === 'completed',
    }

    this.db.messages.updateExecution(record.messageId, {
      state: turnStatus === 'completed' ? 'completed' : 'started',
      mode: execution.mode,
      sessionRef: execution.sessionRef,
      hostSessionId: execution.hostSessionId,
      generation: execution.generation,
      runtimeId: execution.runtimeId,
      runId: execution.runId,
      transport: execution.transport,
    })

    let reply: HrcMessageRecord | undefined
    if (finalOutput && finalOutput.trim().length > 0) {
      reply = this.insertAndNotifyMessage({
        messageId: `msg-${randomUUID()}`,
        kind: 'dm',
        phase: 'response',
        from: body.to,
        to: respondTo,
        body: finalOutput,
        replyToMessageId: record.messageId,
        rootMessageId: record.rootMessageId,
        execution: {
          state: 'completed',
          mode: execution.mode,
          sessionRef: execution.sessionRef,
          hostSessionId: execution.hostSessionId,
          generation: execution.generation,
          runtimeId: execution.runtimeId,
          runId: execution.runId,
          transport: execution.transport,
        },
      })
    }

    return { execution, reply, warnings: turnBody.warnings, delivery: turnBody.delivery }
  } catch (err) {
    // T-07191: a typed urgent-delivery failure must reach the sender as a
    // typed refusal, never be laundered into an exit-success response whose
    // only trace of failure is the persisted execution record.
    if (
      (body.whenBusy === 'steer' || body.whenBusy === 'steer_else_queue') &&
      err instanceof HrcDomainError &&
      (err.code === HrcErrorCode.URGENT_DELIVERY_UNSUPPORTED ||
        err.code === HrcErrorCode.URGENT_DELIVERY_RACE_LOST ||
        err.code === HrcErrorCode.URGENT_DELIVERY_AMBIGUOUS)
    ) {
      this.db.messages.updateExecution(record.messageId, {
        state: 'failed',
        errorCode: err.code,
        errorMessage: err.message,
      })
      throw err
    }
    const errorMessage = err instanceof Error ? err.message : String(err)
    const latestRuntime = findLatestRuntime(this.db, session.hostSessionId)
    writeServerLog('WARN', 'semantic_dm.execution_failed', {
      messageId: record.messageId,
      originNodeId: federationOriginNodeId(record),
      scopeRef: session.scopeRef,
      hostSessionId: session.hostSessionId,
      runtimeId: latestRuntime?.runtimeId,
      runId: latestRuntime?.activeRunId,
      runtimeStatus: latestRuntime?.status,
      transport: latestRuntime?.transport,
      errorName: err instanceof Error ? err.name : undefined,
      error: errorMessage,
    })
    this.db.messages.updateExecution(record.messageId, {
      state: 'failed',
      errorCode: 'semantic_dm_execution_failed',
      errorMessage,
    })
    return {}
  }
}

type SemanticDmLiveSubstrateGuardDeps = {
  createTmuxManager(options: { socketPath: string }): {
    listSessionNames(): Promise<string[]>
    inspectPaneProcess(
      paneId: string
    ): Promise<{ command: string; pid: number; dead: boolean } | null>
  }
  isLiveProcess(pid: number): boolean
  reattach(runtime: HrcRuntimeSnapshot): Promise<DurableBrokerDispatchReattachResult>
  log(level: 'INFO', message: string, fields: Record<string, unknown>): void
}

/**
 * T-07047: a crashed/stale row is not sufficient authority to mint over a
 * broker whose recorded leased-tmux substrate is still alive. This is the one
 * exceptional probe on the semantic-DM mint edge: prove the recorded session
 * and broker-pane PID, then prefer the existing durable reattach. Any probe or
 * clean reattach miss leaves the row untouched and falls through to today's
 * ordinary fresh-provision path.
 */
export async function reattachLiveSemanticDmSubstrate(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  deps: Partial<SemanticDmLiveSubstrateGuardDeps> = {}
): Promise<boolean> {
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (
    runtime.controllerKind !== 'harness-broker' ||
    (runtime.status !== 'crashed' && runtime.status !== 'stale') ||
    hosting?.substrate.kind !== 'leased-tmux'
  ) {
    return false
  }

  try {
    const substrate = hosting.substrate
    const leaseTmux = (deps.createTmuxManager ?? createTmuxManager)({
      socketPath: substrate.tmuxSocketPath,
    })
    const sessionExists = (await leaseTmux.listSessionNames()).includes(substrate.sessionName)
    const paneProcess = sessionExists
      ? await leaseTmux.inspectPaneProcess(substrate.brokerWindow.paneId)
      : null
    if (
      paneProcess === null ||
      paneProcess.pid <= 0 ||
      paneProcess.dead ||
      !(deps.isLiveProcess ?? isLiveProcess)(paneProcess.pid)
    ) {
      return false
    }

    const outcome = deps.reattach
      ? await deps.reattach(runtime)
      : await reattachDurableBrokerForDispatch(this.db, runtime, {
          runtimeRoot: this.options.runtimeRoot,
          controller: this.getHarnessBrokerController(),
          inFlightOperations: this.brokerReattachOperations,
          brokerUnixClientFactory:
            this.brokerUnixClientFactory ??
            ((options) =>
              connectObservedBrokerUnixClient(options) as ReturnType<BrokerUnixClientFactory>),
        })
    if (outcome.state !== 'reattached') {
      return false
    }
    ;(deps.log ?? writeServerLog)('INFO', 'dm.mint_averted_live_substrate', {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
    })
    return true
  } catch {
    // A failed direct probe/reattach is not proof that the recorded substrate
    // can serve input. Preserve the existing semantic-DM mint fallthrough.
    return false
  }
}

export const targetMessageHandlersMethods = {
  handleListTargets,
  handleGetTarget,
  handleCreateSessionSuccessor,
  handleResumeContinuation,
  handleArchiveAbandonedSessions,
  handleQueryMessages,
  handleTraceMessage,
  handleSemanticTurnHandoff,
  tryDeliverSemanticTurnToInteractiveRuntime,
  handleSemanticDm,
  deliverPersistedSemanticDm,
  rejectBusyHeadlessSemanticDm,
  steerBusyHeadlessSemanticDm,
  executeSemanticTurn,
  reattachLiveSemanticDmSubstrate,
}

export type TargetMessageHandlersMethods = typeof targetMessageHandlersMethods
