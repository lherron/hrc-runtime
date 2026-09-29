import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseProviderTranscript } from './provider-transcript.js'
import {
  CAPTURE_VERIFIER_SCHEMA,
  type CaptureVerificationFinding,
  type CaptureVerificationReport,
  type CaptureVerificationStore,
  type ProviderTranscriptArtifact,
  type ProviderTranscriptArtifactHashStatus,
  type VerificationCandidate,
  type VerifyInvocationInput,
} from './types.js'
import {
  buildAnalytics,
  buildLifecycleAnalytics,
  emptyRawEventsAnalytics,
} from './verifier-analytics.js'
import { checkLedger, checkLifecycle, checkRawMirrors } from './verifier-checks.js'
import { compareTranscript } from './verifier-transcript.js'

export { lifecycleKey } from './verifier-normalize.js'

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
