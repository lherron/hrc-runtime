import { randomUUID } from 'node:crypto'

import {
  HrcBadRequestError,
  HrcErrorCode,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
  isCodexAppOwnedScopeRef,
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
import { parseOptionalBirthCredential } from '../federation/birth-credential.js'
import { assertScopeNotRetired } from '../federation/summon-gate-server.js'
import { appendHrcEvent, createUserPromptPayload } from '../hrc-event-helper.js'
import { normalizeTargetLane } from '../messages.js'
import { requireGhosttySurface, requireTmuxPane } from '../require-helpers.js'
import { runtimeActivityPatch } from '../runtime-activity.js'
import { findBoundSessionRuntime, findLatestRuntime } from '../runtime-select.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import {
  isRecord,
  parseJsonBody,
  parseOptionalTurnResponseFormat,
  parseSessionRef,
} from '../server-parsers.js'
import { isRuntimeUnavailableStatus, json, timestamp } from '../server-util.js'
import { findTargetSession } from '../target-view.js'
import type { TmuxPaneState } from '../tmux.js'

/**
 * Parse a by-selector request body and extract the required, non-empty
 * `selector.sessionRef`. Throws the canonical `MALFORMED_REQUEST` errors used by
 * every by-selector handler when the selector or sessionRef is missing/empty.
 */
async function parseSelectorRequest(
  request: Request
): Promise<{ body: Record<string, unknown>; sessionRef: string }> {
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

  return { body, sessionRef }
}

/** Canonical `scopeRef/lane:<normalizedLane>` rendering for a target session. */
function formatSelectorRef(session: HrcSessionRecord): string {
  const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef
  return `${session.scopeRef}/lane:${laneRef}`
}

/**
 * Build the canonical `DeliverLiteralBySelectorResponse` JSON. The base field
 * set is shared across every literal-delivery path; the optional `runId`/`status`
 * are only present on the broker-dispatch path and stay conditional so no
 * `undefined` keys leak into the response.
 */
function deliverLiteralResponse(
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  extra?: { runId: string; status: DispatchTurnResponse['status'] }
): Response {
  return json({
    delivered: true,
    sessionRef: formatSelectorRef(session),
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    ...(extra ? { runId: extra.runId, status: extra.status } : {}),
  } satisfies DeliverLiteralBySelectorResponse)
}

export async function handleCaptureBySelector(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const { body, sessionRef } = await parseSelectorRequest(request)

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
  this.db.runtimes.update(
    runtime.runtimeId,
    runtimeActivityPatch(this.db, runtime.runtimeId, {
      source: 'agent-message',
      occurredAt: now,
      updatedAt: now,
    })
  )

  return json({
    text,
    sessionRef: formatSelectorRef(session),
    runtimeId: runtime.runtimeId,
  } satisfies CaptureBySelectorResponse)
}

export async function handleLiteralInputBySelector(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const { body, sessionRef } = await parseSelectorRequest(request)

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
  this.db.runtimes.update(
    runtime.runtimeId,
    runtimeActivityPatch(this.db, runtime.runtimeId, {
      source: 'agent-message',
      occurredAt: now,
      updatedAt: now,
    })
  )

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

  return deliverLiteralResponse(session, runtime)
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

  // Shared epilogue for all three broker-literal delivery arms: emit the
  // observable `target.literal-input` event and return the canonical
  // delivery response. The decision arms below own the state mutation
  // (buffer / flush) and the per-arm event data — `ts`, `payloadLength`,
  // `enter`, the `delivery` tag, and the optional `runId` (event + response)
  // — all of which stay byte-identical to the pre-refactor inline blocks.
  const emitLiteralInputAndRespond = (variant: {
    ts: string
    payloadLength: number
    enter: boolean
    delivery: 'broker-buffered-literal' | 'broker-empty-enter' | 'broker-dispatch-input'
    runId?: string
    responseExtra?: { runId: string; status: DispatchTurnResponse['status'] }
  }): Response => {
    const event = appendHrcEvent(this.db, 'target.literal-input', {
      ts: variant.ts,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      ...(variant.runId !== undefined ? { runId: variant.runId } : {}),
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        sessionRef,
        payloadLength: variant.payloadLength,
        enter: variant.enter,
        delivery: variant.delivery,
      },
    })
    this.notifyEvent(event)
    return deliverLiteralResponse(session, runtime, variant.responseExtra)
  }

  if (!enter) {
    const buffered = `${pending?.text ?? ''}${text}`
    this.pendingBrokerLiteralInputs.set(runtime.runtimeId, {
      sessionRef,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      text: buffered,
    })
    this.db.runtimes.update(
      runtime.runtimeId,
      runtimeActivityPatch(this.db, runtime.runtimeId, {
        source: 'agent-message',
        occurredAt: now,
        updatedAt: now,
      })
    )
    return emitLiteralInputAndRespond({
      ts: now,
      payloadLength: text.length,
      enter: false,
      delivery: 'broker-buffered-literal',
    })
  }

  const prompt = `${pending?.text ?? ''}${text}`
  if (prompt.trim().length === 0) {
    this.pendingBrokerLiteralInputs.delete(runtime.runtimeId)
    const pane = requireTmuxPane(runtime)
    await this.tmuxForPane(pane).sendEnter(pane.paneId)
    this.db.runtimes.update(
      runtime.runtimeId,
      runtimeActivityPatch(this.db, runtime.runtimeId, {
        source: 'agent-message',
        occurredAt: now,
        updatedAt: now,
      })
    )
    return emitLiteralInputAndRespond({
      ts: now,
      payloadLength: 0,
      enter: true,
      delivery: 'broker-empty-enter',
    })
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
  // `ts` is deliberately RECOMPUTED here (not the `now` captured at entry): the
  // dispatch arm awaits the turn, so the event timestamp reflects post-dispatch
  // wall-clock. Preserved from the pre-refactor inline block.
  return emitLiteralInputAndRespond({
    ts: timestamp(),
    payloadLength: prompt.length,
    enter: true,
    delivery: 'broker-dispatch-input',
    runId: turnBody.runId,
    responseExtra: { runId: turnBody.runId, status: turnBody.status },
  })
}

export async function handleDispatchTurnBySelector(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const { body, sessionRef } = await parseSelectorRequest(request)

  if (typeof body['prompt'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'prompt is required', {
      field: 'prompt',
    })
  }
  const responseFormat = parseOptionalTurnResponseFormat(body['responseFormat'])

  await assertScopeNotRetired(this, {
    scopeRef: parseSessionRef(sessionRef).scopeRef,
    path: 'archived-successor',
    advisoryCoveredByDownstreamGate: () =>
      findTargetSession(this.db, sessionRef) === undefined &&
      body['createIfMissing'] === true &&
      isRecord(body['runtimeIntent']) &&
      !isCodexAppOwnedScopeRef(sessionRef),
  })

  let session = findTargetSession(this.db, sessionRef)
  if (
    !session &&
    body['createIfMissing'] === true &&
    // T-05161: never summon a local runtime for a Codex.app-owned address.
    !isCodexAppOwnedScopeRef(sessionRef)
  ) {
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
    const birthCredential = parseOptionalBirthCredential(body['birthCredential'])
    session = await this.ensureTargetSession(
      sessionRef,
      runtimeIntent,
      parsedScopeJson,
      birthCredential
    )
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
    { runId, responseFormat }
  )
  const turnBody = (await turnResponse.json()) as DispatchTurnResponse
  const transport = turnBody.transport

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

  const turnStatus = turnBody.status
  return json({
    runId: turnBody.runId,
    sessionRef: formatSelectorRef(session),
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
