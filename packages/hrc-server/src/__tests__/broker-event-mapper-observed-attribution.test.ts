import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type {
  InvocationEventEnvelope,
  InvocationEventType,
  TurnId,
} from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import {
  LANE_REF,
  type SeededFixture,
  TMUX_HOST_SESSION_ID,
  TMUX_INVOCATION_ID,
  TMUX_OPERATION_ID,
  TMUX_RUNTIME_ID,
  TMUX_SCOPE_REF,
  makeTmuxSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

const RUN_ID = 'run-observed-own'
const INPUT_ID = 'input-observed-own'
const FOREIGN_TURN = 'turn-observed-foreign' as TurnId
const UNKNOWN_TURN = 'turn-observed-unknown' as TurnId
const OWN_TURN = 'turn-observed-own' as TurnId

function observedEnvelope(
  type: InvocationEventType,
  seq: number,
  payload: unknown,
  extra: Partial<Pick<InvocationEventEnvelope, 'turnId' | 'inputId'>> = {}
): InvocationEventEnvelope {
  return {
    invocationId: TMUX_INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
    ...extra,
  }
}

function sequence(): InvocationEventEnvelope[] {
  return [
    observedEnvelope('input.accepted', 1, { inputId: INPUT_ID }, { inputId: INPUT_ID as never }),
    observedEnvelope(
      'turn.started',
      2,
      { turnId: FOREIGN_TURN, source: 'observed' },
      { turnId: FOREIGN_TURN }
    ),
    observedEnvelope(
      'turn.attributed',
      3,
      { turnId: FOREIGN_TURN, ownership: 'foreign', origin: 'human' },
      { turnId: FOREIGN_TURN }
    ),
    observedEnvelope(
      'assistant.message.completed',
      4,
      {
        messageId: 'message-foreign',
        content: [{ type: 'text', text: 'foreign answer' }],
        final: true,
      },
      { turnId: FOREIGN_TURN }
    ),
    observedEnvelope(
      'turn.completed',
      5,
      { turnId: FOREIGN_TURN, status: 'completed', producedContent: true },
      { turnId: FOREIGN_TURN }
    ),
    observedEnvelope(
      'turn.started',
      6,
      { turnId: UNKNOWN_TURN, source: 'observed' },
      { turnId: UNKNOWN_TURN }
    ),
    observedEnvelope(
      'turn.attributed',
      7,
      { turnId: UNKNOWN_TURN, ownership: 'unknown', origin: 'unknown' },
      { turnId: UNKNOWN_TURN }
    ),
    observedEnvelope(
      'turn.interrupted',
      8,
      { turnId: UNKNOWN_TURN, reason: 'interrupted' },
      { turnId: UNKNOWN_TURN }
    ),
    observedEnvelope(
      'turn.started',
      9,
      { turnId: OWN_TURN, source: 'observed' },
      { turnId: OWN_TURN }
    ),
    observedEnvelope(
      'turn.attributed',
      10,
      {
        turnId: OWN_TURN,
        ownership: 'own',
        inputId: INPUT_ID,
        origin: 'broker',
      },
      { turnId: OWN_TURN, inputId: INPUT_ID as never }
    ),
    observedEnvelope(
      'assistant.message.completed',
      11,
      {
        messageId: 'message-own',
        content: [{ type: 'text', text: 'owned answer' }],
        final: true,
      },
      { turnId: OWN_TURN }
    ),
    observedEnvelope(
      'turn.completed',
      12,
      { turnId: OWN_TURN, status: 'completed', producedContent: true },
      { turnId: OWN_TURN }
    ),
  ]
}

let fixture: SeededFixture

beforeEach(async () => {
  fixture = await makeTmuxSeededFixture()
  const now = ts()
  fixture.db.runs.insert({
    runId: RUN_ID,
    hostSessionId: TMUX_HOST_SESSION_ID,
    runtimeId: TMUX_RUNTIME_ID,
    scopeRef: TMUX_SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'tmux',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
    operationId: TMUX_OPERATION_ID,
    invocationId: TMUX_INVOCATION_ID,
    dispatchedInputId: INPUT_ID,
  })
  fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
    activeInvocationId: TMUX_INVOCATION_ID,
    activeRunId: RUN_ID,
    status: 'busy',
    updatedAt: now,
  })
  fixture.db.brokerInvocations.update(TMUX_INVOCATION_ID, {
    brokerDriver: 'codex-app-server',
    capabilitiesJson: JSON.stringify({ bracketMintingMode: 'observed' }),
    updatedAt: now,
  })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('observed Codex turn attribution', () => {
  it('never borrows a pending input for foreign/unknown turns and durably joins the later own turn', () => {
    const mapper = new BrokerEventMapper({
      db: fixture.db,
      now: () => ts(100),
    })
    const events = sequence()
    for (const event of events) mapper.apply(event)

    const rows = fixture.db.brokerInvocationEvents.listByInvocationId(TMUX_INVOCATION_ID)
    const runBySeq = new Map(rows.map((row) => [row.seq, row.runId]))
    expect([...runBySeq.entries()].filter(([seq]) => seq >= 2 && seq <= 9)).toEqual([
      [2, undefined],
      [3, undefined],
      [4, undefined],
      [5, undefined],
      [6, undefined],
      [7, undefined],
      [8, undefined],
      [9, undefined],
    ])
    expect(runBySeq.get(10)).toBe(RUN_ID)
    expect(runBySeq.get(11)).toBe(RUN_ID)
    expect(runBySeq.get(12)).toBe(RUN_ID)
    expect(fixture.db.runs.getByRunId(RUN_ID)).toMatchObject({
      status: 'completed',
      completedAt: ts(12),
    })

    expect(
      fixture.db.sqlite
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM broker_turn_attributions')
        .get()?.count
    ).toBe(0)

    const beforeReplay = rows.map(({ seq, type, runId }) => ({
      seq,
      type,
      runId,
    }))
    const replayMapper = new BrokerEventMapper({
      db: fixture.db,
      now: () => ts(101),
    })
    expect(events.map((event) => replayMapper.apply(event).idempotent)).toEqual(
      events.map(() => true)
    )
    expect(
      fixture.db.brokerInvocationEvents
        .listByInvocationId(TMUX_INVOCATION_ID)
        .map(({ seq, type, runId }) => ({ seq, type, runId }))
    ).toEqual(beforeReplay)
  })
})
