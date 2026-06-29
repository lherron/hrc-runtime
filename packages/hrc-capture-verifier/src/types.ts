export const CAPTURE_VERIFIER_SCHEMA = 'hrc.capture-verifier/v1'
export const CAPTURE_OBSERVATION_SCHEMA = 'hrc.capture-observation/v1'

export type CaptureProvider = 'codex' | 'claude-code' | 'unknown'

export type CaptureObservationType =
  | 'user.message'
  | 'assistant.message.completed'
  | 'tool.call.started'
  | 'tool.call.completed'
  | 'tool.call.failed'

export type FindingSeverity = 'error' | 'warning' | 'info'
export type FindingLayer =
  | 'provider'
  | 'provider-provenance'
  | 'broker-ledger'
  | 'raw-mirror'
  | 'lifecycle'

export type ListVerificationCandidatesInput = {
  scopeRef: string
  limit?: number | undefined
  since?: string | undefined
  until?: string | undefined
}

export type LoadInvocationCaptureInput = {
  invocationId: string
}

export type CaptureVerificationStore = {
  listVerificationCandidates(
    input: ListVerificationCandidatesInput
  ): Promise<VerificationCandidate[]>
  loadInvocationCapture(
    input: LoadInvocationCaptureInput
  ): Promise<InvocationCaptureSnapshot | undefined>
}

export type TranscriptGuess = {
  path: string
  confidence: 'explicit' | 'high' | 'medium' | 'low'
  evidence: string[]
  warnings: string[]
}

export type VerificationCandidate = {
  schema: typeof CAPTURE_VERIFIER_SCHEMA
  invocationId: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  runtimeId: string
  runId?: string | undefined
  generation: number
  provider?: CaptureProvider | undefined
  driver?: string | undefined
  brokerDriver: string
  brokerProtocol: string
  state: string
  createdAt: string
  updatedAt: string
  eventCount: number
  firstSeq?: number | undefined
  lastSeq?: number | undefined
  firstEventAt?: string | undefined
  lastEventAt?: string | undefined
  rawMirrorCount: number
  lifecycleProjectionCount: number
  transcriptGuess?: TranscriptGuess | undefined
}

export type BrokerInvocationCapture = {
  invocationId: string
  operationId: string
  runtimeId: string
  runId?: string | undefined
  brokerDriver: string
  brokerProtocol: string
  state: string
  currentHarnessGeneration?: number | undefined
  currentTurnAttempt?: number | undefined
  createdAt: string
  updatedAt: string
}

export type BrokerCaptureEvent = {
  invocationId: string
  seq: number
  time: string
  type: string
  runId?: string | undefined
  runtimeId: string
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
  payload: unknown
  payloadJsonText: string
  hrcEventSeq?: number | undefined
  projectionStatus: string
  projectionError?: string | undefined
  createdAt: string
}

export type RawMirrorEvent = {
  seq: number
  source: string
  eventKind: string
  eventJson: unknown
  eventJsonText: string
}

export type HrcLifecycleProjection = {
  hrcSeq: number
  eventKind: string
  payload: unknown
}

export type ProviderTranscriptArtifactHashStatus =
  | 'matched'
  | 'mismatched'
  | 'unreadable'
  | 'unchecked'

export type ProviderTranscriptArtifact = {
  artifactId: string
  operationId: string
  path: string
  storedHash: string
  currentHash?: string | undefined
  hashStatus: ProviderTranscriptArtifactHashStatus
  createdAt: string
  artifactJson?: string | undefined
}

export type InvocationCaptureSnapshot = {
  schema: typeof CAPTURE_VERIFIER_SCHEMA
  invocation: BrokerInvocationCapture
  brokerEvents: BrokerCaptureEvent[]
  rawMirrors: Record<number, RawMirrorEvent | undefined>
  lifecycleProjections: Record<string, HrcLifecycleProjection[]>
  transcriptArtifact?: ProviderTranscriptArtifact | undefined
}

export type CaptureObservation = {
  schema: typeof CAPTURE_OBSERVATION_SCHEMA
  line: number
  provider: CaptureProvider
  type: CaptureObservationType
  correlationKey?: string | undefined
  normalizedPayload: unknown
  payloadHash: string
  text?: string | undefined
}

export type ParsedProviderTranscript = {
  schema: typeof CAPTURE_VERIFIER_SCHEMA
  path: string
  provider: CaptureProvider
  observations: CaptureObservation[]
  warnings: string[]
  lineCount: number
  totalLines: number
  parsedRecords: number
  invalidJsonRecords: number
  applicableObservations: number
  ignoredRecords: number
  unsupportedRecords: number
  unknownRecords: number
  warningCount: number
  observationsByType: Record<CaptureObservationType, number>
}

export type TranscriptResolution = {
  schema: typeof CAPTURE_VERIFIER_SCHEMA
  path: string
  confidence: 'explicit' | 'high' | 'medium' | 'low'
  evidence: string[]
  warnings: string[]
  alternatives: string[]
}

export type CaptureVerificationFinding = {
  schema: typeof CAPTURE_VERIFIER_SCHEMA
  severity: FindingSeverity
  layer: FindingLayer
  code: string
  message: string
  sourceRef?: string | undefined
  line?: number | undefined
  brokerSeq?: number | undefined
  rawEventSeq?: number | undefined
  lifecycleHrcSeq?: number | undefined
  type?: string | undefined
}

export type ProviderObservationMatch = {
  line: number
  type: string
  correlationKey?: string | undefined
  brokerSeq?: number | undefined
  status: 'matched' | 'missing' | 'divergent' | 'text-mismatch-tolerated'
  detail?: string | undefined
}

export type LedgerCheck = {
  eventCount: number
  firstSeq?: number | undefined
  lastSeq?: number | undefined
  statuses: Record<string, number>
}

export type RawMirrorCheck = {
  checked: number
  matched: number
}

export type LifecycleCheck = {
  brokerSeq: number
  brokerType: string
  lifecycleKind?: string | undefined
  status: 'present' | 'missing' | 'not_applicable' | 'suppressed'
  hrcSeq?: number | undefined
}

export type ProviderJsonlAnalytics = {
  path: string
  provider: CaptureProvider
  totalLines: number
  parsedRecords: number
  invalidJsonRecords: number
  applicableObservations: number
  ignoredRecords: number
  unsupportedRecords: number
  unknownRecords: number
  warningCount: number
  observationsByType: Record<CaptureObservationType, number>
}

export type BrokerLedgerAnalytics = {
  invocationId: string
  eventCount: number
  firstSeq?: number | undefined
  lastSeq?: number | undefined
  seqHoleCount: number
  duplicateSeqCount: number
  statuses: Record<string, number>
  eventsByType: Record<string, number>
  runtimeIdentityMismatchCount: number
  runDivergenceWarningCount: number
  staleGenerationCount: number
  staleAttemptCount: number
}

export type RawEventsAnalytics = {
  expectedFromBroker: number
  appliedBrokerRows: number
  linkedByHrcEventSeq: number
  found: number
  matched: number
  missing: number
  /** Row-level count; field-specific mismatch counts may sum above this value. */
  mismatched: number
  wrongSource: number
  wrongEventKind: number
  wrongInvocation: number
  wrongSeq: number
  wrongType: number
  payloadMismatch: number
  malformedEventJson: number
  malformedPayload: number
}

export type LifecycleProjectionAnalyticsBucket = {
  policyMapped: number
  expected: number
  present: number
  missing: number
  suppressed: number
  notApplicable: number
}

export type LifecycleKindAnalyticsBucket = {
  expected: number
  present: number
  missing: number
  suppressed: number
}

export type LifecycleProjectionAnalytics = {
  policyId: string
  policyVersion: 'v1'
  policyHash: string
  checkedBrokerEvents: number
  policyMapped: number
  expected: number
  present: number
  missing: number
  suppressed: number
  notApplicable: number
  byBrokerType: Record<string, LifecycleProjectionAnalyticsBucket>
  byLifecycleKind: Record<string, LifecycleKindAnalyticsBucket>
}

export type CrossSinkAnalytics = {
  providerToBroker?:
    | {
        expected: number
        matched: number
        missing: number
        divergent: number
        textMismatchTolerated: number
      }
    | undefined
  brokerToRaw: {
    expected: number
    matched: number
    missing: number
    mismatched: number
  }
  brokerToLifecycle: {
    expected: number
    present: number
    missing: number
    suppressed: number
    notApplicable: number
  }
}

export type CaptureVerificationAnalytics = {
  schema: typeof CAPTURE_VERIFIER_SCHEMA
  providerJsonl?: ProviderJsonlAnalytics | undefined
  brokerLedger: BrokerLedgerAnalytics
  rawEvents: RawEventsAnalytics
  lifecycleProjection: LifecycleProjectionAnalytics
  crossSink: CrossSinkAnalytics
}

export type CaptureVerificationReport = {
  schema: typeof CAPTURE_VERIFIER_SCHEMA
  status: 'pass' | 'fail' | 'inconclusive'
  ok: boolean
  invocationId: string
  brokerDriver: string
  brokerProtocol: string
  runtimeId: string
  runId?: string | undefined
  transcriptPath?: string | undefined
  transcriptArtifact?: ProviderTranscriptArtifact | undefined
  transcript?: ParsedProviderTranscript | undefined
  ledger: LedgerCheck
  rawMirror: RawMirrorCheck
  providerMatches: ProviderObservationMatch[]
  lifecycle: LifecycleCheck[]
  findings: CaptureVerificationFinding[]
  analytics: CaptureVerificationAnalytics
}

export type ResolveProviderTranscriptInput = {
  candidate?: VerificationCandidate | undefined
  explicitPath?: string | undefined
  searchRoots?: string[] | undefined
}

export type ParseProviderTranscriptInput = {
  path: string
}

export type VerifyInvocationInput = {
  store: CaptureVerificationStore
  invocationId: string
  transcript?: ParsedProviderTranscript | undefined
  transcriptPath?: string | undefined
  strictText?: boolean | undefined
}
