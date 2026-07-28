/**
 * Regression for T-07035 — a broker socket-close callback must not let a
 * transient SQLite write failure escape into Bun's event loop and terminate the
 * hrc-server process.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HarnessBrokerController } from '../broker/controller'
import {
  INVOCATION_ID,
  RUNTIME_ID,
  type SeededFixture,
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

describe('T-07035 broker-close SQLITE_BUSY containment', () => {
  it('keeps the event callback alive and logs when crash bookkeeping is locked', () => {
    const errorLogs: Array<{
      message: string
      fields?: Record<string, unknown>
    }> = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      now: () => ts(),
      serverInstanceId: 'hrc-server-broker-close-busy-test',
      logger: {
        error: (message, fields) => errorLogs.push({ message, fields }),
      },
    })
    const originalUpdate = fixture.db.brokerInvocations.update
    const busyError = Object.assign(new Error('database is locked'), {
      name: 'SQLiteError',
      code: 'SQLITE_BUSY',
    })
    fixture.db.brokerInvocations.update = () => {
      throw busyError
    }

    try {
      expect(() =>
        (
          controller as unknown as {
            handleBrokerClose: (runtimeId: string, error: Error) => void
          }
        ).handleBrokerClose(RUNTIME_ID, new Error('broker transport closed'))
      ).not.toThrow()
    } finally {
      fixture.db.brokerInvocations.update = originalUpdate
      controller.shutdown()
    }

    expect(errorLogs).toContainEqual({
      message: 'harness broker crash bookkeeping failed',
      fields: expect.objectContaining({
        runtimeId: RUNTIME_ID,
        error: 'database is locked',
        retryScheduled: true,
      }),
    })
  })

  it('retries the atomic terminal transition after a transient lock clears', async () => {
    const controller = new HarnessBrokerController({
      db: fixture.db,
      now: () => ts(),
      serverInstanceId: 'hrc-server-broker-close-retry-test',
    })
    const originalUpdate = fixture.db.brokerInvocations.update
    let updateAttempts = 0
    fixture.db.brokerInvocations.update = (invocationId, patch) => {
      updateAttempts++
      if (updateAttempts === 1) {
        throw Object.assign(new Error('database is locked'), {
          name: 'SQLiteError',
          code: 'SQLITE_BUSY',
        })
      }
      return originalUpdate.call(fixture.db.brokerInvocations, invocationId, patch)
    }

    try {
      expect(() =>
        (
          controller as unknown as {
            handleBrokerClose: (runtimeId: string, error: Error) => void
          }
        ).handleBrokerClose(RUNTIME_ID, new Error('broker transport closed'))
      ).not.toThrow()

      await new Promise((resolve) => setTimeout(resolve, 1_100))

      expect(updateAttempts).toBe(2)
      expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.invocationState).toBe(
        'failed'
      )
      expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('crashed')
    } finally {
      fixture.db.brokerInvocations.update = originalUpdate
      controller.shutdown()
    }
  })
})
