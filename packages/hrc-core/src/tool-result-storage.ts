export const TOOL_RESULT_SPILL_THRESHOLD_BYTES = 32_768
export const TOOL_RESULT_SPILL_HEAD_CHARS = 4_096
export const TOOL_RESULT_SPILL_TAIL_CHARS = 1_024

export type ToolResultBlobKind = 'broker_raw' | 'lifecycle_canonical'

export type ToolResultSpillDescriptor = {
  blobId: string
  bytes: number
  kind: ToolResultBlobKind
}

export type CanonicalToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export type CanonicalToolResult = {
  content: CanonicalToolResultContentBlock[]
  details?: Record<string, unknown> | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** The single forward-write and backfill threshold authority. */
export function toolResultExceedsSpillThreshold(result: unknown): boolean {
  const resultJson = JSON.stringify(result)
  return (
    resultJson !== undefined &&
    Buffer.byteLength(resultJson, 'utf8') > TOOL_RESULT_SPILL_THRESHOLD_BYTES
  )
}

/** Canonical broker-result conversion shared by the mapper and store hydrator. */
export function toolResultFromBrokerResult(result: unknown): CanonicalToolResult {
  if (isRecord(result) && Array.isArray(result['content'])) {
    const content = result['content']
    if (content.every((item) => isRecord(item) && typeof item['type'] === 'string')) {
      return result as unknown as CanonicalToolResult
    }
  }
  const text =
    typeof result === 'string'
      ? result
      : isRecord(result) && typeof result['output'] === 'string'
        ? result['output']
        : result === undefined || result === null
          ? ''
          : safeStringify(result)
  const details = isRecord(result) ? result : undefined
  return details === undefined
    ? { content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }], details }
}

function resultBody(result: unknown): string {
  if (typeof result === 'string') return result
  if (isRecord(result) && typeof result['output'] === 'string') return result['output']
  if (isRecord(result) && Array.isArray(result['content'])) {
    return result['content']
      .filter(isRecord)
      .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
      .join('')
  }
  return safeStringify(result)
}

function nonBodyDetails(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return {}
  const details = isRecord(result['details']) ? result['details'] : {}
  const withoutBody = (record: Record<string, unknown>): Record<string, unknown> => {
    const { content: _content, output: _output, spill: _spill, ...rest } = record
    return rest
  }
  const { content: _content, output: _output, details: _details, ...topLevel } = result
  return { ...withoutBody(details), ...topLevel }
}

/** Build the canonical excerpt stub persisted in place of a large result. */
export function createToolResultSpillStub(
  result: unknown,
  spill: ToolResultSpillDescriptor
): CanonicalToolResult {
  const body = resultBody(result)
  const text = `${body.slice(0, TOOL_RESULT_SPILL_HEAD_CHARS)}\n…[${spill.bytes} bytes spilled → ${spill.blobId}]…\n${body.slice(-TOOL_RESULT_SPILL_TAIL_CHARS)}`
  return {
    content: [{ type: 'text', text }],
    details: { ...nonBodyDetails(result), spill },
  }
}

export function readToolResultSpillDescriptor(
  result: unknown
): ToolResultSpillDescriptor | undefined {
  if (!isRecord(result) || !isRecord(result['details'])) return undefined
  const spill = result['details']['spill']
  const bytes = isRecord(spill) ? spill['bytes'] : undefined
  if (
    !isRecord(spill) ||
    typeof spill['blobId'] !== 'string' ||
    !Number.isSafeInteger(bytes) ||
    (bytes as number) < 0 ||
    (spill['kind'] !== 'broker_raw' && spill['kind'] !== 'lifecycle_canonical')
  ) {
    return undefined
  }
  return {
    blobId: spill['blobId'],
    bytes: bytes as number,
    kind: spill['kind'],
  }
}

export function brokerToolResultBlobId(runtimeId: string, toolCallId: string): string {
  return `tc:${runtimeId}:${toolCallId}`
}

export function lifecycleToolResultBlobId(ledgerIncarnationId: string, hrcSeq: number): string {
  return `lc:${ledgerIncarnationId}:${hrcSeq}`
}
