/**
 * Leaf helpers, constants, and projection types for the BrokerEventMapper.
 *
 * Extracted verbatim from event-mapper.ts as a pure mechanical move: these are
 * module-private utilities (coercion, identity keys, broker->hrc kind table) and
 * the projection-context / result types the mapper threads through its methods.
 */
import type { HrcEventEnvelope, HrcLifecycleEvent, HrcLifecycleTransport } from 'hrc-core'
import type { ContentBlock, ToolResult } from 'hrc-events'
import type { HrcDatabase } from 'hrc-store-sqlite'

// Canonical definition now lives in broker/json.ts (F5 / T-04738); re-exported
// here so existing `./helpers` importers keep their import path unchanged.
import { isRecord } from '../json'

export { isRecord }

export function omitRuntimeStateActiveRun(value: Record<string, unknown>): Record<string, unknown> {
  const { activeRunId: _activeRunId, ...rest } = value
  return rest
}

export function lifecycleTransportFromRuntime(value: string): HrcLifecycleTransport {
  if (value === 'sdk' || value === 'tmux' || value === 'headless' || value === 'ghostty') {
    return value
  }
  return 'headless'
}

export function permissionIdentityKey(input: {
  invocationId: string
  harnessGeneration?: number | null | undefined
  turnAttempt?: number | null | undefined
  permissionRequestId: string
}): string {
  return JSON.stringify([
    input.invocationId,
    input.harnessGeneration ?? null,
    input.turnAttempt ?? null,
    input.permissionRequestId,
  ])
}

/**
 * Coerce the broker `tool.call.completed.result` field (typed `unknown`) into
 * the canonical hrc-events `ToolResult` shape. Broker drivers emit
 * driver-specific result blobs (e.g. codex's `command` tool returns
 * `{output, exitCode}`); the lifecycle stream uses the hook-derived
 * `{content: ContentBlock[]}` shape consumers already know how to render.
 */
export function toolResultFromBrokerResult(result: unknown): ToolResult {
  if (isRecord(result) && Array.isArray(result['content'])) {
    const content = result['content']
    if (content.every((item) => isRecord(item) && typeof item['type'] === 'string')) {
      return result as unknown as ToolResult
    }
  }
  const text =
    typeof result === 'string'
      ? result
      : isRecord(result) && typeof result['output'] === 'string'
        ? result['output']
        : result === undefined || result === null
          ? ''
          : safeStringify(result)
  const block: ContentBlock = { type: 'text', text }
  const details = isRecord(result) ? result : undefined
  return details === undefined ? { content: [block] } : { content: [block], details }
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Broker event type -> canonical HRC lifecycle `event_kind`. The `events` table
 * mirror carries every broker event under a `broker.<type>` kind for provenance,
 * but the lifecycle stream (`hrc_events`, served by `/v1/events`) is what every
 * client consumes: hrcchat `turn` / `monitor wait` follow it and gate on these
 * canonical kinds, and `notifyEvent` only finalizes the semantic turn on a
 * `turn.completed` lifecycle event. A broker event with no mapping here is
 * provenance-only (no lifecycle row) (T-01711). Mapped kinds MUST exist in
 * `hrc-event-helper`'s KIND_CATEGORIES or `appendHrcEvent` throws.
 */
export const BROKER_TO_HRC_KIND: Partial<Record<string, string>> = {
  'input.accepted': 'turn.accepted',
  'turn.started': 'turn.started',
  // Interactive TUI prompts (claude-code-tmux / codex-cli-tmux) surface the
  // operator's typed text as a broker user.message, emitted right after
  // turn.started. Map it to the canonical turn.user_prompt so the prompt rides
  // the same lifecycle stream as agent messages and tool calls (T-02026).
  'user.message': 'turn.user_prompt',
  'assistant.message.completed': 'turn.message',
  'tool.call.started': 'turn.tool_call',
  'tool.call.completed': 'turn.tool_result',
  'tool.call.failed': 'turn.tool_result',
  'turn.completed': 'turn.completed',
  // Failed/interrupted have no registered lifecycle kind; surface them as a
  // terminal turn.completed (payload carries success:false) so client waiters
  // unblock — run state already records failed/cancelled via projectState.
  'turn.failed': 'turn.completed',
  'turn.interrupted': 'turn.completed',
}

export const TERMINAL_TURN_EVENT_TYPES = [
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
] as const
export const TERMINAL_TURN_EVENT_TYPE_SQL = TERMINAL_TURN_EVENT_TYPES.map(
  (type) => `'${type}'`
).join(', ')

export type BrokerEventMapperDeps = {
  db: HrcDatabase
  now?: () => string
}

export type BrokerProjectionResult = {
  /** True when the (invocationId, seq) was already applied with the same payload. */
  idempotent: boolean
  /** Raw `events`-table mirror appended this call (each `source:'broker'`); empty on idempotent re-apply. */
  events: HrcEventEnvelope[]
  /**
   * Canonical `hrc_events` lifecycle events appended this call (the ones the
   * server `notifyEvent`s to follow-stream subscribers and uses to finalize the
   * semantic turn). Empty on idempotent re-apply or for provenance-only events.
   */
  lifecycleEvents: HrcLifecycleEvent[]
}

/**
 * A pending HRC-derived turn lifecycle event (T-01946). projectState records the
 * descriptor while it mutates state; project() emits it AFTER the canonical event
 * so the hrcSeq order matches the returned lifecycleEvents order.
 */
export type DerivedTurnDescriptor = {
  eventKind: 'turn.awaiting_input' | 'turn.input_resumed'
  toolUseId: string
  toolName: string
}

/** Resolved projection context for a single invocation. */
export type ProjectionContext = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  transport: HrcLifecycleTransport
  operationId: string
  runId: string | undefined
}

export type RuntimeRecord = NonNullable<ReturnType<HrcDatabase['runtimes']['getByRuntimeId']>>
