import type {
  HrcBrokerInvocationEventRecord,
  HrcLifecycleEvent,
  HrcRuntimeIntent,
  HrcSessionRecord,
  PreemptSubmissionRequest,
} from 'hrc-core'
import type {
  HrcDatabase,
  HrcMailAutoReplyCandidate,
  HrcMailDriveAttempt,
  HrcMailDriveWakeReason,
} from 'hrc-store-sqlite'

import type {
  ForeignHome,
  KickerBrokerPort,
  KickerDispatchOptions,
  KickerDispatchResult,
  KickerLogLevel,
  KickerRegistryClient,
} from './contracts.js'
import type { DisposalInFlight } from './diagnostics/attempt-log.js'
import type { MailKickerLedger } from './ledger/client.js'

/** Internal capability surface shared by the decomposed kicker state machines. */
export type MailKickerContext = {
  readonly db: HrcDatabase
  readonly ledger: MailKickerLedger
  readonly nodeId: string
  readonly registry: KickerRegistryClient | undefined
  readonly foreignHomeMemo: Map<string, ForeignHome>
  readonly broker: KickerBrokerPort
  readonly afterClaim: ((attempt: HrcMailDriveAttempt) => void | Promise<void>) | undefined
  readonly enabled: boolean
  readonly sweepIntervalMs: number

  stopping: boolean
  mailKickerSweepTimer: ReturnType<typeof setInterval> | undefined
  mailKickerSweepInFlight: Promise<void> | undefined
  wrkqLedgerTailInFlight: Promise<void> | undefined
  mailKickerColdStartCatchupPending: boolean
  readonly mailKickerPendingTargets: Map<string, HrcMailDriveWakeReason>
  readonly mailKickerTargetOperations: Map<string, Promise<void>>
  readonly mailKickerForeignHomeAnnounced: Map<string, string>
  readonly mailKickerBirthDeferredAnnounced: Map<string, string>
  readonly mailKickerBirthSweepBackoff: Map<string, { attempts: number; nextAtMs: number }>
  readonly mailKickerLapsedRuntimes: Set<string>
  /** Live obligation disposals, keyed by attempt; what `dispose_interrupted` reports. */
  readonly mailKickerDisposalsInFlight: Map<string, DisposalInFlight>
  /** One boot-reconcile report is owed per process (T-07964 §4). */
  mailKickerBootReconcilePending: boolean

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
  preemptAuthorized(session: HrcSessionRecord, request: PreemptSubmissionRequest): Promise<boolean>
  requestAutoReplyReconcile(): void
  log(level: KickerLogLevel, event: string, detail: Record<string, unknown>): void

  wake(targetSessionRef: string, reason: HrcMailDriveWakeReason): void
  drainTarget(targetSessionRef: string): Promise<void>
  runSweepOnce(): Promise<void>
  runTailOnce(): Promise<void>
  observeLifecycleEvent(event: HrcLifecycleEvent): void
  observeBrokerEvent(event: HrcBrokerInvocationEventRecord): void
}

export type ActionableEnvelopeAutoReply = HrcMailAutoReplyCandidate | undefined
