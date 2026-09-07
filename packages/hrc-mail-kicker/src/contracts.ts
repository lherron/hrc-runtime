import type {
  DispatchTurnResponse,
  HrcBrokerInvocationEventRecord,
  HrcLifecycleEvent,
  HrcRuntimeIntent,
  HrcSessionRecord,
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
  /**
   * The broker door this delivery goes through (spec T-08092 D2).
   *
   * `steer` is the default for a turn-active seat whose driver advertises the
   * class: the body joins the turn the reader is already inside rather than
   * waiting for it to end. Every door returns ADMISSION only; the landing is
   * reported later on the committed broker stream.
   */
  submissionDoor: 'steer' | 'enqueue' | 'invoke' | 'preempt'
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

export type MailKickerDependencies = {
  db: HrcDatabase
  ledger: MailKickerLedger
  nodeId: string
  registry?: KickerRegistryClient | undefined
  /** Shared with other HRC home-authority consumers; the kicker never owns the verdict. */
  foreignHomeMemo: Map<string, ForeignHome>
  resolveForeignHome(scopeRef: string): Promise<ForeignHome | undefined>
  resolveRuntimeIntent(
    scopeRef: string,
    materializationIntent: string | undefined
  ): HrcRuntimeIntent | undefined
  findTargetSession(targetSessionRef: string): HrcSessionRecord | undefined
  ensureTargetSession(
    targetSessionRef: string,
    intent: HrcRuntimeIntent,
    options: { persistIntent: false }
  ): Promise<HrcSessionRecord>
  dispatchTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: KickerDispatchOptions
  ): Promise<KickerDispatchResult>
  broker: KickerBrokerPort
  preemptAuthorized(session: HrcSessionRecord, request: PreemptSubmissionRequest): Promise<boolean>
  log(level: KickerLogLevel, event: string, detail: Record<string, unknown>): void
}

export type MailKickerOptions = {
  enabled: boolean
  sweepIntervalMs: number
}

export type MailKickerLifecycleObserver = (event: HrcLifecycleEvent) => void
export type MailKickerBrokerObserver = (event: HrcBrokerInvocationEventRecord) => void
