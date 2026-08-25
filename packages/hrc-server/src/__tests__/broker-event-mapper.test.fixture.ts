import { afterEach, beforeEach } from 'bun:test'

import { BrokerEventMapper } from '../broker/event-mapper'
import type { SeededFixture } from './broker-event-mapper-fixtures'
import { makeSeededFixture, ts } from './broker-event-mapper-fixtures'

export function createBrokerEventMapperTestFixture() {
  let fixture: SeededFixture

  beforeEach(async () => {
    fixture = await makeSeededFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  return {
    get fixture(): SeededFixture {
      return fixture
    },
    makeMapper() {
      return new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
    },
  }
}
