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

function getAttrString(
  attrs: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!attrs) return undefined
  const v = attrs[key]
  return typeof v === 'string' ? v : undefined
}

function getAttrBool(attrs: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (!attrs) return undefined
  const v = attrs[key]
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
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
export function normalizeCodexOtelEvent(record: OtelLogRecordInput): NormalizeOtelResult {
  const eventName = extractEventName(record)
  const attrs = record.logRecord.attributes

  if (eventName === 'codex.tool_decision') {
    const toolName = getAttrString(attrs, 'tool_name') ?? 'tool'
    const callId = getAttrString(attrs, 'call_id')
    if (!callId) return { events: [], eventName }

    // Try to parse arguments JSON string into an input record
    const argumentsRaw = getAttrString(attrs, 'arguments')
    const input = tryParseJson(argumentsRaw)
    if (!input) return { events: [], eventName }

    return {
      events: [
        {
          type: 'tool_execution_start',
          toolUseId: callId,
          toolName,
          input,
        },
      ],
      eventName,
    }
  }

  if (eventName === 'codex.tool_result') {
    const toolName = getAttrString(attrs, 'tool_name') ?? 'tool'
    const callId = getAttrString(attrs, 'call_id')
    if (!callId) return { events: [], eventName }

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

    return {
      events,
      eventName,
    }
  }

  if (eventName === 'codex.user_prompt') {
    const prompt = getAttrString(attrs, 'prompt') ?? ''
    const truncated = prompt.length > 200 ? `${prompt.slice(0, 200)}\u2026` : prompt

    return {
      events: [
        {
          type: 'notice',
          level: 'info' as const,
          message: `User prompt: ${truncated}`,
        },
      ],
      eventName,
    }
  }

  if (eventName === 'codex.conversation_starts') {
    const model = getAttrString(attrs, 'model') ?? 'unknown'
    const provider = getAttrString(attrs, 'provider_name') ?? ''
    const label = provider ? `${provider}/${model}` : model

    return {
      events: [
        {
          type: 'notice',
          level: 'info' as const,
          message: `Codex conversation started (model: ${label})`,
        },
      ],
      eventName,
    }
  }

  // Transport/infra events — no typed mapping
  return { events: [], eventName }
}
