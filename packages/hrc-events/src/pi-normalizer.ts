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

function normalizePiPayload(eventName: string, payload: Record<string, unknown>): PiDerivedEvent[] {
  if (eventName === 'tool_execution_start') {
    const toolUseId = getString(payload, 'toolUseId', 'tool_use_id', 'id', 'callId') ?? ''
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

  if (eventName === 'tool_execution_update') {
    const toolUseId = getString(payload, 'toolUseId', 'tool_use_id', 'id', 'callId') ?? ''
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

  if (eventName === 'tool_execution_end') {
    const toolUseId = getString(payload, 'toolUseId', 'tool_use_id', 'id', 'callId') ?? ''
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

  if (
    eventName === 'message_start' ||
    eventName === 'message_update' ||
    eventName === 'message_end'
  ) {
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

  if (eventName === 'turn_start') {
    return [{ type: 'notice', level: 'info', message: 'Pi turn started' }]
  }

  if (eventName === 'turn_end') {
    return [{ type: 'notice', level: 'info', message: 'Pi turn completed' }]
  }

  return []
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
