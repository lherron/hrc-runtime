import { readFile } from 'node:fs/promises'

import { compactText, hashPayload, isRecord, safeJsonParse, textFromContent } from './json.js'
import type { ObservedProviderEvent, ProviderTranscript } from './types.js'

type AdapterResult = {
  event?: ObservedProviderEvent | undefined
  warning?: string | undefined
}

export async function readProviderJsonl(path: string): Promise<ProviderTranscript> {
  const raw = await readFile(path, 'utf8')
  const warnings: string[] = []
  const observed: ObservedProviderEvent[] = []
  let provider: ProviderTranscript['provider'] = 'unknown'
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
      provider = provider === 'claude' ? 'unknown' : 'codex'
      if (codex.event) observed.push(codex.event)
      if (codex.warning) warnings.push(codex.warning)
      continue
    }

    const claude = adaptClaudeRecord(parsed, lineNo)
    if (claude.event || claude.warning) {
      provider = provider === 'codex' ? 'unknown' : 'claude'
      if (claude.event) observed.push(claude.event)
      if (claude.warning) warnings.push(claude.warning)
    }
  }

  return { path, provider, observed, warnings, lineCount }
}

function makeObserved(input: {
  line: number
  provider: ObservedProviderEvent['provider']
  type: ObservedProviderEvent['type']
  correlationKey?: string | undefined
  normalizedPayload: unknown
  text?: string | undefined
}): ObservedProviderEvent {
  return {
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
      // Codex JSONL replays prompt/context records as user messages. In broker
      // headless runs those are represented by input.accepted, not user.message,
      // so they are not transcript-observable broker message obligations.
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
      return { warning: `line ${line}: Codex function_call ${rawName} is outside broker JSONL v1 scope` }
    }
    const input = parseMaybeJson(payload['arguments'])
    const normalized = normalizeCodexToolStart(callId, rawName, input)
    return {
      event: makeObserved({
        line,
        provider: 'codex',
        type: 'tool.call.started',
        correlationKey: callId,
        normalizedPayload: normalized,
      }),
    }
  }

  if (payload['type'] === 'function_call_output') {
    const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
    if (callId !== undefined && ignoredCallIds.has(callId)) {
      return {}
    }
    const output = typeof payload['output'] === 'string' ? payload['output'] : ''
    const failed = /Process exited with code (?!0\b)\d+/.test(output)
    return {
      event: makeObserved({
        line,
        provider: 'codex',
        type: failed ? 'tool.call.failed' : 'tool.call.completed',
        correlationKey: callId,
        normalizedPayload: {
          toolCallId: callId,
          result: normalizeToolResult(extractCodexCommandOutput(output)),
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
      return {
        event: makeObserved({
          line,
          provider: 'claude',
          type: 'tool.call.completed',
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
          provider: 'claude',
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
          provider: 'claude',
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
          provider: 'claude',
          type: 'assistant.message.completed',
          normalizedPayload: { content: text },
          text,
        }),
      }
    }
  }

  return {}
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

function normalizeToolResult(value: unknown): unknown {
  if (isRecord(value) && Array.isArray(value['content'])) {
    return value
  }
  return { output: normalizeCommandOutputText(value === undefined ? '' : String(value)) }
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

function extractCodexCommandOutput(output: string): string {
  const marker = '\nOutput:\n'
  const idx = output.indexOf(marker)
  return idx === -1 ? output : output.slice(idx + marker.length)
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
