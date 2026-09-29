import { compactText, hashPayload, isRecord, safeJsonParse, textFromContent } from './json.js'
import type { BrokerCaptureEvent } from './types.js'

export type ComparableBrokerEvent = {
  row: BrokerCaptureEvent
  type: string
  correlationKey?: string | undefined
  normalizedPayload: unknown
  payloadHash: string
  text?: string | undefined
}

export function toComparableBrokerEvent(row: BrokerCaptureEvent): ComparableBrokerEvent {
  const payload = isRecord(row.payload) ? row.payload : {}
  switch (row.type) {
    case 'user.message': {
      const text = compactText(
        typeof payload['content'] === 'string' ? payload['content'] : undefined
      )
      const normalizedPayload = { content: text ?? '' }
      return {
        row,
        type: row.type,
        normalizedPayload,
        payloadHash: hashPayload(normalizedPayload),
        ...(text !== undefined ? { text } : {}),
      }
    }
    case 'assistant.message.completed': {
      const text = compactText(
        textFromContent(payload['content']) ?? textFromContent(payload['message'])
      )
      const normalizedPayload = { content: text ?? '' }
      return {
        row,
        type: row.type,
        normalizedPayload,
        payloadHash: hashPayload(normalizedPayload),
        ...(text !== undefined ? { text } : {}),
      }
    }
    case 'tool.call.started': {
      const key = stringField(payload, 'toolCallId') ?? stringField(payload, 'id')
      const normalizedPayload = {
        toolCallId: key,
        name: stringField(payload, 'name') ?? 'unknown',
        input: normalizeBrokerToolInput(payload['input']),
      }
      return {
        row,
        type: row.type,
        ...(key !== undefined ? { correlationKey: key } : {}),
        normalizedPayload,
        payloadHash: hashPayload(normalizedPayload),
      }
    }
    case 'tool.call.completed':
    case 'tool.call.failed': {
      const key = stringField(payload, 'toolCallId') ?? stringField(payload, 'id')
      const normalizedPayload = {
        toolCallId: key,
        result: normalizeBrokerToolResult(payload['result'] ?? payload['message']),
        ...(typeof payload['isError'] === 'boolean' ? { isError: payload['isError'] } : {}),
      }
      return {
        row,
        type: row.type,
        ...(key !== undefined ? { correlationKey: key } : {}),
        normalizedPayload,
        payloadHash: hashPayload(normalizedPayload),
      }
    }
    default:
      return {
        row,
        type: row.type,
        normalizedPayload: row.payload,
        payloadHash: hashPayload(row.payload),
      }
  }
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function normalizeBrokerToolResult(value: unknown): unknown {
  if (isRecord(value) && typeof value['output'] === 'string') {
    return {
      output: normalizeCommandOutputText(value['output']),
      ...(typeof value['exitCode'] === 'number' ? { exitCode: value['exitCode'] } : {}),
    }
  }
  if (isRecord(value) && Array.isArray(value['content'])) {
    return normalizeContentResult(value['content'])
  }
  return value
}

export function normalizeBrokerToolInput(value: unknown): unknown {
  if (!isRecord(value)) return value ?? {}
  const rawCommand = typeof value['command'] === 'string' ? value['command'] : undefined
  const command = rawCommand !== undefined ? unwrapZshCommand(rawCommand) : undefined
  const cwd = typeof value['cwd'] === 'string' ? value['cwd'] : undefined
  if (command !== undefined || cwd !== undefined) {
    return {
      ...(command !== undefined ? { cmd: command } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    }
  }
  return value
}

export function unwrapZshCommand(command: string): string {
  const prefix = '/bin/zsh -lc '
  if (!command.startsWith(prefix)) return command
  const raw = command.slice(prefix.length)
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1).replace(/\\"/g, '"')
  }
  return raw
}

export function normalizeContentBlocks(value: unknown[]): unknown[] {
  return value.map((item) => normalizeContentBlock(item))
}

export function normalizeContentResult(value: unknown[]): unknown {
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

export function normalizeContentBlock(value: unknown): unknown {
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

export function formatFileContent(content: string, startLine: unknown): string {
  if (typeof startLine !== 'number' || !Number.isFinite(startLine)) {
    return content
  }
  return content
    .split('\n')
    .map((line, index) => `${startLine + index}\t${line}`)
    .join('\n')
}

export function payloadsCompatible(observed: unknown, broker: unknown): boolean {
  if (toolStartInputsCompatible(observed, broker)) {
    return true
  }
  const observedExitCode = exitCodeFromResult(observed)
  const brokerExitCode = exitCodeFromResult(broker)
  if (
    observedExitCode !== undefined &&
    brokerExitCode !== undefined &&
    observedExitCode !== brokerExitCode
  ) {
    return false
  }
  const observedIsError = isErrorFromPayload(observed)
  const brokerIsError = isErrorFromPayload(broker)
  if (
    observedIsError !== undefined &&
    brokerIsError !== undefined &&
    observedIsError !== brokerIsError
  ) {
    return false
  }
  const observedOutput = outputText(observed)
  const brokerOutput = outputText(broker)
  if (observedOutput !== undefined && brokerOutput !== undefined) {
    return outputsCompatible(observedOutput, brokerOutput)
  }
  if (observedExitCode !== undefined && brokerExitCode !== undefined) {
    return true
  }
  return false
}

export function outputsCompatible(left: string, right: string): boolean {
  const leftVariants = outputTextVariants(left)
  const rightVariants = outputTextVariants(right)
  for (const leftVariant of leftVariants) {
    for (const rightVariant of rightVariants) {
      if (leftVariant.includes(rightVariant) || rightVariant.includes(leftVariant)) {
        return true
      }
      if (significantLinesOverlap(leftVariant, rightVariant)) {
        return true
      }
    }
  }
  return false
}

export function significantLinesOverlap(left: string, right: string): boolean {
  const leftLines = significantOutputLines(left)
  const rightLines = significantOutputLines(right)
  if (leftLines.length < 3 || rightLines.length < 3) {
    return false
  }
  const rightSet = new Set(rightLines)
  const common = leftLines.filter((line) => rightSet.has(line)).length
  return common >= 3 && common / Math.min(leftLines.length, rightLines.length) >= 0.5
}

export function outputTextVariants(value: string): string[] {
  const variants = new Set<string>([value, normalizeCommandOutputText(value)])
  const pending = [...variants]
  for (const variant of pending) {
    const parsed = safeJsonParse(variant)
    if (typeof parsed === 'string') {
      variants.add(normalizeCommandOutputText(parsed))
    }
    variants.add(decodeJsonEscapedText(variant))
  }
  return [...variants].filter((variant) => variant.length > 0)
}

export function decodeJsonEscapedText(value: string): string {
  return value
    .replaceAll(String.raw`\r\n`, '\n')
    .replaceAll(String.raw`\n`, '\n')
    .replaceAll(String.raw`\t`, '\t')
    .replaceAll(String.raw`\"`, '"')
    .replaceAll(String.raw`\/`, '/')
}

export function significantOutputLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function toolStartInputsCompatible(observed: unknown, broker: unknown): boolean {
  if (!isRecord(observed) || !isRecord(broker)) return false
  if (observed['toolCallId'] !== broker['toolCallId']) return false
  if (observed['name'] !== broker['name']) return false
  const observedInput = observed['input']
  const brokerInput = broker['input']
  if (!isRecord(observedInput) || !isRecord(brokerInput)) return false
  const observedCommand =
    typeof observedInput['cmd'] === 'string' ? observedInput['cmd'] : undefined
  const brokerCommand = typeof brokerInput['cmd'] === 'string' ? brokerInput['cmd'] : undefined
  if (observedCommand === undefined || brokerCommand === undefined) return false
  const observedFingerprint = commandFingerprint(observedCommand)
  const brokerFingerprint = commandFingerprint(brokerCommand)
  if (observedFingerprint.length === 0 || brokerFingerprint.length === 0) return false
  return observedFingerprint.every((token) => brokerFingerprint.includes(token))
}

export function commandFingerprint(command: string): string[] {
  return [
    ...new Set(
      command
        .replaceAll(String.raw`\"`, '"')
        .replaceAll(`"'"`, "'")
        .replaceAll(/[^a-zA-Z0-9_./:-]+/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 1 && token !== 'bin' && token !== 'zsh' && token !== 'lc')
    ),
  ].sort()
}

export function exitCodeFromResult(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const result = value['result']
  if (!isRecord(result)) return undefined
  return typeof result['exitCode'] === 'number' ? result['exitCode'] : undefined
}

export function isErrorFromPayload(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined
  return typeof value['isError'] === 'boolean' ? value['isError'] : undefined
}

export function outputText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const result = value['result']
  if (!isRecord(result)) return undefined
  const output = result['output']
  return typeof output === 'string' ? output : undefined
}

export function normalizeCommandOutputText(output: string): string {
  return output.replace(/^Total output lines: \d+\n\n/, '')
}

export function lifecycleKey(row: BrokerCaptureEvent, lifecycleKind: string): string {
  return JSON.stringify([
    row.runtimeId,
    row.runId ?? null,
    row.harnessGeneration ?? null,
    lifecycleKind,
  ])
}
