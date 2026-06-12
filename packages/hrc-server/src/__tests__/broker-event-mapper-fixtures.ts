/**
 * Shared fixtures for the broker EVENT MAPPER RED tests (T-01696 / T-01690 W3A)
 * and dedup RED tests (T-04215 / T-04221).
 *
 * Provides:
 *  - a fully-migrated on-disk HrcDatabase seeded with one session + runtime +
 *    run + broker_invocation (the context the mapper resolves from a bare
 *    InvocationEventEnvelope.invocationId);
 *  - a tmux-interactive variant (makeTmuxSeededFixture) with NO runId on the
 *    broker invocation — mirrors real broker-tmux shape (hrc_seq 376316/376317
 *    evidence: run_id NULL on interactive turns);
 *  - typed synthetic InvocationEventEnvelope builders (no live broker);
 *  - the canonical ordered headless codex-app-server sequence used by the
 *    projection-mapping + replay tests.
 *
 * No production code is imported here other than the persistence package
 * (`hrc-store-sqlite`) and the broker protocol TYPES — the mapper-under-test is
 * imported by the .test.ts file itself so module-not-found is the RED signal.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type {
  InputId,
  InvocationEventEnvelope,
  InvocationEventType,
  InvocationId,
  IsoTimestamp,
  MessageId,
  PermissionRequestId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'

export type FixtureDb = ReturnType<typeof openHrcDatabase>

// ── Stable identifiers shared across the seeded graph ──────────────────────
export const HOST_SESSION_ID = 'hsid_broker_w3a'
export const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-01696'
export const LANE_REF = 'default'
export const GENERATION = 1
export const RUNTIME_ID = 'runtime_broker_w3a'
export const OPERATION_ID = 'op_broker_w3a'
export const INVOCATION_ID = 'invocation_broker_w3a' as InvocationId
export const RUN_ID = 'run_broker_w3a'

// ── Stable identifiers for the tmux-interactive dedup fixture (T-04215) ────
// Mirrors real broker-tmux shape: invocation has NO runId (hrc_seq 376316/
// 376317 evidence: run_id NULL, only runtimeId/generation/hostSessionId set).
export const TMUX_HOST_SESSION_ID = 'hsid_dedup_tmux'
export const TMUX_SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-04215'
export const TMUX_RUNTIME_ID = 'runtime_dedup_tmux'
export const TMUX_OPERATION_ID = 'op_dedup_tmux'
export const TMUX_INVOCATION_ID = 'invocation_dedup_tmux' as InvocationId

export function ts(offsetSeconds = 0): IsoTimestamp {
  return new Date(Date.UTC(2026, 4, 27, 12, 0, offsetSeconds)).toISOString() as IsoTimestamp
}

export type SeededFixture = {
  db: FixtureDb
  dbPath: string
  cleanup: () => Promise<void>
}

/**
 * Open a fresh migrated DB in a temp dir and seed the runtime graph the mapper
 * resolves context from. The mapper is expected to look up the broker
 * invocation by `invocationId`, then resolve runtime/session/run from there.
 */
export async function makeSeededFixture(): Promise<SeededFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-broker-mapper-'))
  const dbPath = join(dir, 'test.sqlite')
  const db = openHrcDatabase(dbPath)
  const now = ts()

  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })

  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'starting',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: OPERATION_ID,
    createdAt: now,
    updatedAt: now,
  })

  db.runs.insert({
    runId: RUN_ID,
    hostSessionId: HOST_SESSION_ID,
    runtimeId: RUNTIME_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'headless',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
    operationId: OPERATION_ID,
    invocationId: INVOCATION_ID,
  })

  // broker_invocations carries no FK, but is the canonical invocationId ->
  // runtime/run linkage the mapper resolves projection context from.
  db.brokerInvocations.insert({
    invocationId: INVOCATION_ID,
    operationId: OPERATION_ID,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    brokerProtocol: 'harness-broker/0.1',
    brokerDriver: 'codex-app-server',
    invocationState: 'starting',
    capabilitiesJson: JSON.stringify({ turns: 'single' }),
    specHash: 'sha256:spec-w3a',
    startRequestHash: 'sha256:req-w3a',
    selectedProfileHash: 'sha256:prof-w3a',
    createdAt: now,
    updatedAt: now,
  })

  return {
    db,
    dbPath,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Tmux-interactive fixture for T-04215 dedup RED tests.
 *
 * Unlike `makeSeededFixture`, the broker invocation carries NO runId — this
 * mirrors the real broker-tmux shape observed in state.sqlite (hrc_seq 376316/
 * 376317: runtime rt-64673c6d, generation 1, run_id NULL). With no runId on
 * the invocation and no input.accepted in broker_invocation_events,
 * `resolveRunIdForEvent` returns undefined, so ctx.runId is undefined
 * throughout the turn.
 *
 * When `priorPromptContent` is supplied, a synthetic turn.user_prompt is seeded
 * into hrc_events (simulating what broker-interactive-handlers.ts emits at
 * injection-time before the broker TUI echoes the prompt back as user.message).
 */
export async function makeTmuxSeededFixture(priorPromptContent?: string): Promise<SeededFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-broker-dedup-'))
  const dbPath = join(dir, 'test.sqlite')
  const db = openHrcDatabase(dbPath)
  const now = ts()

  db.sessions.insert({
    hostSessionId: TMUX_HOST_SESSION_ID,
    scopeRef: TMUX_SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })

  db.runtimes.insert({
    runtimeId: TMUX_RUNTIME_ID,
    hostSessionId: TMUX_HOST_SESSION_ID,
    scopeRef: TMUX_SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'busy',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: TMUX_OPERATION_ID,
    createdAt: now,
    updatedAt: now,
  })

  // Real broker-tmux shape: invocation has NO runId.
  // No db.runs.insert either — interactive TUI turns don't go through the
  // dispatched-input path that binds a runId at invocation time.
  db.brokerInvocations.insert({
    invocationId: TMUX_INVOCATION_ID,
    operationId: TMUX_OPERATION_ID,
    runtimeId: TMUX_RUNTIME_ID,
    // runId intentionally absent — mirrors hrc_seq 376316/376317 evidence
    brokerProtocol: 'harness-broker/0.1',
    brokerDriver: 'claude-code-tmux',
    invocationState: 'turn_active',
    capabilitiesJson: JSON.stringify({ turns: 'multi' }),
    specHash: 'sha256:spec-dedup',
    startRequestHash: 'sha256:req-dedup',
    selectedProfileHash: 'sha256:prof-dedup',
    createdAt: now,
    updatedAt: now,
  })

  if (priorPromptContent !== undefined) {
    // Simulate the synthetic turn.user_prompt that broker-interactive-handlers.ts
    // emits at injection time (~line 617), before the TUI echoes it back.
    db.hrcEvents.append({
      ts: ts(1),
      hostSessionId: TMUX_HOST_SESSION_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: GENERATION,
      runtimeId: TMUX_RUNTIME_ID,
      category: 'turn',
      eventKind: 'turn.user_prompt',
      transport: 'tmux',
      payload: { type: 'message_end', message: { role: 'user', content: priorPromptContent } },
    })
  }

  return {
    db,
    dbPath,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

// ── Envelope builder ───────────────────────────────────────────────────────
export type EnvelopeOverrides = {
  invocationId?: InvocationId
  turnId?: TurnId
  inputId?: InputId
  itemId?: string
  time?: IsoTimestamp
  harnessGeneration?: number
  turnAttempt?: number
}

export function envelope(
  type: InvocationEventType,
  seq: number,
  payload: unknown,
  overrides: EnvelopeOverrides = {}
): InvocationEventEnvelope {
  return {
    invocationId: overrides.invocationId ?? INVOCATION_ID,
    seq,
    time: overrides.time ?? ts(seq),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
    ...(overrides.turnId !== undefined ? { turnId: overrides.turnId } : {}),
    ...(overrides.inputId !== undefined ? { inputId: overrides.inputId } : {}),
    ...(overrides.itemId !== undefined ? { itemId: overrides.itemId } : {}),
    ...(overrides.harnessGeneration !== undefined
      ? { harnessGeneration: overrides.harnessGeneration }
      : {}),
    ...(overrides.turnAttempt !== undefined ? { turnAttempt: overrides.turnAttempt } : {}),
  }
}

// Branded-id helpers so test payloads stay readable.
export const turnId = (s: string): TurnId => s as TurnId
export const inputId = (s: string): InputId => s as InputId
export const messageId = (s: string): MessageId => s as MessageId
export const toolCallId = (s: string): ToolCallId => s as ToolCallId
export const permissionRequestId = (s: string): PermissionRequestId => s as PermissionRequestId

export const ASSISTANT_TEXT = 'Hello from the broker driver.'
export const CONTINUATION_KEY = 'thread_abc123'
export const TOOL_CALL_ID = 'tool_call_w3a_1'
export const TOOL_NAME = 'shell'

// ── Queued-input attribution fixture identifiers (T-04239) ──────────────────
// Two-run scenario: run A is running (activeRunId on runtime), run B is the
// queued input that arrived mid-turn. The bug: findPriorInputAccepted returns
// input_B (seq=3) for events at seq≥4, misattributing them to run B instead of
// the still-open run A.
export const Q_HOST_SESSION_ID = 'hsid_queued_attr'
export const Q_SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-04239'
export const Q_OPERATION_ID = 'op_queued_attr'
export const Q_RUNTIME_ID = 'rt_queued_attr'
export const Q_INVOCATION_ID = 'inv_queued_attr' as InvocationId
export const Q_RUN_A_ID = 'run_queued_A'
export const Q_RUN_B_ID = 'run_queued_B'
export const Q_INPUT_A_ID = 'input_queued_A' as InputId
export const Q_INPUT_B_ID = 'input_queued_B' as InputId

/**
 * The canonical ordered headless codex-app-server lifecycle used by the
 * projection-mapping and replay tests:
 *   started -> ready -> input.accepted -> turn.started -> assistant.message
 *   -> tool.call -> turn.completed -> continuation.updated -> exited
 */
export function headlessSequence(): InvocationEventEnvelope[] {
  const tid = turnId('turn_w3a_1')
  const iid = inputId('input_w3a_1')
  return [
    envelope('invocation.started', 1, {
      pid: 4242,
      command: 'codex',
      args: ['app-server'],
      cwd: '/tmp/project',
    }),
    envelope('invocation.ready', 2, { state: 'ready' }),
    envelope('input.accepted', 3, { inputId: iid }, { inputId: iid }),
    envelope('turn.started', 4, { turnId: tid }, { turnId: tid }),
    envelope(
      'assistant.message.completed',
      5,
      {
        messageId: messageId('msg_w3a_1'),
        content: [{ type: 'text', text: ASSISTANT_TEXT }],
        final: true,
      },
      { turnId: tid }
    ),
    envelope(
      'tool.call.completed',
      6,
      {
        toolCallId: toolCallId(TOOL_CALL_ID),
        name: TOOL_NAME,
        result: { stdout: 'ok' },
        isError: false,
        durationMs: 12,
      },
      { turnId: tid }
    ),
    envelope(
      'turn.completed',
      7,
      {
        turnId: tid,
        status: 'completed',
        finalOutput: ASSISTANT_TEXT,
        producedContent: true,
      },
      { turnId: tid }
    ),
    envelope('continuation.updated', 8, {
      provider: 'openai',
      key: CONTINUATION_KEY,
    }),
    envelope('invocation.exited', 9, { exitCode: 0, signal: null }),
  ]
}

/** Concatenated runtime-buffer text persisted for a run (assistant projection). */
export function bufferTextForRun(db: FixtureDb, runId: string): string {
  return db.runtimeBuffers
    .listByRunId(runId)
    .map((chunk) => chunk.text)
    .join('')
}

/** Does any emitted HRC event payload reference the given substring? */
export function emittedEventsMentioning(
  events: Array<{ eventKind: string; eventJson: unknown }>,
  needle: string
): Array<{ eventKind: string; eventJson: unknown }> {
  return events.filter((event) => JSON.stringify(event.eventJson ?? null).includes(needle))
}

/**
 * Queued-input fixture for T-04239 RED tests.
 *
 * Models the runtime state AFTER dispatching run A (active, TUI busy) and
 * BEFORE the queued run B's turn.started fires. Key characteristics:
 *  - claude-code-tmux transport (supportsInflightInput=true, input.queue=true)
 *  - Runtime is 'busy' with activeRunId=Q_RUN_A_ID
 *  - Run A: dispatchedInputId=Q_INPUT_A_ID, status='accepted' (will become 'running' on turn.started)
 *  - Run B: dispatchedInputId=Q_INPUT_B_ID, status='accepted' (queued)
 *  - Broker invocation: no runId (tmux interactive — input.accepted rows carry the run linkage)
 */
export async function makeQueuedFixture(): Promise<SeededFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-broker-queued-'))
  const dbPath = join(dir, 'test.sqlite')
  const db = openHrcDatabase(dbPath)
  const now = ts()

  db.sessions.insert({
    hostSessionId: Q_HOST_SESSION_ID,
    scopeRef: Q_SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })

  db.runtimes.insert({
    runtimeId: Q_RUNTIME_ID,
    hostSessionId: Q_HOST_SESSION_ID,
    scopeRef: Q_SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'starting',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: Q_OPERATION_ID,
    createdAt: now,
    updatedAt: now,
  })

  // Put runtime in busy state with activeRunId=A (as dispatch would have done)
  db.runtimes.update(Q_RUNTIME_ID, {
    status: 'busy',
    activeRunId: Q_RUN_A_ID,
    runtimeStateJson: { status: 'busy', activeRunId: Q_RUN_A_ID },
    updatedAt: ts(1),
  })

  // Run A: the currently-running input (dispatched before B arrived)
  db.runs.insert({
    runId: Q_RUN_A_ID,
    hostSessionId: Q_HOST_SESSION_ID,
    runtimeId: Q_RUNTIME_ID,
    scopeRef: Q_SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
    operationId: Q_OPERATION_ID,
    dispatchedInputId: Q_INPUT_A_ID,
  })

  // Run B: the queued input (arrived while A was in-flight)
  db.runs.insert({
    runId: Q_RUN_B_ID,
    hostSessionId: Q_HOST_SESSION_ID,
    runtimeId: Q_RUNTIME_ID,
    scopeRef: Q_SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    status: 'accepted',
    acceptedAt: ts(3),
    updatedAt: ts(3),
    operationId: Q_OPERATION_ID,
    dispatchedInputId: Q_INPUT_B_ID,
  })

  // Broker invocation: tmux-interactive shape — no runId on the invocation row.
  // The run linkage flows through input.accepted.inputId → runs.dispatched_input_id.
  db.brokerInvocations.insert({
    invocationId: Q_INVOCATION_ID,
    operationId: Q_OPERATION_ID,
    runtimeId: Q_RUNTIME_ID,
    // runId intentionally absent — tmux-interactive shape
    brokerProtocol: 'harness-broker/0.1',
    brokerDriver: 'claude-code-tmux',
    invocationState: 'turn_active',
    capabilitiesJson: JSON.stringify({ turns: 'multi', 'input.queue': true }),
    specHash: 'sha256:spec-queued',
    startRequestHash: 'sha256:req-queued',
    selectedProfileHash: 'sha256:prof-queued',
    createdAt: now,
    updatedAt: now,
  })

  return {
    db,
    dbPath,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
