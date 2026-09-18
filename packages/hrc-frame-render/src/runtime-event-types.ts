/**
 * T-08597 — vendored harness session-event types for frame rendering.
 *
 * Origin: verbatim shapes from spaces-runtime `session/types.d.ts` at ASP
 * 0.1.1-dev.20260917231122 (`ContentBlock`, `Message`, `ToolResult`, and the
 * twelve `UnifiedSessionEvent` members). spaces-runtime-contracts carries no
 * equivalent for these render-level shapes, so they live here. The adapter
 * only casts unknown harness payloads to these types and the frame union only
 * carries them — no interpretation, no behavior. If the upstream shapes gain
 * a member, update this file deliberately, never by re-adding the
 * spaces-runtime import.
 */

export type RuntimeContentBlock =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'image'
      data: string
      mimeType: string
    }
  | {
      type: 'media_ref'
      url: string
      mimeType?: string
      filename?: string
      alt?: string
    }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }

export interface RuntimeMessage {
  role: 'user' | 'assistant' | 'toolResult'
  content: RuntimeContentBlock[] | string
}

export interface RuntimeToolResult {
  content: RuntimeContentBlock[]
  details?: Record<string, unknown>
}

export interface RuntimeAgentStartEvent {
  type: 'agent_start'
  sessionId?: string
  sdkSessionId?: string
}

export interface RuntimeAgentEndEvent {
  type: 'agent_end'
  sessionId?: string
  sdkSessionId?: string
  reason?: string
}

export interface RuntimeTurnStartEvent {
  type: 'turn_start'
  turnId?: string
}

export interface RuntimeTurnEndEvent {
  type: 'turn_end'
  turnId?: string
  toolResults?: Array<{
    toolUseId: string
    result: RuntimeToolResult
  }>
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface RuntimeMessageStartEvent {
  type: 'message_start'
  messageId?: string
  message: RuntimeMessage
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface RuntimeMessageUpdateEvent {
  type: 'message_update'
  messageId?: string
  textDelta?: string
  contentBlocks?: RuntimeContentBlock[]
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface RuntimeMessageEndEvent {
  type: 'message_end'
  messageId?: string
  message?: RuntimeMessage
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface RuntimeToolExecutionStartEvent {
  type: 'tool_execution_start'
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  /** ID of the parent Task tool if this is from a subagent */
  parentToolUseId?: string
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface RuntimeToolExecutionUpdateEvent {
  type: 'tool_execution_update'
  toolUseId: string
  message?: string
  partialOutput?: string
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface RuntimeToolExecutionEndEvent {
  type: 'tool_execution_end'
  toolUseId: string
  toolName: string
  result: RuntimeToolResult
  isError?: boolean
  durationMs?: number
  /** ID of the parent Task tool if this is from a subagent */
  parentToolUseId?: string
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

/** Event emitted when SDK provides its internal session ID (for resume) */
export interface RuntimeSdkSessionIdEvent {
  type: 'sdk_session_id'
  sdkSessionId: string
}

/** Operator-visible warning or informational notice emitted by a harness. */
export interface RuntimeNoticeEvent {
  type: 'notice'
  level: 'info' | 'warn'
  message: string
}

export type UnifiedRuntimeSessionEvent =
  | RuntimeAgentStartEvent
  | RuntimeAgentEndEvent
  | RuntimeTurnStartEvent
  | RuntimeTurnEndEvent
  | RuntimeMessageStartEvent
  | RuntimeMessageUpdateEvent
  | RuntimeMessageEndEvent
  | RuntimeToolExecutionStartEvent
  | RuntimeToolExecutionUpdateEvent
  | RuntimeToolExecutionEndEvent
  | RuntimeSdkSessionIdEvent
  | RuntimeNoticeEvent
