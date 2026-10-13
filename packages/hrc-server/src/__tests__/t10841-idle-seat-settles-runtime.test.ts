/**
 * T-10841 — a current live-seat `idle` observation settles a runtime the event
 * projection left busy on a run that already completed.
 *
 * Recorded on rt-95f8757d (2026-10-13): an unclosed coalesced turn bracket made
 * every later turn terminal skip clearing the runtime, so it read busy on a
 * completed run while the broker seat sat idle. The idle seat is the repair
 * signal: a completed active run cannot be an in-flight dispatch.
 *
 * Failure modes this file pins:
 *  F1 idle seat + busy runtime on a completed run → stays busy (the defect).
 *  F2 an idle observation that raced a fresh dispatch (active run not yet
 *     completed) clears the dispatch's ownership.
 *  F3 a busy seat settles the runtime because the run row says completed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { SeatProbeRequest, SeatProbeResponse } from 'spaces-harness-broker-protocol'

import { HarnessBrokerController } from '../broker/controller'
import {
  FakeBrokerClient,
  NOW,
  type TestFixture,
  makeFixture,
  makeStartInput,
  tick,
} from './fixtures/broker-controller.fixture'

const RUNTIME = 'runtime_w2'
const INVOCATION = 'invocation_w2'
const RUN = 'run_t10841_last'

let fixture: TestFixture
let controller: HarnessBrokerController | undefined

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  controller?.shutdown()
  await fixture.cleanup()
})

async function startBusySeat(runCompleted: boolean): Promise<{
  setSeat: (seat: SeatProbeResponse['seat']) => void
}> {
  const fake = new FakeBrokerClient()
  let seat: SeatProbeResponse['seat'] = { state: 'idle' }
  fake.seatProbe = async (request: SeatProbeRequest) => ({
    invocationId: request.invocationId,
    seat,
    brokerHeldDepth: 0,
  })
  controller = new HarnessBrokerController({
    db: fixture.db,
    brokerClientFactory: async () => fake,
    brokerSeatProbeIntervalMs: 0,
    now: () => NOW,
  })
  await controller.start({ ...makeStartInput(), brokerClient: fake })
  await tick()
  const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME)!
  fixture.db.runs.insert({
    runId: RUN,
    hostSessionId: runtime.hostSessionId,
    runtimeId: RUNTIME,
    scopeRef: runtime.scopeRef,
    laneRef: runtime.laneRef,
    generation: runtime.generation,
    transport: runtime.transport,
    status: runCompleted ? 'completed' : 'accepted',
    acceptedAt: NOW,
    ...(runCompleted ? { completedAt: NOW } : {}),
    updatedAt: NOW,
    invocationId: INVOCATION,
  })
  fixture.db.runtimes.update(RUNTIME, {
    status: 'busy',
    activeRunId: RUN,
    activeInvocationId: INVOCATION,
    updatedAt: NOW,
  })
  fixture.db.brokerInvocations.update(INVOCATION, {
    invocationState: 'turn_active',
    updatedAt: NOW,
  })
  return {
    setSeat: (next) => {
      seat = next
    },
  }
}

describe('T-10841 idle live seat settles a busy runtime on a completed run', () => {
  it('F1: idle seat clears the stale owner and projects ready', async () => {
    await startBusySeat(true)
    await controller!.seatProbe(RUNTIME)

    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME)).toMatchObject({
      status: 'ready',
      activeRunId: undefined,
    })
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION)?.invocationState).toBe(
      'ready'
    )
  })

  it('F2: idle seat leaves an in-flight dispatch alone', async () => {
    await startBusySeat(false)
    await controller!.seatProbe(RUNTIME)

    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME)).toMatchObject({
      status: 'busy',
      activeRunId: RUN,
    })
  })

  it('F3: a turn-active seat keeps the runtime busy', async () => {
    const { setSeat } = await startBusySeat(true)
    setSeat({ state: 'turn-active', turnId: 'turn-t10841' as never })
    await controller!.seatProbe(RUNTIME)

    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME)?.status).toBe('busy')
  })
})
