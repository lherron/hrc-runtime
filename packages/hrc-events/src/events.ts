/**
 * Hook-derived session event types.
 *
 * This is the subset of session events that can be derived from Claude Code
 * hook payloads (PreToolUse, PostToolUse, Notification, PreCompact,
 * SubagentStart, Stop/SessionEnd/SubagentStop).
 *
 * Extracted from control-plane's battle-tested event model, narrowed to
 * hook-normalizer output only. Uses neutral naming — no CP or HRC prefix.
 */

// ============================================================================
// Content / Message primitives
// ============================================================================

/** Content block types used in messages */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

/** Tool execution result */
export interface ToolResult {
  content: ContentBlock[]
  /** Raw details from the tool response */
  details?: Record<string, unknown> | undefined
}

export interface UserPromptEvent {
  type: 'message_end'
  message: {
    role: 'user'
    content: string | ContentBlock[]
  }
  truncated?: boolean | undefined
}

export interface AgentMessageEvent {
  type: 'message_end'
  message: {
    role: 'assistant'
    content: string | ContentBlock[]
  }
  truncated?: boolean | undefined
}

// ============================================================================
// Hook-derived event interfaces
// ============================================================================

/** Emitted on PreToolUse hook */
export interface ToolExecutionStartEvent {
  type: 'tool_execution_start'
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

/** Emitted for Notification hooks with a toolUseId */
export interface ToolExecutionUpdateEvent {
  type: 'tool_execution_update'
  toolUseId: string
  message?: string | undefined
  partialOutput?: string | undefined
}

/** Emitted on PostToolUse hook */
export interface ToolExecutionEndEvent {
  type: 'tool_execution_end'
  toolUseId: string
  toolName: string
  result: ToolResult
  isError?: boolean | undefined
}

/** Emitted for Notification hooks without a toolUseId */
export interface NoticeEvent {
  type: 'notice'
  level: 'info' | 'warn' | 'error'
  message: string
  projectId?: string | undefined
  runId?: string | undefined
}

/** Emitted on PreCompact hook */
export interface ContextCompactionEvent {
  type: 'context_compaction'
  trigger?: string | undefined
  customInstructions?: string | undefined
  details?: Record<string, unknown> | undefined
}

/** Emitted on SubagentStart hook */
export interface SubagentStartEvent {
  type: 'subagent_start'
  agentId?: string | undefined
  agentType?: string | undefined
}

// ============================================================================
// Combined union
// ============================================================================

/** All event types that can be derived from Claude Code hook payloads */
export type HookDerivedEvent =
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | NoticeEvent
  | ContextCompactionEvent
  | SubagentStartEvent

/** All hook-derived event type discriminants */
export type HookDerivedEventType = HookDerivedEvent['type']

/** Type guard: is this a hook-derived event? */
export function isHookDerivedEvent(event: { type: string }): event is HookDerivedEvent {
  return [
    'tool_execution_start',
    'tool_execution_update',
    'tool_execution_end',
    'notice',
    'context_compaction',
    'subagent_start',
  ].includes(event.type)
}
