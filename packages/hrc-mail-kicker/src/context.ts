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
  /**
   * In-flight obligation disposals (T-07963). `stop()` drains these before the
   * store closes; T-07964's `mailKickerDisposalsInFlight` is the DIAGNOSTIC
   * register of the same work and is deliberately separate — one answers "what
   * must I wait for", the other "what was outstanding when we were told to stop".
   */
  readonly mailKickerDisposalsPending: Set<Promise<void>>
  /** Live obligation disposals, keyed by attempt; what `dispose_interrupted` reports. */
  readonly mailKickerDisposalsInFlight: Map<string, DisposalInFlight>
  /** One boot-reconcile report is owed per process (T-07964 §4). */
  mailKickerBootReconcilePending: boolean
  /** Attempts already named by a stalled-delivery line; one per attempt per process. */
  readonly mailKickerStalledDeliveryAnnounced: Set<string>

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
  /** Canonical run response body; one server-owned projection (T-07969). */
  projectTurnResponse(runId: string): { body: string; truncated: boolean }
  log(level: KickerLogLevel, event: string, detail: Record<string, unknown>): void

  wake(targetSessionRef: string, reason: HrcMailDriveWakeReason): void
  drainTarget(targetSessionRef: string): Promise<void>
  runSweepOnce(): Promise<void>
  runTailOnce(): Promise<void>
  observeLifecycleEvent(event: HrcLifecycleEvent): void
  observeBrokerEvent(event: HrcBrokerInvocationEventRecord): void
}

export type ActionableEnvelopeAutoReply = HrcMailAutoReplyCandidate | undefined
