import { randomUUID } from 'node:crypto'

import {
  HRC_STARTED_FRESH_TURN_OUTCOME,
  HrcDomainError,
  HrcErrorCode,
  HrcUnprocessableEntityError,
  hrcAdmittedIntoActiveTurn,
  hrcPresentedToLiveHarness,
} from 'hrc-core'
import type {
  HrcDeliveryOutcome,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcSteerContributionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import type { InvocationInput } from 'spaces-harness-broker-protocol'
import { appendHrcEvent, createUserPromptPayload } from './hrc-event-helper.js'
import { isBrokerRuntimeSteerCapable, isRunActive } from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { json, timestamp } from './server-util.js'

/**
 * T-07203 (spec r7, daedalus-approved) — the steer-class dispatch flow shared
 * by the headless and interactive broker routes.
 *
 * Contract: a `whenBusy:'steer'` dispatch either reports an HONEST success —
 * admitted_into_active_turn (headless codex, actuator proves turn admission),
 * presented_to_live_harness (claude-code-tmux, actuator proves only a pane
 * write), or started_fresh_turn (the target was idle by the time the broker
 * acted) — or fails typed. It is never silently downgraded into a queue.
 *
 * Load-bearing invariants, each the resolution of a named rejection flaw:
 * - The steer policy is only sent when HRC holds the run identity the outcome
 *   will cite; with no known activeRun the first call is a NON-ACTUATING
 *   `reject` probe and the broker's live state decides (r4).
 * - Exactly one steerContributions row is written BEFORE the first call that
 *   can actuate — probe included, since its 'started' disposition IS
 *   actuation — and that ledger is the SOLE retry authority: steer-class run
 *   rows never carry the dispatch idempotency key (r3, r5).
 * - URGENT_DELIVERY_UNSUPPORTED is an ALLOWLIST of refusals proven to fire
 *   before any driver invocation; every other failure seals AMBIGUOUS because
 *   actuation may have begun (r6 — the pane receives text before Enter).
 * - The provisional run row exists only for event-mapper correlation; when the
 *   input joins another turn it is terminalized `cancelled` (tagged
 *   superseded_by_steer) and its runId appears in no response or replay (r3).
 */

type SteerRoute = 'headless' | 'interactive'

type BrokerDispatchResult =
  | {
      ok: true
      response: { accepted: boolean; disposition?: string | undefined; reason?: string | undefined }
    }
  | { ok: false; error: { code: string; message: string } }

const RACE_LOST_PATTERN = /expectedTurnId|active turn|turn_mismatch|no active turn/i
const PROBE_BUSY_REJECTED_PATTERN = /busy_rejected/

/**
 * r6 allowlist: refusal shapes proven (and daedalus-verified against producer
 * source) to occur before the driver/actuator is invoked. Only these may seal
 * UNSUPPORTED. Reasons are matched against the broker's own constants —
 * equality/prefix, no free-text heuristics.
 */
function isProvablyNonActuatedRefusal(result: BrokerDispatchResult): boolean {
  if (!result.ok) {
    return result.error.code === 'broker_runtime_not_active'
  }
  if (result.response.accepted) return false
  const reason = result.response.reason ?? ''
  return reason === 'steer_not_supported' || reason.startsWith('UnsupportedCapability')
}

export async function executeSteerClassDispatch(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  options: {
    route: SteerRoute
    responseFormat?: HrcTurnResponseFormat | undefined
    dispatchIdempotencyKey?: string | undefined
    dispatchRequestHash?: string | undefined
    /**
     * T-07214 best-effort (steer_else_queue): provably NON-actuated failures
     * return the 'floor' sentinel (caller delivers the route's ordinary
     * floor) instead of throwing typed. AMBIGUOUS still throws — a possibly
     * actuated order is never delivered a second time by any class.
     */
    bestEffort?: boolean | undefined
  }
): Promise<Response | 'floor'> {
  const route = options.route
  const transport: 'headless' | 'tmux' = route === 'headless' ? 'headless' : 'tmux'
  const invocationId = runtime.activeInvocationId

  if (runtime.controllerKind !== 'harness-broker' || invocationId === undefined) {
    if (options.bestEffort === true) return 'floor'
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.URGENT_DELIVERY_UNSUPPORTED,
      'the target runtime has no durable broker endpoint that can be steered',
      { runtimeId: runtime.runtimeId, route, recommendation: 'rotate the runtime' }
    )
  }

  // Ledger replay: the SOLE retry authority for steer-class dispatches.
  const idempotencyKey = options.dispatchIdempotencyKey
  if (idempotencyKey !== undefined) {
    const existing = this.db.steerContributions.findByIdempotencyKey(
      session.hostSessionId,
      idempotencyKey
    )
    if (existing !== null) {
      if (
        existing.requestHash !== undefined &&
        options.dispatchRequestHash !== undefined &&
        existing.requestHash !== options.dispatchRequestHash
      ) {
        throw new HrcDomainError(
          HrcErrorCode.STALE_CONTEXT,
          'dispatch idempotency key was already used for a different request',
          { hostSessionId: session.hostSessionId, idempotencyKey }
        )
      }
      return replaySteerClassContribution(session, existing, route, transport)
    }
  }

  // Capability gate: negotiated against the LIVE broker process. Unconditional
  // (idle or busy) — a steer request to a non-steer-capable target fails typed
  // with zero broker calls; the sender resends without --steer.
  if (!isBrokerRuntimeSteerCapable(this.db, runtime)) {
    if (options.bestEffort === true) return 'floor'
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.URGENT_DELIVERY_UNSUPPORTED,
      'the broker serving this runtime cannot accept urgent delivery',
      {
        runtimeId: runtime.runtimeId,
        invocationId,
        route,
        recommendation:
          'this runtime predates urgent delivery; rotate it so a current broker process serves it',
      }
    )
  }

  const activeRun =
    runtime.activeRunId !== undefined ? this.db.runs.getByRunId(runtime.activeRunId) : null
  const knownActiveRun = activeRun !== null && isRunActive(activeRun) ? activeRun : null

  // The provisional run row: keyless (r3 — the ledger owns retry identity),
  // internally minted (its runId must never surface in any response, so it can
  // never collide with route-layer run projections), inserted BEFORE dispatch
  // so the event-mapper can correlate the drained input.accepted envelope on
  // whichever side of the busy race the broker lands.
  const provisionalRunId = `run-${randomUUID()}`
  const inputId = `input-${randomUUID()}`
  const now = timestamp()
  this.db.runs.insert({
    runId: provisionalRunId,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport,
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
    invocationId,
    operationId: runtime.activeOperationId,
    dispatchedInputId: inputId,
  })

  // Universal write-ahead (r5): one ledger row before the FIRST call that can
  // actuate. On the idle path the recorded run pointer is the provisional row —
  // the run that becomes live if the probe lands 'started'.
  const contributionId = `steer-${randomUUID()}`
  this.db.steerContributions.insertAttempting({
    contributionId,
    hostSessionId: session.hostSessionId,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(options.dispatchRequestHash !== undefined
      ? { requestHash: options.dispatchRequestHash }
      : {}),
    runtimeId: runtime.runtimeId,
    invocationId,
    activeRunId: knownActiveRun?.runId ?? provisionalRunId,
    inputId,
    now,
  })

  // T-01996: as on the input-turn executors — let the post-restart serving
  // controller finish warmup so the first dispatch does not race a cold
  // controller into a spurious broker_runtime_not_active refusal.
  await this.brokerWarmupComplete

  const flow = new SteerClassFlow(this, session, runtime, prompt, {
    route,
    transport,
    invocationId,
    provisionalRunId,
    inputId,
    contributionId,
    bestEffort: options.bestEffort === true,
  })

  if (knownActiveRun !== null) {
    return await flow.steerAgainst(knownActiveRun)
  }

  // Idle path (r4): NON-ACTUATING reject probe. Never 'queue' (silent-downgrade
  // fence) and never 'steer' (no citable identity yet).
  const probe = (await this.getHarnessBrokerController().dispatchInput({
    runtimeId: runtime.runtimeId,
    input: flow.buildInput(provisionalRunId),
    policy: { whenBusy: 'reject' as const },
  })) as BrokerDispatchResult

  if (probe.ok && probe.response.accepted && probe.response.disposition === 'started') {
    return flow.retainStartedRun()
  }

  const probeBusyRejected =
    !probe.ok &&
    probe.error.code === 'broker_input_failed' &&
    PROBE_BUSY_REJECTED_PATTERN.test(probe.error.message)
  if (probeBusyRejected) {
    // The probe revealed a concurrent turn. Its refusal is non-actuated by the
    // broker's reject-policy contract; resolve the identity the concurrent
    // dispatcher wrote (synchronously, before its own broker call) and make
    // the single steer attempt against it.
    const freshRuntime = this.db.runtimes.getByRuntimeId(runtime.runtimeId)
    const resolved =
      freshRuntime?.activeRunId !== undefined
        ? this.db.runs.getByRunId(freshRuntime.activeRunId)
        : null
    if (resolved !== null && isRunActive(resolved) && resolved.runId !== provisionalRunId) {
      this.db.steerContributions.updateAttemptingRunPointer(contributionId, {
        activeRunId: resolved.runId,
        runtimeId: runtime.runtimeId,
        invocationId,
        now: timestamp(),
      })
      return await flow.steerAgainst(resolved)
    }
    // Double race: a turn began and ended entirely inside the probe window.
    // Non-actuated, honest, retryable by the sender.
    if (options.bestEffort === true) {
      return flow.floorFallback('race_lost')
    }
    flow.sealFailure('race_lost', HrcErrorCode.URGENT_DELIVERY_RACE_LOST)
    throw new HrcDomainError(
      HrcErrorCode.URGENT_DELIVERY_RACE_LOST,
      'a turn began and ended around the steer request; the order did not preempt it',
      { runtimeId: runtime.runtimeId, invocationId, route }
    )
  }

  return flow.failTyped(probe, { phase: 'probe' })
}

/**
 * Per-dispatch state and the disposition handling shared by both phases.
 * A class keeps the bookkeeping (session, ids, sealing) in one place without
 * threading eight arguments through every branch.
 */
class SteerClassFlow {
  constructor(
    private readonly server: HrcServerInstanceForHandlers,
    private readonly session: HrcSessionRecord,
    private readonly runtime: HrcRuntimeSnapshot,
    private readonly prompt: string,
    private readonly ctx: {
      route: SteerRoute
      transport: 'headless' | 'tmux'
      invocationId: string
      provisionalRunId: string
      inputId: string
      contributionId: string
      bestEffort: boolean
    }
  ) {}

  buildInput(metadataRunId: string): InvocationInput {
    return {
      inputId: this.ctx.inputId as InvocationInput['inputId'],
      kind: 'user',
      content: [{ type: 'text', text: this.prompt }],
      metadata: { runId: metadataRunId },
    }
  }

  async steerAgainst(activeRun: HrcRunRecord): Promise<Response | 'floor'> {
    const { server, session, runtime, ctx } = this
    const now = timestamp()

    // Attribution against the ACTIVE run: the audit trail must show who
    // preempted whom, and that the order arrived mid-flight.
    const userPromptEvent = appendHrcEvent(server.db, 'turn.user_prompt', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId: activeRun.runId,
      runtimeId: runtime.runtimeId,
      transport: ctx.transport,
      payload: createUserPromptPayload(this.prompt),
    })
    server.notifyEvent(userPromptEvent)

    const result = (await server.getHarnessBrokerController().dispatchInput({
      runtimeId: runtime.runtimeId,
      input: this.buildInput(activeRun.runId),
      policy: { whenBusy: 'steer' as const },
    })) as BrokerDispatchResult

    if (result.ok && result.response.accepted) {
      if (result.response.disposition === 'attempted_steer') {
        return this.concludeSteerSuccess(activeRun)
      }
      if (result.response.disposition === 'started') {
        // The active turn ended in the dispatch window and the broker started
        // a fresh turn with our input. Honest outcome, tracked run (r2).
        return this.retainStartedRun()
      }
      // Accepted but retained in some other shape (e.g. queued): actuation
      // state unknown — never report never-landed (r6/r7).
      this.sealFailure('ambiguous', HrcErrorCode.URGENT_DELIVERY_AMBIGUOUS)
      throw new HrcDomainError(
        HrcErrorCode.URGENT_DELIVERY_AMBIGUOUS,
        'the broker retained the input; whether it preempts the active turn is unknown',
        {
          runtimeId: runtime.runtimeId,
          invocationId: ctx.invocationId,
          runId: activeRun.runId,
          route: ctx.route,
          cause: result.response.disposition,
        }
      )
    }

    return this.failTyped(result, { phase: 'steer', activeRunId: activeRun.runId })
  }

  /** attempted_steer: the honest success for the route's proof level. */
  private concludeSteerSuccess(activeRun: HrcRunRecord): Response {
    const { server, session, runtime, ctx } = this
    const now = timestamp()

    // The provisional row's only remaining purpose was correlation; the input
    // joined another turn, so terminalize it. Audit artifact only — this runId
    // appears in no response, replay body, or message record (r3).
    server.db.runs.markCompleted(ctx.provisionalRunId, {
      status: 'cancelled',
      completedAt: now,
      updatedAt: now,
      errorMessage: 'superseded_by_steer',
    })

    const delivery =
      ctx.route === 'headless'
        ? hrcAdmittedIntoActiveTurn({ mergedIntoRunId: activeRun.runId })
        : hrcPresentedToLiveHarness({ presentedDuringRunId: activeRun.runId })
    server.db.steerContributions.seal(ctx.contributionId, {
      state: ctx.route === 'headless' ? 'admitted' : 'presented',
      now,
    })
    server.db.runtimes.update(runtime.runtimeId, {
      ...runtimeActivityPatch(server.db, runtime.runtimeId, {
        source: 'turn',
        occurredAt: now,
        updatedAt: now,
      }),
    })
    writeServerLog('INFO', `steer_class.${ctx.route}_steer_${delivery.code}`, {
      runtimeId: runtime.runtimeId,
      invocationId: ctx.invocationId,
      runId: activeRun.runId,
      contributionId: ctx.contributionId,
    })

    return json({
      runId: activeRun.runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: ctx.transport,
      status: 'started',
      supportsInFlightInput: ctx.route === 'interactive',
      delivery,
    })
  }

  /** disposition 'started': our input began its own turn — retain the run. */
  retainStartedRun(): Response {
    const { server, session, runtime, ctx } = this
    const now = timestamp()

    server.db.runtimes.update(runtime.runtimeId, {
      activeRunId: ctx.provisionalRunId,
      status: 'busy',
      statusChangedAt: now,
      ...runtimeActivityPatch(server.db, runtime.runtimeId, {
        source: 'turn',
        occurredAt: now,
        updatedAt: now,
      }),
    })
    server.db.brokerInvocations.update(ctx.invocationId, {
      runId: ctx.provisionalRunId,
      updatedAt: now,
    })
    server.db.steerContributions.seal(ctx.contributionId, {
      state: 'started_fresh',
      outcome: { runId: ctx.provisionalRunId },
      now,
    })
    // Emitted after the fact on this path (the probe could not know whether a
    // turn would start); the mapper's turn.started may already have projected.
    const userPromptEvent = appendHrcEvent(server.db, 'turn.user_prompt', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId: ctx.provisionalRunId,
      runtimeId: runtime.runtimeId,
      transport: ctx.transport,
      payload: createUserPromptPayload(this.prompt),
    })
    server.notifyEvent(userPromptEvent)
    writeServerLog('INFO', 'steer_class.started_fresh_turn', {
      runtimeId: runtime.runtimeId,
      invocationId: ctx.invocationId,
      runId: ctx.provisionalRunId,
      contributionId: ctx.contributionId,
      route: ctx.route,
    })

    return json({
      runId: ctx.provisionalRunId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: ctx.transport,
      status: 'started',
      supportsInFlightInput: ctx.route === 'interactive',
      delivery: HRC_STARTED_FRESH_TURN_OUTCOME,
    })
  }

  /**
   * Map a broker failure per r7 and throw typed; UNSUPPORTED is allowlisted.
   * T-07214 best-effort: provably non-actuated states fall to the floor
   * instead of throwing; AMBIGUOUS always throws.
   */
  failTyped(
    result: BrokerDispatchResult,
    context: { phase: 'probe' | 'steer'; activeRunId?: string | undefined }
  ): 'floor' | never {
    const { runtime, ctx } = this
    const cause = result.ok
      ? (result.response.reason ?? result.response.disposition ?? 'rejected')
      : result.error.message

    let code: HrcErrorCode
    let state: 'unsupported' | 'race_lost' | 'ambiguous'
    if (!result.ok && result.error.code === 'broker_input_timeout') {
      code = HrcErrorCode.URGENT_DELIVERY_AMBIGUOUS
      state = 'ambiguous'
    } else if (
      context.phase === 'steer' &&
      ctx.route === 'headless' &&
      !result.ok &&
      RACE_LOST_PATTERN.test(result.error.message)
    ) {
      // Turn-identity race signals exist only where the actuator carries turn
      // identity (codex app-server). Never fabricated for the tmux driver.
      code = HrcErrorCode.URGENT_DELIVERY_RACE_LOST
      state = 'race_lost'
    } else if (isProvablyNonActuatedRefusal(result)) {
      code = HrcErrorCode.URGENT_DELIVERY_UNSUPPORTED
      state = 'unsupported'
    } else {
      // r7 default: anything not proven non-actuated is AMBIGUOUS — the pane
      // may already hold the text (paste-then-Enter partial failure).
      code = HrcErrorCode.URGENT_DELIVERY_AMBIGUOUS
      state = 'ambiguous'
    }

    // Non-actuated states may floor in best-effort mode; race_lost is
    // non-actuated by construction (turn-identity refusal), unsupported is the
    // allowlist. Ambiguous never floors.
    if (this.ctx.bestEffort && (state === 'unsupported' || state === 'race_lost')) {
      return this.floorFallback(state)
    }
    this.sealFailure(state, code)
    const message =
      state === 'ambiguous'
        ? 'the delivery attempt failed after actuation may have begun; whether the order was presented is unknown'
        : state === 'race_lost'
          ? 'the active turn ended before the urgent order could be applied'
          : 'the broker refused urgent delivery before any actuation'
    throw new HrcDomainError(code, message, {
      runtimeId: runtime.runtimeId,
      invocationId: ctx.invocationId,
      route: ctx.route,
      phase: context.phase,
      ...(context.activeRunId !== undefined ? { runId: context.activeRunId } : {}),
      cause,
    })
  }

  /**
   * T-07214: best-effort fallback — the ledger row (already inserted before
   * the first actuating call) is sealed as the audit-only 'queued_fallback'
   * state recording the non-actuated attempt, the provisional row is
   * terminalized, and the caller delivers the route's ordinary floor.
   */
  floorFallback(attempt: 'unsupported' | 'race_lost'): 'floor' {
    const now = timestamp()
    this.server.db.steerContributions.seal(this.ctx.contributionId, {
      state: 'queued_fallback',
      outcome: { attempt },
      now,
    })
    this.server.db.runs.markCompleted(this.ctx.provisionalRunId, {
      status: 'cancelled',
      completedAt: now,
      updatedAt: now,
      errorMessage: 'superseded_by_floor_fallback',
    })
    writeServerLog('INFO', 'steer_class.best_effort_floor', {
      runtimeId: this.runtime.runtimeId,
      invocationId: this.ctx.invocationId,
      contributionId: this.ctx.contributionId,
      route: this.ctx.route,
      attempt,
    })
    return 'floor'
  }

  sealFailure(state: 'unsupported' | 'race_lost' | 'ambiguous', code: HrcErrorCode): void {
    const now = timestamp()
    this.server.db.steerContributions.seal(this.ctx.contributionId, {
      state,
      outcomeCode: code,
      now,
    })
    this.server.db.runs.markCompleted(this.ctx.provisionalRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: code,
    })
    writeServerLog('WARN', 'steer_class.failed', {
      runtimeId: this.runtime.runtimeId,
      invocationId: this.ctx.invocationId,
      contributionId: this.ctx.contributionId,
      route: this.ctx.route,
      state,
      errorCode: code,
    })
  }
}

/** Ledger-driven replay: every sealed state reconstructs its honest outcome. */
function replaySteerClassContribution(
  session: HrcSessionRecord,
  record: HrcSteerContributionRecord,
  route: SteerRoute,
  transport: 'headless' | 'tmux'
): Response {
  if (record.state === 'admitted' || record.state === 'presented') {
    const delivery: HrcDeliveryOutcome =
      record.state === 'admitted'
        ? hrcAdmittedIntoActiveTurn({ mergedIntoRunId: record.activeRunId })
        : hrcPresentedToLiveHarness({ presentedDuringRunId: record.activeRunId })
    return json({
      runId: record.activeRunId,
      hostSessionId: record.hostSessionId,
      generation: session.generation,
      runtimeId: record.runtimeId,
      transport,
      status: 'started',
      supportsInFlightInput: route === 'interactive',
      delivery,
    })
  }
  if (record.state === 'started_fresh') {
    return json({
      runId: record.activeRunId,
      hostSessionId: record.hostSessionId,
      generation: session.generation,
      runtimeId: record.runtimeId,
      transport,
      status: 'started',
      supportsInFlightInput: route === 'interactive',
      delivery: HRC_STARTED_FRESH_TURN_OUTCOME,
    })
  }
  const code =
    record.state === 'race_lost'
      ? HrcErrorCode.URGENT_DELIVERY_RACE_LOST
      : record.state === 'ambiguous'
        ? HrcErrorCode.URGENT_DELIVERY_AMBIGUOUS
        : HrcErrorCode.URGENT_DELIVERY_UNSUPPORTED
  throw new HrcDomainError(code, `urgent delivery previously resolved as ${record.state}`, {
    runtimeId: record.runtimeId,
    invocationId: record.invocationId,
    runId: record.activeRunId,
    route,
    replayed: true,
  })
}

export const steerClassDispatchMethods = {
  executeSteerClassDispatch,
}

export type SteerClassDispatchMethods = typeof steerClassDispatchMethods
