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
 *   3. emits HRC events with `source: 'broker'` via `EventRepository.append`;
 *   4. marks the broker event row projection_status = 'applied'.
 *
 * Contract invariants under test:
 *   - atomic: a projection error rolls the appended broker event row back too;
 *   - idempotent: same (invocationId, seq) + SAME payload twice => one projection;
 *   - conflict: same (invocationId, seq) + DIFFERENT payload => throws
 *     BrokerInvocationEventConflictError, NO projection;
 *   - source:'broker' on every emitted HRC event;
 *   - full ordered sequence projects runtime/run/message/tool/continuation;
 *   - replay of the whole sequence is a no-op.
 *
 * Public API under test (documented for curly in the final reply):
 *   class BrokerEventMapper {
 *     constructor(deps: { db: HrcDatabase; now?: () => string })
 *     apply(envelope: InvocationEventEnvelope): {
 *       idempotent: boolean
 *       events: HrcEventEnvelope[]   // each has source: 'broker'
 *     }
 *   }
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrokerInvocationEventConflictError } from 'hrc-store-sqlite'
import type { TurnId } from 'spaces-harness-broker-protocol'

// RED gate: this module does not exist yet (curly creates it under src/broker/).
import { BrokerEventMapper } from '../broker/event-mapper'

import {
  ASSISTANT_TEXT,
  CONTINUATION_KEY,
  GENERATION,
  HOST_SESSION_ID,
  INVOCATION_ID,
  LANE_REF,
  OPERATION_ID,
  RUNTIME_ID,
  RUN_ID,
  SCOPE_REF,
  type SeededFixture,
  TMUX_INVOCATION_ID,
  TMUX_RUNTIME_ID,
  TOOL_CALL_ID,
  TOOL_NAME,
  bufferTextForRun,
  emittedEventsMentioning,
  envelope,
  headlessSequence,
  makeSeededFixture,
  makeTmuxSeededFixture,
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

// ---------------------------------------------------------------------------
// 1. source:'broker' on every emitted HRC event
// ---------------------------------------------------------------------------
describe('emitted HRC events', () => {
  it('stamps source:"broker" on every event emitted across the sequence', () => {
    const mapper = makeMapper()
    const allEmitted = headlessSequence().flatMap((env) => mapper.apply(env).events)

    expect(allEmitted.length).toBeGreaterThan(0)
    for (const event of allEmitted) {
      expect(event.source).toBe('broker')
    }
  })

  it('persists emitted events to the events table with source:"broker"', () => {
    const mapper = makeMapper()
    mapper.apply(envelope('invocation.ready', 2, { state: 'ready' }))

    const persisted = fixture.db.events.listFromSeq(1, { runtimeId: RUNTIME_ID })
    expect(persisted.length).toBeGreaterThan(0)
    for (const event of persisted) {
      expect(event.source).toBe('broker')
    }
  })

  it('persists provider transcript artifacts from explicit broker notifications', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-provider-transcript-'))
    try {
      const transcriptPath = join(dir, 'transcript.jsonl')
      const line = JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'artifact text' }],
        },
      })
      await writeFile(transcriptPath, `${line}\n`, 'utf8')
      const mapper = makeMapper()

      mapper.apply(
        envelope(
          'provider.transcript.reported' as never,
          8,
          { artifactPath: transcriptPath, provider: 'codex', harnessGeneration: GENERATION },
          { harnessGeneration: GENERATION }
        )
      )
      mapper.apply(
        envelope(
          'provider.transcript.reported' as never,
          8,
          { artifactPath: transcriptPath, provider: 'codex', harnessGeneration: GENERATION },
          { harnessGeneration: GENERATION }
        )
      )

      const artifacts = fixture.db.runtimeArtifacts.listByOperationIdAndKind(
        OPERATION_ID,
        'provider-transcript-jsonl'
      )
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]).toMatchObject({
        artifactId: `provider-transcript:${INVOCATION_ID}:8`,
        artifactKind: 'provider-transcript-jsonl',
        storageKind: 'file-path',
        mediaType: 'application/x-ndjson',
        artifactPath: transcriptPath,
        contentHash: `sha256:${createHash('sha256').update(`${line}\n`).digest('hex')}`,
      })
      expect(JSON.parse(artifacts[0]!.artifactJson ?? '{}')).toMatchObject({
        schema: 'hrc.provider-transcript-artifact/v1',
        // T-05375: carries the ASP producer CONTENT schema distinctly from the
        // HRC-owned metadata schema above.
        sourceSchema: 'harness-broker.provider-transcript.codex-jsonrpc-notification-jsonl/v1',
        invocationId: INVOCATION_ID,
        runtimeId: RUNTIME_ID,
        runId: RUN_ID,
        brokerSeq: 8,
        hashAlgorithm: 'sha256',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('warns without artifact persistence when transcript notification path is not absolute', () => {
    const mapper = makeMapper()
    mapper.apply(
      envelope(
        'provider.transcript.reported' as never,
        8,
        { artifactPath: 'relative/transcript.jsonl', provider: 'codex' },
        { harnessGeneration: GENERATION }
      )
    )

    expect(
      fixture.db.runtimeArtifacts.listByOperationIdAndKind(
        OPERATION_ID,
        'provider-transcript-jsonl'
      )
    ).toEqual([])
    const warnings = fixture.db.events
      .listFromSeq(1, { runtimeId: RUNTIME_ID })
      .filter((event) => event.eventKind === 'broker.provider_transcript_artifact.warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.eventJson).toMatchObject({
      invocationId: INVOCATION_ID,
      seq: 8,
      reason: 'invalid_path',
    })
  })

  // T-01711: clients follow the canonical hrc_events lifecycle stream (/v1/events),
  // NOT the raw `events` mirror. The mapper must project mapped broker types into
  // hrc_events under registered turn.* kinds (carrying hrcSeq so follow-subscribers
  // deliver them + notifyEvent finalizes the turn). The raw mirror stays broker.*.
  it('projects mapped broker types into the hrc_events lifecycle stream', () => {
    const mapper = makeMapper()
    const db = fixture.db

    const completed = mapper.apply(
      envelope(
        'turn.completed',
        7,
        { turnId: 'turn_x' as never, status: 'completed', producedContent: true },
        { turnId: 'turn_x' as never }
      )
    )

    // Raw mirror keeps the broker. prefix; lifecycle event is canonical.
    expect(completed.events.map((e) => e.eventKind)).toEqual(['broker.turn.completed'])
    expect(completed.lifecycleEvents.map((e) => e.eventKind)).toEqual(['turn.completed'])
    // Lifecycle event carries hrcSeq + runId so the follow stream/finalize path fires.
    expect(typeof completed.lifecycleEvents[0]!.hrcSeq).toBe('number')
    expect(completed.lifecycleEvents[0]!.runId).toBe(RUN_ID)

    // The canonical turn.completed lands in hrc_events for the run (gates read this).
    const hrcCompleted = db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.completed' })
    expect(hrcCompleted.length).toBe(1)
  })

  it('uses the runtime transport when projecting broker lifecycle events', () => {
    const db = fixture.db
    db.runtimes.update(RUNTIME_ID, {
      transport: 'tmux',
      updatedAt: ts(99),
    })
    const mapper = makeMapper()

    const completed = mapper.apply(
      envelope(
        'turn.completed',
        7,
        { turnId: 'turn_x' as never, status: 'completed', producedContent: true },
        { turnId: 'turn_x' as never }
      )
    )

    expect(completed.lifecycleEvents[0]!.transport).toBe('tmux')
    expect(completed.lifecycleEvents[0]!.payload).toMatchObject({ transport: 'tmux' })

    const hrcCompleted = db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.completed' })
    expect(hrcCompleted[0]!.transport).toBe('tmux')
    expect(hrcCompleted[0]!.payload).toMatchObject({ transport: 'tmux' })
  })

  it('treats unmapped broker types as provenance-only (no lifecycle event)', () => {
    const mapper = makeMapper()
    const diagnostic = mapper.apply(envelope('diagnostic', 8, { level: 'info', message: 'noise' }))
    expect(diagnostic.events.map((e) => e.eventKind)).toEqual(['broker.diagnostic'])
    expect(diagnostic.lifecycleEvents).toEqual([])
  })

  // hrcchat turn / Discord / monitor follow the canonical hrc_events stream.
  // Tool calls are the most visible mid-turn signal — if they don't reach the
  // lifecycle stream, the UX shows a long blank ... between user prompt and
  // final message. Mapper MUST project tool.call.started/completed/failed under
  // the registered turn.tool_call / turn.tool_result kinds, with hrc-events'
  // canonical hook-derived payload shape so existing renderers consume them.
  it('projects tool.call.started into turn.tool_call with hook-derived payload', () => {
    const mapper = makeMapper()
    const db = fixture.db

    const result = mapper.apply(
      envelope(
        'tool.call.started',
        10,
        {
          toolCallId: TOOL_CALL_ID as never,
          name: TOOL_NAME,
          input: { command: '/bin/zsh -lc ls', cwd: '/tmp/project' },
        },
        { turnId: 'turn_x' as never }
      )
    )

    expect(result.events.map((e) => e.eventKind)).toEqual(['broker.tool.call.started'])
    expect(result.lifecycleEvents.map((e) => e.eventKind)).toEqual(['turn.tool_call'])
    const lifecycle = result.lifecycleEvents[0]!
    expect(lifecycle.runId).toBe(RUN_ID)
    expect(lifecycle.payload).toEqual({
      type: 'tool_execution_start',
      toolUseId: TOOL_CALL_ID,
      toolName: TOOL_NAME,
      input: { command: '/bin/zsh -lc ls', cwd: '/tmp/project' },
    })

    const rows = db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.tool_call' })
    expect(rows.length).toBe(1)
  })

  it('projects tool.call.completed into turn.tool_result, normalizing driver result shape', () => {
    const mapper = makeMapper()
    const db = fixture.db

    const result = mapper.apply(
      envelope(
        'tool.call.completed',
        11,
        {
          toolCallId: TOOL_CALL_ID as never,
          name: TOOL_NAME,
          // codex's `command` tool emits {output, exitCode}, not a ToolResult.
          // Mapper must coerce into hrc-events' {content: ContentBlock[]} shape.
          result: { output: 'AGENTS.md\nCLAUDE.md\n', exitCode: 0 },
          isError: false,
          durationMs: 12,
        },
        { turnId: 'turn_x' as never }
      )
    )

    expect(result.lifecycleEvents.map((e) => e.eventKind)).toEqual(['turn.tool_result'])
    expect(result.lifecycleEvents[0]!.payload).toEqual({
      type: 'tool_execution_end',
      toolUseId: TOOL_CALL_ID,
      toolName: TOOL_NAME,
      result: {
        content: [{ type: 'text', text: 'AGENTS.md\nCLAUDE.md\n' }],
        details: { output: 'AGENTS.md\nCLAUDE.md\n', exitCode: 0 },
      },
      isError: false,
    })
    expect(db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.tool_result' }).length).toBe(1)
  })

  // T-02026: interactive TUI prompts (claude-code-tmux / codex-cli-tmux) surface
  // the operator's typed text as a broker user.message emitted right after
  // turn.started. The mapper MUST project it into turn.user_prompt with the
  // canonical {type:'message_end', role:'user'} payload so the prompt rides the
  // same lifecycle stream consumers (viewer / hrcchat) already render — otherwise
  // interactive turns show no user message at all.
  it('projects user.message into turn.user_prompt with role:user payload', () => {
    const mapper = makeMapper()
    const db = fixture.db

    const result = mapper.apply(
      envelope('user.message', 9, { content: 'ship the fix' }, { turnId: 'turn_x' as never })
    )

    expect(result.events.map((e) => e.eventKind)).toEqual(['broker.user.message'])
    expect(result.lifecycleEvents.map((e) => e.eventKind)).toEqual(['turn.user_prompt'])
    const lifecycle = result.lifecycleEvents[0]!
    expect(lifecycle.runId).toBe(RUN_ID)
    expect(lifecycle.payload).toEqual({
      type: 'message_end',
      message: { role: 'user', content: 'ship the fix' },
    })

    const rows = db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.user_prompt' })
    expect(rows.length).toBe(1)
  })

  it('passes through a result already in ToolResult shape', () => {
    const mapper = makeMapper()
    const result = mapper.apply(
      envelope(
        'tool.call.completed',
        12,
        {
          toolCallId: TOOL_CALL_ID as never,
          name: TOOL_NAME,
          result: { content: [{ type: 'text', text: 'pre-shaped' }] },
        },
        { turnId: 'turn_x' as never }
      )
    )
    expect(result.lifecycleEvents[0]!.payload).toEqual({
      type: 'tool_execution_end',
      toolUseId: TOOL_CALL_ID,
      toolName: TOOL_NAME,
      result: { content: [{ type: 'text', text: 'pre-shaped' }] },
    })
  })

  it('projects tool.call.failed into turn.tool_result with isError:true', () => {
    const mapper = makeMapper()
    const result = mapper.apply(
      envelope(
        'tool.call.failed',
        13,
        {
          toolCallId: TOOL_CALL_ID as never,
          name: TOOL_NAME,
          message: 'command timed out',
        },
        { turnId: 'turn_x' as never }
      )
    )

    expect(result.lifecycleEvents.map((e) => e.eventKind)).toEqual(['turn.tool_result'])
    expect(result.lifecycleEvents[0]!.payload).toEqual({
      type: 'tool_execution_end',
      toolUseId: TOOL_CALL_ID,
      toolName: TOOL_NAME,
      result: { content: [{ type: 'text', text: 'command timed out' }] },
      isError: true,
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Idempotency — same (invocationId, seq) + SAME payload twice
// ---------------------------------------------------------------------------
describe('idempotency', () => {
  it('applies SAME (invocationId, seq) + SAME payload exactly once', () => {
    const mapper = makeMapper()
    const env = envelope('continuation.updated', 8, {
      provider: 'openai',
      key: CONTINUATION_KEY,
    })

    const first = mapper.apply(env)
    expect(first.idempotent).toBe(false)
    expect(first.events.length).toBeGreaterThan(0)

    const eventsAfterFirst = fixture.db.events.count({ runtimeId: RUNTIME_ID })
    const brokerRowsAfterFirst =
      fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).length

    const second = mapper.apply(env)
    expect(second.idempotent).toBe(true)
    expect(second.events.length).toBe(0)

    // No double-apply: no new HRC events, no new broker event rows.
    expect(fixture.db.events.count({ runtimeId: RUNTIME_ID })).toBe(eventsAfterFirst)
    expect(fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).length).toBe(
      brokerRowsAfterFirst
    )

    // The single projection is intact (not applied twice / not reverted).
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual({
      provider: 'openai',
      key: CONTINUATION_KEY,
    })
  })

  it('does not throw on a duplicate apply', () => {
    const mapper = makeMapper()
    const env = envelope('invocation.ready', 2, { state: 'ready' })
    mapper.apply(env)
    expect(() => mapper.apply(env)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. Conflict — same (invocationId, seq) + DIFFERENT payload
// ---------------------------------------------------------------------------
describe('conflict (divergent payload, same key)', () => {
  it('throws BrokerInvocationEventConflictError and projects nothing from the conflicting event', () => {
    const mapper = makeMapper()

    const original = envelope('continuation.updated', 8, {
      provider: 'openai',
      key: 'key_ORIGINAL',
    })
    mapper.apply(original)
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual({
      provider: 'openai',
      key: 'key_ORIGINAL',
    })

    const eventsBefore = fixture.db.events.count({ runtimeId: RUNTIME_ID })

    const divergent = envelope('continuation.updated', 8, {
      provider: 'openai',
      key: 'key_DIVERGENT',
    })

    expect(() => mapper.apply(divergent)).toThrow(BrokerInvocationEventConflictError)

    // No projection from the divergent event: continuation unchanged, no new
    // HRC events, stored broker payload still the original.
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual({
      provider: 'openai',
      key: 'key_ORIGINAL',
    })
    expect(fixture.db.events.count({ runtimeId: RUNTIME_ID })).toBe(eventsBefore)

    const stored = fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 8)
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored!.brokerEventJson)).toEqual({
      provider: 'openai',
      key: 'key_ORIGINAL',
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Transaction atomicity — projection failure rolls back the event row
// ---------------------------------------------------------------------------
describe('transaction atomicity', () => {
  it('rolls back the appended broker event row when projection fails', () => {
    const mapper = makeMapper()
    const db = fixture.db

    // Fault the HRC-event emission so projection throws mid-transaction.
    const original = db.events.append.bind(db.events)
    let armed = true
    ;(db.events as { append: typeof db.events.append }).append = ((input) => {
      if (armed) {
        throw new Error('injected projection failure')
      }
      return original(input)
    }) as typeof db.events.append

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
      ;(db.events as { append: typeof db.events.append }).append = original
    }

    // Neither the broker event row nor the run-state projection persisted.
    expect(db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 7)).toBeNull()
    const run = db.runs.getByRunId(RUN_ID)!
    expect(run.status).toBe('accepted')
    expect(run.completedAt).toBeUndefined()
  })

  it('marks the broker event row projection_status applied on success', () => {
    const mapper = makeMapper()
    mapper.apply(envelope('invocation.ready', 2, { state: 'ready' }))

    const stored = fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 2)
    expect(stored).not.toBeNull()
    expect(stored!.projectionStatus).toBe('applied')
    expect(typeof stored!.hrcEventSeq).toBe('number')
  })

  it('clears runtime activeRunId when an interactive broker turn completes', () => {
    const mapper = makeMapper()
    const db = fixture.db
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
    const mapper = makeMapper()
    const db = fixture.db
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
describe('projection mapping (ordered sequence)', () => {
  it('projects runtime / run / message / tool / continuation state', () => {
    const mapper = makeMapper()
    const db = fixture.db
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

    // tool.call.* -> tool events (surfaced as broker HRC events).
    const allEmitted = seq.flatMap((env) => emittedByType.get(env.type)!.events)
    const toolEvents = emittedEventsMentioning(allEmitted, TOOL_CALL_ID)
    expect(toolEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(toolEvents[0]!.eventJson)).toContain(TOOL_NAME)

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

    // every emitted event is sourced from the broker.
    for (const event of allEmitted) {
      expect(event.source).toBe('broker')
    }
  })

  it('does not double-buffer completed assistant text already emitted as deltas', () => {
    const mapper = makeMapper()
    const db = fixture.db
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

  it('continuation.cleared drops BOTH runtime AND session continuation', () => {
    const mapper = makeMapper()
    const db = fixture.db

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
    const mapper = makeMapper()
    const db = fixture.db

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
describe('auxiliary projections', () => {
  it('audits permission.resolved through permission_decisions', () => {
    const mapper = makeMapper()
    const prid = permissionRequestId('perm_w3a_1')

    mapper.apply(
      envelope('permission.requested', 30, {
        permissionRequestId: prid,
        kind: 'command',
        subjectDisplay: { command: 'rm -rf /tmp/x' },
        defaultDecision: 'deny',
      })
    )

    mapper.apply(
      envelope('permission.resolved', 31, {
        permissionRequestId: prid,
        decision: 'deny',
        decidedBy: 'policy',
      })
    )

    const decision = fixture.db.permissionDecisions.getByPermissionRequestId('perm_w3a_1')
    expect(decision).not.toBeNull()
    expect(decision!.decision).toBe('deny')
    expect(decision!.decidedBy).toBe('policy')
    expect(decision!.invocationId).toBe(INVOCATION_ID)
    expect(decision!.runtimeId).toBe(RUNTIME_ID)
  })

  it('binds a terminal surface on terminal.surface.reported', () => {
    const mapper = makeMapper()
    mapper.apply(
      envelope('terminal.surface.reported', 40, {
        kind: 'tmux-session',
        socketPath: '/tmp/hrc-tmux.sock',
        sessionName: 'broker-w3a',
        paneId: '%7',
      })
    )

    const bindings = fixture.db.surfaceBindings.findByRuntime(RUNTIME_ID)
    expect(bindings.length).toBeGreaterThan(0)
  })

  it('surfaces diagnostics as broker HRC events', () => {
    const mapper = makeMapper()
    const result = mapper.apply(
      envelope('diagnostic', 50, {
        level: 'warn',
        message: 'broker-diagnostic-marker',
        source: 'driver',
      })
    )

    expect(result.events.length).toBeGreaterThan(0)
    const hits = emittedEventsMentioning(result.events, 'broker-diagnostic-marker')
    expect(hits.length).toBeGreaterThan(0)
    for (const event of result.events) {
      expect(event.source).toBe('broker')
    }
  })

  it('projects only error/api diagnostics into non-terminal monitor lifecycle rows', () => {
    const mapper = makeMapper()
    const db = fixture.db

    // T-05096 guard: info/warn diagnostics remain provenance-only so monitor
    // visibility does not broaden into noisy broker health chatter.
    const warn = mapper.apply(
      envelope('diagnostic', 50, {
        level: 'warn',
        source: 'harness',
        message: 'background warning',
        data: { code: 'ordinary_warning' },
      })
    )
    expect(warn.events.map((event) => event.eventKind)).toEqual(['broker.diagnostic'])
    expect(warn.lifecycleEvents).toEqual([])
    expect(db.hrcEvents.listByRun(RUN_ID, { eventKind: 'broker.diagnostic' })).toEqual([])

    const beforeRun = db.runs.getByRunId(RUN_ID)!
    const beforeRuntime = db.runtimes.getByRuntimeId(RUNTIME_ID)!

    const diagnosticEnvelope = {
      ...envelope(
        'diagnostic',
        51,
        {
          level: 'error',
          source: 'harness',
          message: 'API Error: overloaded upstream',
          data: {
            code: 'api_error',
            rawType: 'assistant',
            isApiErrorMessage: true,
            requestId: 'req_05096',
            apiErrorStatus: 529,
          },
        },
        {
          turnId: 'turn_api_error' as TurnId,
          inputId: 'input_api_error' as never,
          itemId: 'item_api_error',
        }
      ),
      correlation: { requestId: 'req_05096', spanId: 'span_05096' },
      driver: { kind: 'claude-code-tmux', rawType: 'assistant' },
    }

    const result = mapper.apply(diagnosticEnvelope)

    expect(result.events.map((event) => event.eventKind)).toEqual(['broker.diagnostic'])
    expect(result.lifecycleEvents.map((event) => event.eventKind)).toEqual(['broker.diagnostic'])
    expect(result.lifecycleEvents).toHaveLength(1)

    const lifecycle = result.lifecycleEvents[0]!
    expect(lifecycle.category).toBe('runtime')
    expect(lifecycle.runId).toBe(RUN_ID)
    expect(lifecycle.payload).toMatchObject({
      level: 'error',
      source: 'harness',
      message: 'API Error: overloaded upstream',
      data: {
        code: 'api_error',
        rawType: 'assistant',
        isApiErrorMessage: true,
        requestId: 'req_05096',
        apiErrorStatus: 529,
      },
      invocationId: INVOCATION_ID,
      seq: 51,
      time: ts(51),
      turnId: 'turn_api_error',
      inputId: 'input_api_error',
      itemId: 'item_api_error',
      correlation: { requestId: 'req_05096', spanId: 'span_05096' },
      driver: { kind: 'claude-code-tmux', rawType: 'assistant' },
      runId: RUN_ID,
    })

    const hrcRows = db.hrcEvents.listByRun(RUN_ID, { eventKind: 'broker.diagnostic' })
    expect(hrcRows).toHaveLength(1)
    expect(hrcRows[0]!.category).toBe('runtime')
    expect(hrcRows[0]!.payload).toMatchObject({
      message: 'API Error: overloaded upstream',
      data: { code: 'api_error' },
      invocationId: INVOCATION_ID,
      seq: 51,
      runId: RUN_ID,
    })

    expect(db.runs.getByRunId(RUN_ID)).toMatchObject({
      status: beforeRun.status,
      completedAt: beforeRun.completedAt,
    })
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
      status: beforeRuntime.status,
    })
    expect(
      db.hrcEvents
        .listByRun(RUN_ID)
        .filter((event) =>
          ['turn.failed', 'turn.finished', 'turn.completed', 'invocation.failed'].includes(
            event.eventKind
          )
        )
    ).toEqual([])

    // T-05096 idempotency guard: replaying the same broker sequence must not
    // duplicate the monitor-visible diagnostic.
    const replay = mapper.apply(diagnosticEnvelope)
    expect(replay.idempotent).toBe(true)
    expect(replay.lifecycleEvents).toEqual([])
    expect(db.hrcEvents.listByRun(RUN_ID, { eventKind: 'broker.diagnostic' })).toHaveLength(1)
    expect(
      db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).map((event) => event.seq)
    ).toContain(51)
  })

  it('does not expose fabricated terminal-state fields on public run/runtime records', () => {
    const mapper = makeMapper()
    const db = fixture.db

    mapper.apply(
      envelope(
        'diagnostic',
        52,
        {
          level: 'error',
          source: 'harness',
          message: 'API Error: rate limited',
          data: { code: 'api_error' },
        },
        {
          turnId: 'turn_x' as TurnId,
          inputId: 'input_rate_limit',
          driver: { kind: 'claude-code-tmux', rawType: 'assistant' },
        }
      )
    )

    const run = db.runs.getByRunId(RUN_ID)!
    const runtime = db.runtimes.getByRuntimeId(RUNTIME_ID)!

    // T-05096 gate addendum: these fields never existed on the public DTOs.
    // Non-terminal behavior is covered by real status/completedAt/event-kind
    // assertions; adding undefined placeholders would pollute every consumer.
    expect('failureKind' in run).toBe(false)
    expect('lastError' in runtime).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. Replay — applying the whole sequence again is a no-op
// ---------------------------------------------------------------------------
describe('replay (end-to-end idempotency)', () => {
  it('produces no state change when the full sequence is replayed', () => {
    const mapper = makeMapper()
    const db = fixture.db
    const seq = headlessSequence()

    for (const env of seq) {
      mapper.apply(env)
    }

    const snapshot = {
      hrcEvents: db.events.count({ runtimeId: RUNTIME_ID }),
      brokerRows: db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).length,
      bufferChunks: db.runtimeBuffers.listByRunId(RUN_ID).length,
      runStatus: db.runs.getByRunId(RUN_ID)!.status,
      runtimeContinuation: db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation,
      sessionContinuation: db.sessions.getByHostSessionId(HOST_SESSION_ID)!.continuation,
      invocationState: db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.invocationState,
    }

    // Replay the identical sequence.
    for (const env of seq) {
      const replay = mapper.apply(env)
      expect(replay.idempotent).toBe(true)
      expect(replay.events.length).toBe(0)
    }

    expect(db.events.count({ runtimeId: RUNTIME_ID })).toBe(snapshot.hrcEvents)
    expect(db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).length).toBe(
      snapshot.brokerRows
    )
    expect(db.runtimeBuffers.listByRunId(RUN_ID).length).toBe(snapshot.bufferChunks)
    expect(db.runs.getByRunId(RUN_ID)!.status).toBe(snapshot.runStatus)
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual(
      snapshot.runtimeContinuation
    )
    expect(db.sessions.getByHostSessionId(HOST_SESSION_ID)!.continuation).toEqual(
      snapshot.sessionContinuation
    )
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.invocationState).toBe(
      snapshot.invocationState
    )
  })
})

// ---------------------------------------------------------------------------
// T-04836 — continuation kind must survive broker projection
// ---------------------------------------------------------------------------
describe('T-04836 continuation kind persistence', () => {
  it('persists continuation.updated kind on both runtime and session continuation refs', () => {
    const mapper = makeMapper()
    const codexSessionUuid = '018fe9d5-992c-7cc8-a4bc-9c0c04c4f919'

    mapper.apply(
      envelope('continuation.updated', 8, {
        provider: 'openai',
        kind: 'session',
        key: codexSessionUuid,
      })
    )

    // T-04836: Codex tmux resume is safe only for explicit session UUID resume.
    // Dropping `kind` makes HRC unable to distinguish session ids from other
    // continuation keys, so both persisted refs must retain it.
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual({
      provider: 'openai',
      kind: 'session',
      key: codexSessionUuid,
    })
    expect(fixture.db.sessions.getByHostSessionId(HOST_SESSION_ID)!.continuation).toEqual({
      provider: 'openai',
      kind: 'session',
      key: codexSessionUuid,
    })
  })
})

// ---------------------------------------------------------------------------
// 8. T-04215 — broker user.message echo dedup
//
//    A broker `user.message` that is merely the TUI echo of an HRC-authored
//    prompt already recorded for the same dispatch must NOT project a second
//    canonical `turn.user_prompt`. Suppression at lifecycle-projection time in
//    BrokerEventMapper; raw `broker.user.message` provenance still appended.
//
//    CRITICAL: runId is EMPTY on real broker-tmux interactive runtimes.
//    Evidence: hrc_seq 376316/376317, runtime rt-64673c6d, generation 1,
//    run_id NULL. Dedup correlation must key on
//    (hostSessionId, generation, runtimeId, canonical content) scoped to the
//    current turn window — NOT runId.
//
//    Test 1 (T-02026 guard): preserved at ~line 241 above — bare user.message
//    with no prior synth → one turn.user_prompt.  Must stay GREEN.
//    Test 2 (RED): prior synth with same content → lifecycleEvents=[]  ← FAILS now
//    Test 3 (guard): different content → still projects.  Must stay GREEN.
// ---------------------------------------------------------------------------
describe('broker.user.message echo dedup (T-04215)', () => {
  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Seed a prior synthetic turn.user_prompt into the standard fixture's hrc_events,
   * simulating what broker-interactive-handlers.ts emits at injection time
   * (before the TUI echoes the same prompt back via broker user.message).
   */
  function seedPriorSynthUserPrompt(content: string): void {
    fixture.db.hrcEvents.append({
      ts: ts(1),
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: GENERATION,
      runtimeId: RUNTIME_ID,
      category: 'turn',
      eventKind: 'turn.user_prompt',
      transport: 'headless',
      payload: { type: 'message_end', message: { role: 'user', content } },
    })
  }

  // ── Test 2a (RED) — tmux fixture, runId absent ────────────────────────────
  //
  // The canonical RED test: mirrors the REAL broker-tmux interactive shape
  // where the broker invocation carries no runId.  A prior synthetic
  // turn.user_prompt already exists in hrc_events (same runtimeId, same
  // content, same generation).  Applying the broker user.message echo must NOT
  // produce a second lifecycle turn.user_prompt.
  //
  // Current code: emitLifecycle always projects 'user.message' → 'turn.user_prompt'
  // → this test FAILS RED until the suppression is implemented.
  it('[RED] does NOT project a second turn.user_prompt when prior synth exists — runId-absent (real tmux shape)', async () => {
    // makeTmuxSeededFixture pre-seeds the prior synthetic turn.user_prompt.
    const tmuxFixture = await makeTmuxSeededFixture('ship the fix')
    try {
      const mapper = new BrokerEventMapper({ db: tmuxFixture.db, now: () => ts(100) })

      const result = mapper.apply({
        invocationId: TMUX_INVOCATION_ID,
        seq: 9,
        time: ts(9),
        type: 'user.message',
        payload: { content: 'ship the fix' },
        // turnId set; no runId — mirrors real tmux lifecycle event shape
        turnId: 'turn_dedup_1' as TurnId,
      })

      // Raw provenance event MUST still be appended to the events mirror.
      expect(result.events.map((e) => e.eventKind)).toEqual(['broker.user.message'])

      // Echo is suppressed — no second canonical turn.user_prompt.
      // FAILS RED against current code: current code always emits the lifecycle event.
      expect(result.lifecycleEvents).toEqual([])

      // Database has exactly ONE turn.user_prompt for this runtime (the synth).
      const allPrompts = tmuxFixture.db.hrcEvents.listByKind('turn.user_prompt', {
        runtimeId: TMUX_RUNTIME_ID,
      })
      expect(allPrompts).toHaveLength(1)
    } finally {
      await tmuxFixture.cleanup()
    }
  })

  // ── Test 2b (RED) — standard fixture, runId present ──────────────────────
  //
  // Same dedup invariant, standard headless fixture (runId present).  Proves
  // the suppression is not special-cased on tmux-only — it applies whenever
  // a prior synth turn.user_prompt exists for the same (runtimeId, generation,
  // hostSessionId, content) in the current turn window.
  //
  // FAILS RED against current code for the same reason as Test 2a.
  it('[RED] does NOT project a second turn.user_prompt when prior synth exists — runId-present (standard fixture)', () => {
    seedPriorSynthUserPrompt('ship the fix')

    const mapper = makeMapper()
    const result = mapper.apply(
      envelope('user.message', 9, { content: 'ship the fix' }, { turnId: 'turn_x' as never })
    )

    // Raw provenance mirror still appended.
    expect(result.events.map((e) => e.eventKind)).toEqual(['broker.user.message'])
    // Echo suppressed — no second canonical turn.user_prompt.
    // FAILS RED: current code → lifecycleEvents=['turn.user_prompt']
    expect(result.lifecycleEvents).toEqual([])
    // Exactly one turn.user_prompt in hrc_events for this runtime.
    const allPrompts = fixture.db.hrcEvents.listByKind('turn.user_prompt', {
      runtimeId: RUNTIME_ID,
    })
    expect(allPrompts).toHaveLength(1)
  })

  // ── Test 3 (guard — different content still projects) ─────────────────────
  //
  // A broker user.message whose content DIFFERS from the prior synthetic
  // turn.user_prompt must NOT be suppressed — it is a genuinely new user
  // message (e.g. a follow-up message in the same turn window).
  //
  // GREEN against current code (always projects) and must remain GREEN after fix.
  it('[guard] still projects turn.user_prompt when user.message content differs from prior synth', () => {
    // Seed a prior synth with DIFFERENT content.
    seedPriorSynthUserPrompt('deploy the fix')

    const mapper = makeMapper()
    const result = mapper.apply(
      envelope('user.message', 9, { content: 'ship the fix' }, { turnId: 'turn_x' as never })
    )

    // Content differs → NOT suppressed → lifecycle event still emitted.
    expect(result.lifecycleEvents.map((e) => e.eventKind)).toContain('turn.user_prompt')
    // DB now has two turn.user_prompt events: the seeded synth + the new one.
    const allPrompts = fixture.db.hrcEvents.listByKind('turn.user_prompt', {
      runtimeId: RUNTIME_ID,
    })
    expect(allPrompts).toHaveLength(2)
  })
})
