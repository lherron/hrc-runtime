import { expect, test } from 'bun:test'
import { BrokerEventMapper } from '../broker/event-mapper'
import { INVOCATION_ID, headlessSequence, makeSeededFixture } from './broker-event-mapper-fixtures'

test('compacted committed prefix skips replay without duplicating canonical lifecycle events', async () => {
  const fixture = await makeSeededFixture()
  try {
    const mapper = new BrokerEventMapper({ db: fixture.db })
    const events = headlessSequence()
    for (const event of events) mapper.apply(event)
    const before = fixture.db.sqlite.query('SELECT COUNT(*) n FROM hrc_events').get()
    const cursor = fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq
    expect(cursor).toBe(events.at(-1)?.seq)
    fixture.db.sqlite.exec('DELETE FROM broker_projection_dispositions')
    for (const event of events) expect(mapper.apply(event).idempotent).toBe(true)
    expect(fixture.db.sqlite.query('SELECT COUNT(*) n FROM hrc_events').get()).toEqual(before)
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(
      cursor
    )
  } finally {
    await fixture.cleanup()
  }
})
