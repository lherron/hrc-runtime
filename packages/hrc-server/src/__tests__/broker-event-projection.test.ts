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

import {
  ASSISTANT_TEXT,
  CONTINUATION_KEY,
  HOST_SESSION_ID,
  INVOCATION_ID,
  RUNTIME_ID,
  RUN_ID,
  TOOL_CALL_ID,
  TOOL_NAME,
  bufferTextForRun,
  envelope,
  headlessSequence,
  messageId,
  ts,
} from './broker-event-mapper-fixtures'

import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

const harness = createBrokerEventMapperTestFixture()

describe('projection mapping (ordered sequence)', () => {
  it('maps normalized pi-sdk driver events unchanged without requiring a terminal surface', () => {
    const db = harness.fixture.db
    db.brokerInvocations.update(INVOCATION_ID, {
      brokerDriver: 'pi-sdk',
      updatedAt: ts(1),
    })
    const mapper = harness.makeMapper()
    const sequence = headlessSequence()

    const lifecycleKinds = sequence.flatMap((event) => mapper.apply(event).lifecycleEvents)
    const durableTypes = db.brokerInvocationEvents
      .listByInvocationId(INVOCATION_ID)
      .map((event) => event.type)

    expect(durableTypes).toEqual(sequence.map((event) => event.type))
    expect(lifecycleKinds.map((event) => event.eventKind)).toContain('turn.completed')
    expect(bufferTextForRun(db, RUN_ID)).toContain(ASSISTANT_TEXT)
    expect(db.surfaceBindings.findByRuntime(RUNTIME_ID)).toEqual([])
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.brokerDriver).toBe('pi-sdk')
  })

  it('projects runtime / run / message / tool / continuation state', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db
    const seq = headlessSequence()
    const emittedByType = new Map<string, ReturnType<typeof mapper.apply>>()
    for (const env of seq) {
      emittedByType.set(env.type, mapper.apply(env))
    }

    // invocation.started -> runtime linkage; invocation.ready/exited -> state.
    const invocation = db.brokerInvocations.getByInvocationId(INVOCATION_ID)!
    expect(invocation.invocationState).toBe('exited')
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)!.activeInvocationId).toBe(INVOCATION_ID)

    // turn lifecycle -> run.
    const run = db.runs.getByRunId(RUN_ID)!
    expect(run.startedAt).toBeDefined()
    expect(run.status).toBe('completed')
    expect(run.completedAt).toBeDefined()

    // assistant.message.* -> runtime buffer / message events.
    expect(bufferTextForRun(db, RUN_ID)).toContain(ASSISTANT_TEXT)

    // tool.call.* -> canonical lifecycle events.
    const toolEvents = seq
      .flatMap((env) => emittedByType.get(env.type)!.lifecycleEvents)
      .filter((event) => JSON.stringify(event.payload).includes(TOOL_CALL_ID))
    expect(toolEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(toolEvents[0]!.payload)).toContain(TOOL_NAME)

    // continuation.updated -> BOTH runtime AND session continuation.
    const expectedContinuation = { provider: 'openai', key: CONTINUATION_KEY }
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual(expectedContinuation)
    expect(db.sessions.getByHostSessionId(HOST_SESSION_ID)!.continuation).toEqual(
      expectedContinuation
    )

    // every broker event row was projected.
    const rows = db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
    expect(rows.length).toBe(seq.length)
    for (const row of rows) {
      expect(row.projectionStatus).toBe('applied')
    }

    expect(seq.flatMap((env) => emittedByType.get(env.type)!.events)).toEqual([])
  })

  it('does not double-buffer completed assistant text already emitted as deltas', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db
    const tid = 'turn_delta_completed' as TurnId
    const messageId = 'msg_delta_completed'

    mapper.apply(envelope('input.accepted', 3, { inputId: 'input_delta_completed' }))
    mapper.apply(envelope('turn.started', 4, { turnId: tid }, { turnId: tid }))
    mapper.apply(
      envelope(
        'assistant.message.delta',
        5,
        {
          messageId,
          text: ASSISTANT_TEXT,
        },
        { turnId: tid }
      )
    )
    mapper.apply(
      envelope(
        'assistant.message.completed',
        6,
        {
          messageId,
          content: [{ type: 'text', text: ASSISTANT_TEXT }],
          final: true,
        },
        { turnId: tid }
      )
    )

    expect(bufferTextForRun(db, RUN_ID)).toBe(ASSISTANT_TEXT)
    expect(db.runtimeBuffers.listByRunId(RUN_ID)).toHaveLength(1)
  })

  it('separates consecutive assistant messages in the buffered turn body', () => {
    // T-07824 buffered branch: narrate -> tool -> answer streams two assistant
    // messages; without a boundary chunk the raw buffer join('') glues them
    // ("...path./Users/..."). message.started after buffered output appends '\n\n'.
    const mapper = harness.makeMapper()
    const db = harness.fixture.db
    const tid = 'turn_message_boundary' as TurnId

    mapper.apply(envelope('input.accepted', 3, { inputId: 'input_message_boundary' }))
    mapper.apply(envelope('turn.started', 4, { turnId: tid }, { turnId: tid }))
    mapper.apply(envelope('assistant.message.started', 5, { messageId: messageId('msg_narrate') }))
    mapper.apply(
      envelope(
        'assistant.message.delta',
        6,
        { messageId: messageId('msg_narrate'), text: "I'll check with pwd." },
        { turnId: tid }
      )
    )
    mapper.apply(
      envelope(
        'assistant.message.completed',
        7,
        {
          messageId: messageId('msg_narrate'),
          content: [{ type: 'text', text: "I'll check with pwd." }],
          final: false,
        },
        { turnId: tid }
      )
    )
    mapper.apply(envelope('assistant.message.started', 8, { messageId: messageId('msg_answer') }))
    mapper.apply(
      envelope(
        'assistant.message.delta',
        9,
        { messageId: messageId('msg_answer'), text: '/tmp/answer-path' },
        { turnId: tid }
      )
    )

    expect(bufferTextForRun(db, RUN_ID)).toBe("I'll check with pwd.\n\n/tmp/answer-path")
  })

  it('does not prepend a boundary before the first assistant message', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db
    const tid = 'turn_first_message' as TurnId

    mapper.apply(envelope('input.accepted', 3, { inputId: 'input_first_message' }))
    mapper.apply(envelope('turn.started', 4, { turnId: tid }, { turnId: tid }))
    mapper.apply(envelope('assistant.message.started', 5, { messageId: messageId('msg_only') }))
    mapper.apply(
      envelope(
        'assistant.message.delta',
        6,
        { messageId: messageId('msg_only'), text: 'single message' },
        { turnId: tid }
      )
    )

    expect(bufferTextForRun(db, RUN_ID)).toBe('single message')
  })

  it('does not re-read the full run buffer while appending a long streamed message', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db
    const tid = 'turn_bounded_buffer_append' as TurnId
    const messageId = 'msg_bounded_buffer_append'
    const chunks = Array.from({ length: 128 }, (_, index) => `chunk-${index}\n`)
    const listByRunId = db.runtimeBuffers.listByRunId.bind(db.runtimeBuffers)
    const nextChunkSeqByRunId = db.runtimeBuffers.nextChunkSeqByRunId.bind(db.runtimeBuffers)
    let nextChunkSeqQueries = 0

    mapper.apply(envelope('input.accepted', 3, { inputId: 'input_bounded_buffer_append' }))
    mapper.apply(envelope('turn.started', 4, { turnId: tid }, { turnId: tid }))

    db.runtimeBuffers.nextChunkSeqByRunId = (runId) => {
      nextChunkSeqQueries += 1
      return nextChunkSeqByRunId(runId)
    }
    db.runtimeBuffers.listByRunId = () => {
      throw new Error('full runtime-buffer scan is forbidden on the append hot path')
    }
    try {
      for (const [index, text] of chunks.entries()) {
        mapper.apply(
          envelope('assistant.message.delta', 5 + index, { messageId, text }, { turnId: tid })
        )
      }
      mapper.apply(
        envelope(
          'assistant.message.completed',
          5 + chunks.length,
          {
            messageId,
            content: [{ type: 'text', text: chunks.join('') }],
            final: true,
          },
          { turnId: tid }
        )
      )
    } finally {
      db.runtimeBuffers.listByRunId = listByRunId
      db.runtimeBuffers.nextChunkSeqByRunId = nextChunkSeqByRunId
    }

    expect(
      listByRunId(RUN_ID)
        .map((chunk) => chunk.text)
        .join('')
    ).toBe(chunks.join(''))
    expect(nextChunkSeqQueries).toBe(1)
  })

  it('continuation.cleared drops BOTH runtime AND session continuation', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db

    // Seed a captured continuation on both runtime and session.
    mapper.apply(
      envelope('continuation.updated', 8, { provider: 'anthropic', key: CONTINUATION_KEY })
    )
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toBeDefined()
    expect(db.sessions.getByHostSessionId(HOST_SESSION_ID)!.continuation).toBeDefined()

    // A user-initiated SessionEnd (Claude /quit) clears it on both sides so the
    // next launch resolution (`runtime.continuation ?? session.continuation`)
    // finds nothing and starts fresh.
    mapper.apply(envelope('continuation.cleared', 9, { reason: 'prompt_input_exit' }))
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toBeUndefined()
    expect(db.sessions.getByHostSessionId(HOST_SESSION_ID)!.continuation).toBeUndefined()
  })

  it('reflects invocation lifecycle state transitions in order', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db

    mapper.apply(envelope('invocation.started', 1, { command: 'codex', args: [], cwd: '/tmp' }))
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)!.activeInvocationId).toBe(INVOCATION_ID)

    mapper.apply(envelope('invocation.ready', 2, { state: 'ready' }))
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.invocationState).toBe('ready')

    mapper.apply(
      envelope('invocation.exited', 9, { exitCode: 0, signal: null, reason: 'idle-ttl' })
    )
    let invocation = db.brokerInvocations.getByInvocationId(INVOCATION_ID)!
    expect(invocation.invocationState).toBe('exited')
    expect(invocation.lifecycleTerminalReason).toBe('idle-ttl')

    mapper.apply(
      envelope('invocation.failed', 10, {
        message: 'runner degraded',
        reason: 'runner-degraded',
      })
    )
    invocation = db.brokerInvocations.getByInvocationId(INVOCATION_ID)!
    expect(invocation.invocationState).toBe('failed')
    expect(invocation.lifecycleTerminalReason).toBe('runner-degraded')

    mapper.apply(envelope('invocation.disposed', 11, { disposed: true }))
    invocation = db.brokerInvocations.getByInvocationId(INVOCATION_ID)!
    expect(invocation.invocationState).toBe('disposed')
    expect(invocation.lifecycleTerminalReason).toBe('runner-degraded')
  })
})

// ---------------------------------------------------------------------------
// 6. Permission audit, surface binding, diagnostics
// ---------------------------------------------------------------------------
