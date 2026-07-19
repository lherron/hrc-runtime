import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { TurnId } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import { markRuntimeDead } from '../startup-reconcile/runtime-mutations.js'
import {
  RUNTIME_ID,
  type SeededFixture,
  envelope,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

let fixture: SeededFixture

beforeEach(async () => {
  fixture = await makeSeededFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('T-06578 runtime status causal-time projection', () => {
  it('stamps busy → awaiting_input → busy → ready and daemon death from their causal events', () => {
    const processingTime = ts(100)
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => processingTime })
    const turnId = 'turn-status-changed-at' as TurnId

    mapper.apply(envelope('input.accepted', 3, { inputId: 'input-status-changed-at' }))
    mapper.apply(envelope('turn.started', 4, { turnId }, { turnId }))
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
      status: 'busy',
      statusChangedAt: ts(4),
      updatedAt: processingTime,
    })

    mapper.apply(
      envelope('tool.call.started', 5, {
        toolCallId: 'ask-status-changed-at',
        name: 'request_user_input',
        input: { prompt: 'continue?' },
      })
    )
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
      status: 'awaiting_input',
      statusChangedAt: ts(5),
      updatedAt: processingTime,
    })

    mapper.apply(
      envelope('tool.call.completed', 6, {
        toolCallId: 'ask-status-changed-at',
        name: 'request_user_input',
        result: { answer: 'yes' },
        isError: false,
        durationMs: 1,
      })
    )
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
      status: 'busy',
      statusChangedAt: ts(6),
      updatedAt: processingTime,
    })

    mapper.apply(envelope('turn.completed', 7, { turnId, status: 'completed' }, { turnId }))
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
      status: 'ready',
      statusChangedAt: ts(7),
      updatedAt: processingTime,
    })

    const session = fixture.db.sessions.getByHostSessionId(
      fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!.hostSessionId
    )!
    markRuntimeDead(
      fixture.db,
      session,
      fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!,
      'runtime',
      { reason: 'daemon_exit' }
    )
    const deathEvent = fixture.db.events
      .listFromSeq(1, { runtimeId: RUNTIME_ID })
      .find((event) => event.eventKind === 'runtime.dead')!
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
      status: 'dead',
      statusChangedAt: deathEvent.ts,
    })
    expect(deathEvent.ts).toBeDefined()
  })
})
