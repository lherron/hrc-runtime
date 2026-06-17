import { readFile } from 'node:fs/promises'

import { compactText, hashPayload, isRecord, safeJsonParse, textFromContent } from './json.js'
import {
  CAPTURE_OBSERVATION_SCHEMA,
  CAPTURE_VERIFIER_SCHEMA,
  type CaptureObservation,
  type CaptureProvider,
  type ParseProviderTranscriptInput,
  type ParsedProviderTranscript,
} from './types.js'

type AdapterResult = {
  event?: CaptureObservation | undefined
  warning?: string | undefined
}

export async function parseProviderTranscript(
  input: ParseProviderTranscriptInput
): Promise<ParsedProviderTranscript> {
  const raw = await readFile(input.path, 'utf8')
  const warnings: string[] = []
  const observations: CaptureObservation[] = []
  let provider: CaptureProvider = 'unknown'
  const lines = raw.split(/\r?\n/)
  let lineCount = 0
  const ignoredCodexCallIds = new Set<string>()

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]
    if (line === undefined || line.trim().length === 0) continue
    lineCount += 1
    const parsed = safeJsonParse(line)
    const lineNo = idx + 1
    if (!isRecord(parsed)) {
      warnings.push(`line ${lineNo}: invalid JSON`)
      continue
    }

    const codex = adaptCodexRecord(parsed, lineNo, ignoredCodexCallIds)
    if (codex.event || codex.warning) {
      provider = provider === 'claude-code' ? 'unknown' : 'codex'
      if (codex.event) observations.push(codex.event)
      if (codex.warning) warnings.push(codex.warning)
      continue
    }

    const claude = adaptClaudeRecord(parsed, lineNo)
    if (claude.event || claude.warning) {
      provider = provider === 'codex' ? 'unknown' : 'claude-code'
      if (claude.event) observations.push(claude.event)
      if (claude.warning) warnings.push(claude.warning)
      continue
    }

    if (recordLooksProviderRelevant(parsed)) {
      warnings.push(`line ${lineNo}: provider JSONL record is not capture-relevant in verifier v1`)
    }
  }

  return {
    schema: CAPTURE_VERIFIER_SCHEMA,
    path: input.path,
    provider,
    observations,
    warnings,
    lineCount,
  }
}

function makeObserved(input: {
  line: number
  provider: CaptureProvider
  type: CaptureObservation['type']
  correlationKey?: string | undefined
  normalizedPayload: unknown
  text?: string | undefined
}): CaptureObservation {
  return {
    schema: CAPTURE_OBSERVATION_SCHEMA,
    line: input.line,
    provider: input.provider,
    type: input.type,
    ...(input.correlationKey !== undefined ? { correlationKey: input.correlationKey } : {}),
    normalizedPayload: input.normalizedPayload,
    payloadHash: hashPayload(input.normalizedPayload),
    ...(input.text !== undefined ? { text: input.text } : {}),
  }
}

function adaptCodexRecord(
  record: Record<string, unknown>,
  line: number,
  ignoredCallIds: Set<string>
): AdapterResult {
  if (record['type'] !== 'response_item') return {}
  const payload = record['payload']
  if (!isRecord(payload)) {
    return { warning: `line ${line}: Codex response_item has non-object payload` }
  }

  if (payload['type'] === 'message') {
    const role = payload['role']
    const text = compactText(textFromContent(payload['content']))
    if (role === 'user') {
      return {}
    }
    if (role === 'assistant' && text !== undefined) {
      return {
        event: makeObserved({
          line,
          provider: 'codex',
          type: 'assistant.message.completed',
          normalizedPayload: { content: text },
          text,
        }),
      }
    }
    return { warning: `line ${line}: Codex message response_item has no capture-relevant text` }
  }

  if (payload['type'] === 'function_call') {
    const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
    const rawName = stringField(payload, 'name') ?? 'unknown'
    if (rawName !== 'exec_command') {
      if (callId !== undefined) ignoredCallIds.add(callId)
      return {
        warning: `line ${line}: Codex function_call ${rawName} is outside broker JSONL v1 scope`,
      }
    }
    const parsedInput = parseMaybeJson(payload['arguments'])
    return {
      event: makeObserved({
        line,
        provider: 'codex',
        type: 'tool.call.started',
        correlationKey: callId,
        normalizedPayload: normalizeCodexToolStart(callId, rawName, parsedInput),
      }),
    }
  }

  if (payload['type'] === 'function_call_output') {
    const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
    if (callId !== undefined && ignoredCallIds.has(callId)) {
      return {}
    }
    const output = typeof payload['output'] === 'string' ? payload['output'] : ''
    if (isCodexPendingCommandOutput(output)) {
      return {}
    }
    const result = extractCodexCommandResult(output)
    const failed = result.exitCode !== undefined ? result.exitCode !== 0 : false
    return {
      event: makeObserved({
        line,
        provider: 'codex',
        type: failed ? 'tool.call.failed' : 'tool.call.completed',
        correlationKey: callId,
        normalizedPayload: {
          toolCallId: callId,
          result: normalizeToolResult(result.output, result.exitCode),
        },
      }),
    }
  }

  return {}
}

function adaptClaudeRecord(record: Record<string, unknown>, line: number): AdapterResult {
  const type = record['type']
  const message = isRecord(record['message']) ? record['message'] : record
  const role = message['role'] ?? type

  if (role === 'user') {
    const content = message['content']
    const toolResult = firstContentBlock(content, 'tool_result')
    if (toolResult !== undefined) {
      const toolUseId = stringField(toolResult, 'tool_use_id') ?? stringField(toolResult, 'id')
      const isError = toolResult['is_error'] === true || toolResult['isError'] === true
      return {
        event: makeObserved({
          line,
          provider: 'claude-code',
          type: isError ? 'tool.call.failed' : 'tool.call.completed',
          correlationKey: toolUseId,
          normalizedPayload: {
            toolCallId: toolUseId,
            result: normalizeToolResult(toolResult['content']),
          },
        }),
      }
    }
    const text = compactText(textFromContent(content))
    if (text !== undefined) {
      return {
        event: makeObserved({
          line,
          provider: 'claude-code',
          type: 'user.message',
          normalizedPayload: { content: text },
          text,
        }),
      }
    }
  }

  if (role === 'assistant') {
    const toolUse = firstContentBlock(message['content'], 'tool_use')
    if (toolUse !== undefined) {
      const toolUseId = stringField(toolUse, 'id')
      const name = stringField(toolUse, 'name') ?? 'unknown'
      return {
        event: makeObserved({
          line,
          provider: 'claude-code',
          type: 'tool.call.started',
          correlationKey: toolUseId,
          normalizedPayload: { toolCallId: toolUseId, name, input: toolUse['input'] ?? {} },
        }),
      }
    }
    const text = compactText(textFromContent(message['content']))
    if (text !== undefined) {
      return {
        event: makeObserved({
          line,
          provider: 'claude-code',
          type: 'assistant.message.completed',
          normalizedPayload: { content: text },
          text,
        }),
      }
    }
  }

  return {}
}

function recordLooksProviderRelevant(record: Record<string, unknown>): boolean {
  return (
    typeof record['type'] === 'string' ||
    typeof record['sessionId'] === 'string' ||
    typeof record['parentUuid'] === 'string'
  )
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  const parsed = safeJsonParse(value)
  return parsed === undefined ? value : parsed
}

function normalizeToolResult(value: unknown, exitCode?: number | undefined): unknown {
  if (Array.isArray(value)) {
    return normalizeContentResult(value)
  }
  if (isRecord(value) && Array.isArray(value['content'])) {
    return normalizeContentResult(value['content'])
  }
  const output = normalizeCommandOutputText(value === undefined ? '' : String(value))
  if (output.length === 0 && exitCode !== undefined) {
    return { exitCode }
  }
  return { output }
}

function normalizeContentResult(value: unknown[]): unknown {
  const content = normalizeContentBlocks(value)
  if (
    content.length === 1 &&
    isRecord(content[0]) &&
    content[0]['type'] === 'text' &&
    typeof content[0]['text'] === 'string'
  ) {
    return { output: content[0]['text'] }
  }
  return { content }
}

function normalizeContentBlocks(value: unknown[]): unknown[] {
  return value.map((item) => normalizeContentBlock(item))
}

function normalizeContentBlock(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (value['type'] === 'text' && typeof value['text'] === 'string') {
    const parsed = safeJsonParse(value['text'])
    if (isRecord(parsed) && parsed['type'] === 'image') {
      return normalizeContentBlock(parsed)
    }
    if (isRecord(parsed) && parsed['type'] === 'text') {
      const file = isRecord(parsed['file']) ? parsed['file'] : undefined
      if (typeof file?.['content'] === 'string') {
        return {
          type: 'text',
          text: formatFileContent(file['content'], file['startLine']),
        }
      }
    }
    return { type: 'text', text: normalizeCommandOutputText(value['text']) }
  }
  if (value['type'] === 'image') {
    const source = isRecord(value['source']) ? value['source'] : undefined
    const file = isRecord(value['file']) ? value['file'] : undefined
    const mediaType =
      (typeof source?.['media_type'] === 'string' ? source['media_type'] : undefined) ??
      (typeof source?.['mediaType'] === 'string' ? source['mediaType'] : undefined) ??
      (typeof file?.['type'] === 'string' ? file['type'] : undefined) ??
      (typeof file?.['media_type'] === 'string' ? file['media_type'] : undefined)
    const base64 =
      (typeof source?.['data'] === 'string' ? source['data'] : undefined) ??
      (typeof file?.['base64'] === 'string' ? file['base64'] : undefined)
    return {
      type: 'image',
      ...(mediaType !== undefined ? { mediaType } : {}),
      ...(base64 !== undefined ? { base64 } : {}),
    }
  }
  return value
}

function formatFileContent(content: string, startLine: unknown): string {
  if (typeof startLine !== 'number' || !Number.isFinite(startLine)) {
    return content
  }
  return content
    .split('\n')
    .map((line, index) => `${startLine + index}\t${line}`)
    .join('\n')
}

function normalizeCodexToolStart(
  toolCallId: string | undefined,
  name: string,
  input: unknown
): Record<string, unknown> {
  if (name === 'exec_command' && isRecord(input)) {
    const cmd = typeof input['cmd'] === 'string' ? input['cmd'] : ''
    const cwd = typeof input['workdir'] === 'string' ? input['workdir'] : undefined
    return {
      toolCallId,
      name: 'command',
      input: {
        cmd,
        ...(cwd !== undefined ? { cwd } : {}),
      },
    }
  }
  return { toolCallId, name, input: input ?? {} }
}

function extractCodexCommandResult(output: string): {
  exitCode?: number | undefined
  output: string
} {
  const exitMatch = output.match(/Process exited with code (\d+)/)
  const marker = '\nOutput:\n'
  const idx = output.indexOf(marker)
  return {
    ...(exitMatch?.[1] !== undefined ? { exitCode: Number(exitMatch[1]) } : {}),
    output: idx === -1 ? output : output.slice(idx + marker.length),
  }
}

function isCodexPendingCommandOutput(output: string): boolean {
  return (
    /Process running with session ID \d+/.test(output) &&
    /\nOutput:\n?$/.test(output) &&
    !/Process exited with code \d+/.test(output)
  )
}

function normalizeCommandOutputText(output: string): string {
  return output.replace(/^Total output lines: \d+\n\n/, '')
}

function firstContentBlock(value: unknown, type: string): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  for (const item of value) {
    if (isRecord(item) && item['type'] === type) {
      return item
    }
  }
  return undefined
}
