/**
 * Regression for T-06532 — a broker close callback can race server teardown
 * after the backing SQLite store has already closed.
 *
 * Only the broker-close continuation lookup may treat that teardown signal as
 * absence. Ordinary repository access must continue surfacing the closed-store
 * error so live-path defects are not hidden.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HarnessBrokerController } from '../broker/controller'
import { findUserInitiatedContinuationClearReasonForRuntime } from '../broker/controller/persistence'
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
  try {
    await fixture.cleanup()
  } catch {
    // Tests that exercise teardown close the fixture before cleanup.
  }
})

describe('T-06532 broker-close lookup survives DB teardown', () => {
  it('returns gracefully when the store is already closed', () => {
    const controller = new HarnessBrokerController({
      db: fixture.db,
      now: () => ts(),
      serverInstanceId: 'hrc-server-broker-close-db-test',
    })
    fixture.db.close()

    expect(() =>
      (
        controller as unknown as {
          handleBrokerClose: (runtimeId: string, error: Error) => void
        }
      ).handleBrokerClose(RUNTIME_ID, new Error('broker transport closed'))
    ).not.toThrow()
  })

  it('still returns the persisted user-exit reason while the store is open', () => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      activeInvocationId: INVOCATION_ID,
      updatedAt: ts(1),
    })
    fixture.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 1,
      time: ts(1),
      type: 'continuation.cleared',
      runtimeId: RUNTIME_ID,
      payload: { reason: 'prompt_input_exit' },
      envelopeJson: JSON.stringify({
        invocationId: INVOCATION_ID,
        seq: 1,
        time: ts(1),
        type: 'continuation.cleared',
        payload: { reason: 'prompt_input_exit' },
      }),
      projectionStatus: 'projected',
    })

    expect(findUserInitiatedContinuationClearReasonForRuntime(fixture.db, RUNTIME_ID)).toBe(
      'prompt_input_exit'
    )
  })

  it('does not mask closed-store errors on ordinary repository access', () => {
    fixture.db.close()

    expect(() => fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)).toThrow(
      /Cannot use a closed database/i
    )
  })
})
