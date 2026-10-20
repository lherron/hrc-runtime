import { afterEach, describe, expect, it } from 'bun:test'

import { BrokerEventMapper } from '../broker/event-mapper'

import {
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

const stored = () =>
  fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.runtimeStateJson?.['contextReading']
const announced = () =>
  fixture.db.hrcEvents
    .listByKind('runtime.context.updated', { runtimeId: RUNTIME_ID })
    .map((event) => event.payload)

describe('T-11448 in-turn context readings', () => {
  it('announces a long turn every 30s from its own samples, starting with the first', async () => {
    fixture = await makeSeededFixture()
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
    const turn = turnId('turn_long')
    const sample = (seq: number, at: number, usedTokens: number, withTurn = true) =>
      mapper.apply(
        envelope(
          'usage.updated',
          seq,
          { usage: {}, context: { usedTokens, windowTokens: 1_000_000 } },
          { time: ts(at), ...(withTurn ? { turnId: turn } : {}) }
        )
      )

    mapper.apply(envelope('turn.started', 1, { turnId: turn }, { turnId: turn }))

    // A fresh runtime has no reading; its first in-turn sample is announced.
    expect(sample(2, 2, 40_000).lifecycleEvents.map((event) => event.eventKind)).toEqual([
      'runtime.context.updated',
    ])
    expect(stored()).toMatchObject({ turnId: 'turn_long', usedTokens: 40_000, observedAt: ts(2) })

    // Inside 30s of the stored reading: durable evidence only.
    expect(sample(3, 12, 45_000).lifecycleEvents).toEqual([])
    expect(sample(4, 31, 48_000).lifecycleEvents).toEqual([])
    expect(stored()).toMatchObject({ usedTokens: 40_000 })

    // 30s after the stored reading, the next sample is announced.
    const due = sample(5, 32, 50_000)
    expect(due.lifecycleEvents[0]?.payload).toEqual({
      turnId: 'turn_long',
      usedTokens: 50_000,
      windowTokens: 1_000_000,
    })
    expect(stored()).toMatchObject({ usedTokens: 50_000, observedAt: ts(32) })

    // A sample that names no turn cannot be attributed; it waits for the terminal.
    expect(sample(6, 70, 60_000, false).lifecycleEvents).toEqual([])

    const completed = mapper.apply(
      envelope(
        'turn.completed',
        7,
        { turnId: turn, status: 'completed', producedContent: true },
        { turnId: turn, time: ts(71) }
      )
    )
    expect(completed.lifecycleEvents.map((event) => event.eventKind)).toEqual([
      'turn.completed',
      'runtime.context.updated',
    ])
    expect(announced()).toEqual([
      { turnId: 'turn_long', usedTokens: 40_000, windowTokens: 1_000_000 },
      { turnId: 'turn_long', usedTokens: 50_000, windowTokens: 1_000_000 },
      { turnId: 'turn_long', usedTokens: 60_000, windowTokens: 1_000_000 },
    ])
  })

  it('sends nothing while idle: a post-turn redraw that repeats the reading is not announced', async () => {
    fixture = await makeSeededFixture()
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
    const turn = turnId('turn_done')
    mapper.apply(
      envelope(
        'turn.completed',
        1,
        { turnId: turn, status: 'completed', producedContent: true },
        { turnId: turn }
      )
    )
    const redraw = (seq: number, at: number, usedTokens: number) =>
      mapper.apply(
        envelope(
          'usage.updated',
          seq,
          { usage: {}, context: { usedTokens, windowTokens: 200_000 } },
          { time: ts(at) }
        )
      )

    // The final statusline render after the turn still lands once.
    expect(redraw(2, 2, 51_200).lifecycleEvents.map((event) => event.eventKind)).toEqual([
      'runtime.context.updated',
    ])
    // Idle redraws of the same reading, however far apart, announce nothing.
    expect(redraw(3, 40, 51_200).lifecycleEvents).toEqual([])
    expect(redraw(4, 400, 51_200).lifecycleEvents).toEqual([])
    expect(stored()).toMatchObject({ usedTokens: 51_200, observedAt: ts(2) })
    expect(announced()).toEqual([
      { turnId: 'turn_done', usedTokens: 51_200, windowTokens: 200_000 },
    ])
  })
})
