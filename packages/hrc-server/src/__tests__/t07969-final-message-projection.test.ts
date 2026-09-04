/**
 * T-07969 — the canonical turn response is the turn's FINAL assistant message.
 *
 * Since the T-07873 Claude authority cutover a turn emits every assistant
 * message it produced: the mid-turn narration flagged `final:false` and exactly
 * one `final:true` per run. HRC dropped the flag at the mapper and joined every
 * `turn.message` row, so the auto-reply and the dispatcher response both opened
 * with "I'll start by reading the task spec in full." and truncated long turns
 * before the answer. Lance ruled 2026-09-04 that agent notices are not part of
 * a reply.
 *
 * The fixture below replays the shape of the incident directly: EN-03734, run
 * `run-ef4d2a6b-7242-487c-a7a2-86443fe33e9a`, 20 `final:false` narration
 * segments then one `final:true` answer, then `turn.completed`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { TurnId } from 'spaces-harness-broker-protocol'

import { projectSemanticTurnResponse } from '../event-notification-handlers.js'
import { TURN_TEXT_LIMIT, appendHrcEvent } from '../hrc-event-helper.js'
import { RUN_ID as MAPPER_RUN_ID, envelope, messageId } from './broker-event-mapper-fixtures'
import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

const harness = createBrokerEventMapperTestFixture()

const RUN_ID = 'run-ef4d2a6b-7242-487c-a7a2-86443fe33e9a'
const HOST_SESSION_ID = 'hsid-t07969'
const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-07964'
const RUNTIME_ID = 'rt-68065278-6ee7-444c-82fa-6d8177adf089'

/** The seq-728 text: the one message the reply is allowed to be. */
const ANSWER =
  '**Landed and pushed to `origin/main`** — `77db9216` (the diagnostics) + `6523eba5` (a gate fix).'

let tmpDir: string
let db: HrcDatabase

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-t07969-'))
  db = openHrcDatabase(join(tmpDir, 'state.sqlite'))
  seedRun(RUN_ID)
})

/** runtime_buffers FK-references both runtimes and runs, so both must exist. */
function seedRun(runId: string): void {
  const now = new Date().toISOString()
  if (db.sessions.getByHostSessionId(HOST_SESSION_ID) == null) {
    db.sessions.insert({
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
  }
  if (db.runtimes.getByRuntimeId(RUNTIME_ID) == null) {
    db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })
  }
  db.runs.insert({
    runId,
    hostSessionId: HOST_SESSION_ID,
    runtimeId: RUNTIME_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    status: 'completed',
    acceptedAt: now,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  })
}

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

/** Append one `turn.message` row in the shape the mapper writes. */
function appendMessage(content: string, final?: boolean): void {
  appendHrcEvent(db, 'turn.message', {
    ts: new Date().toISOString(),
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    runId: RUN_ID,
    runtimeId: RUNTIME_ID,
    payload: {
      type: 'message_end',
      message: { role: 'assistant', content },
      ...(final === undefined ? {} : { final }),
    },
  })
}

function appendBuffer(text: string, chunkSeq: number): void {
  db.runtimeBuffers.append({
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    chunkSeq,
    text,
    createdAt: new Date().toISOString(),
  })
}

/** The 22 narration lines EN-03734 actually opened with, abbreviated. */
const NARRATION = [
  "I'll start by reading the task spec in full.",
  'Now let me explore the kicker code and set up a worktree.',
  'Setting up the worktree and announcing on the T-07963 room in parallel:',
  'Now implementing. Starting with the read-only repository queries:',
  'Now writing the diagnostic repository reads:',
  'Now the diagnostics module:',
  'Now wiring the log lines into `attempt-lifecycle.ts`:',
  'Now the unowned-turn and boot-reconcile diagnostics:',
  'Now the enriched `drive_in_flight` heartbeat:',
  'Now the CLI command:',
  'Now exporting the renderer and writing the tests:',
  'Now the CLI test for `hrc mail inspect`:',
  'Now documenting the new surface:',
  'Lint clean. Re-running the full verify chain:',
  'The only verify failure is a pre-existing worktree-location test:',
  'The pre-push hook blocks on that test. Let me look:',
  'Pushed. Verifying origin and then installing:',
  'Now the criterion-by-criterion evidence comment:',
  'Making the ask concrete:',
  'Staged and waiting on the final verify pass. Status while that runs:',
]

describe('T-07969 canonical turn response', () => {
  it('replays the EN-03734 shape and projects the seq-728 answer alone', () => {
    for (const line of NARRATION) appendMessage(line, false)
    appendMessage(ANSWER, true)

    const { body, truncated } = projectSemanticTurnResponse(db, RUN_ID)

    expect(body).toBe(ANSWER)
    expect(truncated).toBe(false)
    // The regression was not "the answer is missing" — it was that the answer
    // arrived behind the narration. Assert the narration is GONE, not just that
    // the answer is present.
    for (const line of NARRATION) expect(body).not.toContain(line)
  })

  it('prefers the flagged final message over the raw runtime buffer', () => {
    // The incident ran on a TMUX seat, and the buffer branch is what actually
    // fired: `appendCompletedMessageBuffer` runs for every transport, and the
    // buffer used to be consulted FIRST. Both sources are present here, exactly
    // as they were for run-ef4d2a6b, and the flagged message must win.
    for (const line of NARRATION) appendMessage(line, false)
    appendMessage(ANSWER, true)
    let chunk = 0
    for (const line of NARRATION) {
      chunk += 1
      appendBuffer(line, chunk)
      chunk += 1
      appendBuffer('\n\n', chunk)
    }
    appendBuffer(ANSWER, chunk + 1)

    expect(db.runtimeBuffers.listByRunId(RUN_ID).length).toBeGreaterThan(0)
    expect(projectSemanticTurnResponse(db, RUN_ID).body).toBe(ANSWER)
  })

  it('leaves the raw runtime buffer intact for the capture surface', () => {
    // `hrc capture` serves sdk/headless runtimes from these rows — it is the
    // analogue of a tmux pane capture, and narrowing the REPLY must not narrow
    // it. The projection reads around the buffer; it never rewrites it.
    appendMessage('narration', false)
    appendMessage(ANSWER, true)
    appendBuffer('narration', 1)
    appendBuffer('\n\n', 2)
    appendBuffer(ANSWER, 3)

    const raw = db.runtimeBuffers
      .listByRunId(RUN_ID)
      .map((row) => row.text)
      .join('')
    expect(raw).toBe(`narration\n\n${ANSWER}`)
    expect(projectSemanticTurnResponse(db, RUN_ID).body).toBe(ANSWER)
  })

  it('leaves a single-message turn unchanged', () => {
    appendMessage(ANSWER, true)
    expect(projectSemanticTurnResponse(db, RUN_ID).body).toBe(ANSWER)
  })

  it('leaves a single UNFLAGGED message turn unchanged', () => {
    // Transports predating the flag must keep working untouched.
    appendMessage(ANSWER)
    expect(projectSemanticTurnResponse(db, RUN_ID).body).toBe(ANSWER)
  })

  it('falls back to the last non-empty segment when the final message is empty', () => {
    appendMessage('narration', false)
    appendMessage(ANSWER, false)
    appendMessage('', true)
    expect(projectSemanticTurnResponse(db, RUN_ID).body).toBe(ANSWER)
  })

  it('falls back to the last non-empty segment when nothing is flagged', () => {
    appendMessage('narration')
    appendMessage(ANSWER)
    expect(projectSemanticTurnResponse(db, RUN_ID).body).toBe(ANSWER)
  })

  it('handles a run with only final:false segments and no final:true', () => {
    // An expected TRANSIENT, not a hole: a turn still in flight has emitted its
    // narration and not yet its answer (run-2f01b463 on inv-4f0ed029 was in
    // exactly this state, status='running', while this task was being built).
    // "Exactly one final per run" is a terminal-state invariant, so the
    // projection must never assume it holds at the moment of observation.
    appendMessage('narrating one', false)
    appendMessage('narrating two', false)
    expect(projectSemanticTurnResponse(db, RUN_ID).body).toBe('narrating two')
  })

  it('projects only the final message of a codex-app-server headless turn', () => {
    // T-07551 shape: the headless driver emits the same flagged stream, and its
    // body is projected by the same rule — no per-transport special case.
    appendMessage('Reading the manifest.', false)
    appendMessage('Patching the resolver.', false)
    appendMessage(ANSWER, true)
    appendBuffer('Reading the manifest.Patching the resolver.', 1)

    expect(projectSemanticTurnResponse(db, RUN_ID).body).toBe(ANSWER)
  })

  it('prefers a flagged broker message over a later unflagged cumulative row', () => {
    // The legacy hook path appends ONE cumulative `turn.message` joining every
    // segment, and it can land after the broker's rows. Selecting "the last
    // segment" alone would pick that join back up; the flag is what rules.
    appendMessage('narration', false)
    appendMessage(ANSWER, true)
    appendMessage(`narration\n\n${ANSWER}`)

    expect(projectSemanticTurnResponse(db, RUN_ID).body).toBe(ANSWER)
  })

  it('selects the final message per RUN, not per invocation', () => {
    // A durable seat serves many turns under one invocation: inv-4f0ed029 held
    // FOUR `final:true` messages, one per run. The projection is run-scoped, so
    // another run's answer must not leak into this one.
    const other = 'run-fc415e3c-01e3-4631-b39f-e80a5647050e'
    seedRun(other)
    appendMessage(ANSWER, true)
    appendHrcEvent(db, 'turn.message', {
      ts: new Date().toISOString(),
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      runId: other,
      runtimeId: RUNTIME_ID,
      payload: {
        type: 'message_end',
        message: { role: 'assistant', content: 'a different turn answer' },
        final: true,
      },
    })

    expect(projectSemanticTurnResponse(db, RUN_ID).body).toBe(ANSWER)
    expect(projectSemanticTurnResponse(db, other).body).toBe('a different turn answer')
  })

  it('still reports truncation against the turn-text bound', () => {
    const long = 'x'.repeat(TURN_TEXT_LIMIT + 10)
    appendMessage('narration', false)
    appendMessage(long, true)

    const projection = projectSemanticTurnResponse(db, RUN_ID)
    expect(projection.truncated).toBe(true)
    expect(projection.body.length).toBe(TURN_TEXT_LIMIT)
  })

  it('falls back to the raw buffer when the run produced no completed message', () => {
    // A delta-only transport writes the buffer and nothing else; it is still
    // the only body such a run has.
    appendBuffer('streamed only', 1)
    expect(projectSemanticTurnResponse(db, RUN_ID).body).toBe('streamed only')
  })

  it('returns an empty body for a run with neither messages nor buffer', () => {
    expect(projectSemanticTurnResponse(db, RUN_ID)).toEqual({ body: '', truncated: false })
  })
})

describe('T-07969 mapper carries the broker finality flag', () => {
  it('preserves final on each turn.message row of a false,false,true turn', () => {
    const mapper = harness.makeMapper()
    const mapperDb = harness.fixture.db
    const tid = 'turn_t07969_flags' as TurnId

    mapper.apply(envelope('input.accepted', 3, { inputId: 'input_t07969' }))
    mapper.apply(envelope('turn.started', 4, { turnId: tid }, { turnId: tid }))
    const segments: Array<[string, boolean]> = [
      ['narrating one', false],
      ['narrating two', false],
      ['the answer', true],
    ]
    segments.forEach(([text, final], index) => {
      mapper.apply(
        envelope(
          'assistant.message.completed',
          5 + index,
          { messageId: messageId(`msg_t07969_${index}`), content: [{ type: 'text', text }], final },
          { turnId: tid }
        )
      )
    })

    const rows = mapperDb.hrcEvents.listByRun(MAPPER_RUN_ID, { eventKind: 'turn.message' })
    expect(rows).toHaveLength(3)
    expect(
      rows.map((row) => {
        const payload = row.payload as { message: { content: string }; final?: boolean }
        return [payload.message.content, payload.final]
      })
    ).toEqual([
      ['narrating one', false],
      ['narrating two', false],
      ['the answer', true],
    ])

    // And the projection over those very rows is the answer alone.
    expect(projectSemanticTurnResponse(mapperDb, MAPPER_RUN_ID).body).toBe('the answer')
  })

  it('omits final entirely when the broker did not send it', () => {
    const mapper = harness.makeMapper()
    const mapperDb = harness.fixture.db
    const tid = 'turn_t07969_unflagged' as TurnId

    mapper.apply(envelope('input.accepted', 3, { inputId: 'input_t07969_unflagged' }))
    mapper.apply(envelope('turn.started', 4, { turnId: tid }, { turnId: tid }))
    mapper.apply(
      envelope(
        'assistant.message.completed',
        5,
        { messageId: messageId('msg_t07969_unflagged'), content: [{ type: 'text', text: 'only' }] },
        { turnId: tid }
      )
    )

    const rows = mapperDb.hrcEvents.listByRun(MAPPER_RUN_ID, { eventKind: 'turn.message' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).not.toHaveProperty('final')
  })
})
