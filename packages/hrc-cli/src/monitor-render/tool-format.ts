import type { HrcLifecycleEvent } from 'hrc-core'
import { booleanField, numberField, stringField } from '../monitor-fields.js'
import {
  type ParsedToolResult,
  type PendingToolCall,
  asRecord,
  compactPath,
  countLines,
  millisToSeconds,
  parseJsonObject,
  renderPrettyValue,
  truncateText,
  wrapBody,
} from './shared.js'

export function toolCallFromEvent(event: HrcLifecycleEvent): PendingToolCall {
  const payload = asRecord(event.payload)
  return {
    event,
    toolUseId:
      stringField(payload ?? {}, 'toolUseId') ?? stringField(payload ?? {}, 'tool_use_id') ?? '',
    toolName:
      stringField(payload ?? {}, 'toolName') ?? stringField(payload ?? {}, 'tool_name') ?? 'tool',
    input: asRecord(payload?.['input']) ?? {},
  }
}

export function isMatchingToolResult(event: HrcLifecycleEvent, pending: PendingToolCall): boolean {
  if (event.eventKind !== 'turn.tool_result') return false
  const payload = asRecord(event.payload)
  const toolUseId =
    stringField(payload ?? {}, 'toolUseId') ?? stringField(payload ?? {}, 'tool_use_id') ?? ''
  return toolUseId.length > 0 && toolUseId === pending.toolUseId
}

export function formatToolTitle(toolName: string, input: Record<string, unknown>): string {
  const displayName = formatToolDisplayName(toolName)
  const summary = formatToolSummary(toolName, input)
  return summary ? `${displayName} - ${summary}` : displayName
}

export function formatToolDisplayName(toolName: string): string {
  if (toolName === 'exec_command' || toolName === 'command_execution') return 'Bash'
  if (toolName === 'file_change') return 'FileChange'
  if (toolName === 'web_search') return 'WebSearch'
  if (toolName === 'image_view') return 'ImageView'
  return toolName
}

function formatToolSummary(toolName: string, input: Record<string, unknown>): string | undefined {
  const description = stringField(input, 'description')
  if (description) return truncateText(description, 80)

  if (isShellTool(toolName)) {
    const cwd = stringField(input, 'cwd') ?? stringField(input, 'workdir')
    return cwd ? `cwd ${compactPath(cwd)}` : undefined
  }

  if (toolName === 'Read') {
    const path = stringField(input, 'file_path') ?? stringField(input, 'path')
    return path ? compactPath(path) : undefined
  }

  if (toolName === 'Write' || toolName === 'Edit') {
    const path = stringField(input, 'file_path') ?? stringField(input, 'path')
    return path ? compactPath(path) : undefined
  }

  if (toolName === 'TaskUpdate') {
    const taskId = stringField(input, 'taskId') ?? stringField(input, 'task_id')
    const status = stringField(input, 'status')
    return (
      [taskId, status].filter((part): part is string => part !== undefined).join(' ') || undefined
    )
  }

  if (toolName === 'file_change') {
    const changes = input['changes']
    return Array.isArray(changes)
      ? `${changes.length} change${changes.length === 1 ? '' : 's'}`
      : undefined
  }

  if (toolName.startsWith('mcp:')) {
    const tool = stringField(input, 'tool')
    return tool ? truncateText(tool, 80) : undefined
  }

  if (toolName === 'web_search' || toolName === 'WebSearch') {
    const query = stringField(input, 'query')
    return query ? truncateText(query, 80) : undefined
  }

  if (toolName === 'image_view') {
    const path = stringField(input, 'path')
    return path ? compactPath(path) : undefined
  }

  return undefined
}

export function formatToolCallBody(toolName: string, input: Record<string, unknown>): string[] {
  if (isShellTool(toolName)) return formatShellCommand(input)
  if (toolName === 'Read') return formatReadInput(input)
  if (toolName === 'Write') return formatWriteInput(input)
  if (toolName === 'Edit') return formatEditInput(input)
  if (toolName === 'TaskUpdate') return formatTaskUpdateInput(input)
  if (toolName === 'file_change') return formatFileChangeInput(input)
  return formatGenericToolInput(input)
}

function isShellTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'exec_command' || toolName === 'command_execution'
}

function formatShellCommand(input: Record<string, unknown>): string[] {
  const raw = input['command'] ?? input['cmd']
  if (Array.isArray(raw)) {
    const command = raw.map((part) => String(part))
    if (command[0] === 'bash' && command[1] === '-lc' && command[2]) return [`$ ${command[2]}`]
    return [`$ ${command.join(' ')}`]
  }
  if (typeof raw === 'string') return [`$ ${raw}`]
  return formatGenericToolInput(input)
}

function formatReadInput(input: Record<string, unknown>): string[] {
  const out: string[] = []
  const path = stringField(input, 'file_path') ?? stringField(input, 'path')
  if (path) out.push(compactPath(path))
  const offset = numberField(input, 'offset')
  const limit = numberField(input, 'limit')
  const range = [
    offset !== undefined ? `offset ${offset}` : undefined,
    limit !== undefined ? `limit ${limit}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ')
  if (range) out.push(range)
  return out.length > 0 ? out : formatGenericToolInput(input)
}

function formatWriteInput(input: Record<string, unknown>): string[] {
  const out: string[] = []
  const path = stringField(input, 'file_path') ?? stringField(input, 'path')
  if (path) out.push(compactPath(path))
  const content = stringField(input, 'content')
  if (content !== undefined)
    out.push(`write ${countLines(content)} line${countLines(content) === 1 ? '' : 's'}`)
  return out.length > 0 ? out : formatGenericToolInput(input)
}

function formatEditInput(input: Record<string, unknown>): string[] {
  const out: string[] = []
  const path = stringField(input, 'file_path') ?? stringField(input, 'path')
  if (path) out.push(compactPath(path))
  const oldString = stringField(input, 'old_string')
  const newString = stringField(input, 'new_string')
  if (oldString !== undefined || newString !== undefined) {
    out.push(booleanField(input, 'replace_all') ? 'replace all matches' : 'replace one block')
    if (oldString !== undefined)
      out.push(`old: ${countLines(oldString)} line${countLines(oldString) === 1 ? '' : 's'}`)
    if (newString !== undefined)
      out.push(`new: ${countLines(newString)} line${countLines(newString) === 1 ? '' : 's'}`)
  }
  return out.length > 0 ? out : formatGenericToolInput(input)
}

function formatTaskUpdateInput(input: Record<string, unknown>): string[] {
  const taskId = stringField(input, 'taskId') ?? stringField(input, 'task_id')
  const status = stringField(input, 'status')
  const out = [
    taskId ? `task ${taskId}` : undefined,
    status ? `status ${status}` : undefined,
  ].filter((part): part is string => part !== undefined)
  return out.length > 0 ? out : formatGenericToolInput(input)
}

function formatFileChangeInput(input: Record<string, unknown>): string[] {
  const changes = input['changes']
  if (!Array.isArray(changes)) return formatGenericToolInput(input)
  return changes.map((change, index) => {
    const record = asRecord(change)
    const path = stringField(record ?? {}, 'path') ?? stringField(record ?? {}, 'file')
    const type = stringField(record ?? {}, 'type') ?? stringField(record ?? {}, 'status')
    const label = [type, path ? compactPath(path) : undefined]
      .filter((part): part is string => part !== undefined)
      .join(' ')
    return label || `change ${index + 1}`
  })
}

function formatGenericToolInput(input: Record<string, unknown>): string[] {
  return Object.keys(input).length > 0 ? [JSON.stringify(input)] : []
}

export function formatToolResultLabel(result: ParsedToolResult): string {
  if (result.interrupted) return 'interrupted'
  if (result.exitCode !== undefined) return result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`
  if (result.isError === true) return 'error'
  if (result.isError === false) return 'ok'
  return 'result'
}

export function parseToolResult(payload: unknown): ParsedToolResult {
  const payloadRecord = asRecord(payload)
  const resultRecord = asRecord(payloadRecord?.['result'])
  const details = asRecord(resultRecord?.['details'])
  const isError = booleanField(payloadRecord ?? {}, 'isError')
  const stdout = stringField(details ?? {}, 'stdout')
  const stderr = stringField(details ?? {}, 'stderr')
  const interrupted = booleanField(details ?? {}, 'interrupted')
  const detailsExitCode =
    numberField(details ?? {}, 'exitCode') ?? numberField(details ?? {}, 'exit_code')
  const detailsDuration =
    numberField(details ?? {}, 'durationSeconds') ??
    numberField(details ?? {}, 'duration_seconds') ??
    millisToSeconds(
      numberField(details ?? {}, 'durationMs') ?? numberField(payloadRecord ?? {}, 'durationMs')
    )
  if (stdout !== undefined || stderr !== undefined || interrupted !== undefined) {
    return {
      output: [stdout, stderr].filter((part): part is string => Boolean(part)).join('\n'),
      ...(stdout !== undefined ? { stdout } : {}),
      ...(stderr !== undefined ? { stderr } : {}),
      ...(interrupted !== undefined ? { interrupted } : {}),
      ...(detailsExitCode !== undefined ? { exitCode: detailsExitCode } : {}),
      ...(detailsDuration !== undefined ? { durationSeconds: detailsDuration } : {}),
      ...(isError !== undefined ? { isError } : {}),
    }
  }

  const text = extractToolResultText(payloadRecord)
  const json = parseJsonObject(text)
  const metadata = asRecord(json?.['metadata'])
  if (json && typeof json['output'] === 'string') {
    return {
      output: json['output'],
      ...(typeof metadata?.['exit_code'] === 'number' ? { exitCode: metadata['exit_code'] } : {}),
      ...(typeof metadata?.['duration_seconds'] === 'number'
        ? { durationSeconds: metadata['duration_seconds'] }
        : {}),
      ...(isError !== undefined ? { isError } : {}),
    }
  }
  const codex = parseCodexExecOutput(text)
  if (codex) return { ...codex, ...(isError !== undefined ? { isError } : {}) }
  return { output: text, ...(isError !== undefined ? { isError } : {}) }
}

function parseCodexExecOutput(text: string): ParsedToolResult | undefined {
  const marker = '\nOutput:\n'
  const idx = text.indexOf(marker)
  if (idx === -1) return undefined
  const preamble = text.slice(0, idx)
  const exitMatch = preamble.match(/Process exited with code (\d+)/)
  const durationMatch = preamble.match(/Wall time: ([0-9.]+) seconds/)
  return {
    output: text.slice(idx + marker.length),
    ...(exitMatch?.[1] ? { exitCode: Number(exitMatch[1]) } : {}),
    ...(durationMatch?.[1] ? { durationSeconds: Number(durationMatch[1]) } : {}),
  }
}

export function formatToolOutput(text: string, indent: string): string[] {
  const json = parseJsonObject(text.trim())
  if (json) return renderPrettyValue(json, indent)
  return wrapBody(text, indent)
}

function extractToolResultText(payload: Record<string, unknown> | null | undefined): string {
  const result = asRecord(payload?.['result'])
  const content = result?.['content']
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const record = asRecord(item)
        return typeof record?.['text'] === 'string' ? record['text'] : ''
      })
      .join('')
  }
  if (typeof payload?.['message'] === 'string') return payload['message']
  if (typeof payload?.['partialOutput'] === 'string') return payload['partialOutput']
  return typeof payload?.['result'] === 'string' ? payload['result'] : JSON.stringify(payload ?? {})
}
