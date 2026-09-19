import type {
  BirthDesignationRecord,
  BrokerEventsQueryOp,
  BrokerEventsQueryResponse,
  DispatchTurnResponse,
  EventsHeadResponse,
  HrcBrokerInvocationEventRecord,
  HrcLifecycleEvent,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  ListPlacementBindingsResponse,
  ListUnbornDesignationsResponse,
  PreemptAdmission,
  PreemptSubmissionRequest,
  RuntimeSeatResponse,
} from 'hrc-core'
import type { HrcMailDeliveryRepository, WrkqLedgerCursorRepository } from 'hrc-store-sqlite'
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
  listUnbornDesignations?(nodeId: string): Promise<readonly BirthDesignationRecord[]>
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
  runtime(runtimeId: string): Promise<HrcRuntimeSnapshot | undefined>
  runtimesByHostSession(hostSessionId: string): Promise<readonly HrcRuntimeSnapshot[]>
  allRuntimes(): Promise<readonly HrcRuntimeSnapshot[]>
  liveSessionRefs(): Promise<readonly string[]>
  seat(runtimeId: string): Promise<RuntimeSeatResponse>
  withdraw(
    input:
      | { runtimeId: string; submissionId: string; reason: string }
      | { runtimeId: string; envelopeId: string; reason: string }
  ): Promise<KickerRpcResult<SubmissionWithdrawResponse>>
  resolveForeignHome(scopeRef: string): Promise<ForeignHome | undefined>
  resolveRuntimeIntent(
    scopeRef: string,
    materializationIntent: string | undefined
  ): Promise<HrcRuntimeIntent | undefined>
  targetBySessionRef(targetSessionRef: string): Promise<HrcSessionRecord | undefined>
  ensureTargetSession(
    targetSessionRef: string,
    intent: HrcRuntimeIntent,
    options: { persistIntent: false }
  ): Promise<HrcSessionRecord>
  eventsHead(): Promise<EventsHeadResponse>
  lifecycleEvents(input: {
    eventKind: string
    runtimeId: string
    limit: number
  }): Promise<readonly HrcLifecycleEvent[]>
  brokerEventsQuery(op: BrokerEventsQueryOp): Promise<BrokerEventsQueryResponse>
  localPlacementBindings(): Promise<ListPlacementBindingsResponse>
  locate(scopeRef: string): Promise<ForeignHome | undefined>
  unbornDesignations(): Promise<ListUnbornDesignationsResponse>
  subscribeLifecycle(input: {
    afterSeq: number
    onEvent(event: HrcLifecycleEvent): void
  }): Promise<() => void | Promise<void>>
  subscribeBroker(input: {
    afterCommit: number
    onEvent(event: HrcBrokerInvocationEventRecord): void
  }): Promise<() => void | Promise<void>>
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

/** The kicker-owned durable delivery state. */
export type KickerStateStore = {
  mailDelivery: HrcMailDeliveryRepository
  wrkqLedgerCursors: WrkqLedgerCursorRepository
  close?(): void
}

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
