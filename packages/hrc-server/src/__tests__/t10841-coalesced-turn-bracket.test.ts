import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import {
  type SeededFixture,
  TMUX_INVOCATION_ID,
  TMUX_RUNTIME_ID,
  makeTmuxSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

// Claude drains two queued task notifications into one native turn. The
// hook-observed broker opens a bracket per UserPromptSubmit but the turn stops
// once, so the first bracket never gets a terminal. Recorded on rt-95f8757d
// (2026-10-13): turn _2 at seq 71 and turn _3 at seq 74, only _3 completed.
// Every later terminal treated the orphaned _2 as a newer open turn and left
// the runtime busy on a completed run.

const ORPHANED = 'turn-t10841-orphaned'
const COALESCED = 'turn-t10841-coalesced'

function event(
  type: InvocationEventType,
  seq: number,
  turnId: string,
  payload: Record<string, unknown> = {}
): InvocationEventEnvelope {
  return {
    invocationId: TMUX_INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    turnId: turnId as never,
    payload: { turnId, ...payload } as InvocationEventEnvelope['payload'],
  }
}

let fixture: SeededFixture
let mapper: BrokerEventMapper

beforeEach(async () => {
  fixture = await makeTmuxSeededFixture()
  fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
    activeInvocationId: TMUX_INVOCATION_ID,
    status: 'ready',
    runtimeStateJson: { status: 'ready' },
    updatedAt: ts(),
  })
  mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('T-10841 coalesced hook-observed turn brackets', () => {
  it('an older orphaned bracket does not hold the runtime busy', () => {
    mapper.apply(event('turn.started', 1, ORPHANED, { source: 'hook-observed' }))
    mapper.apply(event('turn.started', 2, COALESCED, { source: 'hook-observed' }))
    mapper.apply(event('turn.completed', 3, COALESCED, { status: 'completed' }))

    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)).toMatchObject({
      status: 'ready',
      activeRunId: undefined,
    })
    expect(
      fixture.db.brokerInvocations.getByInvocationId(TMUX_INVOCATION_ID)?.invocationState
    ).toBe('ready')
  })

  it('a bracket opened after the terminating turn still holds the runtime busy', () => {
    mapper.apply(event('turn.started', 1, ORPHANED, { source: 'hook-observed' }))
    mapper.apply(event('turn.started', 2, COALESCED, { source: 'hook-observed' }))
    mapper.apply(event('turn.completed', 3, ORPHANED, { status: 'completed' }))

    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)?.status).toBe('busy')
  })
})
