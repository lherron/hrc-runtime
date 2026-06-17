export const BROKER_TO_HRC_KIND: Partial<Record<string, string>> = {
  'input.accepted': 'turn.accepted',
  'turn.started': 'turn.started',
  'user.message': 'turn.user_prompt',
  'assistant.message.completed': 'turn.message',
  'tool.call.started': 'turn.tool_call',
  'tool.call.completed': 'turn.tool_result',
  'tool.call.failed': 'turn.tool_result',
  'turn.completed': 'turn.completed',
  'turn.failed': 'turn.completed',
  'turn.interrupted': 'turn.completed',
}

export type BrokerVerifyCandidate = {
  invocationId: string
  scopeRef: string
  laneRef: string
  runtimeId: string
  runId?: string | undefined
  hostSessionId: string
  generation: number
  brokerDriver: string
  brokerProtocol: string
  invocationState: string
  createdAt: string
  updatedAt: string
  eventCount: number
  firstSeq?: number | undefined
  lastSeq?: number | undefined
  firstEventAt?: string | undefined
  lastEventAt?: string | undefined
  confidence: 'exact-scope'
}

export type BrokerInvocation = {
  invocationId: string
  operationId: string
  runtimeId: string
  runId?: string | undefined
  brokerDriver: string
  brokerProtocol: string
  invocationState: string
  currentHarnessGeneration?: number | undefined
  currentTurnAttempt?: number | undefined
  createdAt: string
  updatedAt: string
}

export type BrokerEventRow = {
  invocationId: string
  seq: number
  time: string
  type: string
  runId?: string | undefined
  runtimeId: string
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
  brokerEventJson: unknown
  brokerEventJsonText: string
  hrcEventSeq?: number | undefined
  projectionStatus: string
  projectionError?: string | undefined
  createdAt: string
}

export type RawMirrorRow = {
  seq: number
  source: string
  eventKind: string
  eventJson: unknown
  eventJsonText: string
}

export type HrcLifecycleRow = {
  hrcSeq: number
  eventKind: string
  payload: unknown
}

export type ObservedProviderEvent = {
  line: number
  provider: 'codex' | 'claude' | 'unknown'
  type:
    | 'user.message'
    | 'assistant.message.completed'
    | 'tool.call.started'
    | 'tool.call.completed'
    | 'tool.call.failed'
  correlationKey?: string | undefined
  normalizedPayload: unknown
  payloadHash: string
  text?: string | undefined
}

export type ProviderTranscript = {
  path: string
  provider: 'codex' | 'claude' | 'unknown'
  observed: ObservedProviderEvent[]
  warnings: string[]
  lineCount: number
}

export type VerificationIssue = {
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  line?: number | undefined
  seq?: number | undefined
  eventSeq?: number | undefined
  hrcSeq?: number | undefined
  type?: string | undefined
}

export type ProviderMatch = {
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
  status: 'present' | 'inconclusive' | 'not-applicable'
  hrcSeq?: number | undefined
}

export type BrokerVerifyReport = {
  ok: boolean
  invocationId: string
  brokerDriver: string
  brokerProtocol: string
  runtimeId: string
  runId?: string | undefined
  jsonlPath?: string | undefined
  transcript?: ProviderTranscript | undefined
  ledger: LedgerCheck
  rawMirror: RawMirrorCheck
  providerMatches: ProviderMatch[]
  lifecycle: LifecycleCheck[]
  issues: VerificationIssue[]
}
