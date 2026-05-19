import { admissionLabel } from 'agent-action-render'
import { parseScopeRef, validateScopeRef } from 'agent-scope'
import type { ContentBlock, Message, ToolResult } from 'spaces-runtime'
import { createLogger } from './logger.js'
import type { GatewaySessionEvent, SessionEventEnvelope } from './types.js'

const log = createLogger({ component: 'hrc-frame-render' })

export type HrcLifecycleEventPayload = {
  hrcSeq: number
  eventKind: string
  scopeRef: string
  laneRef?: string | undefined
  runId?: string | undefined
  payload: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Derives a project ID from a scope ref. Returns undefined for project-less
 * scopes, which causes the adapter to drop the event. This is correct for
 * consumers that require project-qualified targets (e.g. Discord bindings,
 * hrcchat turn). The `hrcchat turn` command always supplies project-qualified
 * targets, so this contract assumption is safe.
 */
function deriveProjectId(scopeRef: string): string | undefined {
  const validation = validateScopeRef(scopeRef)
  if (!validation.ok) {
    return undefined
  }
  return parseScopeRef(scopeRef).projectId
}

function laneIdFromRef(laneRef: string): string {
  return laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
}

export function canonicalSessionRefFromEvent(event: {
  scopeRef?: string | undefined
  laneRef?: string | undefined
}): string | undefined {
  if (!event.scopeRef || !event.laneRef) {
    return undefined
  }
  return `${event.scopeRef}/lane:${laneIdFromRef(event.laneRef)}`
}

function textFrom(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (value === undefined || value === null) {
    return ''
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isNoticePayload(payload: unknown): payload is {
  type: 'notice'
  level: 'info' | 'warn' | 'error'
  message: string
} {
  if (!isRecord(payload) || payload['type'] !== 'notice') {
    return false
  }

  return (
    (payload['level'] === 'info' || payload['level'] === 'warn' || payload['level'] === 'error') &&
    typeof payload['message'] === 'string'
  )
}

function adaptToolCall(payload: unknown): GatewaySessionEvent | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const toolUseId = getString(payload, 'toolUseId')
  const toolName = getString(payload, 'toolName')
  if (!toolUseId || !toolName) {
    return undefined
  }

  const input = payload['input']
  return {
    type: 'tool_execution_start',
    toolUseId,
    toolName,
    input: isRecord(input) ? input : {},
  }
}

function adaptToolResult(payload: unknown): GatewaySessionEvent | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const toolUseId = getString(payload, 'toolUseId')
  const toolName = getString(payload, 'toolName')
  if (!toolUseId || !toolName) {
    return undefined
  }

  // turn.tool_result uses `result`; sdk.tool_result uses `output` — accept either
  const result = payload['result'] ?? payload['output']
  const isError = getBoolean(payload, 'isError')
  return {
    type: 'tool_execution_end',
    toolUseId,
    toolName,
    result: isRecord(result)
      ? (result as unknown as ToolResult)
      : {
          content: [{ type: 'text', text: textFrom(result) }],
        },
    ...(isError !== undefined ? { isError } : {}),
  }
}

function adaptAssistantMessage(
  payload: unknown,
  fallbackMessageId?: string
): GatewaySessionEvent | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const message = isRecord(payload['message']) ? payload['message'] : payload
  const messageId =
    getString(payload, 'messageId') ??
    (isRecord(message) ? getString(message, 'id') : undefined) ??
    fallbackMessageId
  if (message['role'] !== 'assistant') {
    return undefined
  }

  const content = message['content']
  if (typeof content !== 'string' && !Array.isArray(content)) {
    return undefined
  }

  return {
    type: 'message_end',
    ...(messageId !== undefined ? { messageId } : {}),
    message: {
      role: 'assistant',
      content: content as Message['content'],
    },
    ...(getBoolean(payload, 'truncated') === true ? { truncated: true } : {}),
  }
}

function adaptAssistantMessageStart(payload: unknown): GatewaySessionEvent | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const message = isRecord(payload['message']) ? payload['message'] : undefined
  if (message === undefined || message['role'] !== 'assistant') {
    return undefined
  }

  const content = message['content']
  if (typeof content !== 'string' && !Array.isArray(content)) {
    return undefined
  }

  const messageId = getString(payload, 'messageId')
  return {
    type: 'message_start',
    ...(messageId !== undefined ? { messageId } : {}),
    message: {
      role: 'assistant',
      content: content as Message['content'],
    },
  }
}

function adaptAssistantMessageUpdate(payload: unknown): GatewaySessionEvent | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const messageId = getString(payload, 'messageId')
  const textDelta = getString(payload, 'textDelta')
  const contentBlocks = Array.isArray(payload['contentBlocks'])
    ? (payload['contentBlocks'] as ContentBlock[])
    : undefined

  if (textDelta === undefined && contentBlocks === undefined) {
    return undefined
  }

  return {
    type: 'message_update',
    ...(messageId !== undefined ? { messageId } : {}),
    ...(textDelta !== undefined ? { textDelta } : {}),
    ...(contentBlocks !== undefined ? { contentBlocks } : {}),
  }
}

function adaptTurnCompleted(payload: unknown): GatewaySessionEvent {
  return {
    type: 'turn_end',
    payload,
  }
}

export function adaptHrcLifecycleEvent(
  event: HrcLifecycleEventPayload
): SessionEventEnvelope | undefined {
  const projectId = deriveProjectId(event.scopeRef)
  const sessionRef = canonicalSessionRefFromEvent(event)
  const runId = event.runId?.trim()
  let sessionEvent: GatewaySessionEvent | undefined

  if (!runId) {
    log.debug('adapter.event.dropped', { data: { eventKind: event.eventKind } })
    return undefined
  }

  if (projectId === undefined) {
    log.debug('adapter.event.dropped', { data: { eventKind: event.eventKind, runId } })
    return undefined
  }

  if (sessionRef === undefined) {
    log.warn('adapter.event.dropped', {
      message: 'Dropping HRC event without canonical session identity',
      data: { eventKind: event.eventKind, runId, scopeRef: event.scopeRef, laneRef: event.laneRef },
    })
    return undefined
  }

  if (isNoticePayload(event.payload)) {
    sessionEvent = {
      type: 'notice',
      level: event.payload.level,
      message: event.payload.message,
    }
  } else {
    switch (event.eventKind) {
      case 'message_start':
        sessionEvent = adaptAssistantMessageStart(event.payload)
        break
      case 'message_update':
        sessionEvent = adaptAssistantMessageUpdate(event.payload)
        break
      case 'turn.tool_call':
      case 'sdk.tool_call':
      case 'tool_execution_start':
        sessionEvent = adaptToolCall(event.payload)
        break
      case 'turn.tool_result':
      case 'sdk.tool_result':
      case 'tool_execution_end':
        sessionEvent = adaptToolResult(event.payload)
        break
      case 'turn.message':
        sessionEvent = adaptAssistantMessage(event.payload, `hrc:${event.hrcSeq}`)
        break
      case 'sdk.message':
      case 'message_end':
        sessionEvent = adaptAssistantMessage(event.payload)
        break
      case 'turn.completed':
      case 'turn_end':
        sessionEvent = adaptTurnCompleted(event.payload)
        break
      default:
        if (event.eventKind.startsWith('input.')) {
          const pr = isRecord(event.payload) ? event.payload : {}
          sessionEvent = {
            type: 'notice',
            level: 'info',
            message: admissionLabel({
              eventKind: event.eventKind,
              admissionKind: getString(pr, 'admissionKind'),
              applicationStatus: getString(pr, 'applicationStatus'),
              reason: getString(pr, 'reason'),
            }),
          }
        }
        break
    }
  }

  if (!sessionEvent) {
    log.debug('adapter.event.dropped', { data: { eventKind: event.eventKind, runId } })
    return undefined
  }

  return {
    sessionRef,
    projectId,
    runId,
    seq: event.hrcSeq,
    event: sessionEvent,
  }
}

export const hrcLifecycleEventToSessionEnvelope = adaptHrcLifecycleEvent
