/**
 * RED tests (T-01696 / T-01690 Wave W3A) for the idempotent BROKER EVENT MAPPER.
 *
 * These tests are EXPECTED TO FAIL until curly implements
 *   packages/hrc-server/src/broker/event-mapper.ts
 * (red signal = module-not-found on the import below).
 *
 * The mapper is the SOLE interpreter of broker `InvocationEventEnvelope`
 * payloads. It resolves projection context from the persisted broker invocation
 * and, in ONE SQLite transaction:
 *   1. appends the broker event by (invocationId, seq) via the W1B idempotent
 *      append repo (`BrokerInvocationEventRepository.appendEvent`);
 *   2. projects the event into HRC state (runtime / run / buffer / continuation
 *      / surface / permission audit / diagnostics);
 *   3. emits canonical lifecycle rows through `HrcEventRepository`;
 *   4. marks the broker event row projection_status = 'applied'.
 *
 * Contract invariants under test:
 *   - atomic: a projection error rolls the appended broker event row back too;
 *   - idempotent: same (invocationId, seq) + SAME payload twice => one projection;
 *   - conflict: same (invocationId, seq) + DIFFERENT payload => throws
 *     BrokerInvocationEventConflictError, NO projection;
 *   - the retired raw `events` mirror remains empty;
 *   - full ordered sequence projects runtime/run/message/tool/continuation;
 *   - replay of the whole sequence is a no-op.
 *
 * Public API under test (documented for curly in the final reply):
 *   class BrokerEventMapper {
 *     constructor(deps: { db: HrcDatabase; now?: () => string })
 *     apply(envelope: InvocationEventEnvelope): {
 *       idempotent: boolean
 *       events: HrcEventEnvelope[]   // retired compatibility surface; always empty
 *     }
 *   }
 */
import { describe, expect, it } from 'bun:test'
import type { TurnId } from 'spaces-harness-broker-protocol'

import { INVOCATION_ID, RUNTIME_ID, RUN_ID, envelope, ts } from './broker-event-mapper-fixtures'

import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

const harness = createBrokerEventMapperTestFixture()

describe('transaction atomicity', () => {
  it('rolls back the appended broker event row when projection fails', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db

    // Fault canonical lifecycle emission so projection throws mid-transaction.
    const original = db.hrcEvents.append.bind(db.hrcEvents)
    let armed = true
    ;(db.hrcEvents as { append: typeof db.hrcEvents.append }).append = ((input) => {
      if (armed) {
        throw new Error('injected projection failure')
      }
      return original(input)
    }) as typeof db.hrcEvents.append

    const completed = envelope(
      'turn.completed',
      7,
      { turnId: 'turn_atomic' as never, status: 'completed', producedContent: true },
      { turnId: 'turn_atomic' as never }
    )

    try {
      expect(() => mapper.apply(completed)).toThrow()
    } finally {
      armed = false
      ;(db.hrcEvents as { append: typeof db.hrcEvents.append }).append = original
    }

    // Neither the broker event row nor the run-state projection persisted.
    expect(db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 7)).toBeNull()
    expect(db.brokerInvocationEvents.getProjectionDisposition(INVOCATION_ID, 7)).toBeNull()
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(0)
    const run = db.runs.getByRunId(RUN_ID)!
    expect(run.status).toBe('accepted')
    expect(run.completedAt).toBeUndefined()
  })

  it('marks the broker event row projection_status applied on success', () => {
    const mapper = harness.makeMapper()
    mapper.apply(envelope('invocation.ready', 2, { state: 'ready' }))

    const stored = harness.fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 2)
    expect(stored).not.toBeNull()
    expect(stored!.projectionStatus).toBe('applied')
    expect(stored!.hrcEventSeq).toBeUndefined()
  })

  it('restores the in-memory buffer sequence after a projection rollback', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db
    const tid = 'turn_buffer_rollback' as TurnId
    const completedMessage = envelope(
      'assistant.message.completed',
      5,
      {
        messageId: 'msg_buffer_rollback',
        content: [{ type: 'text', text: 'retry-safe' }],
        final: true,
      },
      { turnId: tid }
    )

    mapper.apply(envelope('input.accepted', 3, { inputId: 'input_buffer_rollback' }))
    mapper.apply(envelope('turn.started', 4, { turnId: tid }, { turnId: tid }))

    const appendLifecycle = db.hrcEvents.append.bind(db.hrcEvents)
    db.hrcEvents.append = () => {
      throw new Error('injected post-buffer projection failure')
    }
    try {
      expect(() => mapper.apply(completedMessage)).toThrow(
        'injected post-buffer projection failure'
      )
    } finally {
      db.hrcEvents.append = appendLifecycle
    }

    expect(db.runtimeBuffers.listByRunId(RUN_ID)).toEqual([])
    expect(() => mapper.apply(completedMessage)).not.toThrow()
    expect(db.runtimeBuffers.listByRunId(RUN_ID).map((chunk) => chunk.chunkSeq)).toEqual([0])
  })

  it('clears runtime activeRunId when an interactive broker turn completes', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db
    db.runtimes.update(RUNTIME_ID, {
      activeRunId: RUN_ID,
      status: 'busy',
      runtimeStateJson: { status: 'busy', activeRunId: RUN_ID },
      updatedAt: ts(99),
    })

    mapper.apply(
      envelope(
        'turn.completed',
        7,
        { turnId: 'turn_x' as never, status: 'completed', producedContent: true },
        { turnId: 'turn_x' as never }
      )
    )

    const runtime = db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(runtime.activeRunId).toBeUndefined()
    expect(runtime.status).toBe('ready')
    expect(runtime.runtimeStateJson).toEqual({ status: 'ready', updatedAt: ts(100) })
  })

  it('does not attach post-terminal broker events to the completed input run', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db
    const dispatchedInputId = 'input_terminal_boundary'

    db.runs.update(RUN_ID, {
      dispatchedInputId,
      updatedAt: ts(99),
    })

    mapper.apply(
      envelope(
        'input.accepted',
        7,
        { inputId: dispatchedInputId },
        { inputId: dispatchedInputId as never }
      )
    )
    mapper.apply(
      envelope(
        'turn.completed',
        8,
        { turnId: 'turn_terminal_boundary' as never, status: 'completed', producedContent: true },
        { turnId: 'turn_terminal_boundary' as never }
      )
    )

    const postTerminal = mapper.apply(
      envelope('tool.call.started', 9, {
        toolCallId: 'tool_after_terminal' as never,
        name: 'Bash',
        input: { command: 'date' },
      })
    )

    expect(postTerminal.lifecycleEvents[0]!.runId).toBeUndefined()
    expect(db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 9)!.runId).toBeUndefined()
    expect(db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.tool_call' })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Projection mapping — ordered synthetic sequence
// ---------------------------------------------------------------------------
