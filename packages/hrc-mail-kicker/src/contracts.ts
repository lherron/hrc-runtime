import type {
  DispatchTurnResponse,
  HrcBrokerInvocationEventRecord,
  HrcLifecycleEvent,
  HrcRuntimeIntent,
  HrcSessionRecord,
  PreemptAdmission,
  PreemptSubmissionRequest,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { SeatProbeResponse, SubmissionWithdrawResponse } from 'spaces-harness-broker-protocol'

import type { MailKickerLedger } from './ledger/client.js'

export type KickerLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export type ForeignHome = Readonly<{
  homeNodeId: string
  source: 'placement-ledger' | 'registry'
}>

export type KickerRegistryConsultResult =
  | { outcome: 'bound'; binding: { homeNodeId: string } }
  | { outcome: 'unbound' | 'retired' | 'unavailable' }

export type KickerRegistryClient = {
  consult(scopeRef: string): Promise<KickerRegistryConsultResult>
  listUnbornDesignations?(nodeId: string): Promise<readonly { scopeRef: string }[]>
}

export type KickerRpcResult<T> =
  | { ok: true; response: T }
  | { ok: false; error: { message: string } }

export type KickerBrokerPort = {
  seatProbe(runtimeId: string): Promise<KickerRpcResult<SeatProbeResponse>>
  withdraw(
    input:
      | { runtimeId: string; submissionId: string; reason: string }
      | { runtimeId: string; envelopeId: string; reason: string }
  ): Promise<KickerRpcResult<SubmissionWithdrawResponse>>
}

export type KickerDispatchOptions = {
  waitForCompletion?: boolean | undefined
  /** Internal in-process adapter diagnostic; policy selects a typed port method. */
  submissionDoor?: 'steer' | 'enqueue' | 'invoke' | 'preempt' | undefined
  ttlMs: number
  turnPolicy?: 'guarded' | undefined
  submissionOrigin: {
    principalRef: string
    scopeRef?: string | undefined
    envelopeId?: string | undefined
  }
  launchPromptOnColdBirth?: boolean | undefined
}

export type KickerDispatchResult = DispatchTurnResponse & {
  inputId?: string | undefined
  delivery?: { code?: string | undefined } | undefined
}

/**
 * The daemon capabilities the mail policy is permitted to use.
 *
 * This is intentionally a structural projection, rather than an HRC database
 * handle: policy receives only the reads and mutations named by the injector
 * contract.  The phase-three in-process implementation projects today's
 * repositories; the socket implementation projects the same operations from
 * HrcClient in the next task.
 */
export type HrcInjectionPort = {
  readonly runtimes: Pick<
    HrcDatabase['runtimes'],
    'getByRuntimeId' | 'listAll' | 'listByHostSessionId' | 'listLiveSessionRefs'
  >
  readonly brokerInvocations: Pick<HrcDatabase['brokerInvocations'], 'getByInvocationId'>
  readonly brokerEvents: Pick<
    HrcDatabase['brokerInvocationEvents'],
    | 'maxBrokerSeq'
    | 'findAdmissionRejection'
    | 'hasInputAccepted'
    | 'findUniqueSubmissionForEnvelopeAfter'
    | 'findSubmissionDisposition'
    | 'findInputRejectionDeliveryEvidence'
  >
  readonly events: Pick<HrcDatabase['hrcEvents'], 'maxHrcSeq' | 'listByKind'>
  readonly placement: Pick<
    ReturnType<typeof import('hrc-store-sqlite').createPlacementLedgerRepository>,
    'list' | 'get'
  >
  readonly broker: KickerBrokerPort
  readonly registry: KickerRegistryClient | undefined
  resolveForeignHome(scopeRef: string): Promise<ForeignHome | undefined>
  resolveRuntimeIntent(
    scopeRef: string,
    materializationIntent: string | undefined
  ): Promise<HrcRuntimeIntent | undefined>
  findTargetSession(targetSessionRef: string): HrcSessionRecord | undefined
  ensureTargetSession(
    targetSessionRef: string,
    intent: HrcRuntimeIntent,
    options: { persistIntent: false }
  ): Promise<HrcSessionRecord>
  steer(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: KickerDispatchOptions
  ): Promise<KickerDispatchResult>
  enqueue(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: KickerDispatchOptions
  ): Promise<KickerDispatchResult>
  invoke(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: KickerDispatchOptions
  ): Promise<KickerDispatchResult>
  preempt(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: KickerDispatchOptions
  ): Promise<KickerDispatchResult>
  preemptAdmission(
    session: HrcSessionRecord,
    request: PreemptSubmissionRequest
  ): Promise<PreemptAdmission>
}

/** The private state that remains co-located with HRC until the store split. */
export type KickerStateStore = Pick<HrcDatabase, 'mailDelivery' | 'wrkqLedgerCursors'>

export type MailKickerDependencies = {
  store: KickerStateStore
  port: HrcInjectionPort
  ledger: MailKickerLedger
  nodeId: string
  /** Shared with other HRC home-authority consumers; the kicker never owns the verdict. */
  foreignHomeMemo: Map<string, ForeignHome>
  log(level: KickerLogLevel, event: string, detail: Record<string, unknown>): void
}

export type MailKickerOptions = {
  enabled: boolean
  sweepIntervalMs: number
}

export type MailKickerLifecycleObserver = (event: HrcLifecycleEvent) => void
export type MailKickerBrokerObserver = (event: HrcBrokerInvocationEventRecord) => void
