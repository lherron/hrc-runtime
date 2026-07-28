import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { BrokerEventMapper } from '../broker/event-mapper'
import {
  INVOCATION_ID,
  RUN_ID,
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

describe('T-07040 broker raw-mirror retirement', () => {
  it('projects durable broker rows and lifecycle events without appending to events', () => {
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })

    const result = mapper.apply(
      envelope(
        'turn.completed',
        7,
        { turnId: 'turn_t07040' as never, status: 'completed', producedContent: true },
        { turnId: 'turn_t07040' as never }
      )
    )

    expect(result.events).toEqual([])
    expect(fixture.db.events.listFromSeq(1)).toEqual([])
    expect(result.lifecycleEvents.map((event) => event.eventKind)).toEqual(['turn.completed'])
    expect(fixture.db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.completed' })).toHaveLength(1)

    const brokerRow = fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 7)
    expect(brokerRow?.projectionStatus).toBe('applied')
    expect(brokerRow?.hrcEventSeq).toBeUndefined()
  })
})
