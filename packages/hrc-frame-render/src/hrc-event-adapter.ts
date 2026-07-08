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

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
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
  const record = recordFrom(payload)
  if (!record) {
    return undefined
  }

  const toolUseId = getString(record, 'toolUseId')
  const toolName = getString(record, 'toolName')
  if (!toolUseId || !toolName) {
    return undefined
  }

  const input = record['input']
  return {
    type: 'tool_execution_start',
    toolUseId,
    toolName,
    input: isRecord(input) ? input : {},
  }
}

function adaptToolResult(payload: unknown): GatewaySessionEvent | undefined {
  const record = recordFrom(payload)
  if (!record) {
    return undefined
  }

  const toolUseId = getString(record, 'toolUseId')
  const toolName = getString(record, 'toolName')
  if (!toolUseId || !toolName) {
    return undefined
  }

  // turn.tool_result uses `result`; sdk.tool_result uses `output` — accept either
  const result = record['result'] ?? record['output']
  const isError = getBoolean(record, 'isError')
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
  const record = recordFrom(payload)
  if (!record) {
    return undefined
  }

  const message = isRecord(record['message']) ? record['message'] : record
  const messageId =
    getString(record, 'messageId') ??
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
    ...(getBoolean(record, 'truncated') === true ? { truncated: true } : {}),
  }
}

function adaptAssistantMessageStart(payload: unknown): GatewaySessionEvent | undefined {
  const record = recordFrom(payload)
  if (!record) {
    return undefined
  }

  const message = isRecord(record['message']) ? record['message'] : undefined
  if (message === undefined || message['role'] !== 'assistant') {
    return undefined
  }

  const content = message['content']
  if (typeof content !== 'string' && !Array.isArray(content)) {
    return undefined
  }

  const messageId = getString(record, 'messageId')
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
  const record = recordFrom(payload)
  if (!record) {
    return undefined
  }

  const messageId = getString(record, 'messageId')
  const textDelta = getString(record, 'textDelta')
  const contentBlocks = Array.isArray(record['contentBlocks'])
    ? (record['contentBlocks'] as ContentBlock[])
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

function adaptEventByKind(
  eventKind: string,
  payload: unknown,
  hrcSeq: number
): GatewaySessionEvent | undefined {
  if (isNoticePayload(payload)) {
    return {
      type: 'notice',
      level: payload.level,
      message: payload.message,
    }
  }

  switch (eventKind) {
    case 'message_start':
      return adaptAssistantMessageStart(payload)
    case 'message_update':
      return adaptAssistantMessageUpdate(payload)
    case 'turn.tool_call':
    case 'sdk.tool_call':
    case 'tool_execution_start':
      return adaptToolCall(payload)
    case 'turn.tool_result':
    case 'sdk.tool_result':
    case 'tool_execution_end':
      return adaptToolResult(payload)
    case 'turn.message':
      return adaptAssistantMessage(payload, `hrc:${hrcSeq}`)
    case 'sdk.message':
    case 'message_end':
      return adaptAssistantMessage(payload)
    case 'turn.completed':
    case 'turn_end':
      return adaptTurnCompleted(payload)
    default:
      if (eventKind.startsWith('input.')) {
        const pr = recordOrEmpty(payload)
        return {
          type: 'notice',
          level: 'info',
          message: admissionLabel({
            eventKind,
            admissionKind: getString(pr, 'admissionKind'),
            applicationStatus: getString(pr, 'applicationStatus'),
            reason: getString(pr, 'reason'),
          }),
        }
      }
      return undefined
  }
}

export function adaptHrcLifecycleEvent(
  event: HrcLifecycleEventPayload
): SessionEventEnvelope | undefined {
  const projectId = deriveProjectId(event.scopeRef)
  const sessionRef = canonicalSessionRefFromEvent(event)
  const runId = event.runId?.trim()

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

  const sessionEvent = adaptEventByKind(event.eventKind, event.payload, event.hrcSeq)

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

/**
 * Retained for published API compatibility. New code should prefer `adaptHrcLifecycleEvent`;
 * removal requires a coordinated contract change.
 *
 * @deprecated Prefer `adaptHrcLifecycleEvent` for new code.
 */
export const hrcLifecycleEventToSessionEnvelope = adaptHrcLifecycleEvent
