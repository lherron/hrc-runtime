import { randomUUID } from 'node:crypto'

import { HrcBadRequestError, HrcDomainError, HrcErrorCode, HrcNotFoundError } from 'hrc-core'
import type {
  DispatchTurnBySelectorResponse,
  DispatchTurnResponse,
  HrcMessageAddress,
  HrcMessageRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTargetView,
  ListMessagesResponse,
  SemanticDmResponse,
  SemanticTurnHandoffResponse,
  WaitMessageResponse,
} from 'hrc-core'
import { enrichTurnPromptForBrain } from './brain-enricher.js'
import { getBrokerRuntimeTmuxSocketPath, shouldUseSdkTransport } from './broker-decisions.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import {
  extractProjectId,
  formatDmPayload,
  normalizeTargetLane,
  parseMessageFilter,
  parseSemanticDmRequest,
} from './messages.js'
import { assertRuntimeNotBusy, isBrokerRuntimeQueueCapable } from './require-helpers.js'
import { findBusyHeadlessRuntimeForSession, findLatestRuntime } from './runtime-select.js'
import {
  HRC_BUSY_HEADLESS_DM_REJECTION_CODE,
  HRC_BUSY_HEADLESS_DM_REJECTION_MESSAGE,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { normalizeOptionalQuery, parseJsonBody } from './server-parsers.js'
import type { PreparedSemanticDmPayload } from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { findTargetSession, isActiveTargetSession, toTargetView } from './target-view.js'

export function handleListTargets(this: HrcServerInstanceForHandlers, url: URL): Response {
  const projectId = normalizeOptionalQuery(url.searchParams.get('projectId'))
  const laneRef = normalizeTargetLane(normalizeOptionalQuery(url.searchParams.get('lane')))
  const targets = new Map<string, HrcTargetView>()

  for (const session of this.listAllSessions()) {
    if (!isActiveTargetSession(this.db, session)) {
      continue
    }
    if (projectId && extractProjectId(session.scopeRef) !== projectId) {
      continue
    }
    if (laneRef && normalizeTargetLane(session.laneRef) !== laneRef) {
      continue
    }

    const view = toTargetView(this.db, session)
    const existing = targets.get(view.sessionRef)
    if (!existing || (view.generation ?? 0) >= (existing.generation ?? 0)) {
      targets.set(view.sessionRef, view)
    }
  }

  return json(Array.from(targets.values()).sort((a, b) => a.sessionRef.localeCompare(b.sessionRef)))
}

export function handleGetTarget(this: HrcServerInstanceForHandlers, url: URL): Response {
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

  return json(toTargetView(this.db, session))
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
  })

  let session = findTargetSession(this.db, body.to.sessionRef)
  if (!session && body.createIfMissing !== false && body.runtimeIntent) {
    session = this.ensureTargetSession(body.to.sessionRef, body.runtimeIntent, body.parsedScopeJson)
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

  const rotationResult = await this.maybeAutoRotateStaleSession(session, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'semantic-turn-handoff',
  })
  session = rotationResult.session

  const sessionRef = `${session.scopeRef}/lane:${normalizeTargetLane(session.laneRef) ?? session.laneRef}`
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
    if (
      liveTmuxRuntime?.controllerKind === 'harness-broker' &&
      liveTmuxRuntime.transport === 'tmux' &&
      getBrokerRuntimeTmuxSocketPath(liveTmuxRuntime) !== undefined
    ) {
      liveTmuxRuntime = await this.reconcileTmuxRuntimeLiveness(liveTmuxRuntime)
    }
    if (
      liveTmuxRuntime &&
      (liveTmuxRuntime.transport === 'tmux' || liveTmuxRuntime.transport === 'ghostty') &&
      !isRuntimeUnavailableStatus(liveTmuxRuntime.status)
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
  }
): Promise<SemanticTurnHandoffResponse | undefined> {
  const { session, runtime, request, payload, runId, sessionRef, fromSeq } = input
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
      { waitForCompletion: false }
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

export async function prepareSemanticDmPayload(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  body: {
    runtimeIntent?: HrcRuntimeIntent | undefined
    body: string
    from: HrcMessageAddress
    to: HrcMessageAddress
  },
  record: HrcMessageRecord
): Promise<PreparedSemanticDmPayload> {
  const basePayload = formatDmPayload(
    body.from,
    body.to,
    body.body,
    record.messageSeq,
    record.messageId
  )
  const baseIntent = body.runtimeIntent ?? session.lastAppliedIntentJson
  if (!baseIntent) {
    return { payload: basePayload }
  }

  const runId = `run-${randomUUID()}`
  const normalizedIntent = normalizeDispatchIntent(baseIntent, session, runId)
  const originalPromptLength = basePayload.length
  const enriched = await enrichTurnPromptForBrain({
    session,
    intent: normalizedIntent,
    prompt: basePayload,
    runId,
  })
  writeServerLog('INFO', `brain.enricher.${enriched.reason}`, {
    hostSessionId: session.hostSessionId,
    runId,
    applied: enriched.applied,
    sourceCount: enriched.sources?.length ?? 0,
    promptLengthDelta: enriched.prompt.length - originalPromptLength,
    transport: 'semantic-dm',
  })
  return { payload: enriched.prompt, runId, normalizedIntent }
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
  let rejected = false

  if (body.to.kind === 'session') {
    // Auto-summon if needed
    let session = findTargetSession(this.db, body.to.sessionRef)
    if (!session && body.createIfMissing !== false) {
      const intent = body.runtimeIntent
      if (intent) {
        session = this.ensureTargetSession(body.to.sessionRef, intent, body.parsedScopeJson)
      }
    }

    if (session) {
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
        sessionRef: `${session.scopeRef}/lane:${normalizeTargetLane(session.laneRef) ?? session.laneRef}`,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
      })

      const busyHeadlessRuntime = findBusyHeadlessRuntimeForSession(this.db, session.hostSessionId)
      if (busyHeadlessRuntime) {
        this.rejectBusyHeadlessSemanticDm(session, record, busyHeadlessRuntime)
        rejected = true
      } else {
        // Prepare the DM payload once before transport selection so brain
        // enrichment fires uniformly across tmux-literal and SDK/headless
        // fallback paths. Without this, the tmux-literal branch bypasses
        // dispatchTurnForSession (and its enricher), leaving live-pane DMs
        // unenriched while only fallback DMs got brain context.
        const prepared = await this.prepareSemanticDmPayload(session, body, record)

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
          prepared,
        })
        execution = result.execution
        reply = result.reply
      }
    }
  }

  // Handle --wait
  let waited: WaitMessageResponse | undefined
  if (body.wait?.enabled && record.phase === 'request' && !rejected) {
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
  const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef
  const sessionRef = `${session.scopeRef}/lane:${laneRef}`
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
  },
  record: HrcMessageRecord,
  respondTo: HrcMessageAddress,
  options: {
    waitForCompletion?: boolean | undefined
    prepared?: PreparedSemanticDmPayload | undefined
  } = {}
): Promise<{
  execution?: DispatchTurnBySelectorResponse
  reply?: HrcMessageRecord | undefined
}> {
  const baseIntent = body.runtimeIntent ?? session.lastAppliedIntentJson
  if (!baseIntent) return {}

  try {
    const prepared = options.prepared
    const runId = prepared?.runId ?? `run-${randomUUID()}`
    const normalizedIntent =
      prepared?.normalizedIntent ?? normalizeDispatchIntent(baseIntent, session, runId)
    const payload =
      prepared?.payload ??
      formatDmPayload(body.from, body.to, body.body, record.messageSeq, record.messageId)
    const turnResponse = await this.dispatchTurnForSession(session, normalizedIntent, payload, {
      runId,
      waitForCompletion: options.waitForCompletion,
      skipBrainEnrichment: prepared !== undefined,
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
      sessionRef: `${session.scopeRef}/lane:${normalizeTargetLane(session.laneRef) ?? session.laneRef}`,
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
  handleQueryMessages,
  handleSemanticTurnHandoff,
  tryDeliverSemanticTurnToInteractiveRuntime,
  prepareSemanticDmPayload,
  handleSemanticDm,
  rejectBusyHeadlessSemanticDm,
  executeSemanticTurn,
}

export type TargetMessageHandlersMethods = typeof targetMessageHandlersMethods
