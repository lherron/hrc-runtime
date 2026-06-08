import { diffLines } from 'diff'

/** Inline content type — matches CP's Message['content'] without importing @lherron/shared */
type MessageContent =
  | Array<{ type: string; text?: string | undefined; [key: string]: unknown }>
  | string

type StructuredPatch = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type ToolOutputFormatResult = {
  output?: string | undefined
  responseObject?: Record<string, unknown> | undefined
}

/** Number of leading lines shown in a Write tool preview before truncation. */
const WRITE_PREVIEW_LINES = 10

/** Build the Modified/Added/Removed summary line for an Edit diff. */
function summarizeEdit(added: number, removed: number): string {
  if (added > 0 && removed > 0) {
    return `Added ${added} lines, removed ${removed} lines`
  }
  if (added > 0) {
    return `Added ${added} lines`
  }
  if (removed > 0) {
    return `Removed ${removed} lines`
  }
  return 'Modified'
}

function stringifyToolValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function asToolInputRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  return value as Record<string, unknown>
}

function extractTextFromContent(content: MessageContent): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function isStructuredPatch(value: unknown): value is StructuredPatch {
  if (!value || typeof value !== 'object') return false
  const patch = value as StructuredPatch
  return (
    typeof patch.oldStart === 'number' &&
    typeof patch.oldLines === 'number' &&
    typeof patch.newStart === 'number' &&
    typeof patch.newLines === 'number' &&
    Array.isArray(patch.lines)
  )
}

function extractStructuredPatches(
  toolResponse: Record<string, unknown> | undefined
): StructuredPatch[] | undefined {
  if (!toolResponse) return undefined
  const candidate = toolResponse['structuredPatch'] ?? toolResponse['structured_patch']
  if (!Array.isArray(candidate)) return undefined
  const patches = candidate.filter(isStructuredPatch)
  return patches.length > 0 ? patches : undefined
}

function buildEditOutputFromStructuredPatches(patches: StructuredPatch[]): {
  output: string
  added: number
  removed: number
} {
  const outputLines: string[] = []
  let added = 0
  let removed = 0

  for (const patch of patches) {
    let oldLine = patch.oldStart
    let newLine = patch.newStart

    for (const rawLine of patch.lines) {
      const prefix = rawLine.length > 0 ? rawLine[0] : ' '
      const content = rawLine.length > 0 ? rawLine.slice(1) : ''

      if (prefix === ' ') {
        outputLines.push(`${newLine}|c|${content}`)
        oldLine++
        newLine++
        continue
      }

      if (prefix === '+') {
        outputLines.push(`${newLine}|+|${content}`)
        added++
        newLine++
        continue
      }

      if (prefix === '-') {
        outputLines.push(`${oldLine}|-|${content}`)
        removed++
        oldLine++
      }
    }
  }

  const summary = summarizeEdit(added, removed)

  return { output: [summary, ...outputLines].join('\n'), added, removed }
}

function splitDiffValue(value: string): string[] {
  if (value.length === 0) return []
  const lines = value.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function buildEditOutputFromLineDiff(
  changes: Array<{ added?: boolean | undefined; removed?: boolean | undefined; value: string }>
): { output: string; added: number; removed: number } {
  const outputLines: string[] = []
  let added = 0
  let removed = 0
  let oldLine = 1
  let newLine = 1

  for (const change of changes) {
    const lines = splitDiffValue(change.value)
    for (const line of lines) {
      if (change.added) {
        outputLines.push(`${newLine}|+|${line}`)
        added++
        newLine++
        continue
      }

      if (change.removed) {
        outputLines.push(`${oldLine}|-|${line}`)
        removed++
        oldLine++
        continue
      }

      outputLines.push(`${newLine}|c|${line}`)
      oldLine++
      newLine++
    }
  }

  const summary = summarizeEdit(added, removed)

  return { output: [summary, ...outputLines].join('\n'), added, removed }
}

/**
 * Coerce an arbitrary tool response into a base output string and (when the
 * response is object-shaped) the structured response object. This is the
 * tool-agnostic first pass; per-tool renderers may override the output below.
 */
function coerceResponseToOutput(toolResponse: unknown): {
  output: string | undefined
  responseObject: Record<string, unknown> | undefined
} {
  if (typeof toolResponse === 'string') {
    return { output: toolResponse, responseObject: undefined }
  }
  if (Array.isArray(toolResponse)) {
    return {
      output: extractTextFromContent(toolResponse as MessageContent),
      responseObject: { content: toolResponse },
    }
  }
  if (toolResponse && typeof toolResponse === 'object') {
    const resp = toolResponse as Record<string, unknown>
    const stdout = resp['stdout']
    const stderr = resp['stderr']
    let output: string | undefined
    if (typeof stdout === 'string') {
      output = stdout
    } else if (typeof stderr === 'string') {
      output = stderr
    }
    const respContent = resp['content']
    if (output === undefined && Array.isArray(respContent)) {
      output = extractTextFromContent(respContent as MessageContent)
    }
    return { output, responseObject: resp }
  }
  return { output: undefined, responseObject: undefined }
}

/**
 * Per-tool rich renderers. Each receives the coerced tool-input record and the
 * coerced response object, and returns an override output string, or undefined
 * to fall through to the coerced/base output.
 */
type ToolRenderer = (ctx: {
  toolInputRecord: Record<string, unknown>
  responseObject: Record<string, unknown> | undefined
}) => string | undefined

const toolRenderers: Record<string, ToolRenderer> = {
  Write: ({ toolInputRecord }) => {
    const filePath =
      typeof toolInputRecord['file_path'] === 'string' ? toolInputRecord['file_path'] : ''
    const content =
      typeof toolInputRecord['content'] === 'string' ? toolInputRecord['content'] : ''
    if (!filePath || !content) return undefined

    const fileName = filePath.split('/').pop() || filePath
    const lines = content.split('\n')
    const lineCount = lines.length
    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    const langMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      rb: 'ruby',
      go: 'go',
      rs: 'rust',
      java: 'java',
      md: 'markdown',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      sh: 'bash',
      bash: 'bash',
      zsh: 'bash',
      css: 'css',
      html: 'html',
    }
    const lang = langMap[ext] || ext
    const previewLines = lines.slice(0, WRITE_PREVIEW_LINES)
    const preview = previewLines.join('\n')
    const truncated =
      lines.length > WRITE_PREVIEW_LINES
        ? `\n... +${lines.length - WRITE_PREVIEW_LINES} more lines`
        : ''
    return `Created ${fileName} with ${lineCount} lines:\n\n${lang}\n${preview}${truncated}`
  },

  Edit: ({ toolInputRecord, responseObject }) => {
    const structuredPatches = extractStructuredPatches(responseObject)
    if (structuredPatches && structuredPatches.length > 0) {
      return buildEditOutputFromStructuredPatches(structuredPatches).output
    }
    const oldString =
      typeof toolInputRecord['old_string'] === 'string' ? toolInputRecord['old_string'] : ''
    const newString =
      typeof toolInputRecord['new_string'] === 'string' ? toolInputRecord['new_string'] : ''
    if (oldString || newString) {
      const changes = diffLines(oldString, newString)
      return buildEditOutputFromLineDiff(changes).output
    }
    return undefined
  },
}

export function formatToolOutput(options: {
  toolName: string
  toolInput: unknown
  toolResponse: unknown
  isError: boolean
}): ToolOutputFormatResult {
  const { toolName, toolInput, toolResponse, isError } = options
  const toolInputRecord = asToolInputRecord(toolInput)

  const coerced = coerceResponseToOutput(toolResponse)
  let toolOutput = coerced.output
  const toolResponseObject = coerced.responseObject

  if (!isError && toolInputRecord) {
    const renderer = toolRenderers[toolName]
    if (renderer) {
      const rendered = renderer({ toolInputRecord, responseObject: toolResponseObject })
      if (rendered !== undefined) {
        toolOutput = rendered
      }
    }
  }

  if (toolOutput === undefined && toolResponse !== undefined) {
    toolOutput = stringifyToolValue(toolResponse)
  }

  return { output: toolOutput, responseObject: toolResponseObject }
}
