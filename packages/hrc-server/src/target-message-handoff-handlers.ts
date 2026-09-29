import { randomUUID } from 'node:crypto'
import {
  HrcBadRequestError,
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  HrcNotFoundError,
  isCodexAppOwnedScopeRef,
} from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcMessageAddress,
  HrcMessageRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
  ListMessagesResponse,
  SemanticTurnHandoffRequest,
  SemanticTurnHandoffStartedResponse,
  TraceMessageRequest,
  TraceMessageResponse,
} from 'hrc-core'
import { createBirthTimeline } from './birth-timeline.js'
import { shouldUseSdkTransport } from './broker-decisions.js'
import { hasLeasedBrokerSubstrate } from './broker/runtime-hosting.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import { assertScopeNotRetired } from './federation/summon-gate-server.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import { buildMessageTrace } from './message-trace.js'
import {
  formatDmPayload,
  formatSessionRef,
  parseMessageFilter,
  parseSemanticDmRequest,
} from './messages.js'
import { isBrokerRuntimeInputDispatchable, requireSession } from './require-helpers.js'
import { findLatestRuntime } from './runtime-select.js'
import { omitPersistedSelectionForReuse } from './selector-message-handlers/selection-request.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { parseJsonBody, parseSessionRef } from './server-parsers.js'
import {
  assertDispatchRunId,
  isRuntimeUnavailableStatus,
  json,
  requireDispatchRuntimeId,
} from './server-util.js'
import {
  federationOriginNodeId,
  isObjectRecord,
  originDispatchOption,
  requireCompleteRuntimeIntent,
  scopeRefOf,
} from './target-message-shared.js'
import { createNotifiedSessionSuccessor } from './target-message-successor-handlers.js'
import { findTargetSession } from './target-view.js'

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
  return json(
    await persistAndDeliverSemanticTurnHandoff.call(this, {
      ...parsedBody,
      runtimeIntent: requireCompleteRuntimeIntent(parsedBody.runtimeIntent),
    })
  )
}

/**
 * The `/v1/messages/turn-handoff` body after wire parsing: persist the durable
 * request row, then deliver it. Also the internal door for a self-restart's
 * resume prompt (T-09872 §4), so the successor is born exactly as a handoff
 * target would be.
 */
export async function persistAndDeliverSemanticTurnHandoff(
  this: HrcServerInstanceForHandlers,
  body: SemanticTurnHandoffRequest
): Promise<SemanticTurnHandoffStartedResponse> {
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

  return await deliverPersistedSemanticTurnHandoff.call(this, sessionBody, record, respondTo)
}

export async function deliverPersistedSemanticTurnHandoff(
  this: HrcServerInstanceForHandlers,
  body: SemanticTurnHandoffRequest & { to: Extract<HrcMessageAddress, { kind: 'session' }> },
  record: HrcMessageRecord,
  respondTo: HrcMessageAddress
): Promise<SemanticTurnHandoffStartedResponse> {
  assertLocalPersonaAllowed(this, scopeRefOf(body.to.sessionRef))
  const summonOrigin = federationOriginNodeId(record) === undefined ? 'local' : 'federated-ingress'
  const { scopeRef: requestedScopeRef, laneRef: requestedLaneRef } = parseSessionRef(
    body.to.sessionRef
  )
  // This request record is the only correlation key that exists before summon
  // authority selects a home and mints a session/run. It deliberately follows
  // the launch as an ephemeral object rather than entering any authority or
  // persistence surface.
  const birthTimeline = createBirthTimeline({
    scopeRef: requestedScopeRef,
    laneRef: requestedLaneRef,
    birthId: record.messageId,
    presentation: 'pending',
  })
  birthTimeline.mark('request-received', { messageId: record.messageId })
  let session = findTargetSession(this.db, body.to.sessionRef)
  if (
    !session &&
    body.createIfMissing !== false &&
    body.runtimeIntent &&
    // T-05161: never summon a local runtime for a Codex.app-owned address.
    !isCodexAppOwnedScopeRef(body.to.sessionRef)
  ) {
    birthTimeline.mark('session-lookup-miss')
    session = await this.ensureTargetSession(
      body.to.sessionRef,
      body.runtimeIntent,
      body.parsedScopeJson,
      summonOrigin,
      { birthTimeline }
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
      ...(body.runtimeIntent !== undefined ? { runtimeIntent: body.runtimeIntent } : {}),
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
  birthTimeline.enrich({
    hostSessionId: session.hostSessionId,
    generation: session.generation,
  })
  birthTimeline.mark('session-resolved')
  this.db.messages.updateExecution(record.messageId, {
    sessionRef,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
  })

  const intent =
    body.runtimeIntent ??
    (session.lastAppliedIntentJson === undefined
      ? undefined
      : omitPersistedSelectionForReuse(session.lastAppliedIntentJson))
  const runId = `run-${randomUUID()}`
  birthTimeline.enrich({ runId })
  const fromSeq = this.db.hrcEvents.maxHrcSeq() + 1

  try {
    const normalizedIntent = normalizeDispatchIntent(intent, session, runId)
    const payload = formatDmPayload(
      body.from,
      body.to,
      body.body,
      record.messageSeq,
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

    birthTimeline.mark('launch-carried-input-handoff', {
      messageId: record.messageId,
      promptLength: payload.length,
    })
    const turnResponse = await this.dispatchTurnForSession(session, normalizedIntent, payload, {
      runId,
      waitForCompletion: false,
      submissionDoor: 'enqueue',
      responseFormat: body.responseFormat,
      birthTimeline,
      // T-07236: the DM sender IS the recorded initiating principal. Derived
      // here rather than asked for on the wire — the identity is already
      // durable on the message — so an agent-caused trip reaches ACP labelled
      // `agent` instead of falling to the unattributed residue.
      ...originDispatchOption(body.from),
    })
    const turnBody = (await turnResponse.json()) as DispatchTurnResponse
    assertDispatchRunId(turnBody)
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
    // Async reply-bridge delivery: do NOT block here. The Claude reply is
    // bridged back as a separate DM via maybeCompleteInteractiveSemanticTurn
    // (8a0979b), so the semantic-turn handoff returns 'started' immediately.
    const turnResponse = await this.executeInteractiveBrokerInputTurn(
      session,
      runtime,
      payload,
      runId,
      { waitForCompletion: false, submissionDoor: 'enqueue', responseFormat }
    )
    const turnBody = (await turnResponse.json()) as DispatchTurnResponse
    assertDispatchRunId(turnBody)
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
