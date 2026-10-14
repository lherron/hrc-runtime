import { afterEach, describe, expect, it } from 'bun:test'

import { BrokerEventMapper } from '../broker/event-mapper'

import {
  INVOCATION_ID,
  RUNTIME_ID,
  type SeededFixture,
  envelope,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

let fixture: SeededFixture

afterEach(async () => {
  await fixture?.cleanup()
})

describe('T-10928 terminal context reading projection', () => {
  it('derives one completed-turn context event from durable usage and preserves the reading on replay', async () => {
    fixture = await makeSeededFixture()

    // This row represents usage the prior HRC process already committed. The
    // fresh mapper below deliberately has no in-memory usage state to consult.
    new BrokerEventMapper({ db: fixture.db, now: () => ts(10) }).apply(
      envelope('usage.updated', 1, {
        usage: {},
        context: { usedTokens: 41_443 },
        model: { id: 'gpt-5.6-terra', source: 'provider-response' },
      })
    )
    new BrokerEventMapper({ db: fixture.db, now: () => ts(11) }).apply(
      envelope('usage.updated', 2, {
        usage: {},
        context: { usedTokens: 45_819, windowTokens: 258_400 },
        model: { id: 'gpt-5.6-terra', source: 'provider-response' },
      })
    )

    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(20) })
    const completed = envelope(
      'turn.completed',
      3,
      { turnId: 'turn_context' as never, status: 'completed', producedContent: true },
      { turnId: 'turn_context' as never }
    )

    const first = mapper.apply(completed)
    expect(first.lifecycleEvents.map((event) => event.eventKind)).toEqual([
      'turn.completed',
      'runtime.context.updated',
    ])
    expect(first.lifecycleEvents[1]?.payload).toEqual({
      turnId: 'turn_context',
      usedTokens: 45_819,
      windowTokens: 258_400,
      model: { id: 'gpt-5.6-terra', source: 'provider-response' },
    })

    const reading =
      fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.runtimeStateJson?.['contextReading']
    expect(reading).toEqual({
      turnId: 'turn_context',
      usedTokens: 45_819,
      windowTokens: 258_400,
      model: { id: 'gpt-5.6-terra', source: 'provider-response' },
      observedAt: ts(2),
    })

    const replay = mapper.apply(completed)
    expect(replay.idempotent).toBe(true)
    expect(replay.lifecycleEvents).toEqual([])
    expect(
      fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.runtimeStateJson?.['contextReading']
    ).toEqual(reading)
    expect(fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 2)).not.toBeNull()
  })
})
