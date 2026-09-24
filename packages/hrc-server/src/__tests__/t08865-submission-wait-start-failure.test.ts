/**
 * T-08865 — a waiting submission door (`steer`/`enqueue`/`preempt` with
 * `wait: true`) must settle when its run fails before the broker ever records a
 * submission disposition. A broker whose start fails (max3, 2026-09-24:
 * `OAuth mode requires dispatchEnv.HARNESS_PI_AUTH_STORE`) writes no
 * `submission.*` rows at all; HRC marks the run failed and appends
 * `turn.failed` (see settleFailedHeadlessBrokerStart). The waiter hung forever.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { DispatchTurnResponse, HrcLifecycleEvent } from 'hrc-core'

import { waitForPublicDispatchStage } from '../turn-dispatch-handlers.js'
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

const START_FAILURE = 'OAuth mode requires dispatchEnv.HARNESS_PI_AUTH_STORE'

function acceptedBase(): DispatchTurnResponse {
  return {
    runId: Q_RUN_B_ID,
    hostSessionId: Q_HOST_SESSION_ID,
    generation: GENERATION,
    runtimeId: Q_RUNTIME_ID,
    transport: 'headless',
    status: 'accepted',
    supportsInFlightInput: false,
    stage: 'accepted',
    replayed: false,
    submissionId: 'input-start-failed',
    admission: 'admitted',
    observation: {
      lifecycle: {
        selector: { runId: Q_RUN_B_ID, runtimeId: Q_RUNTIME_ID, generation: GENERATION },
        fromSeq: 1,
      },
      broker: {
        selector: {
          invocationId: Q_INVOCATION_ID,
          runId: Q_RUN_B_ID,
          runtimeId: Q_RUNTIME_ID,
          generation: GENERATION,
        },
        afterSeq: 0,
      },
    },
  } as DispatchTurnResponse
}

/** What settleFailedHeadlessBrokerStart writes: the run row, then turn.failed. */
function failRunOnBrokerStart(): HrcLifecycleEvent {
  const failedAt = new Date().toISOString()
  fixture.db.runs.markCompleted(Q_RUN_B_ID, {
    status: 'failed',
    completedAt: failedAt,
    updatedAt: failedAt,
    errorCode: 'runtime_unavailable',
    errorMessage: START_FAILURE,
  })
  return fixture.db.hrcEvents.append({
    ts: failedAt,
    hostSessionId: Q_HOST_SESSION_ID,
    scopeRef: Q_SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    runId: Q_RUN_B_ID,
    runtimeId: Q_RUNTIME_ID,
    category: 'turn',
    eventKind: 'turn.failed',
    transport: 'headless',
    errorCode: 'runtime_unavailable',
    payload: { code: 'broker_start_failed', message: START_FAILURE },
  }) as HrcLifecycleEvent
}

function serverDouble() {
  return {
    db: fixture.db,
    rawBrokerSubscribers: new Set(),
    followSubscribers: new Set<(event: HrcLifecycleEvent) => void>(),
  }
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'hung'> {
  return await Promise.race([
    promise,
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), ms)),
  ])
}

describe('T-08865 waiting submission door on a broker start failure', () => {
  it('settles failed when turn.failed lands after the waiter attached', async () => {
    const server = serverDouble()
    const waiting = waitForPublicDispatchStage(server as never, acceptedBase(), 'terminal', false)
    await Bun.sleep(10)
    const failed = failRunOnBrokerStart()
    for (const subscriber of server.followSubscribers) subscriber(failed)

    const response = await settledWithin(waiting, 1_000)
    expect(response).not.toBe('hung')
    if (response === 'hung') return
    expect(await response.json()).toMatchObject({
      runId: Q_RUN_B_ID,
      submissionId: 'input-start-failed',
      stage: 'terminal',
      status: 'failed',
      outcome: 'failed',
      error: { code: 'runtime_unavailable', message: START_FAILURE },
    })
    expect(server.followSubscribers.size).toBe(0)
  })

  it('settles failed when the run already failed before the waiter attached', async () => {
    failRunOnBrokerStart()
    const server = serverDouble()
    const response = await settledWithin(
      waitForPublicDispatchStage(server as never, acceptedBase(), 'terminal', false),
      1_000
    )
    expect(response).not.toBe('hung')
    if (response === 'hung') return
    expect(await response.json()).toMatchObject({ status: 'failed', outcome: 'failed' })
  })

  it('keeps waiting on an unrelated run failure', async () => {
    const server = serverDouble()
    const waiting = waitForPublicDispatchStage(server as never, acceptedBase(), 'terminal', false)
    await Bun.sleep(10)
    for (const subscriber of server.followSubscribers) {
      subscriber({ ...failRunOnBrokerStart(), runId: 'run-someone-else' })
    }
    // The row for OUR run is failed too here, but only our run's event may wake us.
    expect(await settledWithin(waiting, 100)).toBe('hung')
  })
})
