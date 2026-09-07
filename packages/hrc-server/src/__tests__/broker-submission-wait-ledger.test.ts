import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { DispatchTurnResponse } from 'hrc-core'

import { waitForCompilerPrimingTerminal } from '../broker-headless-handlers.js'
import { waitForPublicDispatchStage, waitForSubmissionTerminal } from '../turn-dispatch-handlers.js'
import {
  GENERATION,
  LANE_REF,
  Q_HOST_SESSION_ID,
  Q_INVOCATION_ID,
  Q_RUNTIME_ID,
  Q_RUN_B_ID,
  Q_SCOPE_REF,
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
  it('projects a warm invoke that is already terminal before the waiter attaches', async () => {
    const submissionId = 'sub-warm-terminal'
    const turnId = 'turn-warm-terminal'
    const finalMessage = 'Warm seat summary.'
    append(20, 'submission.executed', { submissionId, turnId })
    append(21, 'turn.completed', { turnId, status: 'completed' })
    fixture.db.hrcEvents.append({
      ts: new Date().toISOString(),
      hostSessionId: Q_HOST_SESSION_ID,
      scopeRef: Q_SCOPE_REF,
      laneRef: LANE_REF,
      generation: GENERATION,
      runId: Q_RUN_B_ID,
      runtimeId: Q_RUNTIME_ID,
      category: 'turn',
      eventKind: 'turn.message',
      transport: 'tmux',
      payload: {
        type: 'message_end',
        message: { role: 'assistant', content: finalMessage },
        final: true,
      },
    })

    const response = await waitForPublicDispatchStage(
      { db: fixture.db, rawBrokerSubscribers: new Set() } as never,
      terminalBase({ submissionId, invocationId: Q_INVOCATION_ID }),
      'terminal',
      false
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      disposition: { type: 'executed', turnId },
      terminal: { turnId, status: 'completed', finalMessage },
    })
  })

  it('keeps a legacy already-terminal response without broker identity projection-less', async () => {
    const response = await waitForPublicDispatchStage(
      { db: fixture.db, rawBrokerSubscribers: new Set() } as never,
      terminalBase({}),
      'terminal',
      false
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).not.toHaveProperty('disposition')
    expect(body).not.toHaveProperty('terminal')
  })

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

function terminalBase(input: {
  submissionId?: string
  invocationId?: string
}): DispatchTurnResponse {
  return {
    runId: Q_RUN_B_ID,
    hostSessionId: Q_HOST_SESSION_ID,
    generation: GENERATION,
    runtimeId: Q_RUNTIME_ID,
    transport: 'tmux',
    status: 'completed',
    supportsInFlightInput: true,
    stage: 'terminal',
    outcome: 'completed',
    replayed: false,
    ...(input.submissionId !== undefined
      ? { submissionId: input.submissionId, admission: 'admitted' as const }
      : {}),
    observation: {
      lifecycle: {
        selector: {
          runId: Q_RUN_B_ID,
          runtimeId: Q_RUNTIME_ID,
          generation: GENERATION,
        },
        fromSeq: 1,
      },
      ...(input.invocationId !== undefined
        ? {
            broker: {
              selector: {
                invocationId: input.invocationId,
                runId: Q_RUN_B_ID,
                runtimeId: Q_RUNTIME_ID,
                generation: GENERATION,
              },
              afterSeq: 0,
            },
          }
        : {}),
    },
  }
}
