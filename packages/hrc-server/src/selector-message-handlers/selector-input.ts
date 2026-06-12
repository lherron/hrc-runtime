import { randomUUID } from 'node:crypto'

import {
  HrcBadRequestError,
  HrcErrorCode,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
} from 'hrc-core'
import type {
  CaptureBySelectorResponse,
  DeliverLiteralBySelectorResponse,
  DispatchTurnBySelectorResponse,
  DispatchTurnResponse,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import { normalizeDispatchIntent } from '../dispatch-invocation.js'
import { appendHrcEvent, createUserPromptPayload } from '../hrc-event-helper.js'
import { normalizeTargetLane } from '../messages.js'
import { requireGhosttySurface, requireTmuxPane } from '../require-helpers.js'
import { findBoundSessionRuntime, findLatestRuntime } from '../runtime-select.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { isRecord, parseJsonBody } from '../server-parsers.js'
import { isRuntimeUnavailableStatus, json, timestamp } from '../server-util.js'
import { findTargetSession } from '../target-view.js'
import type { TmuxPaneState } from '../tmux.js'

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
