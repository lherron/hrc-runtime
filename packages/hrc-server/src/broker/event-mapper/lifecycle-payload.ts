/**
 * Broker-event emission + lifecycle-payload shaping for the BrokerEventMapper.
 *
 * Extracted verbatim from event-mapper.ts as a pure mechanical move. These are
 * the provenance-mirror append (`emitBrokerEvent`), the canonical lifecycle
 * append (`emitLifecycleEvent` + echo suppression), and the legacy-shaped
 * lifecycle payload builder — none mutate HRC state beyond appending events.
 */
import type { HrcEventEnvelope, HrcLifecycleEvent, HrcLifecycleTransport } from 'hrc-core'
import type { AgentMessageEvent, ToolExecutionEndEvent, ToolExecutionStartEvent } from 'hrc-events'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type {
  AssistantMessageCompletedPayload,
  InvocationEventEnvelope,
  ToolCallCompletedPayload,
  ToolCallFailedPayload,
  ToolCallStartedPayload,
  TurnFailedPayload,
  UserMessagePayload,
} from 'spaces-harness-broker-protocol'

import { appendHrcEvent, createUserPromptPayload } from '../../hrc-event-helper'
import {
  BROKER_TO_HRC_KIND,
  type ProjectionContext,
  isRecord,
  toolResultFromBrokerResult,
} from './helpers'

/** Emit a single broker-sourced HRC event mirroring the broker envelope. */
export function emitBrokerEvent(
  db: HrcDatabase,
  envelope: InvocationEventEnvelope,
  ctx: ProjectionContext,
  now: string
): HrcEventEnvelope {
  return db.events.append({
    ts: now,
    hostSessionId: ctx.hostSessionId,
    scopeRef: ctx.scopeRef,
    laneRef: ctx.laneRef,
    generation: ctx.generation,
    ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
    runtimeId: ctx.runtimeId,
    source: 'broker',
    eventKind: `broker.${envelope.type}`,
    eventJson: {
      invocationId: envelope.invocationId,
      seq: envelope.seq,
      type: envelope.type,
      time: envelope.time,
      ...(envelope.turnId !== undefined ? { turnId: envelope.turnId } : {}),
      ...(envelope.inputId !== undefined ? { inputId: envelope.inputId } : {}),
      ...(envelope.itemId !== undefined ? { itemId: envelope.itemId } : {}),
      payload: envelope.payload,
    },
  })
}

/**
 * Project a broker event into the canonical `hrc_events` lifecycle stream that
 * every client follows via `/v1/events`. Returns the appended lifecycle event
 * (so the server can `notifyEvent` it) or undefined for provenance-only types.
 */
export function emitLifecycleEvent(
  db: HrcDatabase,
  envelope: InvocationEventEnvelope,
  ctx: ProjectionContext,
  now: string
): HrcLifecycleEvent | undefined {
  if (shouldSurfaceDiagnostic(envelope)) {
    return appendHrcEvent(db, 'broker.diagnostic', {
      ts: now,
      hostSessionId: ctx.hostSessionId,
      scopeRef: ctx.scopeRef,
      laneRef: ctx.laneRef,
      generation: ctx.generation,
      runtimeId: ctx.runtimeId,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      transport: ctx.transport,
      payload: diagnosticLifecyclePayload(envelope, ctx),
    })
  }

  const eventKind = BROKER_TO_HRC_KIND[envelope.type]
  if (eventKind === undefined) {
    return undefined
  }
  if (eventKind === 'turn.user_prompt' && isEchoedUserPrompt(db, envelope, ctx)) {
    return undefined
  }
  return appendHrcEvent(db, eventKind, {
    ts: now,
    hostSessionId: ctx.hostSessionId,
    scopeRef: ctx.scopeRef,
    laneRef: ctx.laneRef,
    generation: ctx.generation,
    runtimeId: ctx.runtimeId,
    ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
    transport: ctx.transport,
    payload: lifecyclePayload(envelope, ctx.transport),
  })
}

function isEchoedUserPrompt(
  db: HrcDatabase,
  envelope: InvocationEventEnvelope,
  ctx: ProjectionContext
): boolean {
  if (envelope.type !== 'user.message') {
    return false
  }
  const payload = envelope.payload as Partial<UserMessagePayload>
  if (typeof payload.content !== 'string') {
    return false
  }

  const canonicalContent = createUserPromptPayload(payload.content).message.content
  const fromHrcSeq = currentTurnPromptWindowStart(db, ctx)
  const priorPrompts = db.hrcEvents.listByKind('turn.user_prompt', {
    hostSessionId: ctx.hostSessionId,
    generation: ctx.generation,
    runtimeId: ctx.runtimeId,
    fromHrcSeq,
  })

  return priorPrompts.some((event) => userPromptPayloadContent(event.payload) === canonicalContent)
}

function currentTurnPromptWindowStart(db: HrcDatabase, ctx: ProjectionContext): number {
  const events = db.hrcEvents.listFromHrcSeq(1, {
    hostSessionId: ctx.hostSessionId,
    generation: ctx.generation,
    runtimeId: ctx.runtimeId,
  })
  const lastTerminal = events.filter((event) => event.eventKind === 'turn.completed').at(-1)
  return lastTerminal === undefined ? 1 : lastTerminal.hrcSeq + 1
}

function userPromptPayloadContent(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined
  }
  const message = payload['message']
  if (!isRecord(message) || message['role'] !== 'user') {
    return undefined
  }
  const content = message['content']
  return typeof content === 'string' ? content : undefined
}

export function shouldSurfaceDiagnostic(envelope: InvocationEventEnvelope): boolean {
  const payload = envelope.payload as unknown
  if (envelope.type !== 'diagnostic' || !isRecord(payload)) {
    return false
  }
  if (payload['level'] === 'error') {
    return true
  }
  const data = payload['data']
  return isRecord(data) && data['code'] === 'api_error'
}

function diagnosticLifecyclePayload(
  envelope: InvocationEventEnvelope,
  ctx: ProjectionContext
): Record<string, unknown> {
  const payload = isRecord(envelope.payload) ? envelope.payload : {}
  return {
    ...payload,
    invocationId: envelope.invocationId,
    seq: envelope.seq,
    time: envelope.time,
    ...(envelope.turnId !== undefined ? { turnId: envelope.turnId } : {}),
    ...(envelope.inputId !== undefined ? { inputId: envelope.inputId } : {}),
    ...(envelope.itemId !== undefined ? { itemId: envelope.itemId } : {}),
    ...(envelope.correlation !== undefined ? { correlation: envelope.correlation } : {}),
    ...(envelope.driver !== undefined ? { driver: envelope.driver } : {}),
    ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
  }
}

/** Build the legacy-shaped lifecycle payload for a mapped broker event. */
export function lifecyclePayload(
  envelope: InvocationEventEnvelope,
  transport: HrcLifecycleTransport
): Record<string, unknown> {
  switch (envelope.type) {
    case 'user.message': {
      const payload = envelope.payload as UserMessagePayload
      // createUserPromptPayload builds the {type:'message_end', role:'user'}
      // shape (with turn-text truncation) consumers already render.
      return createUserPromptPayload(payload.content) as unknown as Record<string, unknown>
    }
    case 'assistant.message.completed': {
      const payload = envelope.payload as AssistantMessageCompletedPayload
      const content = payload.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
      const event: AgentMessageEvent = {
        type: 'message_end',
        message: { role: 'assistant', content },
      }
      return event as unknown as Record<string, unknown>
    }
    case 'tool.call.started': {
      const payload = envelope.payload as ToolCallStartedPayload
      const event: ToolExecutionStartEvent = {
        type: 'tool_execution_start',
        toolUseId: payload.toolCallId,
        toolName: payload.name,
        input: isRecord(payload.input) ? payload.input : {},
      }
      return event as unknown as Record<string, unknown>
    }
    case 'tool.call.completed': {
      const payload = envelope.payload as ToolCallCompletedPayload
      const event: ToolExecutionEndEvent = {
        type: 'tool_execution_end',
        toolUseId: payload.toolCallId,
        toolName: payload.name,
        result: toolResultFromBrokerResult(payload.result),
        ...(payload.isError !== undefined ? { isError: payload.isError } : {}),
      }
      return event as unknown as Record<string, unknown>
    }
    case 'tool.call.failed': {
      const payload = envelope.payload as ToolCallFailedPayload
      const event: ToolExecutionEndEvent = {
        type: 'tool_execution_end',
        toolUseId: payload.toolCallId,
        toolName: payload.name,
        result: { content: [{ type: 'text', text: payload.message }] },
        isError: true,
      }
      return event as unknown as Record<string, unknown>
    }
    case 'turn.completed':
      return { success: true, transport, source: 'broker' }
    case 'turn.failed': {
      const payload = envelope.payload as TurnFailedPayload
      return {
        success: false,
        transport,
        source: 'broker',
        message: payload.message,
        ...(payload.code !== undefined ? { code: payload.code } : {}),
        ...(payload.data !== undefined ? { data: payload.data } : {}),
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        ...(payload.retryable !== undefined ? { retryable: payload.retryable } : {}),
      }
    }
    case 'turn.interrupted':
      return { success: false, interrupted: true, transport, source: 'broker' }
    default:
      return { transport }
  }
}
