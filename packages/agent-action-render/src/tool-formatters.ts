import { MAX_LINE_CHARS, MAX_PREVIEW_CHARS, truncateText } from './budgets.js'

export const TOOL_EMOJI: Record<string, string> = {
  Bash: '💻',
  exec_command: '💻',
  Read: '📖',
  Write: '✍️',
  Edit: '🔧',
  apply_patch: '🔧',
  Grep: '🔎',
  Glob: '📁',
  Task: '🤖',
  WebFetch: '📄',
  WebSearch: '🔍',
  TodoWrite: '📋',
  NotebookEdit: '📓',
}

export const DEFAULT_TOOL_EMOJI = '⚙️'

export const PRIMARY_ARG_KEY: Record<string, string> = {
  Bash: 'command',
  exec_command: 'cmd',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  apply_patch: 'patch',
  Grep: 'pattern',
  Glob: 'pattern',
  Task: 'description',
  WebFetch: 'url',
  WebSearch: 'query',
  NotebookEdit: 'notebook_path',
}

export function extractToolPreview(
  toolName: string,
  input: Record<string, unknown> | undefined,
  summary: string
): string {
  if (!input) {
    return summary.replace(/^`|`$/g, '')
  }

  if (toolName === 'TodoWrite') {
    const todos = input['todos']
    if (Array.isArray(todos)) {
      return `${todos.length} todo${todos.length === 1 ? '' : 's'}`
    }
    return summary.replace(/^`|`$/g, '')
  }

  const argKey = PRIMARY_ARG_KEY[toolName]
  if (argKey) {
    const value = input[argKey]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }

  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }

  return summary.replace(/^`|`$/g, '')
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
  const emoji = failed ? '❌' : getToolEmoji(toolName)
  const prefix = `${emoji} ${toolName}: "`
  const suffix = '"'
  const previewBudget = Math.min(MAX_PREVIEW_CHARS, MAX_LINE_CHARS - prefix.length - suffix.length)

  const preview = truncateText(extractToolPreview(toolName, input, summary), previewBudget)
  const line = `${prefix}${preview}${suffix}`
  return line.length > MAX_LINE_CHARS ? truncateText(line, MAX_LINE_CHARS) : line
}
