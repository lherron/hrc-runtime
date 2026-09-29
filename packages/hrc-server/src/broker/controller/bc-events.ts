/**
 * Broker event consumption, permission handling, busy-retry projection, and
 * event-gap backfill methods for HarnessBrokerController (split verbatim out of
 * controller.ts).
 *
 * Methods here run with `this` bound to the controller; controller.ts mixes
 * them onto `HarnessBrokerController.prototype`.
 */

import { setTimeout as delay } from 'node:timers/promises'
import type { HrcPermissionDecisionRecord, HrcRuntimeSnapshot } from 'hrc-core'
import type {
  InvocationEventEnvelope,
  InvocationId,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import { DEFAULT_ATTACHED_RUN_RESUME_TIMEOUT_MS } from '../../server-constants'
import { isLiveProcess } from '../../server-lock'
import { createTmuxManager } from '../../tmux'
import type { HarnessBrokerController } from '../controller'
import { isIgnoredBrokerDelta } from '../event-mapper'
import { parseBrokerRuntimeHostingState } from '../runtime-hosting'
import {
  BROKER_DB_BUSY_RETRY_MAX_DELAY_MS,
  isSqliteBusyError,
  resolveBrokerPermissionPolicy,
} from './bc-support'
import { isClosedDbError, toControllerError } from './internal'
import type {
  BrokerAttachedLaunchInput,
  BrokerTmuxAllocation,
  DurableBrokerClientLike,
  PendingAttachedBrokerStart,
} from './types'

export const eventsMethods = {
  async pauseForAttachedInvocationStart(
    this: HarnessBrokerController,
    input: {
      pending: BrokerAttachedLaunchInput
      runtime: HrcRuntimeSnapshot
      allocation: BrokerTmuxAllocation
    }
  ): Promise<void> {
    const { pending, runtime, allocation } = input
    let resume!: () => void
    let reject!: (error: Error) => void
    const resumed = new Promise<void>((resolve, rejectPromise) => {
      resume = resolve
      reject = rejectPromise
    })

    const pendingRecord: PendingAttachedBrokerStart = {
      pendingStartId: pending.pendingStartId,
      runtime,
      allocation,
      resume,
      reject,
    }
    this.pendingAttachedStarts.set(pending.pendingStartId, pendingRecord)

    const waiter = this.attachedStartReadyWaiters.get(pending.pendingStartId)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.attachedStartReadyWaiters.delete(pending.pendingStartId)
      waiter.resolve({ pendingStartId: pending.pendingStartId, runtime })
    }

    try {
      await Promise.race([
        resumed,
        delay(pending.timeoutMs ?? DEFAULT_ATTACHED_RUN_RESUME_TIMEOUT_MS).then(() => {
          throw new Error(`timed out waiting for attached launch resume: ${pending.pendingStartId}`)
        }),
      ])
      if (this.waitForAttachedTerminal) {
        await this.waitForAttachedTerminal({ runtime, allocation })
      }
    } finally {
      this.pendingAttachedStarts.delete(pending.pendingStartId)
    }
  },

  async handlePermissionRequest(
    this: HarnessBrokerController,
    request: PermissionRequestParams
  ): Promise<PermissionDecision> {
    if (this.permissionChannel) {
      return this.permissionChannel.request(request)
    }

    const now = this.now()
    const invocation = this.db.brokerInvocations.getByInvocationId(request.invocationId)
    const runtime = invocation ? this.db.runtimes.getByRuntimeId(invocation.runtimeId) : null
    const policy = resolveBrokerPermissionPolicy(runtime)
    const decision = policy.mode === 'allow' ? 'allow' : 'deny'
    if (invocation) {
      this.insertPermissionDecisionIfAbsent({
        permissionRequestId: request.permissionRequestId,
        invocationId: request.invocationId,
        runtimeId: invocation.runtimeId,
        ...(invocation.runId !== undefined ? { runId: invocation.runId } : {}),
        kind: request.kind,
        subjectDisplayJson: JSON.stringify(request.subject ?? null),
        defaultDecision: request.defaultDecision ?? 'deny',
        decision,
        decidedBy: 'policy',
        policyJson: JSON.stringify(policy),
        requestedAt: now,
        decidedAt: now,
      })
    }

    return policy.mode === 'allow'
      ? { decision: 'allow', message: 'Allowed by HRC policy.' }
      : {
          decision: 'deny',
          message: 'Denied by HRC policy: no permission request channel is configured.',
        }
  },

  insertPermissionDecisionIfAbsent(
    this: HarnessBrokerController,
    record: HrcPermissionDecisionRecord
  ): void {
    if (this.db.permissionDecisions.getByPermissionRequestId(record.permissionRequestId)) {
      return
    }
    this.db.permissionDecisions.insert(record)
  },

  consumeEvents(
    this: HarnessBrokerController,
    runtimeId: string,
    events: AsyncIterable<InvocationEventEnvelope>
  ): void {
    void (async () => {
      let lastInvocationId: string | undefined
      try {
        for await (const envelope of events) {
          // Teardown guard: once the server is stopping (DB about to close, or
          // already closed), stop projecting late broker events rather than
          // reading a closed DB.
          if (this.shuttingDown) {
            break
          }
          lastInvocationId = String(envelope.invocationId)
          await this.projectBrokerEventWithBusyRetry(runtimeId, envelope)
        }
        if (!this.shuttingDown && lastInvocationId !== undefined) {
          this.mapper.flushIgnoredDeltas?.(lastInvocationId)
          await this.ackCommittedProjection(runtimeId, lastInvocationId)
        }
      } catch (error) {
        // Teardown race: the consumer can outlive the backing DB (server.stop
        // closes it while a late broker event is in flight). A closed-DB read is
        // not a broker crash — exit quietly instead of escalating, which would
        // re-read the closed DB in markBrokerCrashTerminal and throw again.
        if (this.shuttingDown || isClosedDbError(error)) {
          return
        }
        const controllerError = toControllerError('broker_event_consumer_failed', error)
        // T-07944: an operator reap tears the transport down on purpose, and the
        // consumer's `for await` throws `Broker transport is closed` on the way
        // out. That is teardown finishing, not a runtime dying — escalating it
        // stamped `runtime.crashed` on a runtime that had just been terminated
        // deliberately, attached it to a run that had completed over an hour
        // earlier, and flipped the already-completed operation row to `failed`.
        // Consult the same intentional-close verdict `handleBrokerClose` does.
        const intentionalReason = this.intentionalCloseReason(runtimeId)
        if (intentionalReason !== undefined) {
          this.logger.info?.('harness broker event consumer ended on intentional close', {
            runtimeId,
            reason: intentionalReason,
            error: controllerError.message,
          })
          this.completeBrokerInvocationOperationOnIntentionalClose(runtimeId, intentionalReason)
          return
        }
        this.logger.error?.('harness broker event consumer failed', {
          runtimeId,
          error: controllerError.message,
        })
        try {
          const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
          const hosting = runtime ? parseBrokerRuntimeHostingState(runtime) : undefined
          if (hosting?.substrate.kind === 'leased-tmux') {
            const substrate = hosting.substrate
            const leaseTmux = createTmuxManager({ socketPath: substrate.tmuxSocketPath })
            const sessionExists = (await leaseTmux.listSessionNames()).includes(
              substrate.sessionName
            )
            const paneProcess = sessionExists
              ? await leaseTmux.inspectPaneProcess(substrate.brokerWindow.paneId)
              : null
            if (
              paneProcess !== null &&
              paneProcess.pid > 0 &&
              !paneProcess.dead &&
              isLiveProcess(paneProcess.pid)
            ) {
              this.logger.warn?.('runtime.condemnation_averted', {
                runtimeId,
                brokerErrorCode: controllerError.code,
                tmuxSocketPath: substrate.tmuxSocketPath,
                sessionName: substrate.sessionName,
                paneId: substrate.brokerWindow.paneId,
                panePid: paneProcess.pid,
              })
              return
            }
          }
        } catch {
          // A failed liveness probe is not proof that the leased substrate survived.
        }
        this.markBrokerCrashTerminal(runtimeId, controllerError)
      }
    })()
  },

  /**
   * Project one validated EPR envelope through the canonical broker mapper.
   * External participants share the mapper but own distinct process-fate law:
   * their clean `invocation.exited` is never classified as a broker crash.
   */
  async projectExternalParticipantEvent(
    this: HarnessBrokerController,
    runtimeId: string,
    envelope: InvocationEventEnvelope
  ): Promise<void> {
    await this.projectBrokerEventWithBusyRetry(runtimeId, envelope, {
      externalParticipant: true,
    })
  },

  /** Flush a delta-only external replay before its participant-owned ACK. */
  flushExternalParticipantIgnoredDeltas(
    this: HarnessBrokerController,
    invocationId: string
  ): number {
    return (
      this.mapper.flushIgnoredDeltas?.(invocationId) ?? this.lastProjectedBrokerSeq(invocationId)
    )
  },

  async projectBrokerEventWithBusyRetry(
    this: HarnessBrokerController,
    runtimeId: string,
    envelope: InvocationEventEnvelope,
    options: { externalParticipant?: boolean | undefined } = {}
  ): Promise<void> {
    const startedAtMs = Date.now()
    let attempt = 1
    while (!this.shuttingDown) {
      try {
        if (isIgnoredBrokerDelta(envelope)) {
          this.mapper.apply(envelope)
          return
        }
        this.mapper.flushIgnoredDeltas?.(String(envelope.invocationId))
        const invocation = this.db.brokerInvocations.getByInvocationId(
          String(envelope.invocationId)
        )
        if (!invocation || invocation.runtimeId !== runtimeId) {
          this.logger.warn?.('dropped broker event for non-consuming runtime', {
            runtimeId,
            invocationId: String(envelope.invocationId),
            invocationRuntimeId: invocation?.runtimeId,
            eventType: envelope.type,
            seq: envelope.seq,
          })
          return
        }
        const lastProjectedSeq = invocation.lastProjectedSeq ?? 0
        if (envelope.seq > lastProjectedSeq + 1) {
          const missingSeqs: number[] = []
          for (let seq = lastProjectedSeq + 1; seq < envelope.seq; seq++) {
            if (
              !this.db.brokerInvocationEvents.hasProjectionDisposition(
                String(envelope.invocationId),
                seq
              )
            ) {
              missingSeqs.push(seq)
            }
          }
          if (missingSeqs.length > 0) {
            this.logger.warn?.('broker.event_gap_detected', {
              runtimeId,
              invocationId: String(envelope.invocationId),
              missingSeqs,
              arrivedSeq: envelope.seq,
            })
            this.scheduleBrokerEventGapBackfill(
              runtimeId,
              String(envelope.invocationId),
              missingSeqs
            )
          }
        }
        const result = this.mapper.apply(envelope)
        await this.testOnlyAfterProjectionCommitBeforeAck?.({
          runtimeId,
          invocationId: String(envelope.invocationId),
          committedThroughSeq: this.lastProjectedBrokerSeq(String(envelope.invocationId)),
        })
        if (!options.externalParticipant) {
          await this.ackCommittedProjection(runtimeId, String(envelope.invocationId))
        }
        if (result.captureStateRefresh === true) {
          await this.refreshCaptureState(runtimeId, String(envelope.invocationId))
        }
        this.afterMappedEvent(runtimeId, envelope, result)
        return
      } catch (error) {
        if (this.shuttingDown || isClosedDbError(error)) {
          return
        }
        if (!isSqliteBusyError(error)) {
          throw error
        }
        const elapsedMs = Date.now() - startedAtMs
        if (elapsedMs >= this.brokerDbBusyRetryWindowMs) {
          throw error
        }
        const delayMs = this.brokerDbBusyRetryDelayMs(attempt, elapsedMs)
        this.logger.warn?.('harness broker event persistence busy; retrying', {
          runtimeId,
          invocationId: String(envelope.invocationId),
          eventType: envelope.type,
          seq: envelope.seq,
          attempt,
          elapsedMs,
          delayMs,
          retryWindowMs: this.brokerDbBusyRetryWindowMs,
        })
        attempt++
        await delay(delayMs)
      }
    }
  },

  brokerDbBusyRetryDelayMs(
    this: HarnessBrokerController,
    attempt: number,
    elapsedMs: number
  ): number {
    const exponentialDelayMs = Math.min(
      BROKER_DB_BUSY_RETRY_MAX_DELAY_MS,
      this.brokerDbBusyRetryBaseDelayMs * 2 ** Math.max(0, attempt - 1)
    )
    return Math.max(0, Math.min(exponentialDelayMs, this.brokerDbBusyRetryWindowMs - elapsedMs))
  },

  async refreshCaptureState(
    this: HarnessBrokerController,
    runtimeId: string,
    invocationId: string
  ): Promise<void> {
    if (this.mapper.projectCaptureState === undefined) return
    const active = this.active.get(runtimeId)
    if (
      !active ||
      active.invocationId !== invocationId ||
      typeof active.client.snapshot !== 'function'
    ) {
      return
    }
    try {
      const snapshot = await active.client.snapshot({
        invocationId: invocationId as InvocationId,
      })
      this.mapper.projectCaptureState(runtimeId, snapshot.capture)
    } catch (error) {
      // The broker event remains committed and acknowledged. Capture status is
      // descriptive; leave the last authoritative view in place and retry on
      // the next signal/status RPC rather than condemning the running seat.
      this.logger.warn?.('broker capture snapshot refresh failed', {
        runtimeId,
        invocationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  scheduleBrokerEventGapBackfill(
    this: HarnessBrokerController,
    runtimeId: string,
    invocationId: string,
    missingSeqs: number[]
  ): void {
    const existing = this.pendingBrokerEventGapBackfills.get(invocationId)
    if (existing) {
      for (const seq of missingSeqs) {
        existing.missingSeqs.add(seq)
      }
      clearTimeout(existing.timer)
      existing.timer = this.createBrokerEventGapBackfillTimer(invocationId)
      return
    }

    this.pendingBrokerEventGapBackfills.set(invocationId, {
      runtimeId,
      missingSeqs: new Set(missingSeqs),
      timer: this.createBrokerEventGapBackfillTimer(invocationId),
    })
  },

  createBrokerEventGapBackfillTimer(
    this: HarnessBrokerController,
    invocationId: string
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const pending = this.pendingBrokerEventGapBackfills.get(invocationId)
      if (!pending) {
        return
      }
      this.pendingBrokerEventGapBackfills.delete(invocationId)
      void this.backfillBrokerEventGap(
        pending.runtimeId,
        invocationId,
        [...pending.missingSeqs].sort((left, right) => left - right)
      )
    }, this.eventGapBackfillDelayMs)
  },

  async backfillBrokerEventGap(
    this: HarnessBrokerController,
    runtimeId: string,
    invocationId: string,
    candidateSeqs: number[]
  ): Promise<void> {
    if (this.shuttingDown) {
      return
    }

    let missingSeqs: number[]
    try {
      missingSeqs = candidateSeqs.filter(
        (seq) => !this.db.brokerInvocationEvents.hasProjectionDisposition(invocationId, seq)
      )
    } catch (error) {
      // A delayed debounce can race a test/server teardown that closes the DB
      // before controller.shutdown() clears its timer.
      if (this.shuttingDown || isClosedDbError(error)) {
        return
      }
      this.logger.warn?.('broker.event_gap_unrecoverable', {
        runtimeId,
        invocationId,
        missingSeqs: candidateSeqs,
        reason: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (missingSeqs.length === 0) {
      return
    }

    const active = this.active.get(runtimeId)
    const eventsSince = (
      active?.client as
        | {
            eventsSince?: DurableBrokerClientLike['eventsSince'] | undefined
          }
        | undefined
    )?.eventsSince
    if (!active || active.invocationId !== invocationId || typeof eventsSince !== 'function') {
      this.logger.warn?.('broker.event_gap_unrecoverable', {
        runtimeId,
        invocationId,
        missingSeqs,
        reason: 'client_unavailable',
      })
      // T-08566 O3: a terminal runtime's gap is repaired only from its retained
      // evidence (eligibility re-checked there); a non-terminal gap waits for the
      // next live attachAndReplay.
      const status = this.db.runtimes.getByRuntimeId(runtimeId)?.status
      if (status === 'terminated' || status === 'failed') {
        this.retainedEvidenceGapHandler?.(runtimeId)
      }
      return
    }

    const afterSeq = Math.min(...missingSeqs) - 1
    try {
      const replay = await eventsSince.call(active.client, {
        invocationId: invocationId as InvocationId,
        afterSeq,
      })
      if (replay.retentionFloorSeq > afterSeq) {
        this.logger.warn?.('broker.event_gap_unrecoverable', {
          runtimeId,
          invocationId,
          missingSeqs,
          reason: 'retention_floor',
          retentionFloorSeq: replay.retentionFloorSeq,
        })
        return
      }

      const missingSet = new Set(missingSeqs)
      const repairedSeqs: number[] = []
      for (const envelope of replay.events) {
        if (
          !missingSet.has(envelope.seq) ||
          this.db.brokerInvocationEvents.hasProjectionDisposition(invocationId, envelope.seq)
        ) {
          continue
        }
        const result = this.mapper.apply(envelope)
        if (result.ignoredDelta) continue
        await this.testOnlyAfterProjectionCommitBeforeAck?.({
          runtimeId,
          invocationId,
          committedThroughSeq: this.lastProjectedBrokerSeq(invocationId),
        })
        await this.ackCommittedProjection(runtimeId, invocationId)
        this.afterMappedEvent(runtimeId, envelope, result)
        if (!result.idempotent) {
          repairedSeqs.push(envelope.seq)
        }
      }
      this.mapper.flushIgnoredDeltas?.(invocationId)
      await this.ackCommittedProjection(runtimeId, invocationId)

      if (repairedSeqs.length > 0) {
        repairedSeqs.sort((left, right) => left - right)
        this.logger.warn?.('broker.event_gap_backfilled', {
          runtimeId,
          invocationId,
          repairedSeqs,
        })
      }

      const committedThroughSeq = this.lastProjectedBrokerSeq(invocationId)
      const stillMissing = missingSeqs.filter(
        (seq) =>
          seq > committedThroughSeq &&
          !this.db.brokerInvocationEvents.hasProjectionDisposition(invocationId, seq)
      )
      if (stillMissing.length > 0) {
        this.logger.warn?.('broker.event_gap_unrecoverable', {
          runtimeId,
          invocationId,
          missingSeqs: stillMissing,
          reason: 'events_not_in_ledger',
          currentSeq: replay.currentSeq,
          retentionFloorSeq: replay.retentionFloorSeq,
        })
      }
    } catch (error) {
      if (this.shuttingDown || isClosedDbError(error)) {
        return
      }
      this.logger.warn?.('broker.event_gap_unrecoverable', {
        runtimeId,
        invocationId,
        missingSeqs,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  },

  /**
   * Terminal envelope arrived while a gap backfill was still debounced. The
   * ledger replay is the only thing that can still close that gap, and it is
   * available right now — so run it immediately instead of cancelling and
   * declaring the gap unrecoverable, which is what this path used to do
   * (T-06974, from T-06090). The pending entry is dropped first so the debounce
   * timer cannot fire a second replay behind this one; `backfillBrokerEventGap`
   * re-checks the ledger and logs `broker.event_gap_unrecoverable` itself if the
   * events genuinely are not there.
   */
  flushBrokerEventGapBackfill(this: HarnessBrokerController, invocationId: string): void {
    const pending = this.pendingBrokerEventGapBackfills.get(invocationId)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    this.pendingBrokerEventGapBackfills.delete(invocationId)
    void this.backfillBrokerEventGap(
      pending.runtimeId,
      invocationId,
      [...pending.missingSeqs].sort((left, right) => left - right)
    )
  },

  /**
   * Mark the controller as shutting down so in-flight event consumers stop
   * projecting before the owning server closes the backing DB. Idempotent;
   * call from the server-stop path BEFORE `db.close()`.
   */
  shutdown(this: HarnessBrokerController): void {
    this.shuttingDown = true
    for (const staged of this.stagedParticipants.values()) {
      void staged.client.close().catch(() => undefined)
    }
    this.stagedParticipants.clear()
    for (const timer of this.brokerSeatMonitorTimers.values()) {
      clearInterval(timer)
    }
    this.brokerSeatMonitorTimers.clear()
    for (const pending of this.pendingBrokerTmuxReaps.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingBrokerTmuxReaps.clear()
    for (const pending of this.pendingBrokerEventGapBackfills.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingBrokerEventGapBackfills.clear()
    for (const pending of this.pendingBrokerCrashTerminalRetries.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingBrokerCrashTerminalRetries.clear()
  },
}

export type EventsMethods = typeof eventsMethods
