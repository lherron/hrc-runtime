import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { BrokerForensicsEvent, BrokerForensicsResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { hasFlag, parseFlag, requireArg, splitCsv } from './cli/argv.js'
import { createClient, fatal } from './cli/shared.js'
import { resolveRuntimeArg } from './selector-resolve.js'

const HUMAN_CLIP_CHARS = 1_000

type SeqRange = { from?: number | undefined; to?: number | undefined }
type TranscriptKind = 'exec' | 'cot' | 'notice'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseSeqRange(raw: string | undefined): SeqRange {
  if (raw === undefined) return {}
  const match = raw.trim().match(/^(\d*)\.\.(\d*)$/)
  if (!match || (match[1] === '' && match[2] === '')) {
    fatal('--seq must use an inclusive <from>..<to> range')
  }
  const from = match[1] ? Number(match[1]) : undefined
  const to = match[2] ? Number(match[2]) : undefined
  if (
    (from !== undefined && !Number.isSafeInteger(from)) ||
    (to !== undefined && !Number.isSafeInteger(to)) ||
    (from !== undefined && to !== undefined && from > to)
  ) {
    fatal('--seq must use an ascending range of safe integers')
  }
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }
}

function inSeqRange(event: BrokerForensicsEvent, range: SeqRange): boolean {
  return (
    (range.from === undefined || event.seq >= range.from) &&
    (range.to === undefined || event.seq <= range.to)
  )
}

function clipHuman(text: string, full = false): string {
  if (full || text.length <= HUMAN_CLIP_CHARS) return text
  return `${text.slice(0, HUMAN_CLIP_CHARS)}… [clipped ${text.length - HUMAN_CLIP_CHARS} chars]`
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function payloadText(event: BrokerForensicsEvent, full = false): string {
  if (event.parseError) {
    return `[unparseable payload: ${event.parseError}]`
  }
  let rendered: string
  if (typeof event.payload === 'string') {
    rendered = event.payload
  } else {
    try {
      rendered = JSON.stringify(event.payload ?? null)
    } catch {
      rendered = '[unrenderable payload]'
    }
  }
  return clipHuman(oneLine(rendered), full)
}

async function fetchForensics(
  rawTarget: string,
  client: HrcClient,
  latest: boolean
): Promise<BrokerForensicsResponse> {
  try {
    // Fast path for exact persisted runtime and invocation IDs. The daemon owns
    // this lookup so terminated invocations are not limited by a live registry.
    return await client.brokerForensics({ targetId: rawTarget })
  } catch (error) {
    if (!(error instanceof HrcDomainError) || error.code !== HrcErrorCode.INVALID_SELECTOR) {
      throw error
    }
  }

  const runtimeId = await resolveRuntimeArg(rawTarget, client, { latest })
  return client.brokerForensics({ targetId: runtimeId })
}

function filterEvents(
  events: BrokerForensicsEvent[],
  options: { types?: Set<string> | undefined; range: SeqRange }
): BrokerForensicsEvent[] {
  return events.filter(
    (event) =>
      inSeqRange(event, options.range) &&
      (options.types === undefined || options.types.has(event.type))
  )
}

export async function cmdBrokerEvents(args: string[]): Promise<void> {
  const rawTarget = requireArg(args, 0, '<runtimeId|invocationId|scope>')
  const jsonOutput = hasFlag(args, '--json')
  const ndjsonOutput = hasFlag(args, '--ndjson')
  if (jsonOutput && ndjsonOutput) fatal('--json and --ndjson are mutually exclusive')

  const typeRaw = parseFlag(args, '--type')
  const types = typeRaw ? new Set(splitCsv(typeRaw)) : undefined
  const range = parseSeqRange(parseFlag(args, '--seq'))
  const client = createClient()
  const result = await fetchForensics(rawTarget, client, hasFlag(args, '--latest'))
  const events = filterEvents(result.events, { types, range })

  if (ndjsonOutput) {
    for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`)
    return
  }
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(events, null, 2)}\n`)
    return
  }
  for (const event of events) {
    process.stdout.write(`${event.seq} ${event.time} ${event.type} | ${payloadText(event)}\n`)
  }
}

function transcriptKind(type: string): TranscriptKind | undefined {
  if (type === 'tool.call.started') return 'exec'
  if (type === 'assistant.message.completed') return 'cot'
  if (type === 'driver.notice') return 'notice'
  return undefined
}

function parseTranscriptKinds(raw: string | undefined): Set<TranscriptKind> {
  const values = raw ? splitCsv(raw) : ['exec', 'cot', 'notice']
  const invalid = values.filter((value) => !['exec', 'cot', 'notice'].includes(value))
  if (invalid.length > 0) {
    fatal(`--kinds accepts only exec,cot,notice (received: ${invalid.join(',')})`)
  }
  return new Set(values as TranscriptKind[])
}

function summarizeTool(
  event: BrokerForensicsEvent,
  full: boolean
): { name: string; input: string } {
  const payload = asRecord(event.payload)
  const name =
    (typeof payload?.['name'] === 'string' && payload['name']) ||
    (typeof payload?.['toolName'] === 'string' && payload['toolName']) ||
    '(unknown)'
  const input = asRecord(payload?.['input'])
  const preferred = input?.['command'] ?? input?.['file_path'] ?? input?.['prompt']
  let summary: string
  if (typeof preferred === 'string') {
    summary = preferred
  } else if (preferred !== undefined) {
    summary = JSON.stringify(preferred)
  } else if (input !== undefined) {
    summary = JSON.stringify(input)
  } else {
    summary = payloadText(event, full)
  }
  return { name, input: clipHuman(oneLine(summary), full) }
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.map(extractText).filter((part): part is string => part !== undefined)
    return parts.length > 0 ? parts.join(' ') : undefined
  }
  const record = asRecord(value)
  if (!record) return undefined
  for (const key of ['text', 'content', 'message', 'notice']) {
    const text = extractText(record[key])
    if (text !== undefined) return text
  }
  return undefined
}

function renderTranscriptEvent(event: BrokerForensicsEvent, full: boolean): string {
  if (event.type === 'tool.call.started') {
    const tool = summarizeTool(event, full)
    return `${event.seq} EXEC ${tool.name} | ${tool.input}`
  }
  if (event.type === 'assistant.message.completed') {
    const text = event.parseError
      ? payloadText(event, full)
      : (extractText(event.payload) ?? payloadText(event, full))
    return `${event.seq} SAYS | ${clipHuman(oneLine(text), full)}`
  }
  const notice = event.parseError
    ? payloadText(event, full)
    : (extractText(event.payload) ?? payloadText(event, full))
  return `${event.seq} NOTE | ${clipHuman(oneLine(notice), full)}`
}

export async function cmdBrokerTranscript(args: string[]): Promise<void> {
  const rawTarget = requireArg(args, 0, '<runtimeId|invocationId|scope>')
  const range = parseSeqRange(parseFlag(args, '--seq'))
  const kinds = parseTranscriptKinds(parseFlag(args, '--kinds'))
  const full = hasFlag(args, '--full')
  const client = createClient()
  const result = await fetchForensics(rawTarget, client, hasFlag(args, '--latest'))
  const events = result.events.filter((event) => {
    const kind = transcriptKind(event.type)
    return kind !== undefined && kinds.has(kind) && inSeqRange(event, range)
  })

  for (const event of events) process.stdout.write(`${renderTranscriptEvent(event, full)}\n`)
}

type BrokerStats = {
  targetKind: BrokerForensicsResponse['targetKind']
  targetId: string
  runtimeIds: string[]
  invocationIds: string[]
  eventTypes: Record<string, number>
  turnCount: number
  toolCallCount: number
  firstActivity: string | null
  lastActivity: string | null
  perTurn: Array<{ turnId: string; toolCallCount: number }>
}

function buildStats(result: BrokerForensicsResponse): BrokerStats {
  const histogram = new Map<string, number>()
  const turnIds = new Set<string>()
  const perTurn = new Map<string, number>()
  let anonymousTurnCount = 0

  for (const event of result.events) {
    histogram.set(event.type, (histogram.get(event.type) ?? 0) + 1)
    if (event.turnId) {
      turnIds.add(event.turnId)
      if (!perTurn.has(event.turnId)) perTurn.set(event.turnId, 0)
    }
    if (!event.turnId && event.type === 'turn.started') anonymousTurnCount += 1
    if (event.type === 'tool.call.started' && event.turnId) {
      perTurn.set(event.turnId, (perTurn.get(event.turnId) ?? 0) + 1)
    }
  }

  const activity = result.events.map((event) => event.time).sort()
  return {
    targetKind: result.targetKind,
    targetId: result.targetId,
    runtimeIds: result.runtimeIds,
    invocationIds: result.invocationIds,
    eventTypes: Object.fromEntries([...histogram.entries()].sort(([a], [b]) => a.localeCompare(b))),
    turnCount: turnIds.size > 0 ? turnIds.size : anonymousTurnCount,
    toolCallCount: histogram.get('tool.call.started') ?? 0,
    firstActivity: activity[0] ?? null,
    lastActivity: activity.at(-1) ?? null,
    perTurn: [...perTurn.entries()].map(([turnId, toolCallCount]) => ({ turnId, toolCallCount })),
  }
}

export async function cmdBrokerStats(args: string[]): Promise<void> {
  const rawTarget = requireArg(args, 0, '<runtimeId|invocationId|scope>')
  const client = createClient()
  const result = await fetchForensics(rawTarget, client, hasFlag(args, '--latest'))
  const stats = buildStats(result)

  if (hasFlag(args, '--json')) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`)
    return
  }

  const lines = [
    `broker stats ${stats.targetId}`,
    `  runtimeIds     ${stats.runtimeIds.join(', ') || '(none)'}`,
    `  invocationIds  ${stats.invocationIds.join(', ') || '(none)'}`,
    `  turn count     ${stats.turnCount}`,
    `  tool calls     ${stats.toolCallCount}`,
    `  first activity ${stats.firstActivity ?? '(none)'}`,
    `  last activity  ${stats.lastActivity ?? '(none)'}`,
    '  event types',
    ...Object.entries(stats.eventTypes).map(([type, count]) => `    ${type}: ${count}`),
    '  per turn',
    ...stats.perTurn.map((turn) => `    ${turn.turnId}: ${turn.toolCallCount} tool calls`),
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}
