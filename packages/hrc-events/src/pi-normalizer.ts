import type {
  AgentMessageEvent,
  HookDerivedEvent,
  ToolExecutionEndEvent,
  UserPromptEvent,
} from './events.js'

export type PiHookEnvelopeInput = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  hookData: unknown
}

export type PiSemanticEvent = {
  source: 'hook'
  eventKind: string
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  payload: PiDerivedEvent
}

/**
 * Continuation-set signal extracted from a Pi `session_start` event.
 * The caller persists this as the runtime continuation so the next launch
 * can pass `--session <key>` to Pi for deterministic resume.
 */
export type PiContinuationSet = {
  provider: 'openai'
  key: string
  sessionFile?: string | undefined
}

export type NormalizePiHookResult = {
  source: 'hook'
  eventName: string
  events: HookDerivedEvent[]
  semanticEvents: PiSemanticEvent[]
  continuation?: PiContinuationSet | undefined
}

type PiDerivedEvent = HookDerivedEvent | AgentMessageEvent | UserPromptEvent

function extractPiEventName(hookData: unknown): string {
  if (!hookData || typeof hookData !== 'object' || Array.isArray(hookData)) {
    return 'unknown'
  }
  const record = hookData as Record<string, unknown>
  return typeof record['eventName'] === 'string'
    ? record['eventName']
    : typeof record['event_name'] === 'string'
      ? record['event_name']
      : typeof record['type'] === 'string'
        ? record['type']
        : 'unknown'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function getString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function getBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

function getRecord(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = asRecord(record[key])
    if (value) return value
  }
  return {}
}

function normalizePayload(hookData: unknown): Record<string, unknown> {
  const record = asRecord(hookData)
  if (!record) return {}

  const payload = asRecord(record['payload'])
  if (!payload) return record

  return {
    ...payload,
    eventName: extractPiEventName(record),
  }
}

function textFrom(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function toToolResult(value: unknown): ToolExecutionEndEvent['result'] {
  const resultRecord = asRecord(value)
  if (resultRecord && Array.isArray(resultRecord['content'])) {
    return resultRecord as unknown as ToolExecutionEndEvent['result']
  }

  return {
    content: [{ type: 'text', text: textFrom(value) }],
  }
}

function eventKindForDerivedEvent(event: PiDerivedEvent, piEventName: string): string | undefined {
  if (event.type === 'tool_execution_start') return 'turn.tool_call'
  if (event.type === 'tool_execution_end') return 'turn.tool_result'
  if (event.type === 'message_end') return 'turn.message'
  if (piEventName === 'turn_start') return 'turn.started'
  if (piEventName === 'turn_end') return 'turn.completed'
  return undefined
}

function semanticEvent(envelope: PiHookEnvelopeInput, eventKind: string, payload: PiDerivedEvent) {
  return {
    source: 'hook' as const,
    eventKind,
    launchId: envelope.launchId,
    hostSessionId: envelope.hostSessionId,
    runtimeId: envelope.runtimeId,
    generation: envelope.generation,
    scopeRef: envelope.scopeRef,
    laneRef: envelope.laneRef,
    payload,
  }
}

function piToolUseId(payload: Record<string, unknown>): string {
  return getString(payload, 'toolUseId', 'tool_use_id', 'id', 'callId') ?? ''
}

function handlePiToolStart(payload: Record<string, unknown>): PiDerivedEvent[] {
  const toolUseId = piToolUseId(payload)
  const toolName = getString(payload, 'toolName', 'tool_name', 'name') ?? 'tool'
  if (!toolUseId) return []
  return [
    {
      type: 'tool_execution_start',
      toolUseId,
      toolName,
      input: getRecord(payload, 'input', 'args', 'arguments'),
    },
  ]
}

function handlePiToolUpdate(payload: Record<string, unknown>): PiDerivedEvent[] {
  const toolUseId = piToolUseId(payload)
  if (!toolUseId) return []
  return [
    {
      type: 'tool_execution_update',
      toolUseId,
      message: getString(payload, 'message'),
      partialOutput: getString(payload, 'partialOutput', 'partial_output', 'output'),
    },
  ]
}

function handlePiToolEnd(payload: Record<string, unknown>): PiDerivedEvent[] {
  const toolUseId = piToolUseId(payload)
  const toolName = getString(payload, 'toolName', 'tool_name', 'name') ?? 'tool'
  if (!toolUseId) return []
  const result = toToolResult(payload['result'] ?? payload['output'])
  return [
    {
      type: 'tool_execution_end',
      toolUseId,
      toolName,
      result,
      isError: getBoolean(payload, 'isError', 'is_error'),
    },
  ]
}

function handlePiMessage(payload: Record<string, unknown>): PiDerivedEvent[] {
  const role = getString(payload, 'role') === 'user' ? 'user' : 'assistant'
  const content = textFrom(payload['content'] ?? payload['text'] ?? payload['message'])
  return role === 'user'
    ? [
        {
          type: 'message_end',
          message: { role: 'user', content },
        },
      ]
    : [
        {
          type: 'message_end',
          message: { role: 'assistant', content },
        },
      ]
}

const piEventHandlers: Record<string, (payload: Record<string, unknown>) => PiDerivedEvent[]> = {
  tool_execution_start: handlePiToolStart,
  tool_execution_update: handlePiToolUpdate,
  tool_execution_end: handlePiToolEnd,
  message_start: handlePiMessage,
  message_update: handlePiMessage,
  message_end: handlePiMessage,
  turn_start: () => [{ type: 'notice', level: 'info', message: 'Pi turn started' }],
  turn_end: () => [{ type: 'notice', level: 'info', message: 'Pi turn completed' }],
}

function normalizePiPayload(eventName: string, payload: Record<string, unknown>): PiDerivedEvent[] {
  const handler = piEventHandlers[eventName]
  return handler ? handler(payload) : []
}

export function normalizePiHookEvent(envelope: PiHookEnvelopeInput): NormalizePiHookResult {
  const eventName = extractPiEventName(envelope.hookData)
  const payload = normalizePayload(envelope.hookData)
  const derivedEvents = normalizePiPayload(eventName, payload)
  const events = derivedEvents.filter(
    (event): event is HookDerivedEvent => event.type !== 'message_end'
  )
  const semanticEvents = derivedEvents.flatMap((event) => {
    const eventKind = eventKindForDerivedEvent(event, eventName)
    return eventKind ? [semanticEvent(envelope, eventKind, event)] : []
  })

  // session_start carries Pi's sessionId AND the absolute path of the JSONL
  // file Pi wrote the session to (both injected by the asp-hrc-events bridge
  // from ctx.sessionManager). Prefer the file path as the continuation key:
  // Pi accepts an absolute path to `--session` directly, and using the path
  // avoids the first-launch ambiguity where the new session was created in
  // Pi's default location rather than under our `--session-dir`.
  let continuation: PiContinuationSet | undefined
  if (eventName === 'session_start') {
    const sessionId = getString(payload, 'sessionId', 'session_id')
    const sessionFile = getString(payload, 'sessionFile', 'session_file')
    const key = sessionFile ?? sessionId
    if (key) {
      continuation = {
        provider: 'openai',
        key,
        ...(sessionFile ? { sessionFile } : {}),
      }
    }
  }

  return {
    source: 'hook',
    eventName,
    events,
    semanticEvents,
    ...(continuation ? { continuation } : {}),
  }
}
