import { randomUUID } from 'node:crypto'

import {
  HrcBadRequestError,
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  HrcNotFoundError,
  HrcUnprocessableEntityError,
  isCodexAppOwnedScopeRef,
} from 'hrc-core'
import type {
  DispatchTurnBySelectorResponse,
  DispatchTurnResponse,
  HrcMessageAddress,
  HrcMessageRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTargetAmbiguityCandidateView,
  HrcTargetView,
  HrcTurnResponseFormat,
  ListMessagesResponse,
  SemanticDmResponse,
  SemanticTurnHandoffResponse,
  WaitMessageResponse,
} from 'hrc-core'
import { shouldUseSdkTransport } from './broker-decisions.js'
import { hasLeasedBrokerSubstrate } from './broker/runtime-hosting.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import { parseOptionalBirthCredential } from './federation/birth-credential.js'
import { assertSummonAuthority } from './federation/summon-gate-server.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import {
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
import { writeServerLog } from './server-log.js'
import { normalizeOptionalQuery, parseJsonBody } from './server-parsers.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { selectResumeContinuationCandidate } from './session-resume-continuation.js'
import { createSessionSuccessorFromContinuation } from './session-successor.js'
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
  const birthCredential = parseOptionalBirthCredential(body['birthCredential'])
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
  await assertSummonAuthority(this, {
    scopeRef: prior.scopeRef,
    path: 'archived-successor',
    intent: 'implicit',
    ...(prior.lastAppliedIntentJson === undefined
      ? {}
      : {
          capabilityHint: {
            placement: prior.lastAppliedIntentJson.placement,
            harness: prior.lastAppliedIntentJson.harness,
          },
        }),
    ...(birthCredential === undefined ? {} : { birthCredential }),
  })

  const successor = createSessionSuccessorFromContinuation(this.db, prior)
  this.notifyEvent(
    this.appendEvent(successor, 'session.created', {
      created: true,
      priorHostSessionId: prior.hostSessionId,
      reason: 'successor-from-continuation',
    })
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
  const birthCredential = parseOptionalBirthCredential(body['birthCredential'])

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

  const successor = await createNotifiedSessionSuccessor(
    this,
    prior,
    intent,
    parsedScopeJson,
    birthCredential
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

  const cutoffMs = Date.now() - idleThresholdDays * 24 * 60 * 60 * 1000
  const now = timestamp()
  let archived = 0
  let skippedPrimary = 0

  for (const session of this.listAllSessions()) {
    if (session.status !== 'active') {
      continue
    }
    if (isPrimaryScopeRef(session.scopeRef)) {
      skippedPrimary += 1
      continue
    }

    const abandonedRuntime = this.db.runtimes
      .listByHostSessionId(session.hostSessionId)
      .find((runtime) => {
        if (!isRuntimeUnavailableStatus(runtime.status)) {
          return false
        }
        const lastActivityMs = Date.parse(runtime.lastActivityAt ?? runtime.createdAt)
        return Number.isFinite(lastActivityMs) && lastActivityMs <= cutoffMs
      })
    if (!abandonedRuntime) {
      continue
    }

    this.db.sessions.updateStatus(session.hostSessionId, 'archived', now)
    archived += 1
  }

  return json({ archived, skippedPrimary, idleThresholdDays })
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPrimaryScopeRef(scopeRef: string): boolean {
  return scopeRef.endsWith(':task:primary') || !scopeRef.includes(':task:')
}

async function createNotifiedSessionSuccessor(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent | undefined,
  parsedScopeJson: Record<string, unknown> | undefined,
  birthCredential?: string
): Promise<HrcSessionRecord> {
  // Covers hrc resume, archived-target turn-handoff, and archived-target DM.
  const capabilityIntent = intent ?? session.lastAppliedIntentJson
  await assertSummonAuthority(server, {
    scopeRef: session.scopeRef,
    path: 'archived-successor',
    intent: 'implicit',
    ...(capabilityIntent === undefined
      ? {}
      : {
          capabilityHint: {
            placement: capabilityIntent.placement,
            harness: capabilityIntent.harness,
          },
        }),
    ...(birthCredential === undefined ? {} : { birthCredential }),
  })

  const successor = createSessionSuccessorFromContinuation(server.db, session, {
    ...(intent ? { lastAppliedIntentJson: intent } : {}),
    ...(parsedScopeJson ? { parsedScopeJson } : {}),
  })
  server.notifyEvent(
    server.appendEvent(successor, 'session.created', {
      created: true,
      priorHostSessionId: session.hostSessionId,
      reason: 'successor-from-continuation',
    })
  )
  return successor
}

export async function handleQueryMessages(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  const filter = parseMessageFilter(body)
  return json({
    messages: this.db.messages.query(filter),
  } satisfies ListMessagesResponse)
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
  const body = parseSemanticDmRequest(await parseJsonBody(request))
  if (body.to.kind !== 'session') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'semantic turn handoff requires a session target',
      { field: 'to' }
    )
  }

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
    metadataJson: { semanticTurnHandoff: { respondTo } },
  })

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
      body.birthCredential
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
      body.birthCredential
    )
  }

  const rotationResult = await this.maybeAutoRotateStaleSession(session, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'semantic-turn-handoff',
  })
  session = rotationResult.session

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
      record.messageId
    )

    let liveTmuxRuntime = findLatestRuntime(this.db, session.hostSessionId)
    // T-01873: route the durable-tmux liveness gate through the runtime-hosting
    // choke point (hasLeasedBrokerSubstrate) instead of the `transport==='tmux'
    // && getBrokerRuntimeTmuxSocketPath` durability proxy. True iff the broker
    // lives in a leased tmux session; false for a ghostty broker — preserving
    // today's tmux-only reconcile.
    if (
      liveTmuxRuntime?.controllerKind === 'harness-broker' &&
      hasLeasedBrokerSubstrate(liveTmuxRuntime)
    ) {
      liveTmuxRuntime = await this.reconcileTmuxRuntimeLiveness(liveTmuxRuntime)
    }
    if (
      liveTmuxRuntime &&
      (liveTmuxRuntime.transport === 'tmux' || liveTmuxRuntime.transport === 'ghostty') &&
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
          return json(delivered satisfies SemanticTurnHandoffResponse)
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
      runtimeId: turnBody.runtimeId,
      runId: turnBody.runId,
      transport,
    })

    return json({
      messageId: record.messageId,
      sessionRef,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      hostSessionId: turnBody.hostSessionId,
      runtimeId: turnBody.runtimeId,
      runId: turnBody.runId,
      generation: turnBody.generation,
      fromSeq,
    } satisfies SemanticTurnHandoffResponse)
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
): Promise<SemanticTurnHandoffResponse | undefined> {
  const { session, runtime, request, payload, runId, sessionRef, fromSeq, responseFormat } = input
  if (runtime.transport !== 'tmux' && runtime.transport !== 'ghostty') {
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
      this.turnResponseFinalizers.set(runId, { ...finalizer, mode: 'interactive' })
    }

    this.db.messages.updateExecution(request.messageId, {
      state: turnBody.status === 'completed' ? 'completed' : 'started',
      mode: 'interactive',
      sessionRef,
      hostSessionId: turnBody.hostSessionId,
      generation: turnBody.generation,
      runtimeId: turnBody.runtimeId,
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
      runtimeId: turnBody.runtimeId,
      runId: turnBody.runId,
      generation: turnBody.generation,
      fromSeq,
    }
  }

  return undefined
}

export async function handleSemanticDm(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseSemanticDmRequest(await parseJsonBody(request))
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

  // If target is a session, attempt semantic turn execution
  let execution: DispatchTurnBySelectorResponse | undefined
  let reply: HrcMessageRecord | undefined

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
    // Auto-summon if needed
    let session = findTargetSession(this.db, body.to.sessionRef)
    if (!session && body.createIfMissing !== false) {
      const intent = body.runtimeIntent
      if (intent) {
        session = await this.ensureTargetSession(
          body.to.sessionRef,
          intent,
          body.parsedScopeJson,
          body.birthCredential
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
          body.birthCredential
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
        if (
          busyHeadlessRuntime.controllerKind !== 'harness-broker' ||
          busyHeadlessRuntime.activeInvocationId === undefined
        ) {
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
            record.messageId
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
        }
      } else {
        // Semantic DMs are harness input. During broker cutover they must not
        // literal-deliver into legacy tmux/ghostty runtimes; dispatch below
        // will reuse only matching broker runtimes or reprovision.
        const liveInteractiveRuntime = findLatestRuntime(this.db, session.hostSessionId)
        if (
          liveInteractiveRuntime &&
          (liveInteractiveRuntime.transport === 'tmux' ||
            liveInteractiveRuntime.transport === 'ghostty') &&
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
      }
    }
  }

  // Handle --wait
  let waited: WaitMessageResponse | undefined
  if (body.wait?.enabled && record.phase === 'request') {
    const timeoutMs = body.wait.timeoutMs ?? 30_000
    waited = await this.waitForMessage(
      {
        thread: { rootMessageId: record.rootMessageId },
        to: respondTo,
        phases: ['response'],
        afterSeq: record.messageSeq,
      },
      timeoutMs
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
  } satisfies SemanticDmResponse)
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

export async function executeSemanticTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  body: {
    runtimeIntent?: HrcRuntimeIntent | undefined
    body: string
    from: HrcMessageAddress
    to: HrcMessageAddress
    responseFormat?: HrcTurnResponseFormat | undefined
  },
  record: HrcMessageRecord,
  respondTo: HrcMessageAddress,
  options: {
    waitForCompletion?: boolean | undefined
  } = {}
): Promise<{
  execution?: DispatchTurnBySelectorResponse
  reply?: HrcMessageRecord | undefined
}> {
  const baseIntent = body.runtimeIntent ?? session.lastAppliedIntentJson
  if (!baseIntent) return {}

  try {
    const runId = `run-${randomUUID()}`
    const normalizedIntent = normalizeDispatchIntent(baseIntent, session, runId)
    const payload = formatDmPayload(
      body.from,
      body.to,
      body.body,
      record.messageSeq,
      record.messageId
    )
    const turnResponse = await this.dispatchTurnForSession(session, normalizedIntent, payload, {
      runId,
      waitForCompletion: options.waitForCompletion,
      responseFormat: body.responseFormat,
    })
    const turnBody = (await turnResponse.json()) as DispatchTurnResponse
    const transport = turnBody.transport as 'sdk' | 'tmux' | 'headless'

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
      runtimeId: turnBody.runtimeId,
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

    return { execution, reply }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    writeServerLog('WARN', 'semantic_dm.execution_failed', {
      messageId: record.messageId,
      error: errorMessage,
    })
    this.db.messages.updateExecution(record.messageId, {
      state: 'failed',
      errorMessage,
    })
    return {}
  }
}

export const targetMessageHandlersMethods = {
  handleListTargets,
  handleGetTarget,
  handleCreateSessionSuccessor,
  handleResumeContinuation,
  handleArchiveAbandonedSessions,
  handleQueryMessages,
  handleSemanticTurnHandoff,
  tryDeliverSemanticTurnToInteractiveRuntime,
  handleSemanticDm,
  rejectBusyHeadlessSemanticDm,
  executeSemanticTurn,
}

export type TargetMessageHandlersMethods = typeof targetMessageHandlersMethods
