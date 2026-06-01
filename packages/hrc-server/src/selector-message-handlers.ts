import { randomUUID } from 'node:crypto'

import {
  HrcBadRequestError,
  HrcErrorCode,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
} from 'hrc-core'
import type {
  CaptureBySelectorResponse,
  CreateMessageResponse,
  DeliverLiteralBySelectorResponse,
  DispatchTurnBySelectorResponse,
  DispatchTurnResponse,
  EnsureTargetResponse,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  RestartStyle,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { getSdkInflightCapability, runSdkTurn } from './agent-spaces-adapter/index.js'
import {
  deriveSdkHarness,
  isMatchingInteractiveTmuxBrokerRuntime,
  validateEnsureRuntimeIntent,
} from './broker-decisions.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import {
  appendHrcEvent,
  createUserPromptPayload,
  deriveSemanticTurnEventFromSdkEvent,
} from './hrc-event-helper.js'
import { normalizeTargetLane, normalizeTargetSessionRef, parseMessageAddress } from './messages.js'
import {
  isRunActive,
  requireGhosttySurface,
  requireSession,
  requireTmuxPane,
} from './require-helpers.js'
import {
  findBoundSessionRuntime,
  findLatestRuntime,
  findLatestSessionRuntime,
} from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { mapSessionRow } from './server-misc.js'
import { isRecord, parseJsonBody, parseSessionRef } from './server-parsers.js'
import type { SessionRow } from './server-types.js'
import { createHostSessionId, isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { findTargetSession, toTargetView } from './target-view.js'
import type { TmuxPaneState } from './tmux.js'

export function listSessionsByScope(
  this: HrcServerInstanceForHandlers,
  scopeRef: string,
  laneRef?: string
): HrcSessionRecord[] {
  if (laneRef) {
    return this.db.sessions.listByScopeRef(scopeRef, laneRef)
  }

  return this.db.sessions.listByScopeRef(scopeRef)
}

export function listAllSessions(
  this: HrcServerInstanceForHandlers,
  laneRef?: string
): HrcSessionRecord[] {
  const sql = laneRef
    ? `
        SELECT
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          status,
          prior_host_session_id,
          created_at,
          updated_at,
          parsed_scope_json,
          ancestor_scope_refs_json,
          last_applied_intent_json,
          continuation_json
        FROM sessions
        WHERE lane_ref = ?
        ORDER BY scope_ref ASC, generation ASC
      `
    : `
        SELECT
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          status,
          prior_host_session_id,
          created_at,
          updated_at,
          parsed_scope_json,
          ancestor_scope_refs_json,
          last_applied_intent_json,
          continuation_json
        FROM sessions
        ORDER BY scope_ref ASC, lane_ref ASC, generation ASC
      `

  const rows = laneRef
    ? this.db.sqlite.query<SessionRow, [string]>(sql).all(laneRef)
    : this.db.sqlite.query<SessionRow, []>(sql).all()

  return rows.map(mapSessionRow)
}

export async function ensureRuntimeForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  restartStyle: RestartStyle
): Promise<HrcRuntimeSnapshot> {
  validateEnsureRuntimeIntent(intent)
  const brokerOptions = this.selectInteractiveTmuxBrokerOptions(intent)
  if (!brokerOptions) {
    throw new HrcRuntimeUnavailableError('ensureRuntime supports only broker-admissible runtimes', {
      hostSessionId: session.hostSessionId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
      route: 'interactive-broker',
    })
  }

  const existingBrokerRuntime = findLatestRuntime(this.db, session.hostSessionId)
  if (
    restartStyle === 'reuse_pty' &&
    existingBrokerRuntime &&
    !isRuntimeUnavailableStatus(existingBrokerRuntime.status) &&
    isMatchingInteractiveTmuxBrokerRuntime(
      existingBrokerRuntime,
      intent,
      brokerOptions.allowedBrokerDriver
    )
  ) {
    return existingBrokerRuntime
  }

  if (existingBrokerRuntime && !isRuntimeUnavailableStatus(existingBrokerRuntime.status)) {
    this.markRuntimeStaleForBrokerReprovision(session, existingBrokerRuntime, {
      reason: 'ensure-runtime-broker-reprovision',
      allowedBrokerDriver: brokerOptions.allowedBrokerDriver,
    })
  }

  return await this.startInteractiveTmuxBrokerRuntime(
    session,
    intent,
    `run-${randomUUID()}`,
    brokerOptions
  )
}

export async function handleSdkDispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: {
    waitForCompletion?: boolean | undefined
  } = {}
): Promise<Response> {
  this.failSdkHarnessPath('handleSdkDispatchTurn', session, intent, runId)

  const existingProvider =
    findLatestSessionRuntime(this.db, session.hostSessionId)?.provider ??
    session.continuation?.provider
  const runtimeId = `rt-${randomUUID()}`
  const now = timestamp()

  this.db.sessions.updateIntent(session.hostSessionId, intent, now)

  const sdkHarness = deriveSdkHarness(intent.harness)

  const runtime = this.db.runtimes.insert({
    runtimeId,
    runtimeKind: 'harness',
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'sdk',
    harness: sdkHarness,
    provider: intent.harness.provider,
    status: 'busy',
    continuation: session.continuation,
    supportsInflightInput: getSdkInflightCapability(sdkHarness),
    adopted: false,
    activeRunId: runId,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  })

  const run = this.db.runs.insert({
    runId,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'sdk',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
  })

  const runtimeCreatedEvent = appendHrcEvent(this.db, 'runtime.created', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'sdk',
    payload: {
      harness: runtime.harness,
    },
  })
  this.notifyEvent(runtimeCreatedEvent)

  const acceptedEvent = appendHrcEvent(this.db, 'turn.accepted', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    transport: 'sdk',
    payload: {
      promptLength: prompt.length,
    },
  })
  this.notifyEvent(acceptedEvent)

  const userPromptEvent = appendHrcEvent(this.db, 'turn.user_prompt', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    transport: 'sdk',
    payload: createUserPromptPayload(prompt),
  })
  this.notifyEvent(userPromptEvent)

  const startedAt = timestamp()
  this.db.runs.update(run.runId, {
    status: 'started',
    startedAt,
    updatedAt: startedAt,
  })
  this.db.runtimes.updateActivity(runtime.runtimeId, startedAt, startedAt)

  const startedEvent = appendHrcEvent(this.db, 'turn.started', {
    ts: startedAt,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    transport: 'sdk',
  })
  this.notifyEvent(startedEvent)

  const execute = async (): Promise<Response> => {
    let chunkSeq = 1
    const result = await runSdkTurn({
      intent,
      hostSessionId: session.hostSessionId,
      runId,
      runtimeId: runtime.runtimeId,
      prompt,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      existingProvider,
      continuation: session.continuation,
      onHrcEvent: (event) => {
        const appended = this.db.events.append(event)
        this.notifyEvent(appended)
        const semanticEvent = deriveSemanticTurnEventFromSdkEvent(event.eventKind, event.eventJson)
        if (semanticEvent) {
          const appendedSemanticEvent = appendHrcEvent(this.db, semanticEvent.eventKind, {
            ts: event.ts,
            hostSessionId: event.hostSessionId,
            scopeRef: event.scopeRef,
            laneRef: event.laneRef,
            generation: event.generation,
            runId: event.runId,
            runtimeId: event.runtimeId,
            transport: 'sdk',
            payload: semanticEvent.payload,
          })
          this.notifyEvent(appendedSemanticEvent)
        }
        this.db.runtimes.updateActivity(runtime.runtimeId, event.ts, event.ts)
      },
      onBuffer: (text) => {
        this.db.runtimeBuffers.append({
          runtimeId: runtime.runtimeId,
          runId,
          chunkSeq,
          text,
          createdAt: timestamp(),
        })
        chunkSeq += 1
      },
    })

    const completedAt = timestamp()
    this.db.runs.markCompleted(run.runId, {
      status: result.result.success ? 'completed' : 'failed',
      completedAt,
      updatedAt: completedAt,
      ...(!result.result.success
        ? {
            errorCode:
              result.result.error?.code === 'provider_mismatch'
                ? HrcErrorCode.PROVIDER_MISMATCH
                : HrcErrorCode.RUNTIME_UNAVAILABLE,
            errorMessage: result.result.error?.message ?? 'sdk turn failed',
          }
        : {}),
    })

    this.db.runtimes.update(runtime.runtimeId, {
      status: 'ready',
      lastActivityAt: completedAt,
      updatedAt: completedAt,
      harnessSessionJson: result.harnessSessionJson,
      continuation: result.continuation,
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)

    if (result.continuation) {
      this.db.sessions.updateContinuation(session.hostSessionId, result.continuation, completedAt)
    }

    const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
      ts: completedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      errorCode: result.result.success
        ? undefined
        : result.result.error?.code === 'provider_mismatch'
          ? HrcErrorCode.PROVIDER_MISMATCH
          : HrcErrorCode.RUNTIME_UNAVAILABLE,
      payload: {
        success: result.result.success,
      },
    })
    this.notifyEvent(completedEvent)

    if (!result.result.success) {
      if (result.result.error?.code === 'provider_mismatch') {
        throw new HrcUnprocessableEntityError(
          HrcErrorCode.PROVIDER_MISMATCH,
          result.result.error.message,
          result.result.error.details ?? {}
        )
      }

      throw new HrcRuntimeUnavailableError(result.result.error?.message ?? 'sdk turn failed', {
        runtimeId: runtime.runtimeId,
        runId,
      })
    }

    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      status: 'completed',
      supportsInFlightInput: runtime.supportsInflightInput,
    } satisfies DispatchTurnResponse)
  }

  if (options.waitForCompletion === false) {
    void execute().catch((err: unknown) => {
      try {
        this.recordDetachedSemanticTurnFailure(session, runtime.runtimeId, runId, 'sdk', err)
      } catch (failureErr) {
        writeServerLog('WARN', 'sdk.detached_turn_failure_record_failed', {
          hostSessionId: session.hostSessionId,
          runtimeId: runtime.runtimeId,
          runId,
          error: failureErr instanceof Error ? failureErr.message : String(failureErr),
        })
      }
    })

    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      status: 'started',
      supportsInFlightInput: runtime.supportsInflightInput,
    } satisfies DispatchTurnResponse)
  }

  return await execute()
}

export function recordDetachedSemanticTurnFailure(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtimeId: string,
  runId: string,
  transport: 'sdk' | 'headless',
  err: unknown
): void {
  const errorMessage = err instanceof Error ? err.message : String(err)
  writeServerLog('WARN', `${transport}.detached_turn_failed`, {
    hostSessionId: session.hostSessionId,
    runtimeId,
    runId,
    error: errorMessage,
  })

  const run = this.db.runs.getByRunId(runId)
  if (!run || !isRunActive(run)) {
    return
  }

  const now = timestamp()
  this.db.runs.markCompleted(runId, {
    status: 'failed',
    completedAt: now,
    updatedAt: now,
    errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
    errorMessage,
  })

  const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
  if (runtime?.activeRunId === runId) {
    this.db.runtimes.updateRunId(runtimeId, undefined, now)
    this.db.runtimes.update(runtimeId, {
      status: 'ready',
      updatedAt: now,
      lastActivityAt: now,
    })
  }

  const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId,
    transport,
    errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
    payload: {
      success: false,
      transport,
    },
  })
  this.notifyEvent(completedEvent)
}

export function ensureTargetSession(
  this: HrcServerInstanceForHandlers,
  sessionRef: string,
  intent: HrcRuntimeIntent,
  parsedScopeJson?: Record<string, unknown>
): HrcSessionRecord {
  const normalized = normalizeTargetSessionRef(sessionRef)
  const existing = findTargetSession(this.db, normalized)
  if (existing) {
    const now = timestamp()
    this.db.sessions.updateIntent(existing.hostSessionId, intent, now)
    if (parsedScopeJson) {
      this.db.sessions.updateParsedScope(existing.hostSessionId, parsedScopeJson, now)
    }
    // Re-read to return the updated record
    return requireSession(this.db, existing.hostSessionId)
  }

  const { scopeRef, laneRef } = parseSessionRef(normalized)
  const now = timestamp()
  const hostSessionId = createHostSessionId()
  const session: HrcSessionRecord = {
    hostSessionId,
    scopeRef,
    laneRef,
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
    lastAppliedIntentJson: intent,
    ...(parsedScopeJson ? { parsedScopeJson } : {}),
  }

  const created = this.db.sessions.insert(session)
  this.db.continuities.upsert({
    scopeRef,
    laneRef,
    activeHostSessionId: hostSessionId,
    updatedAt: now,
  })

  const event = this.appendEvent(created, 'session.created', { created: true, summon: true })
  this.notifyEvent(event)
  return created
}

export async function handleEnsureTarget(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const sessionRef = body['sessionRef']
  if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required', {
      field: 'sessionRef',
    })
  }

  const runtimeIntent = body['runtimeIntent']
  if (!isRecord(runtimeIntent)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeIntent is required', {
      field: 'runtimeIntent',
    })
  }

  const parsedScopeJson = isRecord(body['parsedScopeJson'])
    ? (body['parsedScopeJson'] as Record<string, unknown>)
    : undefined

  const session = this.ensureTargetSession(
    sessionRef,
    runtimeIntent as HrcRuntimeIntent,
    parsedScopeJson
  )
  return json(toTargetView(this.db, session) satisfies EnsureTargetResponse)
}

export async function handleCreateMessage(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  if (typeof body['body'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'body must be a string', {
      field: 'body',
    })
  }

  const kind = body['kind']
  if (kind !== 'dm' && kind !== 'literal' && kind !== 'system') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'kind must be dm, literal, or system',
      {
        field: 'kind',
      }
    )
  }

  const phase = body['phase']
  if (phase !== 'request' && phase !== 'response' && phase !== 'oneway') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'phase must be request, response, or oneway',
      {
        field: 'phase',
      }
    )
  }

  const from = parseMessageAddress(body['from'], 'from')
  const to = parseMessageAddress(body['to'], 'to')

  const replyToMessageId = body['replyToMessageId']
  if (replyToMessageId !== undefined && typeof replyToMessageId !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'replyToMessageId must be a string',
      {
        field: 'replyToMessageId',
      }
    )
  }

  let rootMessageId: string | undefined
  if (replyToMessageId !== undefined) {
    const parent = this.db.messages.getById(replyToMessageId)
    if (!parent) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `unknown replyToMessageId "${replyToMessageId}"`,
        {
          field: 'replyToMessageId',
        }
      )
    }
    rootMessageId = parent.rootMessageId
  }

  const execution = isRecord(body['execution'])
    ? (body['execution'] as Partial<{ state: string }>)
    : undefined
  const metadataJson = isRecord(body['metadataJson'])
    ? (body['metadataJson'] as Record<string, unknown>)
    : undefined

  const record = this.insertAndNotifyMessage({
    messageId: `msg-${randomUUID()}`,
    kind,
    phase,
    from,
    to,
    body: body['body'],
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    ...(rootMessageId !== undefined ? { rootMessageId } : {}),
    ...(execution
      ? { execution: execution as Parameters<HrcDatabase['messages']['insert']>[0]['execution'] }
      : {}),
    ...(metadataJson ? { metadataJson } : {}),
  })

  return json(record satisfies CreateMessageResponse)
}

export async function handleCaptureBySelector(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body) || !isRecord(body['selector'])) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required')
  }

  const sessionRef = (body['selector'] as Record<string, unknown>)['sessionRef']
  if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'selector.sessionRef is required',
      {
        field: 'selector.sessionRef',
      }
    )
  }

  const session = findTargetSession(this.db, sessionRef)
  if (!session) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_SESSION, `unknown session "${sessionRef}"`, {
      sessionRef,
    })
  }

  const runtime = findBoundSessionRuntime(this.db, session.hostSessionId)
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    throw new HrcRuntimeUnavailableError('no capturable runtime is currently bound', {
      sessionRef,
      hostSessionId: session.hostSessionId,
    })
  }

  const lines = typeof body['lines'] === 'number' ? body['lines'] : undefined
  let text: string

  if (runtime.transport === 'sdk' || runtime.transport === 'headless') {
    text = this.db.runtimeBuffers
      .listByRuntimeId(runtime.runtimeId)
      .map((chunk) => chunk.text)
      .join('')
  } else {
    const pane = requireTmuxPane(runtime)
    text = await this.tmuxForPane(pane).capture(pane.paneId)
  }

  if (lines !== undefined && lines > 0) {
    const allLines = text.split('\n')
    text = allLines.slice(-lines).join('\n')
  }

  const now = timestamp()
  this.db.runtimes.updateActivity(runtime.runtimeId, now, now)

  const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef
  return json({
    text,
    sessionRef: `${session.scopeRef}/lane:${laneRef}`,
    runtimeId: runtime.runtimeId,
  } satisfies CaptureBySelectorResponse)
}

export async function handleLiteralInputBySelector(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body) || !isRecord(body['selector'])) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required')
  }

  const sessionRef = (body['selector'] as Record<string, unknown>)['sessionRef']
  if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'selector.sessionRef is required',
      {
        field: 'selector.sessionRef',
      }
    )
  }

  if (typeof body['text'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'text is required', {
      field: 'text',
    })
  }

  const session = findTargetSession(this.db, sessionRef)
  if (!session) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_SESSION, `unknown session "${sessionRef}"`, {
      sessionRef,
    })
  }

  const runtime = findLatestRuntime(this.db, session.hostSessionId)
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    throw new HrcRuntimeUnavailableError('no live literal-capable runtime is currently bound', {
      sessionRef,
      hostSessionId: session.hostSessionId,
    })
  }

  if (runtime.transport !== 'tmux' && runtime.transport !== 'ghostty') {
    throw new HrcRuntimeUnavailableError('runtime does not support literal input', {
      sessionRef,
      runtimeId: runtime.runtimeId,
      transport: runtime.transport,
    })
  }

  if (
    runtime.controllerKind === 'harness-broker' &&
    runtime.transport === 'tmux' &&
    runtime.activeInvocationId !== undefined
  ) {
    return await this.handleBrokerLiteralInputBySelector({
      session,
      runtime,
      sessionRef,
      text: body['text'],
      enter: body['enter'] !== false,
    })
  }

  const pane = runtime.transport === 'tmux' ? requireTmuxPane(runtime) : undefined
  const tmux = pane ? this.tmuxForPane(pane) : this.tmux
  const surfaceId =
    runtime.transport === 'ghostty' ? requireGhosttySurface(runtime).surfaceId : undefined
  if (runtime.transport === 'ghostty') {
    await this.ghostmux.sendLiteral(surfaceId as string, body['text'])
    if (body['enter'] !== false) {
      await this.ghostmux.sendEnter(surfaceId as string)
    }
  } else {
    const paneId = (pane as TmuxPaneState).paneId
    if (body['enter'] !== false) {
      await tmux.sendKeys(paneId, body['text'])
    } else {
      await tmux.sendLiteral(paneId, body['text'])
    }
  }

  const now = timestamp()
  this.db.runtimes.updateActivity(runtime.runtimeId, now, now)

  const event = appendHrcEvent(this.db, 'target.literal-input', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    payload: {
      sessionRef,
      payloadLength: (body['text'] as string).length,
      enter: body['enter'] !== false,
    },
  })
  this.notifyEvent(event)

  if (
    runtime.harness === 'codex-cli' &&
    body['enter'] !== false &&
    (body['text'] as string).trim().length > 0
  ) {
    const promptEvent = appendHrcEvent(this.db, 'turn.user_prompt', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      ...(runtime.launchId ? { launchId: runtime.launchId } : {}),
      transport: runtime.transport,
      payload: createUserPromptPayload(body['text'] as string),
    })
    this.notifyEvent(promptEvent)
  }

  const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef
  return json({
    delivered: true,
    sessionRef: `${session.scopeRef}/lane:${laneRef}`,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
  } satisfies DeliverLiteralBySelectorResponse)
}

export async function handleBrokerLiteralInputBySelector(
  this: HrcServerInstanceForHandlers,
  input: {
    session: HrcSessionRecord
    runtime: HrcRuntimeSnapshot
    sessionRef: string
    text: string
    enter: boolean
  }
): Promise<Response> {
  const { session, runtime, sessionRef, text, enter } = input
  const pending = this.pendingBrokerLiteralInputs.get(runtime.runtimeId)
  const now = timestamp()
  const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef

  if (!enter) {
    const buffered = `${pending?.text ?? ''}${text}`
    this.pendingBrokerLiteralInputs.set(runtime.runtimeId, {
      sessionRef,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      text: buffered,
    })
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
    const event = appendHrcEvent(this.db, 'target.literal-input', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        sessionRef,
        payloadLength: text.length,
        enter: false,
        delivery: 'broker-buffered-literal',
      },
    })
    this.notifyEvent(event)
    return json({
      delivered: true,
      sessionRef: `${session.scopeRef}/lane:${laneRef}`,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
    } satisfies DeliverLiteralBySelectorResponse)
  }

  const prompt = `${pending?.text ?? ''}${text}`
  if (prompt.trim().length === 0) {
    this.pendingBrokerLiteralInputs.delete(runtime.runtimeId)
    const pane = requireTmuxPane(runtime)
    await this.tmuxForPane(pane).sendEnter(pane.paneId)
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
    const event = appendHrcEvent(this.db, 'target.literal-input', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        sessionRef,
        payloadLength: 0,
        enter: true,
        delivery: 'broker-empty-enter',
      },
    })
    this.notifyEvent(event)
    return json({
      delivered: true,
      sessionRef: `${session.scopeRef}/lane:${laneRef}`,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
    } satisfies DeliverLiteralBySelectorResponse)
  }

  this.pendingBrokerLiteralInputs.delete(runtime.runtimeId)
  const runId = `run-${randomUUID()}`
  const turnResponse = await this.executeInteractiveBrokerInputTurn(
    session,
    runtime,
    prompt,
    runId,
    {
      waitForCompletion: false,
    }
  )
  const turnBody = (await turnResponse.json()) as DispatchTurnResponse
  const event = appendHrcEvent(this.db, 'target.literal-input', {
    ts: timestamp(),
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId: turnBody.runId,
    runtimeId: runtime.runtimeId,
    transport: 'tmux',
    payload: {
      sessionRef,
      payloadLength: prompt.length,
      enter: true,
      delivery: 'broker-dispatch-input',
    },
  })
  this.notifyEvent(event)

  return json({
    delivered: true,
    sessionRef: `${session.scopeRef}/lane:${laneRef}`,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    runId: turnBody.runId,
    status: turnBody.status,
  } satisfies DeliverLiteralBySelectorResponse)
}

export async function handleDispatchTurnBySelector(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body) || !isRecord(body['selector'])) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required')
  }

  const sessionRef = (body['selector'] as Record<string, unknown>)['sessionRef']
  if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'selector.sessionRef is required',
      {
        field: 'selector.sessionRef',
      }
    )
  }

  if (typeof body['prompt'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'prompt is required', {
      field: 'prompt',
    })
  }

  let session = findTargetSession(this.db, sessionRef)
  if (!session && body['createIfMissing'] === true) {
    const runtimeIntent = isRecord(body['runtimeIntent'])
      ? (body['runtimeIntent'] as HrcRuntimeIntent)
      : undefined
    if (!runtimeIntent) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'runtimeIntent is required when createIfMissing is true',
        {
          field: 'runtimeIntent',
        }
      )
    }
    const parsedScopeJson = isRecord(body['parsedScopeJson'])
      ? (body['parsedScopeJson'] as Record<string, unknown>)
      : undefined
    session = this.ensureTargetSession(sessionRef, runtimeIntent, parsedScopeJson)
  }

  if (!session) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_SESSION, `unknown session "${sessionRef}"`, {
      sessionRef,
    })
  }

  const intent = isRecord(body['runtimeIntent'])
    ? (body['runtimeIntent'] as HrcRuntimeIntent)
    : session.lastAppliedIntentJson

  if (!intent) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'no runtime intent available for target',
      {
        sessionRef,
      }
    )
  }

  const runId = `run-${randomUUID()}`
  const normalizedIntent = normalizeDispatchIntent(intent, session, runId)
  const turnResponse = await this.dispatchTurnForSession(
    session,
    normalizedIntent,
    body['prompt'],
    { runId }
  )
  const turnBody = (await turnResponse.json()) as DispatchTurnResponse
  const transport = turnBody.transport as 'sdk' | 'tmux' | 'headless' | 'ghostty'

  let finalOutput: string | undefined
  if (transport !== 'tmux' && transport !== 'ghostty') {
    const bufferedOutput = this.db.runtimeBuffers
      .listByRunId(turnBody.runId)
      .map((chunk) => chunk.text)
      .join('')
    if (bufferedOutput.length > 0) {
      finalOutput = bufferedOutput
    }
  }

  const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef
  const turnStatus = turnBody.status as 'completed' | 'started'
  return json({
    runId: turnBody.runId,
    sessionRef: `${session.scopeRef}/lane:${laneRef}`,
    hostSessionId: turnBody.hostSessionId,
    generation: turnBody.generation,
    runtimeId: turnBody.runtimeId,
    transport,
    mode: transport === 'sdk' ? 'nonInteractive' : 'headless',
    status: turnStatus,
    finalOutput,
    continuationUpdated: turnStatus === 'completed',
  } satisfies DispatchTurnBySelectorResponse)
}

export const selectorMessageHandlersMethods = {
  listSessionsByScope,
  listAllSessions,
  ensureRuntimeForSession,
  handleSdkDispatchTurn,
  recordDetachedSemanticTurnFailure,
  ensureTargetSession,
  handleEnsureTarget,
  handleCreateMessage,
  handleCaptureBySelector,
  handleLiteralInputBySelector,
  handleBrokerLiteralInputBySelector,
  handleDispatchTurnBySelector,
}

export type SelectorMessageHandlersMethods = typeof selectorMessageHandlersMethods
