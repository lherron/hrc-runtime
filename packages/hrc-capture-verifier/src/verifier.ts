import { lifecycleKindForBrokerEvent } from 'hrc-core'

import {
  canonicalJson,
  compactText,
  hashPayload,
  isRecord,
  safeJsonParse,
  textFromContent,
} from './json.js'
import { parseProviderTranscript } from './provider-transcript.js'
import {
  type BrokerCaptureEvent,
  type BrokerInvocationCapture,
  CAPTURE_VERIFIER_SCHEMA,
  type CaptureObservation,
  type CaptureVerificationFinding,
  type CaptureVerificationReport,
  type CaptureVerificationStore,
  type InvocationCaptureSnapshot,
  type LifecycleCheck,
  type ProviderObservationMatch,
  type RawMirrorEvent,
  type VerificationCandidate,
  type VerifyInvocationInput,
} from './types.js'

type ComparableBrokerEvent = {
  row: BrokerCaptureEvent
  type: string
  correlationKey?: string | undefined
  normalizedPayload: unknown
  payloadHash: string
  text?: string | undefined
}

export async function listVerificationCandidates(input: {
  store: CaptureVerificationStore
  scopeRef: string
  limit?: number | undefined
  since?: string | undefined
  until?: string | undefined
}): Promise<VerificationCandidate[]> {
  return input.store.listVerificationCandidates({
    scopeRef: input.scopeRef,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
  })
}

export async function verifyInvocation(
  input: VerifyInvocationInput
): Promise<CaptureVerificationReport> {
  const snapshot = await input.store.loadInvocationCapture({ invocationId: input.invocationId })
  if (snapshot === undefined) {
    return missingInvocationReport(input.invocationId)
  }
  const transcript =
    input.transcript ??
    (input.transcriptPath !== undefined
      ? await parseProviderTranscript({ path: input.transcriptPath })
      : undefined)

  const findings: CaptureVerificationFinding[] = []
  const ledger = checkLedger(snapshot.invocation, snapshot.brokerEvents, findings)
  const rawMirror = checkRawMirrors(snapshot, findings)
  const providerMatches =
    transcript === undefined
      ? []
      : compareTranscript(
          transcript.observations,
          snapshot.brokerEvents,
          input.strictText ?? false,
          findings
        )
  const lifecycle = checkLifecycle(snapshot, findings)
  if (transcript !== undefined) {
    for (const warning of transcript.warnings) {
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'warning',
        layer: 'provider',
        code: 'provider_jsonl_warning',
        message: warning,
      })
    }
  }

  const hasErrors = findings.some((finding) => finding.severity === 'error')
  const hasInconclusive = lifecycle.some((item) => item.status === 'missing')
  return {
    schema: CAPTURE_VERIFIER_SCHEMA,
    status: hasErrors ? 'fail' : hasInconclusive ? 'inconclusive' : 'pass',
    ok: !hasErrors,
    invocationId: snapshot.invocation.invocationId,
    brokerDriver: snapshot.invocation.brokerDriver,
    brokerProtocol: snapshot.invocation.brokerProtocol,
    runtimeId: snapshot.invocation.runtimeId,
    ...(snapshot.invocation.runId !== undefined ? { runId: snapshot.invocation.runId } : {}),
    ...(transcript !== undefined ? { transcriptPath: transcript.path, transcript } : {}),
    ledger,
    rawMirror,
    providerMatches,
    lifecycle,
    findings,
  }
}

function missingInvocationReport(invocationId: string): CaptureVerificationReport {
  return {
    schema: CAPTURE_VERIFIER_SCHEMA,
    status: 'fail',
    ok: false,
    invocationId,
    brokerDriver: 'unknown',
    brokerProtocol: 'unknown',
    runtimeId: 'unknown',
    ledger: { eventCount: 0, statuses: {} },
    rawMirror: { checked: 0, matched: 0 },
    providerMatches: [],
    lifecycle: [],
    findings: [
      {
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'broker-ledger',
        code: 'invocation_not_found',
        message: `broker invocation not found: ${invocationId}`,
      },
    ],
  }
}

function checkLedger(
  invocation: BrokerInvocationCapture,
  events: BrokerCaptureEvent[],
  findings: CaptureVerificationFinding[]
): CaptureVerificationReport['ledger'] {
  const statuses: Record<string, number> = {}
  let previousSeq: number | undefined
  const seen = new Set<number>()

  for (const row of events) {
    statuses[row.projectionStatus] = (statuses[row.projectionStatus] ?? 0) + 1
    if (row.runtimeId !== invocation.runtimeId) {
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'broker-ledger',
        code: 'runtime_identity_mismatch',
        message: `broker seq ${row.seq} runtime_id ${row.runtimeId} does not match invocation runtime ${invocation.runtimeId}`,
        brokerSeq: row.seq,
        type: row.type,
      })
    }
    if (
      invocation.runId !== undefined &&
      row.runId !== undefined &&
      row.runId !== invocation.runId
    ) {
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'warning',
        layer: 'broker-ledger',
        code: 'run_identity_differs_from_current_invocation',
        message: `broker seq ${row.seq} run_id ${row.runId} differs from current invocation run ${invocation.runId}; this is valid for prior turns in a multi-turn invocation`,
        brokerSeq: row.seq,
        type: row.type,
      })
    }
    if (row.projectionStatus !== 'applied') {
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'broker-ledger',
        code: 'projection_not_applied',
        message: `broker seq ${row.seq} projection_status is ${row.projectionStatus}`,
        brokerSeq: row.seq,
        type: row.type,
      })
    }
    if (seen.has(row.seq)) {
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'broker-ledger',
        code: 'duplicate_seq',
        message: `broker seq ${row.seq} appears more than once in query result`,
        brokerSeq: row.seq,
        type: row.type,
      })
    }
    seen.add(row.seq)
    if (previousSeq !== undefined && row.seq !== previousSeq + 1) {
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'broker-ledger',
        code: 'seq_hole',
        message: `broker seq jumps from ${previousSeq} to ${row.seq}`,
        brokerSeq: row.seq,
        type: row.type,
      })
    }
    previousSeq = row.seq
  }

  const last = events.at(-1)
  return {
    eventCount: events.length,
    ...(events[0] !== undefined ? { firstSeq: events[0].seq } : {}),
    ...(last !== undefined ? { lastSeq: last.seq } : {}),
    statuses,
  }
}

function checkRawMirrors(
  snapshot: InvocationCaptureSnapshot,
  findings: CaptureVerificationFinding[]
): CaptureVerificationReport['rawMirror'] {
  let matched = 0
  for (const row of snapshot.brokerEvents) {
    if (row.hrcEventSeq === undefined) {
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'raw-mirror',
        code: 'raw_mirror_seq_missing',
        message: `broker seq ${row.seq} has no hrc_event_seq raw mirror link`,
        brokerSeq: row.seq,
        type: row.type,
      })
      continue
    }
    const raw = snapshot.rawMirrors[row.hrcEventSeq]
    if (raw === undefined) {
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'raw-mirror',
        code: 'raw_mirror_missing',
        message: `events.seq ${row.hrcEventSeq} missing for broker seq ${row.seq}`,
        brokerSeq: row.seq,
        rawEventSeq: row.hrcEventSeq,
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
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'raw-mirror',
        code: 'raw_mirror_mismatch',
        message,
        brokerSeq: row.seq,
        rawEventSeq: raw.seq,
        type: row.type,
      })
    }
  }
  return { checked: snapshot.brokerEvents.length, matched }
}

function rawMirrorErrors(row: BrokerCaptureEvent, raw: RawMirrorEvent): string[] {
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
  if (canonicalJson(raw.eventJson['payload']) !== canonicalJson(row.payload)) {
    errors.push(`events.seq ${raw.seq} payload mismatch`)
  }
  return errors
}

function compareTranscript(
  observations: CaptureObservation[],
  brokerRows: BrokerCaptureEvent[],
  strictText: boolean,
  findings: CaptureVerificationFinding[]
): ProviderObservationMatch[] {
  const broker = brokerRows.map(toComparableBrokerEvent)
  const used = new Set<number>()
  const matches: ProviderObservationMatch[] = []

  for (const observed of observations) {
    const match = findBrokerMatch(
      observed.type,
      observed.correlationKey,
      observed.payloadHash,
      broker,
      used
    )
    if (match === undefined) {
      matches.push({
        line: observed.line,
        type: observed.type,
        ...(observed.correlationKey !== undefined
          ? { correlationKey: observed.correlationKey }
          : {}),
        status: 'missing',
        detail:
          'no broker_invocation_events row matched event class, correlation key, and normalized payload',
      })
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'provider',
        code: 'provider_event_missing_in_broker',
        message: `provider JSONL line ${observed.line} ${observed.type} missing from broker ledger`,
        line: observed.line,
        brokerSeq: undefined,
        type: observed.type,
      })
      continue
    }

    used.add(match.row.seq)
    if (
      match.payloadHash !== observed.payloadHash &&
      payloadsCompatible(observed.normalizedPayload, match.normalizedPayload)
    ) {
      matches.push({
        line: observed.line,
        type: observed.type,
        ...(observed.correlationKey !== undefined
          ? { correlationKey: observed.correlationKey }
          : {}),
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
        ...(observed.correlationKey !== undefined
          ? { correlationKey: observed.correlationKey }
          : {}),
        brokerSeq: match.row.seq,
        status: 'text-mismatch-tolerated',
        detail: 'assistant text differs; pass --strict-text to fail this',
      })
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'warning',
        layer: 'provider',
        code: 'assistant_text_mismatch_tolerated',
        message: `provider JSONL line ${observed.line} assistant text differs from broker seq ${match.row.seq}`,
        line: observed.line,
        brokerSeq: match.row.seq,
        type: observed.type,
      })
      continue
    }

    if (match.payloadHash !== observed.payloadHash) {
      matches.push({
        line: observed.line,
        type: observed.type,
        ...(observed.correlationKey !== undefined
          ? { correlationKey: observed.correlationKey }
          : {}),
        brokerSeq: match.row.seq,
        status: 'divergent',
        detail: 'normalized payload hash differs',
      })
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'provider',
        code: 'provider_event_payload_divergent',
        message: `provider JSONL line ${observed.line} payload differs from broker seq ${match.row.seq}`,
        line: observed.line,
        brokerSeq: match.row.seq,
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

function checkLifecycle(
  snapshot: InvocationCaptureSnapshot,
  findings: CaptureVerificationFinding[]
): LifecycleCheck[] {
  const out: LifecycleCheck[] = []
  for (const row of snapshot.brokerEvents) {
    const lifecycleKind = lifecycleKindForBrokerEvent(row.type)
    if (lifecycleKind === undefined) {
      out.push({ brokerSeq: row.seq, brokerType: row.type, status: 'not_applicable' })
      continue
    }
    const lifecycle = snapshot.lifecycleProjections[lifecycleKey(row, lifecycleKind)]?.[0]
    if (lifecycle === undefined) {
      out.push({
        brokerSeq: row.seq,
        brokerType: row.type,
        lifecycleKind,
        status: 'missing',
      })
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'warning',
        layer: 'lifecycle',
        code: 'lifecycle_projection_missing',
        message: `broker seq ${row.seq} ${row.type} has no matching ${lifecycleKind} lifecycle projection`,
        brokerSeq: row.seq,
        type: row.type,
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

export function lifecycleKey(row: BrokerCaptureEvent, lifecycleKind: string): string {
  return JSON.stringify([
    row.runtimeId,
    row.runId ?? null,
    row.harnessGeneration ?? null,
    lifecycleKind,
  ])
}

function toComparableBrokerEvent(row: BrokerCaptureEvent): ComparableBrokerEvent {
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

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeBrokerToolResult(value: unknown): unknown {
  if (isRecord(value) && typeof value['output'] === 'string') {
    return { output: normalizeCommandOutputText(value['output']) }
  }
  if (isRecord(value) && Array.isArray(value['content'])) {
    return normalizeContentResult(value['content'])
  }
  return value
}

function normalizeBrokerToolInput(value: unknown): unknown {
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

function unwrapZshCommand(command: string): string {
  const prefix = '/bin/zsh -lc '
  if (!command.startsWith(prefix)) return command
  const raw = command.slice(prefix.length)
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1).replace(/\\"/g, '"')
  }
  return raw
}

function normalizeContentBlocks(value: unknown[]): unknown[] {
  return value.map((item) => normalizeContentBlock(item))
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

function payloadsCompatible(observed: unknown, broker: unknown): boolean {
  if (toolStartInputsCompatible(observed, broker)) {
    return true
  }
  const observedOutput = outputText(observed)
  const brokerOutput = outputText(broker)
  if (observedOutput !== undefined && brokerOutput !== undefined) {
    return outputsCompatible(observedOutput, brokerOutput)
  }
  if (exitCodesCompatible(observed, broker)) {
    return true
  }
  return false
}

function outputsCompatible(left: string, right: string): boolean {
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

function significantLinesOverlap(left: string, right: string): boolean {
  const leftLines = significantOutputLines(left)
  const rightLines = significantOutputLines(right)
  if (leftLines.length < 3 || rightLines.length < 3) {
    return false
  }
  const rightSet = new Set(rightLines)
  const common = leftLines.filter((line) => rightSet.has(line)).length
  return common >= 3 && common / Math.min(leftLines.length, rightLines.length) >= 0.5
}

function outputTextVariants(value: string): string[] {
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

function decodeJsonEscapedText(value: string): string {
  return value
    .replaceAll(String.raw`\r\n`, '\n')
    .replaceAll(String.raw`\n`, '\n')
    .replaceAll(String.raw`\t`, '\t')
    .replaceAll(String.raw`\"`, '"')
    .replaceAll(String.raw`\/`, '/')
}

function significantOutputLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function toolStartInputsCompatible(observed: unknown, broker: unknown): boolean {
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

function commandFingerprint(command: string): string[] {
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

function exitCodesCompatible(observed: unknown, broker: unknown): boolean {
  const observedExitCode = exitCodeFromResult(observed)
  const brokerExitCode = exitCodeFromResult(broker)
  return (
    observedExitCode !== undefined &&
    brokerExitCode !== undefined &&
    observedExitCode === brokerExitCode
  )
}

function exitCodeFromResult(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const result = value['result']
  if (!isRecord(result)) return undefined
  return typeof result['exitCode'] === 'number' ? result['exitCode'] : undefined
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
