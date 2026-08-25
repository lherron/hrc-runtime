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
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendHrcEvent } from '../hrc-event-helper'

import {
  GENERATION,
  HOST_SESSION_ID,
  INVOCATION_ID,
  LANE_REF,
  OPERATION_ID,
  RUNTIME_ID,
  RUN_ID,
  SCOPE_REF,
  TOOL_CALL_ID,
  TOOL_NAME,
  envelope,
  headlessSequence,
  ts,
} from './broker-event-mapper-fixtures'

import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

const harness = createBrokerEventMapperTestFixture()

describe('emitted lifecycle events', () => {
  it('does not duplicate a durable acceptance when broker input.accepted arrives', () => {
    appendHrcEvent(harness.fixture.db, 'turn.accepted', {
      ts: ts(99),
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: GENERATION,
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      transport: 'headless',
      payload: { authority: 'durable-start-graph' },
    })

    const projected = harness
      .makeMapper()
      .apply(
        envelope(
          'input.accepted',
          3,
          { inputId: 'input_durable_acceptance' },
          { inputId: 'input_durable_acceptance' as never }
        )
      )

    expect(projected.lifecycleEvents).toHaveLength(0)
    expect(
      harness.fixture.db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.accepted' })
    ).toHaveLength(1)
  })

  it('does not return raw mirror events across the sequence', () => {
    const mapper = harness.makeMapper()
    const allEmitted = headlessSequence().flatMap((env) => mapper.apply(env).events)

    expect(allEmitted).toEqual([])
  })

  it('does not persist broker envelopes to the events table', () => {
    const mapper = harness.makeMapper()
    mapper.apply(envelope('invocation.ready', 2, { state: 'ready' }))

    const persisted = harness.fixture.db.events.listFromSeq(1, { runtimeId: RUNTIME_ID })
    expect(persisted).toEqual([])
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
      const mapper = harness.makeMapper()

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

      const artifacts = harness.fixture.db.runtimeArtifacts.listByOperationIdAndKind(
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
    const mapper = harness.makeMapper()
    mapper.apply(
      envelope(
        'provider.transcript.reported' as never,
        8,
        { artifactPath: 'relative/transcript.jsonl', provider: 'codex' },
        { harnessGeneration: GENERATION }
      )
    )

    expect(
      harness.fixture.db.runtimeArtifacts.listByOperationIdAndKind(
        OPERATION_ID,
        'provider-transcript-jsonl'
      )
    ).toEqual([])
    const warnings = harness.fixture.db.events
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
  // The mapper must project mapped broker types into hrc_events under registered
  // turn.* kinds (carrying hrcSeq so follow-subscribers deliver them + notifyEvent
  // finalizes the turn) without appending a raw events-table mirror.
  it('projects mapped broker types into the hrc_events lifecycle stream', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db

    const completed = mapper.apply(
      envelope(
        'turn.completed',
        7,
        { turnId: 'turn_x' as never, status: 'completed', producedContent: true },
        { turnId: 'turn_x' as never }
      )
    )

    expect(completed.events).toEqual([])
    expect(completed.lifecycleEvents.map((e) => e.eventKind)).toEqual(['turn.completed'])
    // Lifecycle event carries hrcSeq + runId so the follow stream/finalize path fires.
    expect(typeof completed.lifecycleEvents[0]!.hrcSeq).toBe('number')
    expect(completed.lifecycleEvents[0]!.runId).toBe(RUN_ID)

    // The canonical turn.completed lands in hrc_events for the run (gates read this).
    const hrcCompleted = db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.completed' })
    expect(hrcCompleted.length).toBe(1)
  })

  it('preserves optional provider details on failed turns and omits absent fields', () => {
    const mapper = harness.makeMapper()
    const detailed = mapper.apply(
      envelope('turn.failed', 7, {
        message: 'API Error: overloaded upstream',
        code: 'api_error',
        data: { status: 529, requestId: 'req_failed_turn' },
        reason: 'serverOverloaded',
        retryable: true,
      })
    )

    expect(detailed.lifecycleEvents).toHaveLength(1)
    expect(detailed.lifecycleEvents[0]).toMatchObject({
      eventKind: 'turn.completed',
      payload: {
        success: false,
        transport: 'headless',
        source: 'broker',
        message: 'API Error: overloaded upstream',
        code: 'api_error',
        data: { status: 529, requestId: 'req_failed_turn' },
        reason: 'serverOverloaded',
        retryable: true,
      },
    })

    const minimal = mapper.apply(envelope('turn.failed', 8, { message: 'provider request failed' }))
    const minimalPayload = minimal.lifecycleEvents[0]!.payload
    expect(minimalPayload).toMatchObject({
      success: false,
      transport: 'headless',
      source: 'broker',
      message: 'provider request failed',
    })
    expect(minimalPayload).not.toHaveProperty('code')
    expect(minimalPayload).not.toHaveProperty('data')
    expect(minimalPayload).not.toHaveProperty('reason')
    expect(minimalPayload).not.toHaveProperty('retryable')
  })

  it('uses the runtime transport when projecting broker lifecycle events', () => {
    const db = harness.fixture.db
    db.runtimes.update(RUNTIME_ID, {
      transport: 'tmux',
      updatedAt: ts(99),
    })
    const mapper = harness.makeMapper()

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
    const mapper = harness.makeMapper()
    const diagnostic = mapper.apply(envelope('diagnostic', 8, { level: 'info', message: 'noise' }))
    expect(diagnostic.events).toEqual([])
    expect(diagnostic.lifecycleEvents).toEqual([])
  })

  // hrcchat turn / Discord / monitor follow the canonical hrc_events stream.
  // Tool calls are the most visible mid-turn signal — if they don't reach the
  // lifecycle stream, the UX shows a long blank ... between user prompt and
  // final message. Mapper MUST project tool.call.started/completed/failed under
  // the registered turn.tool_call / turn.tool_result kinds, with hrc-events'
  // canonical hook-derived payload shape so existing renderers consume them.
  it('projects tool.call.started into turn.tool_call with hook-derived payload', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db

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

    expect(result.events).toEqual([])
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
    const mapper = harness.makeMapper()
    const db = harness.fixture.db

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
    const mapper = harness.makeMapper()
    const db = harness.fixture.db

    const result = mapper.apply(
      envelope('user.message', 9, { content: 'ship the fix' }, { turnId: 'turn_x' as never })
    )

    expect(result.events).toEqual([])
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
    const mapper = harness.makeMapper()
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
    const mapper = harness.makeMapper()
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
