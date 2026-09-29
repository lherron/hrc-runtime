import type { HrcLifecycleEvent } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type {
  CaptureStateView,
  InvocationCaptureReleaseRequest,
  InvocationCaptureReleaseResponse,
  InvocationEventEnvelope,
} from 'spaces-harness-broker-protocol'
import { timeLoopActivity } from '../event-loop-lag'
import { appendHrcEvent } from '../hrc-event-helper'
import { writeServerLog } from '../server-log'
import { isIgnoredBrokerDelta } from './event-mapper/envelope-predicates'
import { type Format2InputMethods, format2InputMethods } from './event-mapper/format2-input'
import {
  type BrokerEventMapperDeps,
  type BrokerProjectionResult,
  lifecycleTransportFromRuntime,
} from './event-mapper/helpers'
import {
  type MessageProjectionMethods,
  messageProjectionMethods,
} from './event-mapper/message-projection'
import {
  type ProjectEnvelopeMethods,
  projectEnvelopeMethods,
} from './event-mapper/project-envelope'
import { type RunResolutionMethods, runResolutionMethods } from './event-mapper/run-resolution'
import {
  type StateProjectionMethods,
  stateProjectionMethods,
} from './event-mapper/state-projection'
import { type TurnProjectionMethods, turnProjectionMethods } from './event-mapper/turn-projection'
import { isRecord } from './json'

export type { BrokerEventMapperDeps, BrokerProjectionResult } from './event-mapper/helpers'
export { isIgnoredBrokerDelta }

const CAPTURE_WARNING_LOG_INTERVAL_MS = 60_000

type CaptureWarningLogState = {
  invocationId: string
  lastLoggedAt: number
  count: number
}

export class BrokerEventMapper {
  readonly db: HrcDatabase
  readonly now: () => string
  private readonly rateLimitNow: () => number
  readonly serverLog: NonNullable<BrokerEventMapperDeps['serverLog']>
  private readonly captureWarningLogState = new Map<string, CaptureWarningLogState>()
  readonly nextBufferChunkSeqByRunId = new Map<string, number>()
  /**
   * T-07235 late-start rows appended during THIS synchronous `apply`, drained
   * into the returned `lifecycleEvents` so live followers see them too. Safe as
   * instance state: `apply` is synchronous and transactional, so no second
   * projection can interleave.
   */
  pendingLateStartEvents: HrcLifecycleEvent[] = []
  /** Canonical input facts appended during THIS synchronous broker projection. */
  pendingInputEvents: HrcLifecycleEvent[] = []
  /**
   * T-08566 — true only inside {@link applyRetained}'s synchronous transaction.
   * Same instance-state safety argument as `pendingLateStartEvents`.
   */
  retainedProjection = false
  /** Contiguous raw-delta high-waters awaiting one durable cursor flush. */
  private readonly ignoredDeltaCursors = new Map<
    string,
    { throughSeq: number; runtimeId: string }
  >()
  private readonly retainedIgnoredDeltaCursors = new Map<
    string,
    { throughSeq: number; runtimeId: string }
  >()

  constructor(deps: BrokerEventMapperDeps) {
    this.db = deps.db
    this.now = deps.now ?? (() => new Date().toISOString())
    this.rateLimitNow = deps.rateLimitNow ?? (() => performance.now())
    this.serverLog = deps.serverLog ?? writeServerLog
  }

  /**
   * Append + project a single broker event in one transaction. Synchronous: the
   * persistence layer is synchronous and the whole operation must commit (event
   * row + state) or roll back together.
   */
  apply(envelope: InvocationEventEnvelope): BrokerProjectionResult {
    if (isIgnoredBrokerDelta(envelope)) {
      return this.ignoreRawDelta(envelope)
    }
    const chunkSeqSnapshot = new Map(this.nextBufferChunkSeqByRunId)
    const run = this.db.sqlite.transaction(() => {
      this.flushIgnoredDeltasInTransaction(String(envelope.invocationId), false)
      return this.project(envelope)
    })
    try {
      const result = timeLoopActivity(`broker.apply:${envelope.type}`, run)
      this.ignoredDeltaCursors.delete(String(envelope.invocationId))
      if (!result.idempotent) this.logBlockedUnknownCaptureWarning(envelope)
      return result
    } catch (error) {
      this.nextBufferChunkSeqByRunId.clear()
      for (const [runId, nextChunkSeq] of chunkSeqSnapshot) {
        this.nextBufferChunkSeqByRunId.set(runId, nextChunkSeq)
      }
      throw error
    }
  }

  /**
   * Raw streaming fragments belong to the broker ledger, not HRC's projection.
   * Extend only an in-memory contiguous range; the next semantic event or replay
   * boundary folds the whole range into one durable cursor update and one ACK.
   */
  private ignoreRawDelta(
    envelope: InvocationEventEnvelope,
    retained = false
  ): BrokerProjectionResult {
    const cursors = retained ? this.retainedIgnoredDeltaCursors : this.ignoredDeltaCursors
    const invocationId = String(envelope.invocationId)
    const pending = cursors.get(invocationId)
    let runtimeId: string
    let cursor: number
    if (pending !== undefined) {
      runtimeId = pending.runtimeId
      cursor = pending.throughSeq
    } else {
      const invocation = this.db.brokerInvocations.getByInvocationId(envelope.invocationId)
      if (!invocation) {
        throw new Error(`broker invocation not found for event: ${envelope.invocationId}`)
      }
      runtimeId = invocation.runtimeId
      if (!this.db.runtimes.getByRuntimeId(runtimeId)) {
        throw new Error(`runtime not found for broker invocation: ${runtimeId}`)
      }
      cursor = retained
        ? (invocation.retainedProjectedThroughSeq ?? invocation.lastProjectedSeq ?? 0)
        : (invocation.lastProjectedSeq ?? 0)
    }
    if (envelope.seq > cursor + 1) {
      throw new Error(
        `raw delta gap for ${envelope.invocationId}: expected ${cursor + 1}, received ${envelope.seq}`
      )
    }
    if (envelope.seq === cursor + 1) {
      cursors.set(invocationId, { throughSeq: envelope.seq, runtimeId })
    }

    return {
      ignoredDelta: true,
      idempotent: true,
      brokerEvent: {
        invocationId: envelope.invocationId,
        seq: envelope.seq,
        time: envelope.time,
        type: envelope.type,
        runtimeId,
        brokerEventJson: JSON.stringify(envelope.payload ?? null),
        brokerEnvelopeJson: JSON.stringify(envelope),
        projectionStatus: 'pending',
        createdAt: envelope.time,
      },
      events: [],
      lifecycleEvents: [],
    }
  }

  /** Commit one contiguous ignored-delta range before a replay/page ACK. */
  flushIgnoredDeltas(invocationId: string, retained = false): number {
    const cursors = retained ? this.retainedIgnoredDeltaCursors : this.ignoredDeltaCursors
    const pending = cursors.get(invocationId)
    if (pending === undefined) {
      const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
      return retained
        ? (invocation?.retainedProjectedThroughSeq ?? invocation?.lastProjectedSeq ?? 0)
        : (invocation?.lastProjectedSeq ?? 0)
    }
    const run = this.db.sqlite.transaction(() =>
      this.flushIgnoredDeltasInTransaction(invocationId, retained)
    )
    const throughSeq = run()
    cursors.delete(invocationId)
    return throughSeq
  }

  private flushIgnoredDeltasInTransaction(invocationId: string, retained: boolean): number {
    const cursors = retained ? this.retainedIgnoredDeltaCursors : this.ignoredDeltaCursors
    const pending = cursors.get(invocationId)
    const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
    if (!invocation) throw new Error(`broker invocation not found for event: ${invocationId}`)
    const cursor = retained
      ? (invocation.retainedProjectedThroughSeq ?? invocation.lastProjectedSeq ?? 0)
      : (invocation.lastProjectedSeq ?? 0)
    if (pending === undefined || pending.throughSeq <= cursor) return cursor
    this.db.brokerInvocations.update(invocationId, {
      ...(retained
        ? { retainedProjectedThroughSeq: pending.throughSeq }
        : { lastProjectedSeq: pending.throughSeq }),
      updatedAt: this.now(),
    })
    return pending.throughSeq
  }

  /**
   * T-08566 — project one committed envelope recovered offline from a dead
   * worker's retained ledger, under the retained-evidence fence.
   *
   * Same transaction, idempotence, mirror, conflict check and contiguous cursor
   * as {@link apply}, plus exactly these kept effects: the mirror row and the
   * canonical lifecycle row both carry `evidence_origin = 'retained'` (the
   * lifecycle row at the envelope's original time); provider-transcript
   * artifacts; the runtime buffer of the envelope's own historical run;
   * absorbed-auxiliary settlement against exact historical owners; terminal
   * invocation state for that invocation; run terminals only where the run has
   * no recorded terminal; permission audit as stale.
   *
   * Everything else is fenced by construction (an allowlist, not per-writer
   * suppression): no runtime status/active run/invocation/operation/policy/
   * continuation/activity write, no session continuation or reuse write, no run
   * non-terminal transition, no first-turn supervision, no surface binding, no
   * derived awaiting-input rows. The caller performs no controller effects.
   *
   * Every semantic envelope also records
   * `broker_invocations.retained_projected_through_seq` in the same transaction.
   * Contiguous delta-only ranges update that fence once at the next semantic
   * envelope or replay boundary.
   */
  applyRetained(envelope: InvocationEventEnvelope): BrokerProjectionResult {
    if (isIgnoredBrokerDelta(envelope)) {
      return this.ignoreRawDelta(envelope, true)
    }
    const chunkSeqSnapshot = new Map(this.nextBufferChunkSeqByRunId)
    const run = this.db.sqlite.transaction(() => {
      this.flushIgnoredDeltasInTransaction(String(envelope.invocationId), true)
      this.retainedProjection = true
      try {
        const result = this.project(envelope)
        if (!result.idempotent) {
          const invocation = this.db.brokerInvocations.getByInvocationId(envelope.invocationId)
          this.db.brokerInvocations.update(envelope.invocationId, {
            retainedProjectedThroughSeq: Math.max(
              invocation?.retainedProjectedThroughSeq ?? 0,
              envelope.seq
            ),
          })
        }
        return result
      } finally {
        this.retainedProjection = false
      }
    })
    try {
      // Reserve the WAL writer first (BEGIN IMMEDIATE): recovery commits while
      // other connections read and write the same store, and a deferred
      // read-then-write transaction fails its upgrade with SQLITE_BUSY instead of
      // waiting out busy_timeout. Same reasoning as the lifecycle append.
      const result = timeLoopActivity(`broker.apply_retained:${envelope.type}`, () =>
        run.immediate()
      )
      this.retainedIgnoredDeltaCursors.delete(String(envelope.invocationId))
      return result
    } catch (error) {
      this.nextBufferChunkSeqByRunId.clear()
      for (const [runId, nextChunkSeq] of chunkSeqSnapshot) {
        this.nextBufferChunkSeqByRunId.set(runId, nextChunkSeq)
      }
      throw error
    }
  }

  /**
   * Persist the broker-authoritative snapshot view without translating it.
   * The envelope path only reports that a refresh is needed; this method is the
   * single projection point for the resulting CaptureStateView.
   */
  projectCaptureState(
    runtimeId: string,
    capture: CaptureStateView | undefined
  ): HrcLifecycleEvent | undefined {
    if (capture === undefined) return undefined
    const run = this.db.sqlite.transaction(() => {
      const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
      if (!runtime) {
        throw new Error(`runtime not found for capture state: ${runtimeId}`)
      }
      const previous = runtime.runtimeStateJson?.['capture'] as CaptureStateView | undefined
      if (JSON.stringify(previous) === JSON.stringify(capture)) return undefined

      const now = this.now()
      this.db.runtimes.update(runtimeId, {
        runtimeStateJson: {
          ...(runtime.runtimeStateJson ?? {}),
          capture,
        },
        updatedAt: now,
      })

      const previousState = previous?.state
      const stateFlipped =
        previousState !== capture.state &&
        (previousState !== undefined || capture.state === 'blocked')
      if (!stateFlipped) return undefined

      return appendHrcEvent(this.db, 'runtime.capture_state_changed', {
        ts: now,
        hostSessionId: runtime.hostSessionId,
        scopeRef: runtime.scopeRef,
        laneRef: runtime.laneRef,
        generation: runtime.generation,
        runtimeId,
        ...(runtime.activeRunId !== undefined ? { runId: runtime.activeRunId } : {}),
        transport: lifecycleTransportFromRuntime(runtime.transport),
        payload: {
          previousCapture: previous ?? null,
          capture,
        },
      })
    })
    return run()
  }

  /** Record an operator disposition and apply the broker-returned capture view. */
  projectCaptureRelease(
    runtimeId: string,
    operatorPrincipal: string,
    request: InvocationCaptureReleaseRequest,
    response: InvocationCaptureReleaseResponse
  ): HrcLifecycleEvent[] {
    const stateEvent = this.projectCaptureState(runtimeId, response.capture)
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime) {
      throw new Error(`runtime not found for capture release: ${runtimeId}`)
    }
    const releasedEvent = appendHrcEvent(this.db, 'runtime.capture_released', {
      ts: this.now(),
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
      runtimeId,
      ...(runtime.activeRunId !== undefined ? { runId: runtime.activeRunId } : {}),
      transport: lifecycleTransportFromRuntime(runtime.transport),
      payload: { operatorPrincipal, request, response },
    })
    this.serverLog('WARN', 'broker.capture_released', {
      runtimeId,
      scopeRef: runtime.scopeRef,
      invocationId: String(request.invocationId),
      operatorPrincipal,
      rawRecordId: response.rawRecordId,
      disposition: response.disposition,
      resumedRecords: response.resumedRecords,
    })
    return [...(stateEvent ? [stateEvent] : []), releasedEvent]
  }

  private logBlockedUnknownCaptureWarning(envelope: InvocationEventEnvelope): void {
    if (
      envelope.type !== 'capture.warning' ||
      envelope.payload.kind !== 'blocked_unknown' ||
      !isRecord(envelope.payload.raw)
    ) {
      return
    }

    const invocation = this.db.brokerInvocations.getByInvocationId(envelope.invocationId)
    if (!invocation) return
    const runtime = this.db.runtimes.getByRuntimeId(invocation.runtimeId)
    if (!runtime) return

    const raw = envelope.payload.raw
    const nativeType =
      typeof raw['nativeType'] === 'string'
        ? raw['nativeType']
        : (envelope.provenance?.nativeType ?? 'unknown')
    const family = typeof raw['family'] === 'string' ? raw['family'] : 'unknown'
    const rawRecordId =
      typeof raw['rawRecordId'] === 'string'
        ? raw['rawRecordId']
        : (envelope.provenance?.rawRecordId ?? 'unknown')
    const invocationId = String(envelope.invocationId)
    const key = JSON.stringify([runtime.runtimeId, nativeType, family])
    const loggedAt = this.rateLimitNow()
    const previous = this.captureWarningLogState.get(key)
    const nextCount = previous?.invocationId === invocationId ? previous.count + 1 : 1
    if (
      previous?.invocationId === invocationId &&
      loggedAt - previous.lastLoggedAt < CAPTURE_WARNING_LOG_INTERVAL_MS
    ) {
      previous.count = nextCount
      return
    }

    this.captureWarningLogState.set(key, {
      invocationId,
      lastLoggedAt: loggedAt,
      count: nextCount,
    })
    const capture = runtime.runtimeStateJson?.['capture']
    const captureDetails =
      isRecord(capture) && typeof capture['state'] === 'string'
        ? {
            state: capture['state'],
            ...(typeof capture['deferredCount'] === 'number'
              ? { deferredCount: capture['deferredCount'] }
              : {}),
          }
        : undefined
    this.serverLog('WARN', 'broker.capture_blocked_unknown', {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      invocationId,
      driver: envelope.driver?.kind ?? invocation.brokerDriver,
      harness: runtime.harness,
      family,
      nativeType,
      rawRecordId,
      message: envelope.payload.message,
      ...(captureDetails !== undefined ? { capture: captureDetails } : {}),
      count: nextCount,
    })
  }
}

// Declaration merges prototype-attached projection methods into BrokerEventMapper.
export interface BrokerEventMapper
  extends ProjectEnvelopeMethods,
    RunResolutionMethods,
    StateProjectionMethods,
    Format2InputMethods,
    TurnProjectionMethods,
    MessageProjectionMethods {}

Object.assign(
  BrokerEventMapper.prototype,
  projectEnvelopeMethods,
  runResolutionMethods,
  stateProjectionMethods,
  format2InputMethods,
  turnProjectionMethods,
  messageProjectionMethods
)
