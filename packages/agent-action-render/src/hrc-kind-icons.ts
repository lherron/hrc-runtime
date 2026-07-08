import { FALLBACK_ICON } from './budgets.js'
import { NOTICE_ICON } from './notice-formatters.js'
import { resolveToolPresenter } from './tool-presenters.js'

export const DEFAULT_HRC_ICON = FALLBACK_ICON

/** Event kinds whose icon derives from the tool name (with a default fallback). */
const TOOL_KEYED_EVENT_KINDS = new Set([
  'tool_execution_start',
  'tool_execution_end',
  'codex.tool_result',
])

/** Exact-match eventKind -> icon lookup for the data-driven cases. */
const ICON_BY_EVENT_KIND: Record<string, string> = {
  'codex.tool_decision': '⚖️',
  'codex.user_prompt': '💬',
  'turn.user_prompt': '💬',
  message_end: '✉️',
  'sdk.message': '🤖',
  'hook.ingested': '🪝',
  'runtime.dead': '💀',
}

export function getHrcEventIcon(
  eventKind: string,
  options: {
    toolName?: string | undefined
    level?: string | undefined
    failed?: boolean | undefined
  } = {}
): string {
  if (options.failed === true) return '❌'
  if (TOOL_KEYED_EVENT_KINDS.has(eventKind)) {
    return options.toolName !== undefined
      ? resolveToolPresenter(options.toolName, {}).emoji
      : DEFAULT_HRC_ICON
  }
  if (eventKind === 'notice') {
    return NOTICE_ICON[options.level ?? 'info'] ?? DEFAULT_HRC_ICON
  }
  const exact = ICON_BY_EVENT_KIND[eventKind]
  if (exact !== undefined) return exact
  if (eventKind.startsWith('message_')) return '🤖'
  return DEFAULT_HRC_ICON
}
