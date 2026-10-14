import { afterEach, describe, expect, it } from 'bun:test'

import { BrokerEventMapper } from '../broker/event-mapper'

import {
  INVOCATION_ID,
  RUNTIME_ID,
  type SeededFixture,
  envelope,
  makeSeededFixture,
  ts,
  turnId,
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

  it('projects a post-turn reading once, while retaining a reading that arrives during the next turn', async () => {
    fixture = await makeSeededFixture()
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(20) })

    const firstCompleted = envelope(
      'turn.completed',
      1,
      { turnId: turnId('turn_first'), status: 'completed', producedContent: true },
      { turnId: turnId('turn_first') }
    )
    mapper.apply(firstCompleted)

    // Claude's final statusline render follows turn.completed. With no active
    // turn, its own projection must persist and announce the reading.
    const postTurnUsage = envelope('usage.updated', 2, {
      usage: {},
      context: { usedTokens: 51_200, windowTokens: 200_000 },
    })
    const postTurn = mapper.apply(postTurnUsage)
    expect(postTurn.lifecycleEvents.map((event) => event.eventKind)).toEqual([
      'runtime.context.updated',
    ])
    expect(postTurn.lifecycleEvents[0]?.payload).toEqual({
      turnId: 'turn_first',
      usedTokens: 51_200,
      windowTokens: 200_000,
    })
    expect(
      fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.runtimeStateJson?.['contextReading']
    ).toMatchObject({ turnId: 'turn_first', usedTokens: 51_200, windowTokens: 200_000 })

    const postTurnReplay = mapper.apply(postTurnUsage)
    expect(postTurnReplay.idempotent).toBe(true)
    expect(postTurnReplay.lifecycleEvents).toEqual([])

    // A queued prompt can start the next turn before the prior statusline
    // redraw arrives. That reading is in-turn evidence: retain it for the
    // next terminal projection instead of emitting it against turn_first.
    mapper.apply(
      envelope(
        'turn.started',
        3,
        { turnId: turnId('turn_second') },
        { turnId: turnId('turn_second') }
      )
    )
    const inTurnUsage = envelope('usage.updated', 4, {
      usage: {},
      context: { usedTokens: 52_000, windowTokens: 200_000 },
    })
    const inTurn = mapper.apply(inTurnUsage)
    expect(inTurn.lifecycleEvents).toEqual([])
    expect(
      fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.runtimeStateJson?.['contextReading']
    ).toMatchObject({ turnId: 'turn_first', usedTokens: 51_200 })

    const secondCompleted = mapper.apply(
      envelope(
        'turn.completed',
        5,
        { turnId: turnId('turn_second'), status: 'completed', producedContent: true },
        { turnId: turnId('turn_second') }
      )
    )
    expect(secondCompleted.lifecycleEvents.map((event) => event.eventKind)).toEqual([
      'turn.completed',
      'runtime.context.updated',
    ])
    expect(secondCompleted.lifecycleEvents[1]?.payload).toEqual({
      turnId: 'turn_second',
      usedTokens: 52_000,
      windowTokens: 200_000,
    })
    expect(
      fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.runtimeStateJson?.['contextReading']
    ).toMatchObject({ turnId: 'turn_second', usedTokens: 52_000, windowTokens: 200_000 })
    expect(
      fixture.db.hrcEvents
        .listByKind('runtime.context.updated', { runtimeId: RUNTIME_ID })
        .map((event) => event.payload)
    ).toEqual([
      { turnId: 'turn_first', usedTokens: 51_200, windowTokens: 200_000 },
      { turnId: 'turn_second', usedTokens: 52_000, windowTokens: 200_000 },
    ])
  })
})
