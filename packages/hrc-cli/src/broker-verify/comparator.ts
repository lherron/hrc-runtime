import { canonicalJson, compactText, hashPayload, isRecord, textFromContent } from './json.js'
import type {
  BrokerEventRow,
  BrokerInvocation,
  BrokerVerifyReport,
  LifecycleCheck,
  ProviderMatch,
  ProviderTranscript,
  RawMirrorRow,
  VerificationIssue,
} from './types.js'
import { BROKER_TO_HRC_KIND } from './types.js'
import type { BrokerVerifyStore } from './store.js'

type ComparableBrokerEvent = {
  row: BrokerEventRow
  type: string
  correlationKey?: string | undefined
  normalizedPayload: unknown
  payloadHash: string
  text?: string | undefined
}

export function verifyInvocation(input: {
  store: BrokerVerifyStore
  invocation: BrokerInvocation
  events: BrokerEventRow[]
  transcript?: ProviderTranscript | undefined
  strictText: boolean
}): BrokerVerifyReport {
  const issues: VerificationIssue[] = []
  const ledger = checkLedger(input.invocation, input.events, issues)
  const rawMirror = checkRawMirrors(input.store, input.events, issues)
  const providerMatches =
    input.transcript === undefined
      ? []
      : compareTranscript(input.transcript, input.events, input.strictText, issues)
  const lifecycle = checkLifecycle(input.store, input.events)
  if (input.transcript !== undefined) {
    for (const warning of input.transcript.warnings) {
      issues.push({ severity: 'warning', code: 'provider_jsonl_warning', message: warning })
    }
  }

  const ok = !issues.some((issue) => issue.severity === 'error')
  return {
    ok,
    invocationId: input.invocation.invocationId,
    brokerDriver: input.invocation.brokerDriver,
    brokerProtocol: input.invocation.brokerProtocol,
    runtimeId: input.invocation.runtimeId,
    ...(input.invocation.runId !== undefined ? { runId: input.invocation.runId } : {}),
    ...(input.transcript !== undefined ? { jsonlPath: input.transcript.path } : {}),
    ...(input.transcript !== undefined ? { transcript: input.transcript } : {}),
    ledger,
    rawMirror,
    providerMatches,
    lifecycle,
    issues,
  }
}

function checkLedger(
  invocation: BrokerInvocation,
  events: BrokerEventRow[],
  issues: VerificationIssue[]
): BrokerVerifyReport['ledger'] {
  const statuses: Record<string, number> = {}
  let previousSeq: number | undefined
  const seen = new Set<number>()

  for (const row of events) {
    statuses[row.projectionStatus] = (statuses[row.projectionStatus] ?? 0) + 1
    if (row.runtimeId !== invocation.runtimeId) {
      issues.push({
        severity: 'error',
        code: 'runtime_identity_mismatch',
        message: `broker seq ${row.seq} runtime_id ${row.runtimeId} does not match invocation runtime ${invocation.runtimeId}`,
        seq: row.seq,
        type: row.type,
      })
    }
    if (
      invocation.runId !== undefined &&
      row.runId !== undefined &&
      row.runId !== invocation.runId
    ) {
      issues.push({
        severity: 'warning',
        code: 'run_identity_differs_from_current_invocation',
        message: `broker seq ${row.seq} run_id ${row.runId} differs from current invocation run ${invocation.runId}; this is valid for prior turns in a multi-turn invocation`,
        seq: row.seq,
        type: row.type,
      })
    }
    if (row.projectionStatus !== 'applied') {
      issues.push({
        severity: 'error',
        code: 'projection_not_applied',
        message: `broker seq ${row.seq} projection_status is ${row.projectionStatus}`,
        seq: row.seq,
        type: row.type,
      })
    }
    if (seen.has(row.seq)) {
      issues.push({
        severity: 'error',
        code: 'duplicate_seq',
        message: `broker seq ${row.seq} appears more than once in query result`,
        seq: row.seq,
        type: row.type,
      })
    }
    seen.add(row.seq)
    if (previousSeq !== undefined && row.seq !== previousSeq + 1) {
      issues.push({
        severity: 'error',
        code: 'seq_hole',
        message: `broker seq jumps from ${previousSeq} to ${row.seq}`,
        seq: row.seq,
        type: row.type,
      })
    }
    previousSeq = row.seq
  }

  return {
    eventCount: events.length,
    ...(events[0] !== undefined ? { firstSeq: events[0].seq } : {}),
    ...(events.at(-1) !== undefined ? { lastSeq: events.at(-1)!.seq } : {}),
    statuses,
  }
}

function checkRawMirrors(
  store: BrokerVerifyStore,
  events: BrokerEventRow[],
  issues: VerificationIssue[]
): BrokerVerifyReport['rawMirror'] {
  let matched = 0
  for (const row of events) {
    if (row.hrcEventSeq === undefined) {
      issues.push({
        severity: 'error',
        code: 'raw_mirror_seq_missing',
        message: `broker seq ${row.seq} has no hrc_event_seq raw mirror link`,
        seq: row.seq,
        type: row.type,
      })
      continue
    }
    const raw = store.getRawMirror(row.hrcEventSeq)
    if (raw === undefined) {
      issues.push({
        severity: 'error',
        code: 'raw_mirror_missing',
        message: `events.seq ${row.hrcEventSeq} missing for broker seq ${row.seq}`,
        seq: row.seq,
        eventSeq: row.hrcEventSeq,
        type: row.type,
      })
      continue
    }
    const errors = rawMirrorErrors(row, raw)
    if (errors.length === 0) {
      matched += 1
      continue
    }
    for (const message of errors) {
      issues.push({
        severity: 'error',
        code: 'raw_mirror_mismatch',
        message,
        seq: row.seq,
        eventSeq: raw.seq,
        type: row.type,
      })
    }
  }
  return { checked: events.length, matched }
}

function rawMirrorErrors(row: BrokerEventRow, raw: RawMirrorRow): string[] {
  const errors: string[] = []
  if (raw.source !== 'broker') {
    errors.push(`events.seq ${raw.seq} source is ${raw.source}, expected broker`)
  }
  if (raw.eventKind !== `broker.${row.type}`) {
    errors.push(`events.seq ${raw.seq} event_kind is ${raw.eventKind}, expected broker.${row.type}`)
  }
  if (!isRecord(raw.eventJson)) {
    errors.push(`events.seq ${raw.seq} event_json is not an object`)
    return errors
  }
  if (raw.eventJson['invocationId'] !== row.invocationId) {
    errors.push(`events.seq ${raw.seq} invocationId mismatch`)
  }
  if (raw.eventJson['seq'] !== row.seq) {
    errors.push(`events.seq ${raw.seq} broker seq mismatch`)
  }
  if (raw.eventJson['type'] !== row.type) {
    errors.push(`events.seq ${raw.seq} broker type mismatch`)
  }
  if (canonicalJson(raw.eventJson['payload']) !== canonicalJson(row.brokerEventJson)) {
    errors.push(`events.seq ${raw.seq} payload mismatch`)
  }
  return errors
}

function compareTranscript(
  transcript: ProviderTranscript,
  brokerRows: BrokerEventRow[],
  strictText: boolean,
  issues: VerificationIssue[]
): ProviderMatch[] {
  const broker = brokerRows.map(toComparableBrokerEvent)
  const used = new Set<number>()
  const matches: ProviderMatch[] = []

  for (const observed of transcript.observed) {
    const match = findBrokerMatch(observed.type, observed.correlationKey, observed.payloadHash, broker, used)
    if (match === undefined) {
      matches.push({
        line: observed.line,
        type: observed.type,
        ...(observed.correlationKey !== undefined ? { correlationKey: observed.correlationKey } : {}),
        status: 'missing',
        detail: 'no broker_invocation_events row matched event class, correlation key, and normalized payload',
      })
      issues.push({
        severity: 'error',
        code: 'provider_event_missing_in_broker',
        message: `provider JSONL line ${observed.line} ${observed.type} missing from broker ledger`,
        line: observed.line,
        type: observed.type,
      })
      continue
    }

    used.add(match.row.seq)
    if (match.payloadHash !== observed.payloadHash && payloadsCompatible(observed.normalizedPayload, match.normalizedPayload)) {
      matches.push({
        line: observed.line,
        type: observed.type,
        ...(observed.correlationKey !== undefined ? { correlationKey: observed.correlationKey } : {}),
        brokerSeq: match.row.seq,
        status: 'matched',
        detail: 'normalized payloads are compatible after provider truncation normalization',
      })
      continue
    }

    if (
      observed.type === 'assistant.message.completed' &&
      match.payloadHash !== observed.payloadHash &&
      !strictText
    ) {
      matches.push({
        line: observed.line,
        type: observed.type,
        ...(observed.correlationKey !== undefined ? { correlationKey: observed.correlationKey } : {}),
        brokerSeq: match.row.seq,
        status: 'text-mismatch-tolerated',
        detail: 'assistant text differs; pass --strict-text to fail this',
      })
      issues.push({
        severity: 'warning',
        code: 'assistant_text_mismatch_tolerated',
        message: `provider JSONL line ${observed.line} assistant text differs from broker seq ${match.row.seq}`,
        line: observed.line,
        seq: match.row.seq,
        type: observed.type,
      })
      continue
    }

    if (match.payloadHash !== observed.payloadHash) {
      matches.push({
        line: observed.line,
        type: observed.type,
        ...(observed.correlationKey !== undefined ? { correlationKey: observed.correlationKey } : {}),
        brokerSeq: match.row.seq,
        status: 'divergent',
        detail: 'normalized payload hash differs',
      })
      issues.push({
        severity: 'error',
        code: 'provider_event_payload_divergent',
        message: `provider JSONL line ${observed.line} payload differs from broker seq ${match.row.seq}`,
        line: observed.line,
        seq: match.row.seq,
        type: observed.type,
      })
      continue
    }

    matches.push({
      line: observed.line,
      type: observed.type,
      ...(observed.correlationKey !== undefined ? { correlationKey: observed.correlationKey } : {}),
      brokerSeq: match.row.seq,
      status: 'matched',
    })
  }

  return matches
}

function findBrokerMatch(
  type: string,
  correlationKey: string | undefined,
  payloadHash: string,
  broker: ComparableBrokerEvent[],
  used: Set<number>
): ComparableBrokerEvent | undefined {
  const candidates = broker.filter((item) => item.type === type && !used.has(item.row.seq))
  if (correlationKey !== undefined) {
    const keyed = candidates.filter((item) => item.correlationKey === correlationKey)
    return keyed.find((item) => item.payloadHash === payloadHash) ?? keyed[0]
  }
  return candidates.find((item) => item.payloadHash === payloadHash) ?? candidates[0]
}

function checkLifecycle(store: BrokerVerifyStore, rows: BrokerEventRow[]): LifecycleCheck[] {
  const out: LifecycleCheck[] = []
  for (const row of rows) {
    const lifecycleKind = BROKER_TO_HRC_KIND[row.type]
    if (lifecycleKind === undefined) {
      out.push({ brokerSeq: row.seq, brokerType: row.type, status: 'not-applicable' })
      continue
    }
    const lifecycle = store.findLifecycle({
      runtimeId: row.runtimeId,
      ...(row.runId !== undefined ? { runId: row.runId } : {}),
      ...(row.harnessGeneration !== undefined ? { generation: row.harnessGeneration } : {}),
      eventKind: lifecycleKind,
    })
    if (lifecycle === undefined) {
      out.push({
        brokerSeq: row.seq,
        brokerType: row.type,
        lifecycleKind,
        status: 'inconclusive',
      })
      continue
    }
    out.push({
      brokerSeq: row.seq,
      brokerType: row.type,
      lifecycleKind,
      status: 'present',
      hrcSeq: lifecycle.hrcSeq,
    })
  }
  return out
}

function toComparableBrokerEvent(row: BrokerEventRow): ComparableBrokerEvent {
  const payload = isRecord(row.brokerEventJson) ? row.brokerEventJson : {}
  switch (row.type) {
    case 'user.message': {
      const text = compactText(typeof payload['content'] === 'string' ? payload['content'] : undefined)
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
      const text = compactText(textFromContent(payload['content']) ?? textFromContent(payload['message']))
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
        normalizedPayload: row.brokerEventJson,
        payloadHash: hashPayload(row.brokerEventJson),
      }
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeBrokerToolResult(value: unknown): unknown {
  if (isRecord(value) && typeof value['output'] === 'string') {
    return { output: normalizeCommandOutputText(value['output']) }
  }
  return value
}

function normalizeBrokerToolInput(value: unknown): unknown {
  if (!isRecord(value)) return value ?? {}
  const command = typeof value['command'] === 'string' ? unwrapZshCommand(value['command']) : undefined
  const cwd = typeof value['cwd'] === 'string' ? value['cwd'] : undefined
  if (command !== undefined || cwd !== undefined) {
    return {
      ...(command !== undefined ? { cmd: command } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    }
  }
  return value
}

function unwrapZshCommand(command: string): string {
  const prefix = '/bin/zsh -lc '
  if (!command.startsWith(prefix)) return command
  const raw = command.slice(prefix.length)
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    return raw.slice(1, -1).replace(/\\"/g, '"')
  }
  return raw
}

function payloadsCompatible(observed: unknown, broker: unknown): boolean {
  const observedOutput = outputText(observed)
  const brokerOutput = outputText(broker)
  if (observedOutput !== undefined && brokerOutput !== undefined) {
    return observedOutput.includes(brokerOutput) || brokerOutput.includes(observedOutput)
  }
  return false
}

function outputText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const result = value['result']
  if (!isRecord(result)) return undefined
  const output = result['output']
  return typeof output === 'string' ? output : undefined
}

function normalizeCommandOutputText(output: string): string {
  return output.replace(/^Total output lines: \d+\n\n/, '')
}
