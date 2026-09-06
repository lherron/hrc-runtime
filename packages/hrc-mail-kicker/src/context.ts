import type {
  HrcBrokerInvocationEventRecord,
  HrcLifecycleEvent,
  HrcRuntimeIntent,
  HrcSessionRecord,
  PreemptSubmissionRequest,
} from 'hrc-core'
import type { HrcDatabase, HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import type {
  ForeignHome,
  KickerBrokerPort,
  KickerDispatchOptions,
  KickerDispatchResult,
  KickerLogLevel,
  KickerRegistryClient,
} from './contracts.js'
import type { MailKickerLedger } from './ledger/client.js'

/** Internal capability surface shared by the decomposed kicker state machines. */
export type MailKickerContext = {
  readonly db: HrcDatabase
  readonly ledger: MailKickerLedger
  readonly nodeId: string
  readonly registry: KickerRegistryClient | undefined
  readonly foreignHomeMemo: Map<string, ForeignHome>
  readonly broker: KickerBrokerPort
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
   * In-flight obligation disposals (T-07963, carried into D3). `stop()` drains
   * these before the store closes; every decision inside one is ALSO written
   * durably as it is made, so a stop that beats the drain leaves the reconcile
   * a candidate rather than silence.
   */
  readonly mailKickerDisposalsPending: Set<Promise<void>>
  /** One boot-reconcile report is owed per process (T-07964 §4). */
  mailKickerBootReconcilePending: boolean
  /** Envelopes already named by a stalled-delivery line; one per envelope per process. */
  readonly mailKickerStalledDeliveryAnnounced: Set<string>
  /**
   * Runtimes whose broker advertised `steer` and then refused one AT THE
   * CAPABILITY LAYER — the driver cannot actually do it.
   *
   * D2's "a refused steer becomes an enqueue" is about exactly that case, and
   * only that case. Without the memo the next pass reads the same advertised
   * capability, takes the same door and is refused again — a spin, not a
   * fallback. Process-local because the capability projection is frozen per
   * invocation: a new broker for the seat is a new runtime id and starts
   * trusted again.
   *
   * A TRANSIENT refusal never lands here. `pane_not_quiescent` fires whenever a
   * human is mid-word in the pane, which is routine on a tab seat; memoizing it
   * would degrade that runtime to enqueue for the life of the daemon and defeat
   * steer-first on precisely the seats a person is sitting at.
   */
  readonly mailKickerSteerRefused: Set<string>
  /**
   * Per-runtime backoff for a TRANSIENT steer refusal: the next pass retries
   * the steer door rather than falling to enqueue, after a short wait.
   *
   * Bounded and doubling so a pane somebody is typing into steadily is not
   * hammered, and cleared on a successful landing so a seat that starts
   * accepting steers again pays nothing for the interval it did not.
   */
  readonly mailKickerSteerBackoff: Map<string, number>

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
  log(level: KickerLogLevel, event: string, detail: Record<string, unknown>): void

  wake(targetSessionRef: string, reason: HrcMailDriveWakeReason): void
  drainTarget(targetSessionRef: string): Promise<void>
  runSweepOnce(): Promise<void>
  runTailOnce(): Promise<void>
  observeLifecycleEvent(event: HrcLifecycleEvent): void
  observeBrokerEvent(event: HrcBrokerInvocationEventRecord): void
}
