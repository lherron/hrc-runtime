import type { HrcBrokerInvocationEventRecord, HrcLifecycleEvent } from 'hrc-core'
import { parseAppSessionScopeRef } from 'hrc-core'
import type { HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import type { MailKickerContext } from './context.js'
import type {
  ForeignHome,
  HrcInjectionPort,
  KickerLogLevel,
  KickerStateStore,
  MailKickerDependencies,
  MailKickerOptions,
} from './contracts.js'
import { kickerScopeRefFor } from './drive/authority.js'
import { commitLanding, observeBrokerLanding } from './drive/landing.js'
import { reconcileOpenIntents } from './drive/reconcile.js'
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
import { disposeRuntimeObligations } from './terminal/disposal.js'
import { failLapsedObligations } from './terminal/runtime-lapse.js'
import { isRuntimeTerminal } from './terminal/runtime-status.js'
import { chargeBirthSweepRefusal } from './wake/birth-retry.js'
import { runWrkqLedgerTail } from './wake/ledger-tail.js'
import { runMailKickerSweep } from './wake/sweep.js'

/** Owns the kicker's scheduler, process-local state, and target-drive serialization. */
export class MailKicker implements MailKickerContext {
  readonly store: KickerStateStore
  readonly port: HrcInjectionPort
  readonly ledger: MailKickerLedger
  readonly nodeId: string
  readonly foreignHomeMemo: Map<string, ForeignHome>
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
  private readonly landingObserverOperations = new Set<Promise<void>>()
  mailKickerBootReconcilePending = true
  readonly mailKickerStalledDeliveryAnnounced = new Set<string>()
  readonly mailKickerSteerRefused = new Set<string>()
  readonly mailKickerSteerFallback = new Set<string>()
  readonly mailKickerDeliveryBackoff = new Map<string, number>()
  private lifecycleUnsubscribe: (() => void | Promise<void>) | undefined
  private brokerUnsubscribe: (() => void | Promise<void>) | undefined

  constructor(
    private readonly dependencies: MailKickerDependencies,
    options: MailKickerOptions
  ) {
    this.store = dependencies.store
    this.port = dependencies.port
    this.ledger = dependencies.ledger
    this.nodeId = dependencies.nodeId
    this.foreignHomeMemo = dependencies.foreignHomeMemo
    this.enabled = options.enabled
    this.sweepIntervalMs = options.sweepIntervalMs
  }

  log(level: KickerLogLevel, event: string, detail: Record<string, unknown>): void {
    this.dependencies.log(level, event, detail)
  }

  async start(): Promise<void> {
    if (!this.enabled || this.mailKickerSweepTimer !== undefined || this.stopping) return
    // D2 step 5: reconcile at daemon START. An intent committed by the previous
    // process is the only record that a delivery may be in flight, and until it
    // is resolved its envelope is not actionable — so this runs before the first
    // tail tick rather than waiting thirty of them for the sweep.
    void reconcileOpenIntents(this, { reason: 'daemon_start' }).catch((error: unknown) => {
      this.log('WARN', 'wrkq.kicker.start_reconcile_failed', { error: errorText(error) })
    })
    try {
      const { hrcSeq, brokerCommit } = await this.port.eventsHead()
      this.lifecycleUnsubscribe = await this.port.subscribeLifecycle({
        afterSeq: hrcSeq,
        onEvent: (event) => this.observeLifecycleEvent(event),
      })
      this.brokerUnsubscribe = await this.port.subscribeBroker({
        afterCommit: brokerCommit,
        onEvent: (event) => this.observeBrokerEvent(event),
      })
    } catch (error) {
      this.log('WARN', 'wrkq.kicker.subscription_start_failed', { error: errorText(error) })
    }
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
    await this.lifecycleUnsubscribe?.()
    this.lifecycleUnsubscribe = undefined
    await this.brokerUnsubscribe?.()
    this.brokerUnsubscribe = undefined
    if (this.mailKickerSweepTimer !== undefined) {
      clearInterval(this.mailKickerSweepTimer)
      this.mailKickerSweepTimer = undefined
    }
    this.mailKickerPendingTargets.clear()
    // T-07963: a FIXED POINT, not one snapshot. A target operation inside the
    // first snapshot can still start a disposal after the disposal set was
    // read, and that disposal would never be waited for. `stopping` is already
    // set, so `wake()` and `drainTarget`'s loop refuse new work and the set is
    // strictly decreasing.
    //
    // DEADLINED, because a disposal is a wrkq RPC per envelope: an unreachable
    // ledger would otherwise make the drain unbounded and the daemon
    // unrestartable, which is a worse failure than the stranding it prevents.
    // The bound is safe because the drain is a latency optimisation over the
    // durable path, not the correctness path — every disposition is written as
    // it is decided, so anything cut off here is recovered by the next boot.
    const deadline = Date.now() + DISPOSAL_DRAIN_DEADLINE_MS
    for (;;) {
      const operations = [
        this.mailKickerSweepInFlight,
        this.wrkqLedgerTailInFlight,
        ...this.mailKickerTargetOperations.values(),
        ...this.mailKickerDisposalsPending,
        ...this.landingObserverOperations,
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
    this.store.close?.()
  }

  wake(targetSessionRef: string, wakeReason: HrcMailDriveWakeReason): void {
    if (!this.enabled || this.stopping) return
    this.mailKickerPendingTargets.set(targetSessionRef, wakeReason)
    queueMicrotask(() => {
      void this.drainTarget(targetSessionRef).catch((error: unknown) => {
        if (this.stopping) return
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
          await chargeBirthSweepRefusal(this, targetSessionRef)
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
    if (this.stopping) return
    observeMailDriveLifecycleEvent.call(this, event)
  }

  observeBrokerEvent(record: HrcBrokerInvocationEventRecord): void {
    if (this.stopping) return
    const operation = observeBrokerLanding(this, record)
      .catch((error: unknown) => {
        this.log('WARN', 'wrkq.kicker.landing_observer_failed', {
          invocationId: record.invocationId,
          runtimeId: record.runtimeId,
          brokerEventType: record.type,
          error: errorText(error),
        })
      })
      .finally(() => this.landingObserverOperations.delete(operation))
    this.landingObserverOperations.add(operation)
  }
}

/**
 * The lifecycle seam, and the whole of D3's trigger.
 *
 * NO `runId === undefined` GUARD. That guard is what made a human-typed pane
 * turn invisible: those turns emit the same terminal event kinds against the
 * same runtime and mint no run at all, and they are exactly the turns a steered
 * obligation now lands in. Disposal keys on the RUNTIME and the ledger sequence,
 * so both shapes are one case.
 */
export function observeMailDriveLifecycleEvent(
  this: MailKickerContext,
  event: HrcLifecycleEvent
): void {
  const runtimeId = event.runtimeId
  if (event.eventKind === 'turn.started') {
    // The LAUNCH-CARRIED landing fact (D2 step 6). A body that rode
    // `spec.launch.initialPrompt` has no submission to be absorbed or executed;
    // the born runtime's first turn IS the delivery. Read off HRC's own
    // committed lifecycle ledger rather than the broker stream so the landing
    // sequence is the same ordering D3's terminals are compared against.
    if (runtimeId === undefined) return
    const intents = this.store.mailDelivery.listLaunchIntentsForRuntime(runtimeId)
    for (const intent of intents) {
      void commitLanding(this, intent, {
        runtimeId,
        eventType: 'turn.started',
        landingHrcSeq: event.hrcSeq,
      }).catch((error: unknown) => {
        this.log('WARN', 'wrkq.kicker.launch_landing_failed', {
          targetSessionRef: intent.targetSessionRef,
          envelope: intent.envelopeId,
          runtimeId,
          error: errorText(error),
        })
      })
    }
    return
  }
  if (event.eventKind === 'turn.failed') {
    recordDeliveryBrokerStartRefusal(this, event)
  }
  if (RUNTIME_TERMINAL_EVENTS.has(event.eventKind)) {
    if (runtimeId === undefined || this.mailKickerLapsedRuntimes.has(runtimeId)) return
    const targetSessionRef = formatSessionRef(event.scopeRef, event.laneRef)
    void (async () => {
      const runtime = await this.port.runtime(runtimeId)
      if (runtime === undefined || !isRuntimeTerminal(runtime.status)) return
      await reconcileOpenIntents(this, {
        runtimeIds: new Set([runtimeId]),
        reason: 'runtime_terminated',
      })
      if (parseAppSessionScopeRef(event.scopeRef) !== null) return
      if (await failLapsedObligations(this, targetSessionRef, new Set([runtimeId]))) {
        this.mailKickerLapsedRuntimes.add(runtimeId)
      }
    })().catch((error: unknown) => {
      this.log('WARN', 'wrkq.kicker.terminal_lapse_failed', {
        targetSessionRef,
        runtimeId,
        error: errorText(error),
      })
    })
    return
  }
  if (!MAIL_DRIVE_TERMINAL_EVENTS.has(event.eventKind)) return
  const targetSessionRef = formatSessionRef(event.scopeRef, event.laneRef)
  if (runtimeId !== undefined) {
    disposeRuntimeObligations(this, {
      runtimeId,
      targetSessionRef,
      terminalHrcSeq: event.hrcSeq,
      terminalEventKind: event.eventKind,
      turnEndedAt: event.ts,
    })
  }
  // T-08576 D2: local disposal above still runs; an app scope is never a wake target.
  if (parseAppSessionScopeRef(event.scopeRef) !== null) return
  this.wake(targetSessionRef, 'turn_completion')
}

/**
 * T-08139 — preserve a wake source when a delivery-triggered broker birth dies
 * before it can mint a submission or start its launch-carried turn.
 *
 * The write-ahead delivery intent is deliberately inspected in this lifecycle
 * observer: broker start appends/notifies `turn.failed` synchronously, before
 * the dispatch promise rejects and the delivery path clears that intent. The
 * newest exact-target intent is therefore the causal delivery. Recording the
 * refusal here survives that clear and returns the now-unseated target to the
 * existing periodic birth-retry candidate source.
 */
function recordDeliveryBrokerStartRefusal(
  server: MailKickerContext,
  event: HrcLifecycleEvent
): void {
  if (event.eventKind !== 'turn.failed') return
  const payload =
    event.payload !== null && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : undefined
  if (payload?.['phase'] !== 'broker-invocation-start') return

  const targetSessionRef = formatSessionRef(event.scopeRef, event.laneRef)
  const intent = server.store.mailDelivery
    .listOpenIntents(targetSessionRef)
    .filter((candidate) => candidate.submittedHrcSeq <= event.hrcSeq)
    .at(-1)
  const scopeRef = kickerScopeRefFor(targetSessionRef)
  if (intent === undefined || scopeRef === undefined) return

  const failure =
    typeof payload['message'] === 'string'
      ? payload['message']
      : typeof payload['code'] === 'string'
        ? payload['code']
        : 'broker start failed'
  const reason = `${intent.envelopeId}: broker-invocation-start: ${failure}`
  server.store.mailDelivery.recordBirthRefusal({ targetSessionRef, scopeRef, reason })
  server.log('WARN', 'wrkq.kicker.delivery_birth_refused', {
    targetSessionRef,
    envelope: intent.envelopeId,
    ...(event.runtimeId === undefined ? {} : { runtimeId: event.runtimeId }),
    reason: 'broker-invocation-start',
    error: failure,
    hrcSeq: event.hrcSeq,
  })
}

export function createMailKicker(
  dependencies: MailKickerDependencies,
  options: MailKickerOptions
): MailKicker {
  return new MailKicker(dependencies, options)
}
