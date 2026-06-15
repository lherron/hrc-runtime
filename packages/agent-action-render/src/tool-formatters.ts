import { FALLBACK_ICON, MAX_LINE_CHARS, MAX_PREVIEW_CHARS, truncateText } from './budgets.js'
import { PRESENTERS, getToolDisplayName, resolveToolPresenter } from './tool-presenters.js'

/**
 * @deprecated Use the ToolPresenter registry instead.
 */
export const TOOL_EMOJI: Record<string, string> = Object.fromEntries(
  PRESENTERS.flatMap((presenter) =>
    typeof presenter.match === 'string' ? [[presenter.match, presenter.emoji]] : []
  )
)

export const DEFAULT_TOOL_EMOJI = FALLBACK_ICON

/**
 * @deprecated Use the ToolPresenter registry instead.
 */
export const PRIMARY_ARG_KEY: Record<string, string> = Object.fromEntries(
  PRESENTERS.flatMap((presenter) =>
    typeof presenter.match === 'string' && presenter.primaryArgKey !== undefined
      ? [[presenter.match, presenter.primaryArgKey]]
      : []
  )
)

function summaryPreview(summary: string): string {
  return summary.replace(/^`|`$/g, '')
}

function firstStringValue(input: Record<string, unknown>): string | undefined {
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return undefined
}

export function extractToolPreview(
  toolName: string,
  input: Record<string, unknown> | undefined,
  summary: string
): string {
  if (!input) {
    return summaryPreview(summary)
  }

  const presenter = resolveToolPresenter(toolName, input)
  const preview = presenter.preview?.(input)
  if (preview !== undefined) {
    return preview
  }

  return firstStringValue(input) ?? summaryPreview(summary)
}

export function getToolEmoji(toolName: string): string {
  return TOOL_EMOJI[toolName] ?? DEFAULT_TOOL_EMOJI
}

export function formatToolLine(
  toolName: string,
  input: Record<string, unknown> | undefined,
  summary: string,
  failed: boolean
): string {
  const presenter = resolveToolPresenter(toolName, input ?? {})
  const displayName = getToolDisplayName(presenter, toolName, input ?? {})
  const emoji = failed ? '❌' : presenter.emoji
  const prefix = `${emoji} ${displayName}: `
  const previewBudget = Math.min(MAX_PREVIEW_CHARS, MAX_LINE_CHARS - prefix.length)

  const preview = truncateText(extractToolPreview(toolName, input, summary), previewBudget)
  const line = `${prefix}${preview}`
  return line.length > MAX_LINE_CHARS ? truncateText(line, MAX_LINE_CHARS) : line
}
