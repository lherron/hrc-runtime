/**
 * Pure normalizer: Claude Code hook payload → typed HookDerivedEvent[].
 *
 * Extracted from control-plane's HookEventHandler. No side effects, no DI deps.
 * The caller (hrc-server) owns persistence, runtime status, and completion signals.
 */

import type { HookDerivedEvent } from './events.js'
import { formatToolOutput } from './tool-output-formatter.js'

// ============================================================================
// Result types
// ============================================================================

/** Human-readable progress hint for UI/status displays */
export type ProgressHint = {
  toolUseId?: string | undefined
  message: string
}

/** Result of normalizing a single Claude Code hook payload */
export type NormalizeHookResult = {
  /** Typed events derived from this hook (may be empty for unrecognized hooks) */
  events: HookDerivedEvent[]
  /** Optional progress hint for UI status lines */
  progress?: ProgressHint | undefined
  /** True when the hook signals run completion (Stop/SessionEnd/SubagentStop) */
  isCompletion: boolean
  /** The raw hook_event_name for caller routing */
  hookName: string
}

// ============================================================================
// Helpers (from CP's hook-event-handler.ts)
// ============================================================================

function asToolInputRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  return value as Record<string, unknown>
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

/** Generate a human-readable one-liner for a tool invocation */
export function formatToolSummary(
  toolName: string,
  toolInput: Record<string, unknown> | undefined
): string {
  if (!toolInput) return toolName

  const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\u2026` : s)

  switch (toolName) {
    case 'Bash': {
      const command = getString(toolInput, 'command')
      if (command) return `\`${truncate(command, 80)}\``
      break
    }
    case 'Read': {
      const filePath = getString(toolInput, 'file_path')
      if (filePath) return `Read \`${truncate(filePath, 60)}\``
      break
    }
    case 'Write': {
      const filePath = getString(toolInput, 'file_path')
      if (filePath) return `Write \`${truncate(filePath, 60)}\``
      break
    }
    case 'Edit': {
      const filePath = getString(toolInput, 'file_path')
      if (filePath) {
        const fileName = filePath.split('/').pop() ?? filePath
        return `${truncate(fileName, 60)}`
      }
      break
    }
    case 'Glob': {
      const pattern = getString(toolInput, 'pattern')
      if (pattern) return `Glob \`${truncate(pattern, 60)}\``
      break
    }
    case 'Grep': {
      const pattern = getString(toolInput, 'pattern')
      if (pattern) return `Grep \`${truncate(pattern, 60)}\``
      break
    }
    case 'Task': {
      const description = getString(toolInput, 'description')
      if (description) return `Task: ${truncate(description, 60)}`
      break
    }
    case 'WebFetch': {
      const url = getString(toolInput, 'url')
      if (url) return `Fetch \`${truncate(url, 60)}\``
      break
    }
    case 'WebSearch': {
      const query = getString(toolInput, 'query')
      if (query) return `Search: ${truncate(query, 60)}`
      break
    }
  }

  return toolName
}

/** Strip CP/harness-internal fields from hook payload for context_compaction details */
function compactHookDetails(hook: Record<string, unknown>): Record<string, unknown> | undefined {
  const details: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(hook)) {
    if (
      key === 'hook_event_name' ||
      key === 'cp_run_id' ||
      key === 'session_id' ||
      key === 'transcript_path' ||
      key === 'permission_mode' ||
      key === 'cwd' ||
      key === 'trigger' ||
      key === 'custom_instructions'
    ) {
      continue
    }
    details[key] = value
  }
  return Object.keys(details).length > 0 ? details : undefined
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Unwrap the hook payload if it arrives in the HRC envelope shape:
 * `{ kind, hookEvent: { hook_event_name, tool_use_id, ... } }`.
 * Returns the inner `hookEvent` if present, otherwise the original object.
 */
function unwrapHookPayload(hook: Record<string, unknown>): Record<string, unknown> {
  // Direct shape: { hook_event_name: 'PreToolUse', ... }
  if (typeof hook['hook_event_name'] === 'string') return hook

  // Wrapped shape: { kind: 'turn.started', hookEvent: { hook_event_name: '...', ... } }
  const hookEvent = hook['hookEvent']
  if (hookEvent && typeof hookEvent === 'object' && !Array.isArray(hookEvent)) {
    const inner = hookEvent as Record<string, unknown>
    if (typeof inner['hook_event_name'] === 'string') return inner
  }

  return hook
}

/**
 * Normalize a raw Claude Code hook payload into typed events.
 *
 * Pure function — no side effects. The caller decides what to do with the
 * result (persist, emit, update runtime status, handle completion, etc.).
 *
 * Handles both direct payloads (`{ hook_event_name, ... }`) and the HRC
 * wrapped shape (`{ kind, hookEvent: { hook_event_name, ... } }`).
 *
 * @param hook - Raw hook payload as parsed JSON
 * @returns Normalized result with typed events, progress hint, and completion flag
 */
export function normalizeClaudeHook(hook: Record<string, unknown>): NormalizeHookResult {
  const unwrapped = unwrapHookPayload(hook)
  const hookName = getString(unwrapped, 'hook_event_name') ?? 'unknown'
  const toolUseId = getString(unwrapped, 'tool_use_id')
  const toolName = getString(unwrapped, 'tool_name')

  if (hookName === 'PreToolUse') {
    const name = toolName ?? 'tool'
    const rawToolInput = unwrapped['tool_input']
    const toolInput = asToolInputRecord(rawToolInput)
    const summary = formatToolSummary(name, toolInput)

    const events: HookDerivedEvent[] = toolUseId
      ? [{ type: 'tool_execution_start', toolUseId, toolName: name, input: toolInput ?? {} }]
      : []

    return {
      events,
      progress: { toolUseId, message: summary },
      isCompletion: false,
      hookName,
    }
  }

  if (hookName === 'PostToolUse') {
    const name = toolName ?? 'tool'
    const rawToolInput = unwrapped['tool_input']
    const toolInput = asToolInputRecord(rawToolInput)
    const isError = unwrapped['is_error'] === true
    const { output, responseObject } = formatToolOutput({
      toolName: name,
      toolInput: rawToolInput,
      toolResponse: unwrapped['tool_response'],
      isError,
    })
    const summary = formatToolSummary(name, toolInput)

    const events: HookDerivedEvent[] = toolUseId
      ? [
          {
            type: 'tool_execution_end',
            toolUseId,
            toolName: name,
            result: {
              content: [{ type: 'text' as const, text: output ?? '' }],
              details: responseObject,
            },
            isError,
          },
        ]
      : []

    return {
      events,
      progress: { toolUseId, message: `\u2713 ${summary}` },
      isCompletion: false,
      hookName,
    }
  }

  if (hookName === 'Notification') {
    const message = getString(unwrapped, 'message') ?? 'notification'

    const events: HookDerivedEvent[] = toolUseId
      ? [{ type: 'tool_execution_update', toolUseId, message }]
      : [{ type: 'notice', level: 'info' as const, message }]

    return {
      events,
      progress: { toolUseId, message },
      isCompletion: false,
      hookName,
    }
  }

  if (hookName === 'PreCompact') {
    const trigger = getString(unwrapped, 'trigger')
    const customInstructions = getString(unwrapped, 'custom_instructions')
    const triggerLabel = trigger ? ` (${trigger})` : ''

    return {
      events: [
        {
          type: 'context_compaction',
          ...(trigger !== undefined ? { trigger } : {}),
          ...(customInstructions !== undefined ? { customInstructions } : {}),
          details: compactHookDetails(unwrapped),
        },
      ],
      progress: { message: `Context compaction${triggerLabel}` },
      isCompletion: false,
      hookName,
    }
  }

  if (hookName === 'SubagentStart') {
    const agentId = getString(unwrapped, 'agent_id')
    const agentType = getString(unwrapped, 'agent_type')
    const label =
      (agentType ?? agentId)
        ? `${agentType ?? 'subagent'}${agentId ? ` (${agentId})` : ''}`
        : 'subagent'

    return {
      events: [
        {
          type: 'subagent_start',
          ...(agentId !== undefined ? { agentId } : {}),
          ...(agentType !== undefined ? { agentType } : {}),
        },
      ],
      progress: { message: `Subagent start: ${label}` },
      isCompletion: false,
      hookName,
    }
  }

  if (hookName === 'Stop' || hookName === 'SessionEnd' || hookName === 'SubagentStop') {
    return {
      events: [],
      isCompletion: true,
      hookName,
    }
  }

  // Unrecognized hook — no events, no progress
  return { events: [], isCompletion: false, hookName }
}
