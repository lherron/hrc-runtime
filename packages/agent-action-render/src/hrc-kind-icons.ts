import { getToolEmoji } from './tool-formatters.js'

export const DEFAULT_HRC_ICON = '⚙️'

export function getHrcEventIcon(
  eventKind: string,
  options: {
    toolName?: string | undefined
    level?: string | undefined
    failed?: boolean | undefined
  } = {}
): string {
  if (options.failed === true) return '❌'
  if (eventKind === 'tool_execution_start' || eventKind === 'tool_execution_end') {
    return options.toolName !== undefined ? getToolEmoji(options.toolName) : DEFAULT_HRC_ICON
  }
  if (eventKind === 'codex.tool_result') {
    return options.toolName !== undefined ? getToolEmoji(options.toolName) : DEFAULT_HRC_ICON
  }
  if (eventKind === 'codex.tool_decision') return '⚖️'
  if (eventKind === 'codex.user_prompt' || eventKind === 'turn.user_prompt') return '💬'
  if (eventKind === 'message_end') return '✉️'
  if (eventKind === 'sdk.message' || eventKind.startsWith('message_')) return '🤖'
  if (eventKind === 'hook.ingested') return '🪝'
  if (eventKind === 'notice') {
    if (options.level === 'warn') return '⚠️'
    if (options.level === 'error') return '❌'
    return 'ℹ️'
  }
  if (eventKind === 'runtime.dead') return '💀'
  return DEFAULT_HRC_ICON
}
