import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { waitForCompilerPrimingTerminal } from '../broker-headless-handlers.js'
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
  it('holds a cold caller invoke until compiler priming reaches terminal on the event projection', async () => {
    const planHash = 'plan-compiler-priming'
    const profileHash = 'profile-compiler-priming'
    const submissionId = 'input-compiler-priming'
    const turnId = 'turn-compiler-priming'
    fixture.db.compiledRuntimePlans.insert({
      planHash,
      compileId: 'compile-compiler-priming',
      schemaVersion: 'agent-runtime-plan/v1',
      compilerName: 'agent-spaces',
      compilerVersion: 'test',
      planProjectionJson: JSON.stringify({
        executionProfiles: [
          {
            profileHash,
            harnessInvocation: { startRequest: { initialInput: { inputId: submissionId } } },
          },
        ],
      }),
      createdAt: new Date().toISOString(),
    })
    append(20, 'submission.executed', { submissionId, turnId })

    const subscribers = new Set<(notification: { record: { invocationId: string } }) => void>()
    const waitPromise = waitForCompilerPrimingTerminal(
      { db: fixture.db, rawBrokerSubscribers: subscribers } as never,
      {
        runtimeId: Q_RUNTIME_ID,
        activeInvocationId: Q_INVOCATION_ID,
        planHash,
        selectedProfileHash: profileHash,
      } as never,
      new AbortController().signal
    )
    let settled = false
    void waitPromise.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(subscribers.size).toBe(1)

    append(21, 'turn.completed', { turnId, status: 'completed' })
    for (const subscriber of subscribers) {
      subscriber({ record: { invocationId: Q_INVOCATION_ID } })
    }

    await waitPromise
    expect(subscribers.size).toBe(0)
  })

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

  it('lost resolves typed without waiting for a turn terminal', async () => {
    append(20, 'submission.lost', {
      submissionId: 'sub-lost',
      reason: 'turn-correlation-lost',
    })
    expect(await wait('sub-lost')).toEqual({
      disposition: { type: 'lost', reason: 'turn-correlation-lost' },
    })
  })

  it('lost is terminal for compiler priming correlation', async () => {
    const planHash = 'plan-lost-compiler-priming'
    const profileHash = 'profile-lost-compiler-priming'
    const submissionId = 'input-lost-compiler-priming'
    fixture.db.compiledRuntimePlans.insert({
      planHash,
      compileId: 'compile-lost-compiler-priming',
      schemaVersion: 'agent-runtime-plan/v1',
      compilerName: 'agent-spaces',
      compilerVersion: 'test',
      planProjectionJson: JSON.stringify({
        executionProfiles: [
          {
            profileHash,
            harnessInvocation: { startRequest: { initialInput: { inputId: submissionId } } },
          },
        ],
      }),
      createdAt: new Date().toISOString(),
    })
    append(20, 'submission.lost', { submissionId, reason: 'turn-correlation-lost' })

    await expect(
      waitForCompilerPrimingTerminal(
        { db: fixture.db, rawBrokerSubscribers: new Set() } as never,
        {
          runtimeId: Q_RUNTIME_ID,
          activeInvocationId: Q_INVOCATION_ID,
          planHash,
          selectedProfileHash: profileHash,
        } as never,
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
  })
})
