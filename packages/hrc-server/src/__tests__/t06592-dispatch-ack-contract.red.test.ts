import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:T-06592'
const INVOCATION_ID = 'inv-t06592-reuse'
const OPERATION_ID = 'op-t06592-reuse'
const RUNTIME_ID = 'rt-t06592-reuse'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let dispatchCalls: number

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t06592-ack-')
  dispatchCalls = 0
  server = await createHrcServer(
    fixture.serverOpts({ headlessCodexBrokerEnabled: true, otelListenerEnabled: false })
  )
  ;(server as any).getHarnessBrokerController = () => {
    const submit = async () => {
      dispatchCalls += 1
      return {
        ok: true,
        response: {
          submissionId: `sub-${dispatchCalls}`,
          admission: 'admitted',
        },
      }
    }
    return { steer: submit, enqueue: submit, invoke: submit, preempt: submit }
  }
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  await fixture.cleanup()
})

function headlessIntent(): object {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider: 'openai',
      interactive: false,
    },
    execution: { preferredMode: 'headless' },
  }
}

async function seedReusableBroker(): Promise<{ hostSessionId: string; generation: number }> {
  const resolved = await fixture.resolveSession(SCOPE_REF)
  const db = openHrcDatabase(fixture.dbPath)
  const now = new Date().toISOString()
  try {
    db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: OPERATION_ID,
      activeInvocationId: INVOCATION_ID,
      createdAt: now,
      updatedAt: now,
    })
    db.brokerInvocations.insert({
      invocationId: INVOCATION_ID,
      operationId: OPERATION_ID,
      runtimeId: RUNTIME_ID,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({ inputQueue: { mode: 'fifo' } }),
      specHash: 'sha256:t06592-spec',
      startRequestHash: 'sha256:t06592-request',
      selectedProfileHash: 'sha256:t06592-profile',
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
  return resolved
}

function dispatchBody(
  hostSessionId: string,
  idempotencyKey: string,
  waitFor: 'accepted' | 'turn_started' | 'terminal' = 'accepted',
  prompt = 'T06592 stage truth'
): Record<string, unknown> {
  return {
    hostSessionId,
    idempotencyKey,
    prompt,
    runtimeIntent: headlessIntent(),
    waitFor,
    waitForCompletion: waitFor === 'terminal',
  }
}

async function postTurn(body: Record<string, unknown>): Promise<Response> {
  return await fixture.postJson('/v1/turns', body)
}

describe('T-06592 durable dispatch acknowledgment', () => {
  it('returns and replays cold acceptance while invocation start is still delayed', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    let provisions = 0
    const presentationSignals: Array<AbortSignal | undefined> = []
    ;(server as any).startHeadlessBrokerRuntime = async (
      session: { hostSessionId: string; scopeRef: string; laneRef: string; generation: number },
      _intent: unknown,
      _prompt: string,
      runId: string,
      options: {
        dispatchIdempotencyKey?: string
        onAccepted?: (runtime: unknown) => Promise<void> | void
      }
    ) => {
      provisions += 1
      const now = new Date().toISOString()
      const runtimeId = 'rt-t06592-cold'
      const invocationId = 'inv-t06592-cold'
      const db = openHrcDatabase(fixture.dbPath)
      let runtime: unknown
      try {
        runtime = db.runtimes.insert({
          runtimeId,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          transport: 'headless',
          harness: 'codex-cli',
          provider: 'openai',
          status: 'starting',
          supportsInflightInput: false,
          adopted: false,
          controllerKind: 'harness-broker',
          activeOperationId: 'op-t06592-cold',
          activeInvocationId: invocationId,
          activeRunId: runId,
          createdAt: now,
          updatedAt: now,
        })
        db.runs.insert({
          runId,
          hostSessionId: session.hostSessionId,
          runtimeId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          transport: 'headless',
          status: 'accepted',
          acceptedAt: now,
          updatedAt: now,
          operationId: 'op-t06592-cold',
          invocationId,
          dispatchIdempotencyKey: options.dispatchIdempotencyKey,
        })
        db.brokerInvocations.insert({
          invocationId,
          operationId: 'op-t06592-cold',
          runtimeId,
          runId,
          brokerProtocol: 'harness-broker/0.2',
          brokerDriver: 'codex-app-server',
          invocationState: 'starting',
          capabilitiesJson: JSON.stringify({}),
          specHash: 'sha256:t06592-cold-spec',
          startRequestHash: 'sha256:t06592-cold-request',
          selectedProfileHash: 'sha256:t06592-cold-profile',
          createdAt: now,
          updatedAt: now,
        })
      } finally {
        db.close()
      }
      await options.onAccepted?.(runtime)
      await startGate
      return runtime
    }
    ;(server as any).publishPresentation = async (
      _runtime: unknown,
      options?: { signal?: AbortSignal }
    ) => {
      presentationSignals.push(options?.signal)
    }

    const body = dispatchBody(hostSessionId, 'idem-t06592-cold')
    const firstResponse = await postTurn(body)
    const first = (await firstResponse.json()) as any
    const replayResponse = await postTurn(body)
    const replay = (await replayResponse.json()) as any

    expect(firstResponse.status).toBe(202)
    expect(first).toMatchObject({
      stage: 'accepted',
      status: 'accepted',
      replayed: false,
      runtimeId: 'rt-t06592-cold',
      startIdentity: { kind: 'broker', invocationId: 'inv-t06592-cold' },
    })
    expect(replayResponse.status).toBe(202)
    expect(replay).toMatchObject({
      stage: 'accepted',
      replayed: true,
      runId: first.runId,
      runtimeId: first.runtimeId,
    })
    expect(provisions).toBe(1)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runs.listRuns({ hostSessionId })).toHaveLength(1)
      expect(db.hrcEvents.listByRun(first.runId, { eventKind: 'turn.accepted' })).toHaveLength(1)
      expect(db.hrcEvents.listByRun(first.runId, { eventKind: 'turn.started' })).toHaveLength(0)
    } finally {
      db.close()
    }

    await server?.stop()
    server = undefined
    releaseStart()
    await Bun.sleep(10)
    expect(presentationSignals).toHaveLength(1)
    expect(presentationSignals[0]).toBeInstanceOf(AbortSignal)
    expect(presentationSignals[0]?.aborted).toBe(true)
    server = await createHrcServer(
      fixture.serverOpts({ headlessCodexBrokerEnabled: true, otelListenerEnabled: false })
    )
    const afterRestartResponse = await postTurn(body)
    const afterRestart = (await afterRestartResponse.json()) as any
    expect(afterRestart).toMatchObject({
      replayed: true,
      runId: first.runId,
      runtimeId: first.runtimeId,
    })
    expect(['accepted', 'terminal']).toContain(afterRestart.stage)
    expect(provisions).toBe(1)
    expect(generation).toBe(1)
  })

  it('returns accepted without claiming turn_started and replays one dispatch by idempotency key', async () => {
    const { hostSessionId } = await seedReusableBroker()
    const body = dispatchBody(hostSessionId, 'idem-t06592-replay')

    const firstResponse = await postTurn(body)
    const first = (await firstResponse.json()) as any
    const replayResponse = await postTurn(body)
    const replay = (await replayResponse.json()) as any

    expect(firstResponse.status).toBe(202)
    expect(first).toMatchObject({
      stage: 'accepted',
      status: 'accepted',
      replayed: false,
      runtimeId: RUNTIME_ID,
      supportsInFlightInput: false,
      startIdentity: { kind: 'broker', invocationId: INVOCATION_ID },
    })
    expect(first.status).not.toBe('started')
    expect(replayResponse.status).toBe(202)
    expect(replay).toMatchObject({
      stage: 'accepted',
      status: 'accepted',
      replayed: true,
      runId: first.runId,
      runtimeId: first.runtimeId,
      supportsInFlightInput: false,
      startIdentity: first.startIdentity,
    })
    expect(dispatchCalls).toBe(1)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runs.listRuns({ hostSessionId })).toHaveLength(1)
      expect(db.hrcEvents.listByRun(first.runId, { eventKind: 'turn.started' })).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('replays a durable idempotency key even when retry content changes', async () => {
    const { hostSessionId } = await seedReusableBroker()
    const firstResponse = await postTurn(dispatchBody(hostSessionId, 'idem-t06592-key-identity'))
    const first = (await firstResponse.json()) as any

    const replayResponse = await postTurn(
      dispatchBody(
        hostSessionId,
        'idem-t06592-key-identity',
        'accepted',
        'changed content must not redefine the key'
      )
    )
    const replay = (await replayResponse.json()) as any

    expect(replayResponse.status).toBe(firstResponse.status)
    expect(replay).toMatchObject({ runId: first.runId, replayed: true })
    expect(dispatchCalls).toBe(1)
  })

  it('coalesces an in-flight idempotency key even when concurrent request content changes', async () => {
    const { hostSessionId } = await fixture.resolveSession(SCOPE_REF)
    let releaseDispatch!: () => void
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve
    })
    let coalescedDispatchCalls = 0
    ;(server as any).dispatchTurnForSession = async (
      session: { hostSessionId: string; generation: number },
      _intent: unknown,
      _prompt: string,
      options: { runId: string }
    ) => {
      coalescedDispatchCalls += 1
      await dispatchGate
      return Response.json({
        status: 'accepted',
        hostSessionId: session.hostSessionId,
        runId: options.runId,
        generation: session.generation,
        transport: 'headless',
      })
    }

    const key = 'idem-t06592-in-flight-key-identity'
    const firstPending = postTurn(dispatchBody(hostSessionId, key, 'accepted', 'first content'))
    while (coalescedDispatchCalls === 0) await Bun.sleep(1)
    const replayPending = postTurn(
      dispatchBody(hostSessionId, key, 'accepted', 'different concurrent content')
    )
    await Bun.sleep(10)
    releaseDispatch()

    const [firstResponse, replayResponse] = await Promise.all([firstPending, replayPending])
    const first = (await firstResponse.json()) as any
    const replay = (await replayResponse.json()) as any
    expect(firstResponse.status).toBe(202)
    expect(replayResponse.status).toBe(202)
    expect(replay).toMatchObject({ runId: first.runId, replayed: true })
    expect(coalescedDispatchCalls).toBe(1)
  })

  it('persists the idempotency key atomically with run acceptance across restart', async () => {
    const { hostSessionId } = await seedReusableBroker()
    const key = 'idem-t06971-crash-boundary'
    const body = dispatchBody(hostSessionId, key)
    const runs = (server as any).db.runs
    const update = runs.update.bind(runs)
    let postAcceptanceKeyUpdates = 0
    runs.update = (runId: string, patch: Record<string, unknown>) => {
      if ('dispatchIdempotencyKey' in patch) {
        postAcceptanceKeyUpdates += 1
        throw new Error('simulated daemon crash at the legacy post-acceptance key update')
      }
      return update(runId, patch)
    }

    await postTurn(body)

    let acceptedRunId: string
    const beforeRestart = openHrcDatabase(fixture.dbPath)
    try {
      const acceptedRuns = beforeRestart.runs.listRuns({ hostSessionId })
      expect(acceptedRuns).toHaveLength(1)
      const acceptedRun = acceptedRuns[0]
      if (acceptedRun === undefined) throw new Error('expected one accepted dispatch run')
      acceptedRunId = acceptedRun.runId
    } finally {
      beforeRestart.close()
    }

    await server?.stop()
    server = undefined
    server = await createHrcServer(
      fixture.serverOpts({ headlessCodexBrokerEnabled: true, otelListenerEnabled: false })
    )
    ;(server as any).getHarnessBrokerController = () => {
      const submit = async () => ({
        ok: true,
        response: {
          submissionId: 'sub-t06971-retry',
          admission: 'admitted',
        },
      })
      return { steer: submit, enqueue: submit, invoke: submit, preempt: submit }
    }

    const retryResponse = await postTurn(body)
    const retry = (await retryResponse.json()) as any
    expect(retryResponse.status).toBe(202)
    expect(retry).toMatchObject({
      runId: acceptedRunId,
      replayed: true,
    })

    const afterRestart = openHrcDatabase(fixture.dbPath)
    try {
      const durableRuns = afterRestart.runs.listRuns({ hostSessionId })
      expect(durableRuns).toHaveLength(1)
      expect(durableRuns[0]).toMatchObject({
        dispatchIdempotencyKey: key,
      })
    } finally {
      afterRestart.close()
    }
    expect(postAcceptanceKeyUpdates).toBe(0)
  })

  it('replays durable acceptance for a queued run with no runtime yet', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const key = 'idem-t06971-queued-no-runtime'
    const runId = 'run-t06971-queued-no-runtime'
    const now = new Date().toISOString()
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runs.insert({
        runId,
        hostSessionId,
        scopeRef: SCOPE_REF,
        laneRef: 'main',
        generation,
        transport: 'headless',
        status: 'queued',
        acceptedAt: now,
        updatedAt: now,
        dispatchIdempotencyKey: key,
      })
    } finally {
      db.close()
    }

    const response = await postTurn(dispatchBody(hostSessionId, key))
    const replay = (await response.json()) as any

    expect(response.status).toBe(202)
    expect(replay).toMatchObject({
      runId,
      hostSessionId,
      generation,
      transport: 'headless',
      stage: 'accepted',
      status: 'accepted',
      replayed: true,
      supportsInFlightInput: false,
    })
    expect(replay.runtimeId).toBeUndefined()
    expect(replay.startIdentity).toBeUndefined()
  })
})
