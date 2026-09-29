/**
 * BrokerEventMapper run/turn owner resolution and Format-2 turn-start preparation.
 *
 * Extracted verbatim from event-mapper.ts as a pure mechanical move; methods are
 * attached to the BrokerEventMapper prototype (see event-mapper.ts).
 */
import { randomUUID } from 'node:crypto'

import type {
  HrcBrokerInvocationRecord,
  HrcInputRecord,
  HrcLifecycleEvent,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import type { SubmissionDisposition } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { runtimeHasAnyOpenAskBracket } from '../../ask-bracket'
import { isLaunchCarriedInvokeCorrelationJson } from '../../server-types'
import { resolveExactTurnOwner } from '../turn-ownership.js'
import {
  type ProjectionContext,
  TERMINAL_TURN_EVENT_TYPE_SQL,
  lifecycleTransportFromRuntime,
} from './helpers'

import type { BrokerEventMapper } from '../event-mapper'
import { isRecord } from '../json'
import type { Format2TurnStart } from './envelope-predicates'

const NONTERMINAL_RUN_STATUSES = new Set(['accepted', 'started', 'running'])

export const runResolutionMethods = {
  /**
   * Resolve the runId this event belongs to, robust to out-of-order projection.
   *
   * Events with explicit inputId are authoritative. Events without inputId are
   * attributed through the open turn bracket: find the most recent turn.started
   * at seq <= event.seq that has not been closed by a terminal turn before the
   * event, then resolve the input.accepted that started that bracket.
   *
   * This is seq-based rather than arrival-order-based, so a later queued
   * input.accepted row cannot steal ownership from the turn whose started
   * bracket is still open.
   */
  resolveRunIdForEvent(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    invocation: HrcBrokerInvocationRecord,
    runtime: HrcRuntimeSnapshot
  ): string | undefined {
    if (invocation.executionFormat === 'format2') {
      return this.resolveFormat2RunId(envelope, invocation, runtime)
    }
    const fallbackRunId = invocation.runId
    const submissionId = this.extractSubmissionIdFromPayload(envelope.payload)
    const submissionRecord =
      envelope.type.startsWith('submission.') ||
      envelope.type.startsWith('admission.') ||
      envelope.type.startsWith('input.') ||
      envelope.type.startsWith('queue.')
    if (submissionRecord && submissionId !== undefined) {
      const run = this.db.runs.getByBrokerSubmissionId(submissionId)
      if (run?.runId !== undefined) return run.runId
    }

    const turnId = this.extractTurnId(envelope)
    const envelopeInputId = envelope.inputId ?? this.extractInputIdFromPayload(envelope.payload)

    // A named execution turn has one durable owner derived only from immutable
    // initiating evidence in this invocation's historical epoch. Never fall
    // through from an unresolved named turn to submission order, the current
    // runtime owner, or the newest open bracket.
    if (turnId !== undefined && !submissionRecord) {
      return resolveExactTurnOwner(this.db, envelope)
    }

    const bracketMintingMode = this.bracketMintingMode(invocation)

    // Prefer envelope.inputId when the broker sets it: input.accepted /
    // input.queued / input.rejected always carry it (contract), and
    // input.queued specifically refers to the QUEUED input.
    if (envelopeInputId !== undefined) {
      const run = this.runForInputIdentity(envelopeInputId)
      if (run?.runId) return run.runId
      return fallbackRunId
    }

    const openTurnStartedSeq = this.findOpenTurnStartedSeqForAttribution(envelope)
    if (openTurnStartedSeq !== undefined) {
      // Harness-evidence drivers identify the submitted turn on the observed
      // turn.started itself. An input-id-less bracket is therefore affirmative
      // evidence of a foreign prompt (not permission to borrow the nearest
      // prior input.accepted). This matters during cold-seat priming: the
      // summons may already be accepted while the harness is still answering
      // its argv priming prompt. Delivery-acknowledged/asserted drivers retain
      // the historical nearest-input fallback below.
      if (
        bracketMintingMode === 'harness-evidence' &&
        this.turnStartedInputId(envelope, openTurnStartedSeq) === undefined
      ) {
        // T-07920: a summons that births a launch-primed seat deliberately has
        // no broker input. The invocation's initial run supplied the launch
        // prompt and the first observed bracket is its launch turn. This stays
        // narrower than the historical fallback: an older promptless birth
        // followed by a queued summons has dispatchedInputId set, so T-07915
        // still leaves that foreign priming turn unowned.
        //
        // T-08094 removed a second arm here — "this run belongs to a mail drive
        // attempt". The drive attempt is gone, and the kicker's cold birth now
        // goes through the invoke door like every other launch-carried first
        // turn, so the correlation below is the whole (and more truthful) test:
        // it records that THIS run put the prompt on launch, rather than that
        // some mail was involved.
        const fallbackRun =
          fallbackRunId === undefined ? null : this.db.runs.getByRunId(fallbackRunId)
        const launchCarriedInvoke =
          fallbackRunId !== undefined &&
          isLaunchCarriedInvokeCorrelationJson(this.db.runs.getCorrelationJson(fallbackRunId))
        if (
          fallbackRunId !== undefined &&
          fallbackRun?.dispatchedInputId === undefined &&
          launchCarriedInvoke
        ) {
          return fallbackRunId
        }
        return undefined
      }
      const bracketInput = this.findPriorInputAccepted(envelope.invocationId, openTurnStartedSeq)
      if (bracketInput) {
        const run = this.runForInputIdentity(bracketInput.inputId)
        if (run?.runId) return run.runId
      }
      const fencedInput = this.findPriorFencedInputAccepted(
        envelope.invocationId,
        openTurnStartedSeq
      )
      if (fencedInput) return fencedInput.runId
      return fallbackRunId
    }

    // No open turn.started bracket. The broker can omit turn.started entirely
    // for a delivered input (T-04845: claude-code-tmux dispatched to an idle
    // runtime emitted input.accepted -> body -> turn.completed with no start),
    // which would otherwise orphan the whole turn to an empty run_id. Attribute
    // to the prior input.accepted's run ONLY when durable broker order proves it
    // is ALREADY the runtime owner (daedalus DM #8234, option B). Any ambiguity
    // keeps the conservative undefined default that protects T-04238.
    const priorInput = this.findPriorInputAccepted(envelope.invocationId, envelope.seq)
    if (priorInput) {
      // T-08566: the no-bracket rule infers ownership from the CURRENT runtime
      // owner, which retained history must never borrow.
      if (this.retainedProjection) return undefined
      return this.resolveNoBracketOwner(envelope, priorInput, invocation, runtime)
    }
    const fencedInput = this.findPriorFencedInputAccepted(envelope.invocationId, envelope.seq)
    if (fencedInput) return fencedInput.runId
    return fallbackRunId
  },

  /**
   * Format-2 execution identity never falls back to an admission, active run,
   * or nearest bracket. Only an exact native turn coordinate selects a run.
   */
  resolveFormat2RunId(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    invocation: HrcBrokerInvocationRecord,
    runtime: HrcRuntimeSnapshot
  ): string | undefined {
    const turnId = this.extractTurnId(envelope)
    if (turnId === undefined) return undefined
    return this.db.runs.getByTurnKey(this.format2TurnKey(envelope, invocation, runtime, turnId))
      ?.runId
  },

  prepareFormat2TurnStart(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    invocation: HrcBrokerInvocationRecord,
    runtime: HrcRuntimeSnapshot,
    generation: number,
    now: string
  ): Format2TurnStart | undefined {
    if (
      this.retainedProjection ||
      invocation.executionFormat !== 'format2' ||
      envelope.type !== 'turn.started'
    ) {
      return undefined
    }
    const turnId = this.extractTurnId(envelope)
    if (turnId === undefined) return undefined

    const turnKey = this.format2TurnKey(envelope, invocation, runtime, turnId)
    const existing = this.db.runs.getByTurnKey(turnKey)
    if (existing !== null) {
      return {
        runId: existing.runId,
        turnId,
        ...(existing.initiatingInputId !== undefined
          ? { initiatingInputId: existing.initiatingInputId }
          : {}),
        joinedInputIds: [],
        minted: false,
      }
    }

    const direct = this.format2InputForEnvelope(envelope, invocation, runtime)
    const executed = this.format2InputsForDisposition(
      invocation,
      runtime,
      turnId,
      'submission.executed'
    )
    const initiating = direct ?? executed[0]
    const joined = this.format2InputsForDisposition(
      invocation,
      runtime,
      turnId,
      'submission.absorbed'
    )
      .filter((input) => input.inputId !== initiating?.inputId)
      .map((input) => input.inputId)

    const runId = `run-${randomUUID()}`
    this.db.runs.insert({
      runId,
      hostSessionId: runtime.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation,
      transport: lifecycleTransportFromRuntime(runtime.transport),
      status: 'running',
      startedAt: envelope.time ?? now,
      updatedAt: now,
      executionFormat: 'format2',
      turnKey,
      nativeTurnId: turnId,
      ...(envelope.harnessGeneration !== undefined
        ? { nativeHarnessGeneration: envelope.harnessGeneration }
        : {}),
      ...(envelope.turnAttempt !== undefined ? { nativeTurnAttempt: envelope.turnAttempt } : {}),
      ...(initiating !== undefined ? { initiatingInputId: initiating.inputId } : {}),
      observationState: 'observed',
      operationId: invocation.operationId,
      invocationId: String(invocation.invocationId),
    })
    return {
      runId,
      turnId,
      ...(initiating !== undefined ? { initiatingInputId: initiating.inputId } : {}),
      joinedInputIds: [...new Set(joined)],
      minted: true,
    }
  },

  finalizeFormat2TurnStart(
    this: BrokerEventMapper,
    start: Format2TurnStart,
    ctx: ProjectionContext,
    lifecycleEvent: HrcLifecycleEvent | undefined,
    now: string
  ): void {
    if (lifecycleEvent?.eventKind !== 'turn.started') return
    this.db.runs.update(start.runId, {
      observedStartHrcSeq: lifecycleEvent.hrcSeq,
      observationState: 'observed',
      updatedAt: now,
    })
    if (start.initiatingInputId !== undefined) {
      this.landFormat2Input({
        inputId: start.initiatingInputId,
        kind: 'initiating',
        runId: start.runId,
        turnId: start.turnId,
        runStartedHrcSeq: lifecycleEvent.hrcSeq,
        ctx,
        now,
      })
    }
    for (const inputId of start.joinedInputIds) {
      this.landFormat2Input({
        inputId,
        kind: 'joined',
        runId: start.runId,
        turnId: start.turnId,
        runStartedHrcSeq: lifecycleEvent.hrcSeq,
        ctx,
        now,
      })
    }
  },

  format2TurnKey(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    invocation: HrcBrokerInvocationRecord,
    runtime: HrcRuntimeSnapshot,
    turnId: string
  ): string {
    return [
      runtime.runtimeId,
      invocation.operationId,
      String(invocation.invocationId),
      turnId,
      `g=${envelope.harnessGeneration ?? '-'}`,
      `a=${envelope.turnAttempt ?? '-'}`,
    ].join('|')
  },

  format2InputForEnvelope(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    invocation: HrcBrokerInvocationRecord,
    runtime: HrcRuntimeSnapshot
  ): HrcInputRecord | undefined {
    // Format-2 HRC input identifiers are never correlated to native envelope
    // `inputId` fields.  A native disposition is attributable only through its
    // `submissionId` and the prebound/returned broker submission identity.
    // The launch-carried initial input is prebound before start under the
    // producer's explicit contract; later inputs bind the submission id the
    // broker returned.  Both comparisons remain inside this invocation's
    // durable placement fence.
    const nativeIds = [
      envelope.inputId,
      this.extractInputIdFromPayload(envelope.payload),
      this.extractSubmissionIdFromPayload(envelope.payload),
    ].filter((value): value is string => typeof value === 'string')
    const matches = new Map<string, HrcInputRecord>()
    for (const nativeId of new Set(nativeIds)) {
      const input = this.db.inputs.getByBrokerSubmissionId(nativeId)
      if (
        input !== null &&
        input.invocationId === String(invocation.invocationId) &&
        input.runtimeId === runtime.runtimeId &&
        input.operationId === invocation.operationId
      ) {
        matches.set(input.inputId, input)
      }
    }
    // An envelope that names two different native submissions cannot decide
    // which HRC input is its subject.  Preserve both reservations and wait for
    // unambiguous evidence; choosing the first field would let a malformed or
    // conflicting payload misdeliver a protected body.
    return matches.size === 1 ? [...matches.values()][0] : undefined
  },

  format2InputsForDisposition(
    this: BrokerEventMapper,
    invocation: HrcBrokerInvocationRecord,
    runtime: HrcRuntimeSnapshot,
    turnId: string,
    type: 'submission.executed' | 'submission.absorbed'
  ): HrcInputRecord[] {
    const inputs = new Map<string, HrcInputRecord>()
    for (const event of this.db.brokerInvocationEvents.listByInvocationId(
      String(invocation.invocationId)
    )) {
      if (event.type !== type) continue
      let payload: unknown
      try {
        payload = JSON.parse(event.brokerEventJson) as unknown
      } catch {
        continue
      }
      if (!isRecord(payload) || payload['turnId'] !== turnId) continue
      const submissionId = payload['submissionId']
      if (typeof submissionId !== 'string') continue
      const input = this.db.inputs.getByBrokerSubmissionId(submissionId)
      if (
        input !== null &&
        input.invocationId === String(invocation.invocationId) &&
        input.runtimeId === runtime.runtimeId &&
        input.operationId === invocation.operationId
      ) {
        inputs.set(input.inputId, input)
      }
    }
    return [...inputs.values()]
  },

  bracketMintingMode(
    this: BrokerEventMapper,
    invocation: HrcBrokerInvocationRecord
  ): string | undefined {
    try {
      const capabilities = JSON.parse(invocation.capabilitiesJson) as unknown
      if (capabilities === null || typeof capabilities !== 'object') return undefined
      const value = (capabilities as Record<string, unknown>)['bracketMintingMode']
      return typeof value === 'string' ? value : undefined
    } catch {
      return undefined
    }
  },

  turnStartedInputId(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    turnStartedSeq: number
  ): string | undefined {
    if (envelope.type === 'turn.started' && envelope.seq === turnStartedSeq) {
      return envelope.inputId ?? this.extractInputIdFromPayload(envelope.payload)
    }
    const started = this.db.brokerInvocationEvents.getByInvocationAndSeq(
      envelope.invocationId,
      turnStartedSeq
    )
    if (started === null) return undefined
    let storedPayload: unknown
    try {
      storedPayload = JSON.parse(started.brokerEventJson) as unknown
    } catch {
      storedPayload = undefined
    }
    const payloadInputId = this.extractInputIdFromPayload(storedPayload)
    if (payloadInputId !== undefined) return payloadInputId
    if (started.brokerEnvelopeJson === undefined) return undefined
    try {
      const parsed = JSON.parse(started.brokerEnvelopeJson) as unknown
      if (parsed === null || typeof parsed !== 'object') return undefined
      const inputId = (parsed as Record<string, unknown>)['inputId']
      return typeof inputId === 'string' ? inputId : undefined
    } catch {
      return undefined
    }
  },

  /**
   * No-`turn.started`-bracket attribution, gated on the full runtime-ownership
   * predicate (daedalus DM #8234 invariant). Returns the candidate runId iff
   * ALL clauses hold; otherwise undefined (never infer ownership from "nearest
   * prior input.accepted" alone — that would reintroduce T-04238):
   *   1. an input.accepted(candidate.dispatchedInputId) exists at seq <= event;
   *   2. candidate is the current runtime owner (runtime.activeRunId === runId,
   *      or invocation.runId for initial-start equivalence) on this runtime;
   *   3. candidate accept seq is AFTER the most recent terminal turn before the
   *      event (post-terminal queued stray events stay orphaned);
   *   4. no open turn bracket (already true here) AND no open ask bracket;
   *   5. no OTHER active nonterminal run for this invocation/runtime.
   */
  resolveNoBracketOwner(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    priorInput: { inputId: string; seq: number },
    invocation: HrcBrokerInvocationRecord,
    runtime: HrcRuntimeSnapshot
  ): string | undefined {
    // (1) candidate run for the prior input.accepted.
    const candidate = this.runForInputIdentity(priorInput.inputId)
    if (!candidate?.runId) return undefined
    // candidate must live on this runtime/invocation.
    if (candidate.runtimeId !== runtime.runtimeId) return undefined

    // (2) candidate must be the current runtime owner.
    const ownerRunId = runtime.activeRunId ?? invocation.runId
    if (ownerRunId === undefined || ownerRunId !== candidate.runId) return undefined

    // (3) candidate accept must be after the most recent terminal turn before
    // this event — otherwise the candidate's turn already closed and this is a
    // post-terminal stray event.
    const priorTerminalSeq = this.findPriorTerminalTurnSeq(envelope.invocationId, envelope.seq)
    if (priorTerminalSeq !== undefined && priorInput.seq <= priorTerminalSeq) return undefined

    // (4) no open ask bracket on the runtime (no open turn bracket is implied by
    // reaching this branch).
    if (runtimeHasAnyOpenAskBracket(this.db, runtime)) return undefined

    // (5) no OTHER active nonterminal run for this invocation/runtime.
    if (this.hasOtherActiveNonterminalRun(runtime.runtimeId, candidate.runId)) return undefined

    return candidate.runId
  },

  runForInputIdentity(this: BrokerEventMapper, inputId: string) {
    return (
      this.db.runs.getByDispatchedInputId(inputId) ?? this.db.runs.getByBrokerSubmissionId(inputId)
    )
  },

  hasOtherActiveNonterminalRun(
    this: BrokerEventMapper,
    runtimeId: string,
    candidateRunId: string
  ): boolean {
    return this.db.runs
      .listByRuntimeId(runtimeId)
      .some((run) => run.runId !== candidateRunId && NONTERMINAL_RUN_STATUSES.has(run.status))
  },

  findPriorTerminalTurnSeq(
    this: BrokerEventMapper,
    invocationId: string,
    beforeSeq: number
  ): number | undefined {
    const row = this.db.sqlite
      .query<{ seq: number }, [string, number]>(
        `SELECT seq FROM broker_invocation_events
          WHERE invocation_id = ?
            AND type IN (${TERMINAL_TURN_EVENT_TYPE_SQL})
            AND seq < ?
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(invocationId, beforeSeq)
    return row?.seq
  },

  extractInputIdFromPayload(this: BrokerEventMapper, payload: unknown): string | undefined {
    if (payload && typeof payload === 'object' && 'inputId' in payload) {
      const v = (payload as { inputId?: unknown }).inputId
      return typeof v === 'string' ? v : undefined
    }
    return undefined
  },

  extractSubmissionIdFromPayload(this: BrokerEventMapper, payload: unknown): string | undefined {
    if (payload && typeof payload === 'object' && 'submissionId' in payload) {
      const value = (payload as { submissionId?: unknown }).submissionId
      return typeof value === 'string' ? value : undefined
    }
    return undefined
  },

  recordRetainedSubmissionDisposition(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    disposition: SubmissionDisposition,
    now: string
  ): void {
    const submissionId = this.extractSubmissionIdFromPayload(envelope.payload)
    if (submissionId === undefined) return
    this.db.submissionAdmissions.recordDisposition({
      submissionId,
      disposition,
      disposedAt: envelope.time ?? now,
      onlyIfAbsent: true,
    })
  },

  extractTurnId(this: BrokerEventMapper, envelope: InvocationEventEnvelope): string | undefined {
    if (typeof envelope.turnId === 'string') return envelope.turnId
    if (envelope.payload && typeof envelope.payload === 'object' && 'turnId' in envelope.payload) {
      const value = (envelope.payload as { turnId?: unknown }).turnId
      return typeof value === 'string' ? value : undefined
    }
    return undefined
  },

  findPriorInputAccepted(
    this: BrokerEventMapper,
    invocationId: string,
    seq: number
  ): { inputId: string; seq: number } | undefined {
    // json_extract on broker_event_json (the payload, which carries inputId
    // on input.accepted per broker contract). Filtering on type='input.accepted'
    // before json_extract keeps this O(log n) via the (invocation_id, seq) index.
    const row = this.db.sqlite
      .query<{ inputId: string | null; seq: number }, [string, number]>(
        `SELECT seq, json_extract(broker_event_json, '$.inputId') AS inputId
           FROM broker_invocation_events
          WHERE invocation_id = ? AND type = 'input.accepted' AND seq <= ?
            AND NOT EXISTS (
              SELECT 1
                FROM runs
               WHERE runs.dispatched_input_id = json_extract(broker_invocation_events.broker_event_json, '$.inputId')
                 AND runs.broker_input_fenced_at IS NOT NULL
            )
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(invocationId, seq)
    return row?.inputId ? { inputId: row.inputId, seq: row.seq } : undefined
  },

  findPriorFencedInputAccepted(
    this: BrokerEventMapper,
    invocationId: string,
    seq: number
  ): { inputId: string; runId: string; seq: number } | undefined {
    const row = this.db.sqlite
      .query<{ inputId: string | null; runId: string | null; seq: number }, [string, number]>(
        `SELECT
            broker_invocation_events.seq AS seq,
            json_extract(broker_invocation_events.broker_event_json, '$.inputId') AS inputId,
            runs.run_id AS runId
           FROM broker_invocation_events
           JOIN runs
             ON runs.dispatched_input_id = json_extract(broker_invocation_events.broker_event_json, '$.inputId')
            AND runs.broker_input_fenced_at IS NOT NULL
          WHERE broker_invocation_events.invocation_id = ?
            AND broker_invocation_events.type = 'input.accepted'
            AND broker_invocation_events.seq <= ?
          ORDER BY broker_invocation_events.seq DESC
          LIMIT 1`
      )
      .get(invocationId, seq)
    return row?.inputId && row.runId
      ? { inputId: row.inputId, runId: row.runId, seq: row.seq }
      : undefined
  },

  findOpenTurnStartedSeqForAttribution(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope
  ): number | undefined {
    if (envelope.type === 'turn.started') {
      return envelope.seq
    }
    const row = this.db.sqlite
      .query<{ seq: number }, [string, number, number]>(
        `SELECT started.seq AS seq
           FROM broker_invocation_events AS started
          WHERE started.invocation_id = ?
            AND started.type = 'turn.started'
            AND started.seq <= ?
            AND NOT EXISTS (
              SELECT 1
                FROM broker_invocation_events AS terminal
               WHERE terminal.invocation_id = started.invocation_id
                 AND terminal.type IN (${TERMINAL_TURN_EVENT_TYPE_SQL})
                 AND terminal.seq > started.seq
                 AND terminal.seq < ?
            )
          ORDER BY started.seq DESC
          LIMIT 1`
      )
      .get(envelope.invocationId, envelope.seq, envelope.seq)
    return row?.seq
  },
}

export type RunResolutionMethods = typeof runResolutionMethods
