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
  DispatchTurnResponse,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import { appendHrcEvent, createUserPromptPayload } from '../hrc-event-helper.js'
import { normalizeTargetLane } from '../messages.js'
import {
  participantDeliveryUnavailable,
  resolveParticipantDelivery,
} from '../participant-delivery.js'
import { reconnectParticipantAttachment } from '../participant-establishment.js'
import { requireTmuxPane } from '../require-helpers.js'
import { runtimeActivityPatch } from '../runtime-activity.js'
import { findBoundSessionRuntime, findLatestRuntime } from '../runtime-select.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { isRecord, parseJsonBody } from '../server-parsers.js'
import { assertDispatchRunId, isRuntimeUnavailableStatus, json, timestamp } from '../server-util.js'
import { findTargetSession } from '../target-view.js'
import { submissionResponse, submitThroughAdmission } from '../turn-admission/submit.js'
import { enrichDispatchTurnResponse } from '../turn-dispatch-attached-run-handlers.js'

// Broker/SDK buffers are token-stream chunks rather than terminal lines. A
// generous fixed ratio preserves the requested line tail for normal streamed
// output while keeping every capture query capped independently of runtime age.
const CAPTURE_BUFFER_CHUNKS_PER_LINE = 32
const MAX_CAPTURE_BUFFER_CHUNKS = 8_192

function captureBufferChunkLimit(lines: number | undefined): number | undefined {
  if (lines === undefined || !Number.isFinite(lines) || lines <= 0) {
    return undefined
  }
  return Math.min(
    MAX_CAPTURE_BUFFER_CHUNKS,
    Math.max(CAPTURE_BUFFER_CHUNKS_PER_LINE, Math.ceil(lines) * CAPTURE_BUFFER_CHUNKS_PER_LINE)
  )
}

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
    const chunkLimit = captureBufferChunkLimit(lines)
    const chunks =
      chunkLimit !== undefined
        ? this.db.runtimeBuffers.listTailByRuntimeId(runtime.runtimeId, chunkLimit)
        : this.db.runtimeBuffers.listByRuntimeId(runtime.runtimeId)
    text = chunks.map((chunk) => chunk.text).join('')
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

  const participant = resolveParticipantDelivery(this, session)
  const runtime =
    participant !== null && participant.outcome !== 'refused'
      ? participant.runtime
      : findLatestRuntime(this.db, session.hostSessionId)
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    throw new HrcRuntimeUnavailableError('no live literal-capable runtime is currently bound', {
      sessionRef,
      hostSessionId: session.hostSessionId,
    })
  }

  if (runtime.transport !== 'tmux') {
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
      signal: request.signal,
    })
  }

  const pane = requireTmuxPane(runtime)
  const tmux = this.tmuxForPane(pane)
  if (body['enter'] !== false) {
    await tmux.sendKeys(pane.paneId, body['text'])
  } else {
    await tmux.sendLiteral(pane.paneId, body['text'])
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
    signal?: AbortSignal | undefined
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

  const runId = `run-${randomUUID()}`
  return submissionResponse(
    await submitThroughAdmission(
      this,
      {
        door: 'literal-flush',
        intent: 'enqueue',
        target: session,
        body: prompt,
        principal: 'system',
        executionFormat: 'format1',
        signal: input.signal,
        options: { runId, waitForCompletion: false },
        replay: async () => {
          throw new Error('literal flush has no idempotency field')
        },
      },
      async (plan) => {
        let participant = plan.participant
        if (participant?.outcome === 'reconnect') {
          await reconnectParticipantAttachment(this, participant.registration, participant.attempt)
          participant = resolveParticipantDelivery(this, plan.session)
        }
        if (participant?.outcome === 'refused')
          throw participantDeliveryUnavailable(plan.session, participant)
        if (participant?.outcome === 'reconnect')
          throw new HrcRuntimeUnavailableError('participant attachment is being restored')
        const deliveryRuntime = participant?.runtime ?? runtime
        this.pendingBrokerLiteralInputs.delete(runtime.runtimeId)
        const raw = await this.executeInteractiveBrokerInputTurn(
          plan,
          deliveryRuntime,
          prompt,
          runId,
          {
            ...plan.options,
            waitForCompletion: false,
            submissionDoor: 'enqueue',
          }
        )
        if (plan.observation === undefined) throw new Error('literal plan has no observation')
        const turnResponse = await enrichDispatchTurnResponse(this, raw, plan.observation)
        const turnBody = (await turnResponse.json()) as DispatchTurnResponse
        assertDispatchRunId(turnBody)
        const value = emitLiteralInputAndRespond({
          ts: timestamp(),
          payloadLength: prompt.length,
          enter: true,
          delivery: 'broker-dispatch-input',
          runId: turnBody.runId,
          responseExtra: { runId: turnBody.runId, status: turnBody.status },
        })
        return turnBody.admission === 'rejected'
          ? { kind: 'rejected_unlanded', rejection: { source: 'positive-rejection', value } }
          : { kind: 'accepted', value }
      }
    )
  )
}
