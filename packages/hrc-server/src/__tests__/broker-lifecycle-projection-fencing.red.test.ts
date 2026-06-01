/**
 * RED tests (T-01788 / T-01783 Workstream C) for HRC broker LIFECYCLE EVENT
 * PROJECTION + GENERATION/ATTEMPT FENCING + PERMISSION CANCELLATION.
 *
 * These are EXPECTED TO FAIL against the current
 *   packages/hrc-server/src/broker/event-mapper.ts
 * which has NO projection cases for the lifecycle vocabulary
 * (lifecycle.policy.accepted / lifecycle.escalation / harness.* / turn.stalled /
 * turn.retry / permission.cancelled) and applies turn-terminal / continuation /
 * assistant / tool projections UNCONDITIONALLY (no generation/attempt fence).
 *
 * The persistence foundation they project into already exists on `main`:
 *   - WS-B (ca8725b): runtimes/broker_invocations carry
 *       current_harness_generation, current_turn_attempt,
 *       lifecycle_terminal_reason, last_lifecycle_escalation_json,
 *       lifecycle_policy_hash; permission_decisions is keyed by
 *       permission_identity_key = JSON([invocationId, harnessGeneration,
 *       turnAttempt, permissionRequestId]).
 *   - WS-A (ecc972d): the lifecycle overlay is materialized + dispatched and the
 *       dispatched hash is persisted on broker_invocations.lifecycle_policy_hash.
 *
 * The mapper-under-test is imported by THIS file so the RED signal is a real
 * assertion failure (the projection/fencing branches don't exist yet), not a
 * module-not-found (the mapper module already exists from W3A).
 *
 * ── Normative contract pinned here (for the WS-C implementer) ───────────────
 *  1. NEW VOCABULARY PROJECTION
 *     - lifecycle.policy.accepted: persist the accepted policy hash onto the
 *       runtime (runtime.lifecyclePolicyHash := payload.policyHash), confirming
 *       it matches the hash WS-A dispatched (invocation.lifecyclePolicyHash).
 *     - lifecycle.escalation: persist invocation.lastLifecycleEscalationJson with
 *       at least { reason, requestedAction }.
 *     - harness.started: advance current_harness_generation to payload.generation
 *       (broker-reported; HRC never allocates/infers).
 *     - harness.exited: set lifecycle_terminal_reason := payload.reason (terminal).
 *     - harness.recovery.completed: advance current_harness_generation to
 *       payload.toGeneration.
 *     - harness.recovery.failed: persist last_lifecycle_escalation_json (reason).
 *     - turn.retry: advance current_turn_attempt to payload.toAttempt AND
 *       current_harness_generation to payload.toHarnessGeneration.
 *     - turn.stalled: retained as evidence only; advances NOTHING.
 *     - permission.cancelled: write a cancellation audit row whose `decision`
 *       stays within {allow,deny} (fail-closed to the request defaultDecision)
 *       and whose payload records the cancellation reason. NO third decision.
 *  2. GENERATION/ATTEMPT FENCING (normative)
 *     Before ANY active-state mutation, compare envelope.harnessGeneration /
 *     envelope.turnAttempt against the persisted current values. A STALE event
 *     (older generation/attempt) is still appended to broker_invocation_events
 *     as immutable evidence but MUST NOT advance active runtime/run/message/
 *     permission/continuation/surface state, and MUST NOT emit a live lifecycle
 *     event (which would mis-finalize / mis-feed the live generation).
 *     Fencing engages ONLY when a current value is persisted (back-compat: legacy
 *     events with no current generation continue to project unconditionally).
 *  3. GENERATION-AWARE PERMISSION IDENTITY
 *     permission.resolved uses the generation/attempt-scoped identity key. A
 *     resolution for an OLDER generation/attempt is stale-audited under its OWN
 *     (stale) identity key and is NOT delivered to the live identity. A current
 *     resolution is recorded under the live (gen, attempt) identity key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

// The mapper module exists (W3A); these projection/fencing branches do not yet.
import { BrokerEventMapper } from '../broker/event-mapper'

import type {
  InputId,
  InvocationEventEnvelope,
  InvocationEventType,
  TurnId,
} from 'spaces-harness-broker-protocol'

import {
  CONTINUATION_KEY,
  HOST_SESSION_ID,
  INVOCATION_ID,
  RUNTIME_ID,
  RUN_ID,
  type SeededFixture,
  ASSISTANT_TEXT,
  bufferTextForRun,
  makeSeededFixture,
  permissionRequestId,
  ts,
} from './broker-event-mapper-fixtures'

let fixture: SeededFixture

beforeEach(async () => {
  fixture = await makeSeededFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

function makeMapper() {
  return new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
}

/**
 * Lifecycle-aware envelope builder: the shared fixtures `envelope()` helper does
 * not thread harnessGeneration/turnAttempt, which the fence reads.
 */
type LcOpts = {
  harnessGeneration?: number
  turnAttempt?: number
  turnId?: string
  inputId?: string
}
function lc(
  type: InvocationEventType,
  seq: number,
  payload: unknown,
  opts: LcOpts = {}
): InvocationEventEnvelope {
  return {
    invocationId: INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
    ...(opts.turnId !== undefined ? { turnId: opts.turnId as TurnId } : {}),
    ...(opts.inputId !== undefined ? { inputId: opts.inputId as InputId } : {}),
    ...(opts.harnessGeneration !== undefined ? { harnessGeneration: opts.harnessGeneration } : {}),
    ...(opts.turnAttempt !== undefined ? { turnAttempt: opts.turnAttempt } : {}),
  }
}

/** Mirror WS-B's permission_identity_key serialization (repositories.ts). */
function permIdentityKey(
  harnessGeneration: number | null,
  turnAttempt: number | null,
  prid: string
): string {
  return JSON.stringify([INVOCATION_ID, harnessGeneration, turnAttempt, prid])
}

/** Seed the persisted "current" lifecycle counters on BOTH runtime + invocation. */
function seedCurrent(opts: { generation?: number; attempt?: number }): void {
  const patch = {
    ...(opts.generation !== undefined ? { currentHarnessGeneration: opts.generation } : {}),
    ...(opts.attempt !== undefined ? { currentTurnAttempt: opts.attempt } : {}),
    updatedAt: ts(99),
  }
  fixture.db.runtimes.update(RUNTIME_ID, patch)
  fixture.db.brokerInvocations.update(INVOCATION_ID, patch)
}

// ---------------------------------------------------------------------------
// 1. New lifecycle vocabulary projection
// ---------------------------------------------------------------------------
describe('lifecycle vocabulary projection', () => {
  it('lifecycle.policy.accepted persists the dispatched policy hash onto the runtime', () => {
    const db = fixture.db
    const POLICY_HASH = 'sha256:lifecycle-policy-w3c'
    // WS-A dispatched + persisted the overlay hash on the invocation.
    db.brokerInvocations.update(INVOCATION_ID, {
      lifecyclePolicyHash: POLICY_HASH,
      updatedAt: ts(99),
    })

    const mapper = makeMapper()
    mapper.apply(
      lc('lifecycle.policy.accepted', 3, {
        policyId: 'policy_w3c',
        policyHash: POLICY_HASH,
        retentionMode: 'keep-alive',
        harnessRecoveryMode: 'none',
        turnRetryMode: 'none',
      })
    )

    // The accepted hash is confirmed against WS-A's dispatch and persisted on the
    // runtime (the runtime fixture starts with no lifecyclePolicyHash).
    const runtime = db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(runtime.lifecyclePolicyHash).toBe(POLICY_HASH)

    // The accepted modes are retained as immutable evidence.
    const evidence = db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 3)!
    expect(JSON.parse(evidence.brokerEventJson)).toMatchObject({
      retentionMode: 'keep-alive',
      harnessRecoveryMode: 'none',
      turnRetryMode: 'none',
    })
  })

  it('lifecycle.escalation persists last_lifecycle_escalation_json with reason + requestedAction', () => {
    const db = fixture.db
    const mapper = makeMapper()

    mapper.apply(
      lc('lifecycle.escalation', 4, {
        reason: 'retry-exhausted',
        requestedAction: 'operator-attention',
        harnessGeneration: 2,
      })
    )

    const invocation = db.brokerInvocations.getByInvocationId(INVOCATION_ID)!
    expect(invocation.lastLifecycleEscalationJson).toBeDefined()
    expect(JSON.parse(invocation.lastLifecycleEscalationJson!)).toMatchObject({
      reason: 'retry-exhausted',
      requestedAction: 'operator-attention',
    })
  })

  it('harness.started advances current_harness_generation to the broker-reported generation', () => {
    const db = fixture.db
    seedCurrent({ generation: 1 })
    const mapper = makeMapper()

    mapper.apply(
      lc('harness.started', 5, {
        generation: 2,
        mode: 'recycle',
        mechanism: 'direct-child',
      })
    )

    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.currentHarnessGeneration).toBe(2)
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)!.currentHarnessGeneration).toBe(2)
  })

  it('harness.exited records lifecycle_terminal_reason on the invocation', () => {
    const db = fixture.db
    seedCurrent({ generation: 2 })
    const mapper = makeMapper()

    mapper.apply(
      lc('harness.exited', 6, { generation: 2, reason: 'crash', exitCode: null, signal: 'SIGKILL' })
    )

    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.lifecycleTerminalReason).toBe(
      'crash'
    )
  })

  it('harness.recovery.completed advances current_harness_generation to toGeneration (started is evidence-only)', () => {
    const db = fixture.db
    seedCurrent({ generation: 1 })
    const mapper = makeMapper()

    // recovery.started is retained but does NOT advance the generation.
    mapper.apply(
      lc('harness.recovery.started', 7, {
        fromGeneration: 1,
        reason: 'child-exit',
        activeTurnDisposition: 'fail-before-recycle',
      })
    )
    expect(db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 7)).not.toBeNull()
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.currentHarnessGeneration).toBe(1)

    // recovery.completed advances to the broker-reported toGeneration.
    mapper.apply(
      lc('harness.recovery.completed', 8, { fromGeneration: 1, toGeneration: 2, ready: true })
    )
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.currentHarnessGeneration).toBe(2)
  })

  it('harness.recovery.failed persists last_lifecycle_escalation_json with the failure reason', () => {
    const db = fixture.db
    seedCurrent({ generation: 1 })
    const mapper = makeMapper()

    mapper.apply(
      lc('harness.recovery.failed', 9, {
        fromGeneration: 1,
        reason: 'runner-unresponsive',
        requestedAction: 'hard-reap',
      })
    )

    const invocation = db.brokerInvocations.getByInvocationId(INVOCATION_ID)!
    expect(invocation.lastLifecycleEscalationJson).toBeDefined()
    expect(invocation.lastLifecycleEscalationJson).toContain('runner-unresponsive')
  })

  it('turn.retry advances current_turn_attempt + current_harness_generation (stall is evidence-only)', () => {
    const db = fixture.db
    seedCurrent({ generation: 2, attempt: 1 })
    const mapper = makeMapper()

    // turn.stalled is recorded as evidence and advances NOTHING.
    mapper.apply(
      lc(
        'turn.stalled',
        10,
        {
          inputId: 'input_retry_1',
          turnId: 'turn_retry_1',
          noProgressMs: 90_000,
          thresholdMs: 60_000,
          healthProbe: 'runner-status',
          harnessGeneration: 2,
          turnAttempt: 1,
        },
        { inputId: 'input_retry_1', turnId: 'turn_retry_1' }
      )
    )
    expect(db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 10)).not.toBeNull()
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.currentTurnAttempt).toBe(1)

    // turn.retry advances to the broker-reported toAttempt + toHarnessGeneration.
    mapper.apply(
      lc(
        'turn.retry',
        11,
        {
          inputId: 'input_retry_1',
          turnId: 'turn_retry_1',
          fromAttempt: 1,
          toAttempt: 2,
          fromHarnessGeneration: 2,
          toHarnessGeneration: 3,
          reason: 'harness-crashed',
          semantics: 'at-least-once',
        },
        { inputId: 'input_retry_1', turnId: 'turn_retry_1' }
      )
    )
    const invocation = db.brokerInvocations.getByInvocationId(INVOCATION_ID)!
    expect(invocation.currentTurnAttempt).toBe(2)
    expect(invocation.currentHarnessGeneration).toBe(3)
  })

  it('permission.cancelled writes a cancellation audit row with reason; decision stays within {allow,deny}', () => {
    const db = fixture.db
    const prid = permissionRequestId('perm_cancel_w3c')
    const mapper = makeMapper()

    mapper.apply(
      lc('permission.requested', 20, {
        permissionRequestId: prid,
        kind: 'command',
        subjectDisplay: { command: 'rm -rf /tmp/x' },
        defaultDecision: 'deny',
      })
    )

    mapper.apply(
      lc('permission.cancelled', 21, {
        permissionRequestId: prid,
        reason: 'turn-failed',
      })
    )

    const decision = db.permissionDecisions.getByPermissionRequestId('perm_cancel_w3c')
    expect(decision).not.toBeNull()
    // The decision enum is binary — a cancellation fail-closes to the request
    // defaultDecision; it never introduces a third value.
    expect(['allow', 'deny']).toContain(decision!.decision)
    expect(decision!.decision).toBe('deny')
    // The cancellation reason is recorded in the audit row.
    expect(JSON.stringify(decision)).toContain('turn-failed')
  })
})

// ---------------------------------------------------------------------------
// 2. Generation / attempt fencing (normative)
// ---------------------------------------------------------------------------
describe('generation/attempt fencing', () => {
  it('retains a STALE turn-terminal as evidence but does NOT complete the run or emit a live lifecycle event', () => {
    const db = fixture.db
    seedCurrent({ generation: 3, attempt: 2 })
    const mapper = makeMapper()

    const result = mapper.apply(
      lc(
        'turn.completed',
        30,
        { turnId: 'turn_stale', status: 'completed', producedContent: true },
        { turnId: 'turn_stale', harnessGeneration: 3, turnAttempt: 1 }
      )
    )

    // Evidence is retained...
    expect(db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 30)).not.toBeNull()
    // ...but the live run is NOT finalized by a stale-attempt terminal, and no
    // canonical turn.completed is delivered to the live stream (which would
    // mis-finalize the live turn for waiters).
    expect(db.runs.getByRunId(RUN_ID)!.status).toBe('accepted')
    expect(db.runs.getByRunId(RUN_ID)!.completedAt).toBeUndefined()
    expect(result.lifecycleEvents.map((e) => e.eventKind)).not.toContain('turn.completed')
  })

  it('retains a STALE continuation.updated as evidence but does NOT overwrite the live continuation', () => {
    const db = fixture.db
    seedCurrent({ generation: 3 })
    // Live continuation captured by the current generation.
    db.runtimes.update(RUNTIME_ID, {
      continuation: { provider: 'openai', key: 'live_continuation' },
      updatedAt: ts(99),
    })
    const mapper = makeMapper()

    mapper.apply(
      lc(
        'continuation.updated',
        31,
        { provider: 'openai', key: 'stale_continuation' },
        { harnessGeneration: 2 }
      )
    )

    expect(db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 31)).not.toBeNull()
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual({
      provider: 'openai',
      key: 'live_continuation',
    })
  })

  it('retains a STALE assistant.message.completed as evidence but does NOT append to the live runtime buffer', () => {
    const db = fixture.db
    seedCurrent({ generation: 3, attempt: 2 })
    const mapper = makeMapper()

    mapper.apply(
      lc(
        'assistant.message.completed',
        32,
        {
          messageId: 'msg_stale',
          content: [{ type: 'text', text: 'STALE GENERATION OUTPUT' }],
          final: true,
        },
        { turnId: 'turn_stale', harnessGeneration: 2, turnAttempt: 1 }
      )
    )

    expect(db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 32)).not.toBeNull()
    expect(bufferTextForRun(db, RUN_ID)).not.toContain('STALE GENERATION OUTPUT')
  })

  it('retains a STALE tool.call.completed as evidence but does NOT emit a live turn.tool_result lifecycle event', () => {
    const db = fixture.db
    seedCurrent({ generation: 3, attempt: 2 })
    const mapper = makeMapper()

    const result = mapper.apply(
      lc(
        'tool.call.completed',
        33,
        {
          toolCallId: 'tool_stale',
          name: 'Bash',
          result: { output: 'stale tool output', exitCode: 0 },
          isError: false,
        },
        { turnId: 'turn_stale', harnessGeneration: 2, turnAttempt: 1 }
      )
    )

    expect(db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 33)).not.toBeNull()
    expect(result.lifecycleEvents.map((e) => e.eventKind)).not.toContain('turn.tool_result')
    expect(db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.tool_result' })).toHaveLength(0)
  })

  it('fences a STALE harness.exited (no terminal-reason write) while a CURRENT-generation harness.exited records it', () => {
    const db = fixture.db
    seedCurrent({ generation: 3 })
    const mapper = makeMapper()

    // Stale exit of an already-superseded generation: evidence only.
    mapper.apply(
      lc('harness.exited', 34, { generation: 2, reason: 'recycle-kill' }, { harnessGeneration: 2 })
    )
    expect(db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 34)).not.toBeNull()
    expect(
      db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.lifecycleTerminalReason
    ).toBeUndefined()

    // Current-generation exit IS recorded.
    mapper.apply(
      lc('harness.exited', 35, { generation: 3, reason: 'crash' }, { harnessGeneration: 3 })
    )
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.lifecycleTerminalReason).toBe(
      'crash'
    )
  })
})

// ---------------------------------------------------------------------------
// 3. Generation-aware permission identity
// ---------------------------------------------------------------------------
describe('generation-aware permission identity', () => {
  it('records a CURRENT-generation permission.resolved under the live (gen, attempt) identity key', () => {
    const db = fixture.db
    seedCurrent({ generation: 2, attempt: 2 })
    const prid = permissionRequestId('perm_live_w3c')
    const mapper = makeMapper()

    mapper.apply(
      lc(
        'permission.requested',
        40,
        {
          permissionRequestId: prid,
          kind: 'command',
          subjectDisplay: { command: 'ls' },
          defaultDecision: 'deny',
        },
        { harnessGeneration: 2, turnAttempt: 2 }
      )
    )
    mapper.apply(
      lc(
        'permission.resolved',
        41,
        { permissionRequestId: prid, decision: 'allow', decidedBy: 'user' },
        { harnessGeneration: 2, turnAttempt: 2 }
      )
    )

    const live = db.permissionDecisions.getByPermissionIdentityKey(
      permIdentityKey(2, 2, 'perm_live_w3c')
    )
    expect(live).not.toBeNull()
    expect(live!.decision).toBe('allow')
    expect(live!.harnessGeneration).toBe(2)
    expect(live!.turnAttempt).toBe(2)
  })

  it('stale-audits an OLD-generation permission.resolved under its own identity key and does NOT deliver it to the live identity', () => {
    const db = fixture.db
    seedCurrent({ generation: 2, attempt: 2 })
    const prid = permissionRequestId('perm_stale_w3c')
    const mapper = makeMapper()

    mapper.apply(
      lc(
        'permission.requested',
        42,
        {
          permissionRequestId: prid,
          kind: 'command',
          subjectDisplay: { command: 'rm -rf /' },
          defaultDecision: 'deny',
        },
        { harnessGeneration: 1, turnAttempt: 1 }
      )
    )
    // A resolution arriving for the OLD generation/attempt (the harness that
    // requested it has since been recycled): must be stale-audited, never
    // delivered to the live generation as an authoritative decision.
    mapper.apply(
      lc(
        'permission.resolved',
        43,
        { permissionRequestId: prid, decision: 'allow', decidedBy: 'user' },
        { harnessGeneration: 1, turnAttempt: 1 }
      )
    )

    // Stale audit row exists under the OLD identity key...
    const stale = db.permissionDecisions.getByPermissionIdentityKey(
      permIdentityKey(1, 1, 'perm_stale_w3c')
    )
    expect(stale).not.toBeNull()
    expect(stale!.harnessGeneration).toBe(1)
    expect(stale!.turnAttempt).toBe(1)
    // ...and it carries a stale marker (not a clean live decision).
    expect(JSON.stringify(stale)).toContain('stale')

    // ...but the stale 'allow' is NOT delivered to the live (gen 2, attempt 2)
    // identity — the live generation has no authoritative allow from a dead gen.
    expect(
      db.permissionDecisions.getByPermissionIdentityKey(permIdentityKey(2, 2, 'perm_stale_w3c'))
    ).toBeNull()
  })
})
