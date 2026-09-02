import { HrcDomainError, HrcErrorCode, splitSessionRef } from 'hrc-core'
import type { BrokerForensicsEvent, BrokerForensicsResponse, HrcSelector } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import type { EventProvenance } from 'spaces-harness-broker-protocol'

import { hasFlag, parseFlag, splitCsv } from './cli/argv.js'
import { createClient, fatal } from './cli/shared.js'
import { parseProfileAwareSelector } from './profile-aware-selector.js'
import { resolveRuntimeArg } from './selector-resolve.js'

const HUMAN_CLIP_CHARS = 1_000

type SeqRange = { from?: number | undefined; to?: number | undefined }
type TranscriptKind = 'user' | 'exec' | 'cot' | 'notice'

type RuntimeSelection = {
  latest: boolean
  previous?: number | undefined
  sourceRef?: string | undefined
}

type BrokerForensicsEventWithProvenance = BrokerForensicsEvent & {
  provenance?: EventProvenance | undefined
}

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

function parsePositiveInteger(flag: string, raw: string): number {
  if (!/^\d+$/.test(raw)) fatal(`${flag} must be a positive integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    fatal(`${flag} must be a positive integer`)
  }
  return value
}

function parsePrevious(args: string[]): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg?.startsWith('--previous=')) {
      return parsePositiveInteger('--previous', arg.slice('--previous='.length))
    }
    if (arg !== '--previous') continue
    const next = args[index + 1]
    // Commander represents an optional argument with no supplied value as true
    // before the legacy argv bridge serializes it.
    if (next === undefined || next === 'true' || next.startsWith('--')) return 1
    return parsePositiveInteger('--previous', next)
  }
  return undefined
}

function parseTail(args: string[]): number | undefined {
  const raw = parseFlag(args, '--tail')
  return raw === undefined ? undefined : parsePositiveInteger('--tail', raw)
}

async function resolvePreviousRuntimeArg(
  rawTarget: string,
  client: HrcClient,
  previous: number
): Promise<string> {
  let selector: HrcSelector
  try {
    selector = parseProfileAwareSelector(
      rawTarget.startsWith('agent:') ? `scope:${rawTarget}` : rawTarget
    )
  } catch {
    fatal(`--previous requires a scope or handle target (received: ${rawTarget})`)
  }

  let scopeRef: string
  let laneRef: string | undefined
  switch (selector.kind) {
    case 'scope':
      scopeRef = selector.scopeRef
      break
    case 'session': {
      const session = splitSessionRef(selector.sessionRef)
      scopeRef = session.scopeRef
      laneRef = session.laneRef
      break
    }
    case 'target':
      if (rawTarget.includes('~')) {
        const session = splitSessionRef(selector.sessionRef)
        scopeRef = session.scopeRef
        laneRef = session.laneRef
      } else {
        scopeRef = selector.scopeRef
      }
      break
    default:
      fatal(`--previous requires a scope or handle target (received: ${rawTarget})`)
  }

  const matches = (await client.listRuntimes({ all: true }))
    .filter(
      (runtime) =>
        runtime.status === 'terminated' &&
        runtime.scopeRef === scopeRef &&
        (laneRef === undefined || runtime.laneRef === laneRef)
    )
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        right.runtimeId.localeCompare(left.runtimeId)
    )
  const match = matches[previous - 1]
  if (!match) {
    fatal(
      `--previous ${previous} requested a terminated runtime for "${rawTarget}", but only ${matches.length} exist`
    )
  }
  return match.runtimeId
}

async function fetchForensics(
  rawTarget: string | undefined,
  client: HrcClient,
  selection: RuntimeSelection
): Promise<BrokerForensicsResponse> {
  if (selection.latest && selection.previous !== undefined) {
    fatal('--previous and --latest are mutually exclusive')
  }
  if (selection.sourceRef !== undefined) {
    if (rawTarget !== undefined) fatal('<target> and --source-ref are mutually exclusive')
    if (selection.previous !== undefined) {
      fatal('--previous requires a scope or handle target')
    }
    return client.brokerForensics({ sourceRef: selection.sourceRef })
  }
  if (rawTarget === undefined) fatal('either <target> or --source-ref is required')
  if (selection.previous !== undefined) {
    const runtimeId = await resolvePreviousRuntimeArg(rawTarget, client, selection.previous)
    return client.brokerForensics({ targetId: runtimeId })
  }
  try {
    // Fast path for exact persisted runtime and invocation IDs. The daemon owns
    // this lookup so terminated invocations are not limited by a live registry.
    return await client.brokerForensics({ targetId: rawTarget })
  } catch (error) {
    if (!(error instanceof HrcDomainError) || error.code !== HrcErrorCode.INVALID_SELECTOR) {
      throw error
    }
  }

  const runtimeId = await resolveRuntimeArg(rawTarget, client, { latest: selection.latest })
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
  const rawTarget = args[0] && !args[0].startsWith('--') ? args[0] : undefined
  const jsonOutput = hasFlag(args, '--json')
  const ndjsonOutput = hasFlag(args, '--ndjson')
  const showProvenance = hasFlag(args, '--provenance')
  if (jsonOutput && ndjsonOutput) fatal('--json and --ndjson are mutually exclusive')

  const typeRaw = parseFlag(args, '--type')
  const types = typeRaw ? new Set(splitCsv(typeRaw)) : undefined
  const range = parseSeqRange(parseFlag(args, '--seq'))
  const client = createClient()
  const result = await fetchForensics(rawTarget, client, {
    latest: hasFlag(args, '--latest'),
    previous: parsePrevious(args),
    sourceRef: parseFlag(args, '--source-ref'),
  })
  const events = filterEvents(result.events, {
    types,
    range,
  }) as BrokerForensicsEventWithProvenance[]

  if (ndjsonOutput) {
    for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`)
    return
  }
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(events, null, 2)}\n`)
    return
  }
  for (const event of events) {
    const provenance = showProvenance
      ? ` | provenance=${event.provenance?.sourceKind ?? '-'}/${event.provenance?.nativeType ?? '-'}/${event.provenance?.rawRecordId ?? '-'}`
      : ''
    process.stdout.write(
      `${event.seq} ${event.time} ${event.type} | ${payloadText(event)}${provenance}\n`
    )
  }
}

function transcriptKind(type: string): TranscriptKind | undefined {
  if (type === 'user.message') return 'user'
  if (type === 'tool.call.started' || type === 'tool.call.completed') return 'exec'
  if (type === 'assistant.message.completed') return 'cot'
  if (type === 'driver.notice') return 'notice'
  return undefined
}

function parseTranscriptKinds(raw: string | undefined): Set<TranscriptKind> {
  const values = raw ? splitCsv(raw) : ['user', 'exec', 'cot', 'notice']
  const invalid = values.filter((value) => !['user', 'exec', 'cot', 'notice'].includes(value))
  if (invalid.length > 0) {
    fatal(`--kinds accepts only user,exec,cot,notice (received: ${invalid.join(',')})`)
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
  for (const key of ['text', 'content', 'output', 'message', 'notice']) {
    const text = extractText(record[key])
    if (text !== undefined) return text
  }
  return undefined
}

function renderTranscriptEvent(event: BrokerForensicsEvent, full: boolean): string {
  if (event.type === 'user.message') {
    const text = event.parseError
      ? payloadText(event, full)
      : (extractText(event.payload) ?? payloadText(event, full))
    return `${event.seq} USER | ${clipHuman(oneLine(text), full)}`
  }
  if (event.type === 'tool.call.started') {
    const tool = summarizeTool(event, full)
    return `${event.seq} EXEC ${tool.name} | ${tool.input}`
  }
  if (event.type === 'tool.call.completed') {
    const payload = asRecord(event.payload)
    const name =
      (typeof payload?.['name'] === 'string' && payload['name']) ||
      (typeof payload?.['toolName'] === 'string' && payload['toolName']) ||
      '(unknown)'
    const result = payload?.['result']
    let text: string
    if (event.parseError) {
      text = payloadText(event, full)
    } else {
      const extracted = extractText(result)
      if (extracted !== undefined) {
        text = extracted
      } else {
        try {
          text = JSON.stringify(result ?? null)
        } catch {
          text = '[unrenderable result]'
        }
      }
    }
    return `${event.seq} RESULT ${name} | ${clipHuman(oneLine(text), full)}`
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
  const rawTarget = args[0] && !args[0].startsWith('--') ? args[0] : undefined
  const range = parseSeqRange(parseFlag(args, '--seq'))
  const kinds = parseTranscriptKinds(parseFlag(args, '--kinds'))
  const tail = parseTail(args)
  const full = hasFlag(args, '--full')
  const client = createClient()
  const result = await fetchForensics(rawTarget, client, {
    latest: hasFlag(args, '--latest'),
    previous: parsePrevious(args),
    sourceRef: parseFlag(args, '--source-ref'),
  })
  const filtered = result.events.filter((event) => {
    const kind = transcriptKind(event.type)
    return kind !== undefined && kinds.has(kind) && inSeqRange(event, range)
  })
  const events = tail === undefined ? filtered : filtered.slice(-tail)

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
  const rawTarget = args[0] && !args[0].startsWith('--') ? args[0] : undefined
  const client = createClient()
  const result = await fetchForensics(rawTarget, client, {
    latest: hasFlag(args, '--latest'),
    previous: parsePrevious(args),
    sourceRef: parseFlag(args, '--source-ref'),
  })
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
