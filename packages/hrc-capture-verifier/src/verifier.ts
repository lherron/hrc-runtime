import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  BROKER_TO_HRC_LIFECYCLE_POLICY_HASH,
  BROKER_TO_HRC_LIFECYCLE_POLICY_ID,
  lifecycleKindForBrokerEvent,
} from 'hrc-core'

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
  type CaptureVerificationAnalytics,
  type CaptureVerificationFinding,
  type CaptureVerificationReport,
  type CaptureVerificationStore,
  type InvocationCaptureSnapshot,
  type LifecycleCheck,
  type LifecycleProjectionAnalytics,
  type ProviderJsonlAnalytics,
  type ProviderObservationMatch,
  type ProviderTranscriptArtifact,
  type ProviderTranscriptArtifactHashStatus,
  type RawEventsAnalytics,
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

type LedgerCheckResult = {
  ledger: CaptureVerificationReport['ledger']
  analytics: CaptureVerificationAnalytics['brokerLedger']
}

type RawMirrorCheckResult = {
  rawMirror: CaptureVerificationReport['rawMirror']
  analytics: RawEventsAnalytics
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
  const findings: CaptureVerificationFinding[] = []
  const autoResolvedArtifact =
    input.transcript === undefined && input.transcriptPath === undefined
      ? await resolveAutoTranscriptArtifact(snapshot.transcriptArtifact, findings)
      : undefined
  const transcript =
    input.transcript ??
    (input.transcriptPath !== undefined
      ? await parseProviderTranscript({ path: input.transcriptPath })
      : autoResolvedArtifact?.transcript)

  const ledgerCheck = checkLedger(snapshot.invocation, snapshot.brokerEvents, findings)
  const rawMirrorCheck = checkRawMirrors(snapshot, findings)
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
  const lifecycleAnalytics = buildLifecycleAnalytics(lifecycle, ledgerCheck.analytics.eventCount)
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
  const analytics = buildAnalytics({
    transcript,
    brokerLedger: ledgerCheck.analytics,
    rawEvents: rawMirrorCheck.analytics,
    lifecycleProjection: lifecycleAnalytics,
    providerMatches,
  })

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
    ...(autoResolvedArtifact?.artifact !== undefined
      ? { transcriptArtifact: autoResolvedArtifact.artifact }
      : {}),
    ledger: ledgerCheck.ledger,
    rawMirror: rawMirrorCheck.rawMirror,
    providerMatches,
    lifecycle,
    findings,
    analytics,
  }
}

async function resolveAutoTranscriptArtifact(
  artifact: ProviderTranscriptArtifact | undefined,
  findings: CaptureVerificationFinding[]
): Promise<
  | {
      artifact: ProviderTranscriptArtifact
      transcript?: Awaited<ReturnType<typeof parseProviderTranscript>> | undefined
    }
  | undefined
> {
  if (artifact === undefined) return undefined

  let bytes: Buffer
  try {
    bytes = await readFile(artifact.path)
  } catch {
    const next = { ...artifact, hashStatus: 'unreadable' as const }
    findings.push({
      schema: CAPTURE_VERIFIER_SCHEMA,
      severity: 'warning',
      layer: 'provider-provenance',
      code: 'transcript_artifact_unreadable',
      message: `stored provider transcript artifact is unreadable: ${artifact.path}`,
      sourceRef: artifact.artifactId,
    })
    return { artifact: next }
  }

  const currentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const hashStatus: ProviderTranscriptArtifactHashStatus =
    currentHash === artifact.storedHash ? 'matched' : 'mismatched'
  const next = { ...artifact, currentHash, hashStatus }
  if (hashStatus === 'mismatched') {
    findings.push({
      schema: CAPTURE_VERIFIER_SCHEMA,
      severity: 'warning',
      layer: 'provider-provenance',
      code: 'transcript_artifact_hash_mismatch',
      message: `stored provider transcript hash ${artifact.storedHash} differs from current ${currentHash}: ${artifact.path}`,
      sourceRef: artifact.artifactId,
    })
  }

  try {
    return { artifact: next, transcript: await parseProviderTranscript({ path: artifact.path }) }
  } catch (error) {
    findings.push({
      schema: CAPTURE_VERIFIER_SCHEMA,
      severity: 'warning',
      layer: 'provider-provenance',
      code: 'transcript_artifact_parse_failed',
      message: `stored provider transcript artifact could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      sourceRef: artifact.artifactId,
    })
    return { artifact: next }
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
    analytics: buildAnalytics({
      brokerLedger: {
        invocationId,
        eventCount: 0,
        seqHoleCount: 0,
        duplicateSeqCount: 0,
        statuses: {},
        eventsByType: {},
        runtimeIdentityMismatchCount: 0,
        runDivergenceWarningCount: 0,
        staleGenerationCount: 0,
        staleAttemptCount: 0,
      },
      rawEvents: emptyRawEventsAnalytics(),
      lifecycleProjection: buildLifecycleAnalytics([], 0),
      providerMatches: [],
    }),
  }
}

function checkLedger(
  invocation: BrokerInvocationCapture,
  events: BrokerCaptureEvent[],
  findings: CaptureVerificationFinding[]
): LedgerCheckResult {
  const statuses: Record<string, number> = {}
  const eventsByType: Record<string, number> = {}
  let previousSeq: number | undefined
  const seen = new Set<number>()
  let seqHoleCount = 0
  let duplicateSeqCount = 0
  let runtimeIdentityMismatchCount = 0
  let runDivergenceWarningCount = 0
  let staleGenerationCount = 0
  let staleAttemptCount = 0

  for (const row of events) {
    statuses[row.projectionStatus] = (statuses[row.projectionStatus] ?? 0) + 1
    eventsByType[row.type] = (eventsByType[row.type] ?? 0) + 1
    if (row.runtimeId !== invocation.runtimeId) {
      runtimeIdentityMismatchCount += 1
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
      runDivergenceWarningCount += 1
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
      duplicateSeqCount += 1
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
    if (previousSeq !== undefined && row.seq > previousSeq + 1) {
      seqHoleCount += 1
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
    if (
      invocation.currentHarnessGeneration !== undefined &&
      row.harnessGeneration !== undefined &&
      row.harnessGeneration !== invocation.currentHarnessGeneration
    ) {
      staleGenerationCount += 1
    }
    if (
      invocation.currentTurnAttempt !== undefined &&
      row.turnAttempt !== undefined &&
      row.turnAttempt !== invocation.currentTurnAttempt
    ) {
      staleAttemptCount += 1
    }
    previousSeq = row.seq
  }

  const last = events.at(-1)
  const ledger = {
    eventCount: events.length,
    ...(events[0] !== undefined ? { firstSeq: events[0].seq } : {}),
    ...(last !== undefined ? { lastSeq: last.seq } : {}),
    statuses,
  }
  return {
    ledger,
    analytics: {
      invocationId: invocation.invocationId,
      eventCount: events.length,
      ...(events[0] !== undefined ? { firstSeq: events[0].seq } : {}),
      ...(last !== undefined ? { lastSeq: last.seq } : {}),
      seqHoleCount,
      duplicateSeqCount,
      statuses,
      eventsByType,
      runtimeIdentityMismatchCount,
      runDivergenceWarningCount,
      staleGenerationCount,
      staleAttemptCount,
    },
  }
}

function checkRawMirrors(
  snapshot: InvocationCaptureSnapshot,
  findings: CaptureVerificationFinding[]
): RawMirrorCheckResult {
  const analytics = emptyRawEventsAnalytics()
  analytics.expectedFromBroker = snapshot.brokerEvents.length
  let matched = 0
  for (const row of snapshot.brokerEvents) {
    if (row.projectionStatus === 'applied') {
      analytics.appliedBrokerRows += 1
    }
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
    analytics.linkedByHrcEventSeq += 1
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
    analytics.found += 1
    const check = rawMirrorCheck(row, raw)
    addRawMirrorFieldCounts(analytics, check)
    if (check.messages.length === 0) {
      matched += 1
      continue
    }
    analytics.mismatched += 1
    for (const message of check.messages) {
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
  analytics.matched = matched
  analytics.missing = analytics.expectedFromBroker - analytics.found
  return { rawMirror: { checked: snapshot.brokerEvents.length, matched }, analytics }
}

type RawMirrorFieldCheck = {
  messages: string[]
  wrongSource: number
  wrongEventKind: number
  wrongInvocation: number
  wrongSeq: number
  wrongType: number
  payloadMismatch: number
  malformedEventJson: number
  malformedPayload: number
}

function rawMirrorCheck(row: BrokerCaptureEvent, raw: RawMirrorEvent): RawMirrorFieldCheck {
  const check: RawMirrorFieldCheck = {
    messages: [],
    wrongSource: 0,
    wrongEventKind: 0,
    wrongInvocation: 0,
    wrongSeq: 0,
    wrongType: 0,
    payloadMismatch: 0,
    malformedEventJson: 0,
    malformedPayload: 0,
  }
  if (raw.source !== 'broker') {
    check.wrongSource += 1
    check.messages.push(`events.seq ${raw.seq} source is ${raw.source}, expected broker`)
  }
  if (raw.eventKind !== `broker.${row.type}`) {
    check.wrongEventKind += 1
    check.messages.push(
      `events.seq ${raw.seq} event_kind is ${raw.eventKind}, expected broker.${row.type}`
    )
  }
  if (!isRecord(raw.eventJson)) {
    check.malformedEventJson += 1
    check.messages.push(`events.seq ${raw.seq} event_json is not an object`)
    return check
  }
  if (raw.eventJson['invocationId'] !== row.invocationId) {
    check.wrongInvocation += 1
    check.messages.push(`events.seq ${raw.seq} invocationId mismatch`)
  }
  if (raw.eventJson['seq'] !== row.seq) {
    check.wrongSeq += 1
    check.messages.push(`events.seq ${raw.seq} broker seq mismatch`)
  }
  if (raw.eventJson['type'] !== row.type) {
    check.wrongType += 1
    check.messages.push(`events.seq ${raw.seq} broker type mismatch`)
  }
  if (!Object.hasOwn(raw.eventJson, 'payload')) {
    check.malformedPayload += 1
    check.messages.push(`events.seq ${raw.seq} payload is missing`)
    return check
  }
  if (canonicalJson(raw.eventJson['payload']) !== canonicalJson(row.payload)) {
    check.payloadMismatch += 1
    check.messages.push(`events.seq ${raw.seq} payload mismatch`)
  }
  return check
}

function addRawMirrorFieldCounts(analytics: RawEventsAnalytics, check: RawMirrorFieldCheck): void {
  analytics.wrongSource += check.wrongSource
  analytics.wrongEventKind += check.wrongEventKind
  analytics.wrongInvocation += check.wrongInvocation
  analytics.wrongSeq += check.wrongSeq
  analytics.wrongType += check.wrongType
  analytics.payloadMismatch += check.payloadMismatch
  analytics.malformedEventJson += check.malformedEventJson
  analytics.malformedPayload += check.malformedPayload
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
    if (isSuppressedLifecycleProjection(snapshot.invocation, row)) {
      out.push({
        brokerSeq: row.seq,
        brokerType: row.type,
        lifecycleKind,
        status: 'suppressed',
      })
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

function isSuppressedLifecycleProjection(
  invocation: BrokerInvocationCapture,
  row: BrokerCaptureEvent
): boolean {
  return (
    (invocation.currentHarnessGeneration !== undefined &&
      row.harnessGeneration !== undefined &&
      row.harnessGeneration !== invocation.currentHarnessGeneration) ||
    (invocation.currentTurnAttempt !== undefined &&
      row.turnAttempt !== undefined &&
      row.turnAttempt !== invocation.currentTurnAttempt)
  )
}

function buildAnalytics(input: {
  transcript?: VerifyInvocationInput['transcript'] | undefined
  brokerLedger: CaptureVerificationAnalytics['brokerLedger']
  rawEvents: RawEventsAnalytics
  lifecycleProjection: LifecycleProjectionAnalytics
  providerMatches: ProviderObservationMatch[]
}): CaptureVerificationAnalytics {
  return {
    schema: CAPTURE_VERIFIER_SCHEMA,
    ...(input.transcript !== undefined
      ? { providerJsonl: providerJsonlAnalytics(input.transcript) }
      : {}),
    brokerLedger: input.brokerLedger,
    rawEvents: input.rawEvents,
    lifecycleProjection: input.lifecycleProjection,
    crossSink: {
      ...(input.transcript !== undefined
        ? { providerToBroker: providerToBrokerAnalytics(input.providerMatches) }
        : {}),
      brokerToRaw: {
        expected: input.rawEvents.expectedFromBroker,
        matched: input.rawEvents.matched,
        missing: input.rawEvents.missing,
        mismatched: input.rawEvents.mismatched,
      },
      brokerToLifecycle: {
        expected: input.lifecycleProjection.expected,
        present: input.lifecycleProjection.present,
        missing: input.lifecycleProjection.missing,
        suppressed: input.lifecycleProjection.suppressed,
        notApplicable: input.lifecycleProjection.notApplicable,
      },
    },
  }
}

function providerJsonlAnalytics(
  transcript: NonNullable<VerifyInvocationInput['transcript']>
): ProviderJsonlAnalytics {
  return {
    path: transcript.path,
    provider: transcript.provider,
    totalLines: transcript.totalLines,
    parsedRecords: transcript.parsedRecords,
    invalidJsonRecords: transcript.invalidJsonRecords,
    applicableObservations: transcript.applicableObservations,
    ignoredRecords: transcript.ignoredRecords,
    unsupportedRecords: transcript.unsupportedRecords,
    unknownRecords: transcript.unknownRecords,
    warningCount: transcript.warningCount,
    observationsByType: transcript.observationsByType,
  }
}

function providerToBrokerAnalytics(
  matches: ProviderObservationMatch[]
): NonNullable<CaptureVerificationAnalytics['crossSink']['providerToBroker']> {
  const out = {
    expected: matches.length,
    matched: 0,
    missing: 0,
    divergent: 0,
    textMismatchTolerated: 0,
  }
  for (const match of matches) {
    switch (match.status) {
      case 'matched':
        out.matched += 1
        break
      case 'missing':
        out.missing += 1
        break
      case 'divergent':
        out.divergent += 1
        break
      case 'text-mismatch-tolerated':
        out.textMismatchTolerated += 1
        break
    }
  }
  return out
}

function buildLifecycleAnalytics(
  lifecycle: LifecycleCheck[],
  checkedBrokerEvents: number
): LifecycleProjectionAnalytics {
  const out: LifecycleProjectionAnalytics = {
    policyId: BROKER_TO_HRC_LIFECYCLE_POLICY_ID,
    policyVersion: 'v1',
    policyHash: BROKER_TO_HRC_LIFECYCLE_POLICY_HASH,
    checkedBrokerEvents,
    policyMapped: 0,
    expected: 0,
    present: 0,
    missing: 0,
    suppressed: 0,
    notApplicable: 0,
    byBrokerType: {},
    byLifecycleKind: {},
  }

  for (const item of lifecycle) {
    let brokerBucket = out.byBrokerType[item.brokerType]
    if (brokerBucket === undefined) {
      brokerBucket = {
        policyMapped: 0,
        expected: 0,
        present: 0,
        missing: 0,
        suppressed: 0,
        notApplicable: 0,
      }
      out.byBrokerType[item.brokerType] = brokerBucket
    }
    if (item.status === 'not_applicable') {
      out.notApplicable += 1
      brokerBucket.notApplicable += 1
      continue
    }

    out.policyMapped += 1
    brokerBucket.policyMapped += 1

    const lifecycleKind = item.lifecycleKind ?? 'unknown'
    let kindBucket = out.byLifecycleKind[lifecycleKind]
    if (kindBucket === undefined) {
      kindBucket = {
        expected: 0,
        present: 0,
        missing: 0,
        suppressed: 0,
      }
      out.byLifecycleKind[lifecycleKind] = kindBucket
    }

    if (item.status === 'suppressed') {
      out.suppressed += 1
      brokerBucket.suppressed += 1
      kindBucket.suppressed += 1
      continue
    }

    out.expected += 1
    brokerBucket.expected += 1
    kindBucket.expected += 1

    if (item.status === 'present') {
      out.present += 1
      brokerBucket.present += 1
      kindBucket.present += 1
    } else {
      out.missing += 1
      brokerBucket.missing += 1
      kindBucket.missing += 1
    }
  }

  return out
}

function emptyRawEventsAnalytics(): RawEventsAnalytics {
  return {
    expectedFromBroker: 0,
    appliedBrokerRows: 0,
    linkedByHrcEventSeq: 0,
    found: 0,
    matched: 0,
    missing: 0,
    mismatched: 0,
    wrongSource: 0,
    wrongEventKind: 0,
    wrongInvocation: 0,
    wrongSeq: 0,
    wrongType: 0,
    payloadMismatch: 0,
    malformedEventJson: 0,
    malformedPayload: 0,
  }
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
