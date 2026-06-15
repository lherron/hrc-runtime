/**
 * Normalizer for Codex OTEL log records → typed HookDerivedEvent[].
 *
 * Maps the Codex CLI OTEL event vocabulary (codex.tool_decision,
 * codex.tool_result, codex.user_prompt, codex.conversation_starts)
 * into the same HookDerivedEvent union used by the Claude Code hook
 * normalizer, so both harness types produce a unified typed event stream.
 *
 * Transport/infra events (codex.api_request, codex.sse_event,
 * codex.websocket_*) are not mapped — they remain as raw OTEL events
 * in the event store.
 */

import type { HookDerivedEvent } from './events.js'
import { getBooleanCoerced, getString, truncate } from './internal/record.js'

// ============================================================================
// Input type — matches otel-ingest.ts NormalizedOtelLogRecord shape
// ============================================================================

/**
 * Minimal shape of a normalized OTEL log record. Compatible with
 * hrc-server's NormalizedOtelLogRecord but decoupled from it so
 * hrc-events has no dependency on hrc-server.
 */
export type OtelLogRecordInput = {
  logRecord: {
    attributes?: Record<string, unknown> | undefined
    body?: unknown
    [key: string]: unknown
  }
  [key: string]: unknown
}

// ============================================================================
// Result type
// ============================================================================

export type NormalizeOtelResult = {
  /** Typed events derived from this OTEL record (empty if not mappable) */
  events: HookDerivedEvent[]
  /** The extracted Codex event name (e.g. 'codex.tool_decision') */
  eventName: string
}

// ============================================================================
// Helpers
// ============================================================================

/** Max characters of a user prompt echoed into a notice before truncation. */
const PROMPT_TRUNCATE = 200

function getAttrString(
  attrs: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  return attrs ? getString(attrs, key) : undefined
}

// OTEL attribute values arrive stringly-typed, so booleans may be the strings
// 'true'/'false' — getBooleanCoerced preserves that coercion.
function getAttrBool(attrs: Record<string, unknown> | undefined, key: string): boolean | undefined {
  return attrs ? getBooleanCoerced(attrs, key) : undefined
}

/**
 * Extract the Codex event name from attributes or body. Follows the same
 * fallback chain as otel-ingest.ts extractEventKind.
 */
function extractEventName(record: OtelLogRecordInput): string {
  const attrs = record.logRecord.attributes
  if (attrs) {
    const eventName = getAttrString(attrs, 'event.name')
    if (eventName) return eventName
    const eventName2 = getAttrString(attrs, 'event_name')
    if (eventName2) return eventName2
  }
  const body = record.logRecord.body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const b = body as Record<string, unknown>
    const eventName = typeof b['eventName'] === 'string' ? b['eventName'] : undefined
    if (eventName) return eventName
    const eventName2 = typeof b['event_name'] === 'string' ? b['event_name'] : undefined
    if (eventName2) return eventName2
  }
  return 'otel.log'
}

/**
 * Try to parse a JSON string into a record, returning undefined on failure.
 */
function tryParseJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // not valid JSON
  }
  return undefined
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Normalize a Codex OTEL log record into typed events.
 *
 * Maps Codex-specific event names to the shared HookDerivedEvent union:
 * - codex.tool_decision → tool_execution_start (only when arguments are present)
 * - codex.tool_result   → tool_execution_end, and backfills tool_execution_start
 *                          when Codex emits arguments only on the result row
 * - codex.user_prompt   → notice (user turn start)
 * - codex.conversation_starts → notice (session start)
 *
 * Transport/infra events (api_request, sse_event, websocket_*) return
 * empty events — they remain as raw OTEL events in the store.
 */
type OtelAttrs = Record<string, unknown> | undefined

function handleToolDecision(attrs: OtelAttrs): HookDerivedEvent[] {
  const toolName = getAttrString(attrs, 'tool_name') ?? 'tool'
  const callId = getAttrString(attrs, 'call_id')
  if (!callId) return []

  // Try to parse arguments JSON string into an input record
  const argumentsRaw = getAttrString(attrs, 'arguments')
  const input = tryParseJson(argumentsRaw)
  if (!input) return []

  return [
    {
      type: 'tool_execution_start',
      toolUseId: callId,
      toolName,
      input,
    },
  ]
}

function handleToolResult(attrs: OtelAttrs): HookDerivedEvent[] {
  const toolName = getAttrString(attrs, 'tool_name') ?? 'tool'
  const callId = getAttrString(attrs, 'call_id')
  if (!callId) return []

  const input = tryParseJson(getAttrString(attrs, 'arguments'))
  const output = getAttrString(attrs, 'output') ?? ''
  const successRaw = getAttrBool(attrs, 'success')
  const isError = successRaw === false

  const events: HookDerivedEvent[] = []
  if (input) {
    events.push({
      type: 'tool_execution_start',
      toolUseId: callId,
      toolName,
      input,
    })
  }

  events.push({
    type: 'tool_execution_end',
    toolUseId: callId,
    toolName,
    result: {
      content: [{ type: 'text' as const, text: output }],
    },
    isError,
  })

  return events
}

function handleUserPrompt(attrs: OtelAttrs): HookDerivedEvent[] {
  const prompt = getAttrString(attrs, 'prompt') ?? ''
  const truncated = truncate(prompt, PROMPT_TRUNCATE)

  return [
    {
      type: 'notice',
      level: 'info' as const,
      message: `User prompt: ${truncated}`,
    },
  ]
}

function handleConversationStart(attrs: OtelAttrs): HookDerivedEvent[] {
  const model = getAttrString(attrs, 'model') ?? 'unknown'
  const provider = getAttrString(attrs, 'provider_name') ?? ''
  const label = provider ? `${provider}/${model}` : model

  return [
    {
      type: 'notice',
      level: 'info' as const,
      message: `Codex conversation started (model: ${label})`,
    },
  ]
}

const otelEventHandlers: Record<string, (attrs: OtelAttrs) => HookDerivedEvent[]> = {
  'codex.tool_decision': handleToolDecision,
  'codex.tool_result': handleToolResult,
  'codex.user_prompt': handleUserPrompt,
  'codex.conversation_starts': handleConversationStart,
}

export function normalizeCodexOtelEvent(record: OtelLogRecordInput): NormalizeOtelResult {
  const eventName = extractEventName(record)
  const attrs = record.logRecord.attributes

  const handler = otelEventHandlers[eventName]
  // Transport/infra events have no typed mapping — empty events.
  const events = handler ? handler(attrs) : []
  return { events, eventName }
}
