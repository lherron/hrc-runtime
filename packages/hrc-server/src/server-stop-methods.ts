import { storeSchemaVersion } from 'hrc-store-sqlite'
import { killActiveOfflineReaders } from './broker/offline-evidence'
import type { HrcServerInstance } from './index.js'
import { projectHrcReleaseIdentity } from './release-provenance.js'
import { flushServerMetrics } from './request-metrics.js'
import {
  type ServerShutdownAttribution,
  appendServerLifecycleEvent,
  recordServerBoot,
} from './server-lifecycle.js'
import { releaseServerLock } from './server-lock.js'
import { writeServerLog } from './server-log.js'
import { unlinkIfExists } from './server-util.js'
import { getTmuxSocketPath } from './tmux-socket.js'

/**
 * How long `stop()` lets an already-running request handler finish before it
 * closes the store underneath it. A courtesy window for work that is about to
 * complete (a broker start drains in ~1.2-1.8s), not a wait for completion: a
 * handler can legitimately park indefinitely (a dispatch blocked on turn
 * completion) and neither `hrc server stop` nor a test teardown may inherit
 * that. A straggler past the bound is logged, not swallowed.
 */
const SERVER_STOP_REQUEST_DRAIN_TIMEOUT_MS = 3_000
/**
 * Background tmux probes should settle inside their own 5s command deadline.
 * This independent shutdown bound protects graceful stop even if a future
 * sweep loses that guarantee or is wedged somewhere outside the child process.
 */
const SERVER_STOP_TMUX_SWEEP_DRAIN_TIMEOUT_MS = 5_000
/**
 * T-09760: every other teardown wait in `stop()`. Each was unbounded, so one
 * wedged dependency held the stop until the foreground deadline (30s) or the
 * supervisor's SIGKILL, and nothing said which step it was. A miss records a
 * `<step>_wait_timeout` reason (withholding server.stopped) and stop continues.
 */
const SERVER_STOP_STEP_TIMEOUT_MS = 5_000

export class StopStepTimeoutError extends Error {
  constructor(
    readonly step: string,
    readonly timeoutMs: number
  ) {
    super(`stop step ${step} did not settle within ${timeoutMs}ms`)
    this.name = 'StopStepTimeoutError'
  }
}

/** Await one teardown step, rejecting with StopStepTimeoutError past its bound. */
export async function awaitStopStep<T>(
  step: string,
  work: Promise<T>,
  timeoutMs: number = SERVER_STOP_STEP_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StopStepTimeoutError(step, timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The reason a failed bounded wait records: `<step>_wait_timeout` or `_wait_failed`. */
function stopWaitReason(step: string, error: unknown): string {
  return error instanceof StopStepTimeoutError ? `${step}_wait_timeout` : `${step}_wait_failed`
}

export const serverStopMethods = {
  /**
   * Register a handler promise for the shutdown drain. Returns the ORIGINAL
   * promise so response semantics are untouched; the tracked copy absorbs
   * rejection so tracking can never mint an unhandled rejection of its own.
   */
  trackInFlightRequest(
    this: HrcServerInstance,
    response: Promise<Response>,
    request: Request
  ): Promise<Response> {
    const settled: Promise<void> = response.then(
      () => {
        this.inFlightRequests.delete(settled)
      },
      () => {
        this.inFlightRequests.delete(settled)
      }
    )
    this.inFlightRequests.set(settled, {
      method: request.method,
      // The pathname only: query strings can carry selectors and cursors.
      route: new URL(request.url).pathname,
      startedAt: performance.now(),
    })
    return response
  },

  /**
   * Let request handlers that were already executing when the stop began finish
   * before the store handle closes. Without this a handler parked on an await
   * resumes against a closed database and throws `RangeError: Cannot use a
   * closed database` out of the sqlite statement layer, which under load lands
   * as an unrelated red in whichever test was running.
   *
   * Scope is deliberately request handlers only. `runtimeStartOperations` are
   * NOT drained: a START intentionally continues past `status: started` and an
   * attached start waits for an operator attach that may never come, so
   * awaiting one blocks shutdown on work that is not trying to finish.
   */
  async drainInFlightRequests(this: HrcServerInstance): Promise<'drained' | 'timeout'> {
    const pending = [...this.inFlightRequests.keys()]
    if (pending.length === 0) {
      return 'drained'
    }

    const startedAt = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let outcome: 'drained' | 'timeout'
    try {
      outcome = await Promise.race([
        Promise.all(pending).then(() => 'drained' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), SERVER_STOP_REQUEST_DRAIN_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }

    writeServerLog(outcome === 'timeout' ? 'WARN' : 'INFO', 'server.stop.request_drain', {
      outcome,
      drained: pending.length,
      stillRunning: this.inFlightRequests.size,
      ...(outcome === 'timeout'
        ? {
            stillRunningRequests: [...this.inFlightRequests.values()].map((entry) => ({
              method: entry.method,
              route: entry.route,
              ageMs: Math.round(performance.now() - entry.startedAt),
            })),
          }
        : {}),
      durMs: performance.now() - startedAt,
      timeoutMs: SERVER_STOP_REQUEST_DRAIN_TIMEOUT_MS,
    })
    return outcome
  },

  async drainTmuxSweepForStop(
    this: HrcServerInstance,
    sweep: Promise<unknown>,
    label: 'active_run_reconcile' | 'tmux_aging'
  ): Promise<'settled' | 'failed' | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const startedAt = performance.now()
    const outcome = await Promise.race([
      sweep.then(
        () => ({ kind: 'settled' as const }),
        (error: unknown) => ({ kind: 'failed' as const, error })
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: 'timeout' }),
          SERVER_STOP_TMUX_SWEEP_DRAIN_TIMEOUT_MS
        )
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)

    if (outcome.kind === 'failed') {
      writeServerLog('WARN', `server.stop.${label}_wait_failed`, { error: outcome.error })
    }
    if (outcome.kind === 'timeout') {
      writeServerLog('WARN', `server.stop.${label}_wait_timeout`, {
        durMs: performance.now() - startedAt,
        timeoutMs: SERVER_STOP_TMUX_SWEEP_DRAIN_TIMEOUT_MS,
      })
    }
    return outcome.kind
  },

  /**
   * T-08137: record this daemon's start, classifying an unconfirmed
   * predecessor first. Production lifecycle integration only.
   */
  recordLifecycleStart(this: HrcServerInstance): void {
    if (this.options.lifecycleProvenance !== true) return
    const identity = projectHrcReleaseIdentity(this.capturedRelease)
    recordServerBoot(this.db, {
      pid: process.pid,
      release: identity?.releaseId ?? null,
      sourceCommit: identity?.sourceCommit ?? null,
      storeSchema: storeSchemaVersion(this.db.sqlite) ?? null,
      processStartedAt: this.startedAt,
    })
    this.serverProjectEvents?.kick()
  },

  /**
   * T-08137: synchronously append `server.shutting_down` before any teardown.
   * Initiation evidence only; it never asserts clean termination.
   */
  beginLifecycleShutdown(this: HrcServerInstance, attribution: ServerShutdownAttribution): void {
    if (this.options.lifecycleProvenance !== true) return
    if (this.lifecycleShutdown !== undefined || this.stopping) return
    if (attribution.grant === null) {
      // T-09861 §7: residual R1 (raw kill / kickstart -k) — detected, not prevented.
      writeServerLog('WARN', 'server.lifecycle.ungranted_shutdown', {
        pid: process.pid,
        reason: attribution.reason,
      })
    }
    const event = appendServerLifecycleEvent(this.db, 'server.shutting_down', {
      pid: process.pid,
      ...attribution,
    })
    this.lifecycleShutdown = { shuttingDownHrcSeq: event.hrcSeq, attribution }
  },

  /**
   * T-08137 rev 4: the foreground's stop deadline fired. A stop() that still
   * finishes afterwards must not claim a completed stop.
   */
  markShutdownDeadlineExpired(this: HrcServerInstance): void {
    this.shutdownDeadlineExpired = true
  },

  /**
   * Step 4 of the rev-4 stop order: only when every pre-close teardown step
   * completed, and re-checking the deadline flag immediately before writing.
   */
  appendServerStopped(this: HrcServerInstance, teardownIncomplete: readonly string[]): void {
    const shutdown = this.lifecycleShutdown
    if (shutdown === undefined) return
    if (teardownIncomplete.length > 0) {
      writeServerLog('WARN', 'server.stop.incomplete', { reasons: [...teardownIncomplete] })
      return
    }
    if (this.shutdownDeadlineExpired) {
      writeServerLog('WARN', 'server.stop.stopped_withheld', {
        reason: 'shutdown_deadline_expired',
      })
      return
    }
    try {
      appendServerLifecycleEvent(this.db, 'server.stopped', {
        pid: process.pid,
        ...shutdown.attribution,
        shuttingDownHrcSeq: shutdown.shuttingDownHrcSeq,
      })
    } catch (error) {
      writeServerLog('WARN', 'server.stop.stopped_append_failed', { error })
    }
  },

  async stop(this: HrcServerInstance): Promise<void> {
    if (this.stopping) {
      return
    }

    this.stopping = true
    // T-08137 rev 4: every continue-past-failure site before the store closes
    // records a stable reason here, keeping its log line and continue behavior.
    // server.stopped is appended only when this stays empty.
    const teardownIncomplete: string[] = []
    const incomplete = (reason: string, details?: Record<string, unknown>): void => {
      teardownIncomplete.push(reason)
      writeServerLog('WARN', `server.stop.${reason}`, details)
    }
    // T-09760: one line as each step begins, so a stop that wedges or is
    // SIGKILLed by its supervisor leaves the step it was in as its last line.
    const stopBeganAt = performance.now()
    const step = (name: string): void => {
      writeServerLog('INFO', 'server.stop.step', {
        step: name,
        sinceBeginMs: Math.round(performance.now() - stopBeganAt),
      })
    }
    this.runtimeStartPresentationAbortController.abort()
    writeServerLog('INFO', 'server.stop.begin', {
      socketPath: this.options.socketPath,
      dbPath: this.options.dbPath,
      tmuxSocketPath: getTmuxSocketPath(this.options),
    })
    step('listener')
    this.server.stop()
    step('event_forwarder')
    if (this.eventForwarder) {
      try {
        await awaitStopStep('event_forwarder', this.eventForwarder.stop())
      } catch (error) {
        incomplete(stopWaitReason('event_forwarder', error), { error })
      }
    }
    step('event_ingest_listener')
    if (this.eventIngestListener) {
      try {
        await awaitStopStep('event_ingest_listener', this.eventIngestListener.stop())
      } catch (error) {
        incomplete(stopWaitReason('event_ingest_listener', error), { error })
      }
    }
    step('federation_listeners')
    this.collectiveHistory?.stop()
    if (this.peerProtocolEndpoint) {
      try {
        this.peerProtocolEndpoint.stop()
      } catch (error) {
        incomplete('peer_protocol_listener_failed', { error })
      }
    }
    if (this.bindingRegistryEndpoint) {
      try {
        this.bindingRegistryEndpoint.stop()
      } catch (error) {
        incomplete('binding_registry_listener_failed', { error })
      }
    }
    this.eventLoopLag?.stop()
    this.sessionProjectEvents.stop()
    this.serverProjectEvents?.stop()
    if (this.zombieSweepTimer) {
      clearInterval(this.zombieSweepTimer)
      this.zombieSweepTimer = undefined
    }
    step('zombie_sweep')
    if (this.zombieSweepInFlight) {
      try {
        await awaitStopStep('zombie_sweep', this.zombieSweepInFlight)
      } catch (error) {
        incomplete(stopWaitReason('zombie_sweep', error), { error })
      }
    }
    if (this.activeRunReconcileTimer) {
      clearInterval(this.activeRunReconcileTimer)
      this.activeRunReconcileTimer = undefined
    }
    step('active_run_reconcile')
    if (this.activeRunReconcileInFlight) {
      const outcome = await this.drainTmuxSweepForStop(
        this.activeRunReconcileInFlight,
        'active_run_reconcile'
      )
      if (outcome !== 'settled') teardownIncomplete.push(`active_run_reconcile_wait_${outcome}`)
    }
    if (this.firstTurnEvalTimer) {
      clearInterval(this.firstTurnEvalTimer)
      this.firstTurnEvalTimer = undefined
    }
    step('first_turn_eval')
    if (this.firstTurnEvalInFlight) {
      try {
        await awaitStopStep('first_turn_eval', this.firstTurnEvalInFlight)
      } catch (error) {
        incomplete(stopWaitReason('first_turn_eval', error), { error })
      }
    }
    if (this.brokerLeaseGcTimer) {
      clearInterval(this.brokerLeaseGcTimer)
      this.brokerLeaseGcTimer = undefined
    }
    if (this.lifecycleCredentialSweepTimer) {
      clearInterval(this.lifecycleCredentialSweepTimer)
      this.lifecycleCredentialSweepTimer = undefined
    }
    this.db.runtimes.setChangeObserver(undefined)
    if (this.retainedEvidenceStartupTimer) {
      clearTimeout(this.retainedEvidenceStartupTimer)
      this.retainedEvidenceStartupTimer = undefined
    }
    for (const timer of this.retainedEvidenceTerminalTimers) clearTimeout(timer)
    this.retainedEvidenceTerminalTimers.clear()
    // In-flight offline readers must not outlive the daemon that spawned them.
    killActiveOfflineReaders()
    step('retained_evidence_pass')
    if (this.retainedEvidencePassInFlight) {
      try {
        await awaitStopStep('retained_evidence_pass', this.retainedEvidencePassInFlight)
      } catch (error) {
        incomplete(stopWaitReason('retained_evidence_pass', error), { error })
      }
    }
    step('broker_lease_gc')
    if (this.brokerLeaseGcInFlight) {
      try {
        await awaitStopStep('broker_lease_gc', this.brokerLeaseGcInFlight)
      } catch (error) {
        incomplete(stopWaitReason('broker_lease_gc', error), { error })
      }
    }
    if (this.tmuxAgingTimer) {
      clearInterval(this.tmuxAgingTimer)
      this.tmuxAgingTimer = undefined
    }
    step('tmux_aging')
    if (this.tmuxAgingInFlight) {
      const outcome = await this.drainTmuxSweepForStop(this.tmuxAgingInFlight, 'tmux_aging')
      if (outcome !== 'settled') teardownIncomplete.push(`tmux_aging_wait_${outcome}`)
    }
    if (this.sessionRetentionTimer) {
      clearInterval(this.sessionRetentionTimer)
      this.sessionRetentionTimer = undefined
    }
    step('session_retention')
    if (this.sessionRetentionInFlight) {
      try {
        await awaitStopStep('session_retention', this.sessionRetentionInFlight)
      } catch (error) {
        incomplete(stopWaitReason('session_retention', error), { error })
      }
    }
    if (this.shadowTeardownTimer) {
      clearInterval(this.shadowTeardownTimer)
      this.shadowTeardownTimer = undefined
    }
    step('shadow_teardown')
    if (this.shadowTeardownInFlight) {
      try {
        await awaitStopStep('shadow_teardown', this.shadowTeardownInFlight)
      } catch (error) {
        incomplete(stopWaitReason('shadow_teardown', error), { error })
      }
    }
    step('transcript_indexer')
    try {
      await awaitStopStep('transcript_indexer', this.transcriptIndexer.stop())
    } catch (error) {
      incomplete(stopWaitReason('transcript_indexer', error), { error })
    }
    this.uninstallProjectRegistrySource()
    // The ledger transport is a child process; leaving it behind would strand a
    // `wrkq rpc --stdio` per daemon restart.
    step('wrkq_ledger')
    await awaitStopStep('wrkq_ledger', this.wrkqLedger.close()).catch((error: unknown) => {
      incomplete(
        error instanceof StopStepTimeoutError
          ? 'wrkq_ledger_close_timeout'
          : 'wrkq_ledger_close_failed',
        { error }
      )
    })
    step('external_participants')
    for (const [id, client] of this.externalParticipantClients) {
      await awaitStopStep('external_participant', client.close()).catch((error: unknown) => {
        incomplete(
          error instanceof StopStepTimeoutError
            ? 'external_participant_close_timeout'
            : 'external_participant_close_failed',
          { id, error }
        )
      })
    }
    this.externalParticipantClients.clear()
    const participantOperationGroups = [
      ['external_registration', [...this.externalRegistrationOperations.values()]],
      [
        'external_registration_establishment',
        [...this.externalRegistrationEstablishmentOperations.values()],
      ],
      ['participant_establishment', [...this.participantEstablishmentOperations.values()]],
    ] as const
    step('participant_operations')
    for (const [group, operations] of participantOperationGroups) {
      if (operations.length === 0) continue
      let settled: PromiseSettledResult<unknown>[]
      try {
        settled = await awaitStopStep('participant_operations', Promise.allSettled(operations))
      } catch (error) {
        incomplete('participant_operation_timeout', { group, error })
        continue
      }
      for (const result of settled) {
        if (result.status === 'rejected') {
          incomplete('participant_operation_failed', { group, error: result.reason })
        }
      }
    }
    step('streams')
    for (const close of [...this.activeStreamClosers]) {
      try {
        close()
      } catch (error) {
        incomplete('stream_close_failed', { error })
      }
    }
    this.activeStreamClosers.clear()
    this.followSubscribers.clear()
    this.rawBrokerSubscribers.clear()
    this.messageSubscribers.clear()
    this.turnResponseFinalizers.clear()
    this.peerRuntimeProjectionCache.clear()
    // Handlers that were already running when the stop began keep executing
    // after the socket closes; let them finish (bounded) before the store goes
    // away underneath them.
    step('request_drain')
    if ((await this.drainInFlightRequests()) === 'timeout') {
      teardownIncomplete.push('request_drain_timeout')
    }
    // Stop in-flight broker event consumers from projecting before the backing
    // DB closes underneath them (avoids closed-DB teardown crashes).
    step('broker_controller')
    this.harnessBrokerController?.shutdown?.()
    let cleanupError: unknown

    // T-08137 rev 4: socket unlink and the metrics flush run BEFORE the store
    // closes (the listener is already stopped), so server.stopped can attest
    // every teardown step up to db.close().
    step('socket_unlink')
    try {
      await awaitStopStep('socket_unlink', unlinkIfExists(this.options.socketPath))
    } catch (error) {
      cleanupError ??= error
      teardownIncomplete.push(
        error instanceof StopStepTimeoutError ? 'socket_unlink_timeout' : 'socket_unlink_failed'
      )
    }

    // Clean stop loses no buffered metrics (T-08784). Never rejects.
    step('metrics_flush')
    try {
      await awaitStopStep('metrics_flush', flushServerMetrics(this.options.stateRoot))
    } catch (error) {
      incomplete('metrics_flush_timeout', { error })
    }

    step('store_close')
    this.appendServerStopped(teardownIncomplete)
    this.db.close()

    // Outside the server.stopped attestation: it cannot be recorded durably
    // after the store closes. Failure behavior is unchanged.
    step('lock_release')
    try {
      await releaseServerLock(this.options.lockPath, this.lockHandle)
    } catch (error) {
      cleanupError ??= error
    }

    if (cleanupError) {
      writeServerLog('ERROR', 'server.stop.cleanup_failed', {
        socketPath: this.options.socketPath,
        dbPath: this.options.dbPath,
        tmuxSocketPath: getTmuxSocketPath(this.options),
        error: cleanupError,
      })
      throw cleanupError
    }

    writeServerLog('INFO', 'server.stop.complete', {
      socketPath: this.options.socketPath,
      dbPath: this.options.dbPath,
      tmuxSocketPath: getTmuxSocketPath(this.options),
    })
  },
}

export type ServerStopMethods = typeof serverStopMethods
