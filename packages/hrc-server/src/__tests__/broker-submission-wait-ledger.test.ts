import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { waitForSubmissionTerminal } from '../turn-dispatch-handlers.js'
import {
  Q_INVOCATION_ID,
  Q_RUNTIME_ID,
  Q_RUN_B_ID,
  type SeededFixture,
  makeQueuedFixture,
} from './broker-event-mapper-fixtures.js'

let fixture: SeededFixture

beforeEach(async () => {
  fixture = await makeQueuedFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

function append(seq: number, type: string, payload: Record<string, unknown>) {
  const time = new Date(Date.UTC(2026, 8, 1, 12, 0, seq)).toISOString()
  fixture.db.brokerInvocationEvents.appendEvent({
    invocationId: Q_INVOCATION_ID,
    seq,
    time,
    type,
    runtimeId: Q_RUNTIME_ID,
    runId: Q_RUN_B_ID,
    payload,
    envelopeJson: JSON.stringify({
      invocationId: Q_INVOCATION_ID,
      seq,
      time,
      type,
      payload,
    }),
  })
}

function wait(submissionId: string) {
  return waitForSubmissionTerminal({ db: fixture.db, rawBrokerSubscribers: new Set() } as never, {
    invocationId: Q_INVOCATION_ID,
    runId: Q_RUN_B_ID,
    submissionId,
    signal: new AbortController().signal,
  })
}

describe('broker submission wait follows the disposition ledger', () => {
  it('executed follows the identified turn to terminal on a multi-request manifest', async () => {
    append(20, 'turn.manifest', {
      turnId: 'turn-shared',
      submissionIds: ['sub-other', 'sub-owned'],
      policy: 'guarded',
    })
    append(21, 'submission.executed', { submissionId: 'sub-other', turnId: 'turn-shared' })
    append(22, 'submission.executed', { submissionId: 'sub-owned', turnId: 'turn-shared' })
    append(23, 'turn.completed', { turnId: 'turn-shared', status: 'completed' })

    expect(await wait('sub-owned')).toEqual({
      disposition: { type: 'executed', turnId: 'turn-shared' },
      terminal: { turnId: 'turn-shared', status: 'completed' },
    })
    expect(
      fixture.db.brokerInvocationEvents
        .listByInvocationId(Q_INVOCATION_ID)
        .some((record) => record.type === 'turn.manifest')
    ).toBe(true)
  })

  it('rejected resolves typed without looking for a reply or turn terminal', async () => {
    append(20, 'submission.rejected', { submissionId: 'sub-rejected', reason: 'seat-busy' })
    expect(await wait('sub-rejected')).toEqual({
      disposition: { type: 'rejected', reason: 'seat-busy' },
    })
  })

  it('expired resolves typed without looking for a reply or turn terminal', async () => {
    append(20, 'submission.expired', { submissionId: 'sub-expired' })
    expect(await wait('sub-expired')).toEqual({ disposition: { type: 'expired' } })
  })
})
