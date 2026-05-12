export interface ToolPresenter {
  match: string | RegExp | ((toolName: string, input: Record<string, unknown>) => boolean)
  displayName: string | ((toolName: string, input: Record<string, unknown>) => string)
  emoji: string
  preview?: (input: Record<string, unknown>) => string | undefined
  primaryArgKey?: string | undefined
}

function commandInput(input: Record<string, unknown>): string | undefined {
  const command = input['command']
  if (typeof command === 'string') return command

  const cmd = input['cmd']
  return typeof cmd === 'string' ? cmd : undefined
}

function primaryString(key: string): (input: Record<string, unknown>) => string | undefined {
  return (input) => {
    const value = input[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
}

function todosPreview(input: Record<string, unknown>): string | undefined {
  const todos = input['todos']
  if (!Array.isArray(todos)) return undefined

  return `${todos.length} todo${todos.length === 1 ? '' : 's'}`
}

export function unwrapShell(cmd: string): string | undefined {
  const match = cmd.match(/^\s*(?:\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+/)
  if (!match) return undefined

  const rest = cmd.slice(match[0].length)
  const first = rest[0]
  if (first !== "'" && first !== '"') return undefined

  const lastQuoteIndex = rest.lastIndexOf(first)
  if (lastQuoteIndex <= 0) return undefined

  const trailing = rest.slice(lastQuoteIndex + 1)
  if (trailing.trim().length > 0) return undefined

  const inner = rest.slice(1, lastQuoteIndex)
  if (inner.includes(first)) return undefined

  return inner
}

export function looksLikeShell(cmd: string): boolean {
  if (unwrapShell(cmd) !== undefined) return true
  return /(?<!\\)(?:[|&;<>`~*]|\$\()/.test(cmd)
}

function isShellLikeExecTool(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== 'command_execution' && toolName !== 'exec_command') return false

  const command = commandInput(input)
  return typeof command === 'string' && looksLikeShell(command)
}

export const PRESENTERS: ToolPresenter[] = [
  {
    match: isShellLikeExecTool,
    displayName: 'shell',
    emoji: '💻',
    preview: (input) => {
      const command = commandInput(input)
      if (command === undefined) return undefined
      return unwrapShell(command) ?? command
    },
  },
  {
    match: 'Bash',
    displayName: 'shell',
    emoji: '💻',
    primaryArgKey: 'command',
    preview: primaryString('command'),
  },
  {
    match: 'exec_command',
    displayName: 'exec_command',
    emoji: '💻',
    primaryArgKey: 'cmd',
    preview: primaryString('cmd'),
  },
  {
    match: 'Read',
    displayName: 'Read',
    emoji: '📖',
    primaryArgKey: 'file_path',
    preview: primaryString('file_path'),
  },
  {
    match: 'Write',
    displayName: 'Write',
    emoji: '✍️',
    primaryArgKey: 'file_path',
    preview: primaryString('file_path'),
  },
  {
    match: 'Edit',
    displayName: 'Edit',
    emoji: '🔧',
    primaryArgKey: 'file_path',
    preview: primaryString('file_path'),
  },
  {
    match: 'apply_patch',
    displayName: 'apply_patch',
    emoji: '🔧',
    primaryArgKey: 'patch',
    preview: primaryString('patch'),
  },
  {
    match: 'Grep',
    displayName: 'Grep',
    emoji: '🔎',
    primaryArgKey: 'pattern',
    preview: primaryString('pattern'),
  },
  {
    match: 'Glob',
    displayName: 'Glob',
    emoji: '📁',
    primaryArgKey: 'pattern',
    preview: primaryString('pattern'),
  },
  {
    match: 'Task',
    displayName: 'Task',
    emoji: '🤖',
    primaryArgKey: 'description',
    preview: primaryString('description'),
  },
  {
    match: 'WebFetch',
    displayName: 'WebFetch',
    emoji: '📄',
    primaryArgKey: 'url',
    preview: primaryString('url'),
  },
  {
    match: 'WebSearch',
    displayName: 'WebSearch',
    emoji: '🔍',
    primaryArgKey: 'query',
    preview: primaryString('query'),
  },
  {
    match: 'TodoWrite',
    displayName: 'TodoWrite',
    emoji: '📋',
    preview: todosPreview,
  },
  {
    match: 'NotebookEdit',
    displayName: 'NotebookEdit',
    emoji: '📓',
    primaryArgKey: 'notebook_path',
    preview: primaryString('notebook_path'),
  },
  {
    match: /^mcp:/,
    displayName: (toolName) => toolName,
    emoji: '⚙️',
  },
]

export const DEFAULT_PRESENTER: ToolPresenter = {
  match: () => true,
  displayName: (toolName) => toolName,
  emoji: '⚙️',
}

function matchesPresenter(
  match: ToolPresenter['match'],
  toolName: string,
  input: Record<string, unknown>
): boolean {
  if (typeof match === 'string') return match === toolName
  if (match instanceof RegExp) return match.test(toolName)
  return match(toolName, input)
}

export function resolveToolPresenter(
  toolName: string,
  input: Record<string, unknown> = {}
): ToolPresenter {
  for (const presenter of PRESENTERS) {
    if (matchesPresenter(presenter.match, toolName, input)) return presenter
  }

  return DEFAULT_PRESENTER
}

export function getToolDisplayName(
  presenter: ToolPresenter,
  toolName: string,
  input: Record<string, unknown>
): string {
  return typeof presenter.displayName === 'function'
    ? presenter.displayName(toolName, input)
    : presenter.displayName
}
