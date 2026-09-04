import type {
  HrcBrokerInvocationEventRecord,
  HrcLifecycleEvent,
  HrcRuntimeIntent,
  HrcSessionRecord,
  PreemptSubmissionRequest,
} from 'hrc-core'
import type { HrcDatabase, HrcMailDriveAttempt, HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import type { MailKickerContext } from './context.js'
import type {
  ForeignHome,
  KickerBrokerPort,
  KickerDispatchOptions,
  KickerDispatchResult,
  KickerLogLevel,
  KickerRegistryClient,
  MailKickerDependencies,
  MailKickerOptions,
} from './contracts.js'
import { logDisposeInterrupted, logDisposePendingAtStop } from './diagnostics/attempt-log.js'
import type { DisposalInFlight } from './diagnostics/attempt-log.js'
import { reportUnownedTurn } from './diagnostics/stranded.js'
import { isRuntimeTerminal } from './drive/attempt-lifecycle.js'
import { driveMailTargetOnce } from './drive/target-driver.js'
import {
  DISPOSAL_DRAIN_DEADLINE_MS,
  LEDGER_SWEEP_TICKS,
  MAIL_DRIVE_TERMINAL_EVENTS,
  RUNTIME_TERMINAL_EVENTS,
  errorText,
  formatSessionRef,
} from './internal.js'
import type { MailKickerLedger } from './ledger/client.js'
import { handleQueuedInjectionExpiry } from './terminal/queued-injection-expiry.js'
import { failLapsedObligations } from './terminal/runtime-lapse.js'
import { chargeBirthSweepRefusal } from './wake/birth-retry.js'
import { runWrkqLedgerTail } from './wake/ledger-tail.js'
import { runMailKickerSweep } from './wake/sweep.js'

/** Owns the kicker's scheduler, process-local state, and target-drive serialization. */
export class MailKicker implements MailKickerContext {
  readonly db: HrcDatabase
  readonly ledger: MailKickerLedger
  readonly nodeId: string
  readonly registry: KickerRegistryClient | undefined
  readonly foreignHomeMemo: Map<string, ForeignHome>
  readonly broker: KickerBrokerPort
  readonly afterClaim: ((attempt: HrcMailDriveAttempt) => void | Promise<void>) | undefined
  readonly enabled: boolean
  readonly sweepIntervalMs: number

  stopping = false
  mailKickerSweepTimer: ReturnType<typeof setInterval> | undefined
  mailKickerSweepInFlight: Promise<void> | undefined
  wrkqLedgerTailInFlight: Promise<void> | undefined
  mailKickerColdStartCatchupPending = false
  readonly mailKickerPendingTargets = new Map<string, HrcMailDriveWakeReason>()
  readonly mailKickerTargetOperations = new Map<string, Promise<void>>()
  readonly mailKickerForeignHomeAnnounced = new Map<string, string>()
  readonly mailKickerBirthDeferredAnnounced = new Map<string, string>()
  readonly mailKickerBirthSweepBackoff = new Map<string, { attempts: number; nextAtMs: number }>()
  readonly mailKickerLapsedRuntimes = new Set<string>()
  readonly mailKickerDisposalsPending = new Set<Promise<void>>()
  readonly mailKickerDisposalsInFlight = new Map<string, DisposalInFlight>()
  mailKickerBootReconcilePending = true
  readonly mailKickerStalledDeliveryAnnounced = new Set<string>()

  constructor(
    private readonly dependencies: MailKickerDependencies,
    options: MailKickerOptions
  ) {
    this.db = dependencies.db
    this.ledger = dependencies.ledger
    this.nodeId = dependencies.nodeId
    this.registry = dependencies.registry
    this.foreignHomeMemo = dependencies.foreignHomeMemo
    this.broker = dependencies.broker
    this.afterClaim = dependencies.afterClaim
    this.enabled = options.enabled
    this.sweepIntervalMs = options.sweepIntervalMs
  }

  resolveForeignHome(scopeRef: string): Promise<ForeignHome | undefined> {
    return this.dependencies.resolveForeignHome(scopeRef)
  }

  resolveRuntimeIntent(
    scopeRef: string,
    materializationIntent: string | undefined
  ): HrcRuntimeIntent | undefined {
    return this.dependencies.resolveRuntimeIntent(scopeRef, materializationIntent)
  }

  findTargetSession(targetSessionRef: string): HrcSessionRecord | undefined {
    return this.dependencies.findTargetSession(targetSessionRef)
  }

  ensureTargetSession(
    targetSessionRef: string,
    intent: HrcRuntimeIntent,
    options: { persistIntent: false }
  ): Promise<HrcSessionRecord> {
    return this.dependencies.ensureTargetSession(targetSessionRef, intent, options)
  }

  dispatchTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: KickerDispatchOptions
  ): Promise<KickerDispatchResult> {
    return this.dependencies.dispatchTurn(session, intent, prompt, options)
  }

  preemptAuthorized(
    session: HrcSessionRecord,
    request: PreemptSubmissionRequest
  ): Promise<boolean> {
    return this.dependencies.preemptAuthorized(session, request)
  }

  requestAutoReplyReconcile(): void {
    this.dependencies.requestAutoReplyReconcile()
  }

  projectTurnResponse(runId: string): { body: string; truncated: boolean } {
    return this.dependencies.projectTurnResponse(runId)
  }

  log(level: KickerLogLevel, event: string, detail: Record<string, unknown>): void {
    this.dependencies.log(level, event, detail)
  }

  start(): void {
    if (!this.enabled || this.mailKickerSweepTimer !== undefined || this.stopping) return
    let tick = 0
    this.mailKickerSweepTimer = setInterval(() => {
      void this.runTailOnce().catch((error: unknown) => {
        this.log('WARN', 'wrkq.kicker.tail_tick_failed', { error: errorText(error) })
      })
      tick += 1
      if (tick % LEDGER_SWEEP_TICKS !== 0) return
      void this.runSweepOnce().catch((error: unknown) => {
        this.log('WARN', 'wrkq.kicker.periodic_sweep_failed', { error: errorText(error) })
      })
    }, this.sweepIntervalMs)
    this.mailKickerSweepTimer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    // Read FIRST, before anything is drained: what was outstanding at the moment
    // the stop was ordered. T-07963 note — this is no longer evidence of LOSS,
    // because the drain below now waits for these; `dispose_interrupted` is
    // emitted after the drain, for whatever genuinely did not finish.
    logDisposePendingAtStop(this)
    if (this.mailKickerSweepTimer !== undefined) {
      clearInterval(this.mailKickerSweepTimer)
      this.mailKickerSweepTimer = undefined
    }
    this.mailKickerPendingTargets.clear()
    // T-07963: a FIXED POINT, not one snapshot. A target operation inside the
    // first snapshot can still reach `observeAttempt` and start a disposal after
    // the disposal set was read, and that disposal would never be waited for.
    // `stopping` is already set, so `wake()` and `drainTarget`'s loop refuse new
    // work and the set is strictly decreasing.
    //
    // DEADLINED, because a disposal is a wrkq RPC per envelope: an unreachable
    // ledger would otherwise make the drain unbounded and the daemon
    // unrestartable, which is a worse failure than the stranding it prevents.
    // The bound is safe because the drain is a latency optimisation over the
    // durable path, not the correctness path — dispositions are written as they
    // are decided, so anything cut off here is recovered by the next boot.
    const deadline = Date.now() + DISPOSAL_DRAIN_DEADLINE_MS
    for (;;) {
      const operations = [
        this.mailKickerSweepInFlight,
        this.wrkqLedgerTailInFlight,
        ...this.mailKickerTargetOperations.values(),
        ...this.mailKickerDisposalsPending,
      ].filter((operation): operation is Promise<void> => operation !== undefined)
      if (operations.length === 0) break
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const raced = await Promise.race([
        Promise.allSettled(operations).then(() => 'settled' as const),
        new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), remaining)
          timer.unref?.()
        }),
      ])
      if (raced === 'timeout') break
    }
    // Only now is "interrupted" a true word: the drain is complete, so anything
    // still registered was genuinely not finished by this stop.
    logDisposeInterrupted(this)
  }

  wake(targetSessionRef: string, wakeReason: HrcMailDriveWakeReason): void {
    if (!this.enabled || this.stopping) return
    this.mailKickerPendingTargets.set(targetSessionRef, wakeReason)
    queueMicrotask(() => {
      void this.drainTarget(targetSessionRef).catch((error: unknown) => {
        this.log('WARN', 'wrkq.kicker.wake_failed', {
          targetSessionRef,
          wakeReason,
          error: errorText(error),
        })
      })
    })
  }

  drainTarget(targetSessionRef: string): Promise<void> {
    const existing = this.mailKickerTargetOperations.get(targetSessionRef)
    if (existing !== undefined) return existing

    const operation = (async () => {
      while (!this.stopping && this.enabled) {
        const reason = this.mailKickerPendingTargets.get(targetSessionRef)
        if (reason === undefined) return
        this.mailKickerPendingTargets.delete(targetSessionRef)
        const result = await driveMailTargetOnce(this, targetSessionRef, reason)
        if (reason === 'periodic' && result?.outcome === 'birth-refused') {
          await chargeBirthSweepRefusal(this, targetSessionRef, result.driveAttemptId)
        }
      }
    })().finally(() => {
      this.mailKickerTargetOperations.delete(targetSessionRef)
      if (this.mailKickerPendingTargets.has(targetSessionRef) && !this.stopping) {
        queueMicrotask(() => {
          void this.drainTarget(targetSessionRef).catch((error: unknown) => {
            this.log('WARN', 'wrkq.kicker.rekick_failed', {
              targetSessionRef,
              error: errorText(error),
            })
          })
        })
      }
    })
    this.mailKickerTargetOperations.set(targetSessionRef, operation)
    return operation
  }

  runSweepOnce(): Promise<void> {
    return runMailKickerSweep.call(this)
  }

  runTailOnce(): Promise<void> {
    return runWrkqLedgerTail.call(this)
  }

  observeLifecycleEvent(event: HrcLifecycleEvent): void {
    observeMailDriveLifecycleEvent.call(this, event)
  }

  observeBrokerEvent(record: HrcBrokerInvocationEventRecord): void {
    void handleQueuedInjectionExpiry(this, record).catch((error: unknown) => {
      this.log('WARN', 'wrkq.kicker.queued_injection_expiry_observer_failed', {
        invocationId: record.invocationId,
        runtimeId: record.runtimeId,
        brokerEventType: record.type,
        error: errorText(error),
      })
    })
  }
}

/** Package-level lifecycle seam retained for focused projection tests. */
export function observeMailDriveLifecycleEvent(
  this: MailKickerContext,
  event: HrcLifecycleEvent
): void {
  if (event.runId === undefined) return
  if (event.eventKind === 'turn.started') {
    this.db.mailDrives.recordStart({
      runId: event.runId,
      startHrcSeq: event.hrcSeq,
      startedAt: event.ts,
      hostSessionId: event.hostSessionId,
      generation: event.generation,
      runtimeId: event.runtimeId,
    })
    return
  }
  if (RUNTIME_TERMINAL_EVENTS.has(event.eventKind)) {
    const runtimeId = event.runtimeId
    if (runtimeId === undefined || this.mailKickerLapsedRuntimes.has(runtimeId)) return
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId) ?? undefined
    if (runtime === undefined || !isRuntimeTerminal(runtime.status)) return
    const targetSessionRef = formatSessionRef(event.scopeRef, event.laneRef)
    void failLapsedObligations(this, targetSessionRef, new Set([runtimeId]))
      .then((complete) => {
        if (complete) this.mailKickerLapsedRuntimes.add(runtimeId)
      })
      .catch((error: unknown) => {
        this.log('WARN', 'wrkq.kicker.lapse_wake_failed', {
          targetSessionRef,
          runtimeId,
          error: errorText(error),
        })
      })
    return
  }
  if (!MAIL_DRIVE_TERMINAL_EVENTS.has(event.eventKind)) return
  const targetSessionRef = formatSessionRef(event.scopeRef, event.laneRef)
  // T-07964 §3. Ahead of the wake and independent of it: the wake re-drives the
  // scope, which is a different question from "did this turn end holding
  // somebody's obligation with no drive left to mint the reply from".
  void reportUnownedTurn(this, event, targetSessionRef).catch((error: unknown) => {
    this.log('WARN', 'wrkq.auto_reply.unowned_turn_check_failed', {
      targetSessionRef,
      ...(event.runtimeId === undefined ? {} : { runtimeId: event.runtimeId }),
      error: errorText(error),
    })
  })
  this.wake(targetSessionRef, 'turn_completion')
}

export function createMailKicker(
  dependencies: MailKickerDependencies,
  options: MailKickerOptions
): MailKicker {
  return new MailKicker(dependencies, options)
}
