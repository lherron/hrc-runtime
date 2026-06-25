/**
 * RED acceptance tests for T-05087 / T-05078 Phase E.
 *
 * These tests pin the broker session semantics that agent-loop's hrc-mode
 * facade depends on:
 * - test 15: repeated dispatchTurn(hostSessionId) calls reuse one broker
 *   invocation while returning fresh run-fenced cursors per turn.
 * - test 16/23: JSON repair is another dispatchTurn on the same session, not
 *   in-flight input, and the repair run/raw envelopes preserve source-run
 *   correlation.
 * - test 14: after a between-turn reap/stale runtime, dispatchTurn
 *   re-provisions and keeps same-generation continuation available to the
 *   broker start path.
 *
 * Expected RED in the current code: dispatchTurn has no repair-correlation
 * request/response contract, so the repair run has no correlation_json linking
 * it back to the failed-validation/source run.
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-server test broker-multiturn-repair-reap
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-05087'
const PROVIDER = 'openai' as const
const OPERATION_ID = 'op-t05087-multiturn'
const INVOCATION_ID = 'inv-t05087-stable'
const REPROVISIONED_INVOCATION_ID = 'inv-t05087-reprovisioned'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-multiturn-repair-reap-')
  server = await createHrcServer(
    fixture.serverOpts({ headlessCodexBrokerEnabled: true, otelListenerEnabled: false })
  )
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

function headlessBrokerIntent(): object {
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
      provider: PROVIDER,
      interactive: false,
    },
    execution: {
      preferredMode: 'headless',
    },
  }
}

function seedReusableBrokerRuntime(
  hostSessionId: string,
  scopeRef: string,
  generation: number,
  runtimeId = 'rt-t05087-stable',
  invocationId = INVOCATION_ID
): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = new Date().toISOString()
  try {
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: PROVIDER,
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: OPERATION_ID,
      activeInvocationId: invocationId,
      continuation: { provider: PROVIDER, key: 'thread-t05087' },
      createdAt: now,
      updatedAt: now,
    })
    db.brokerInvocations.insert({
      invocationId,
      operationId: OPERATION_ID,
      runtimeId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({ turns: 'multi' }),
      continuationJson: JSON.stringify({ provider: PROVIDER, key: 'thread-t05087' }),
      specHash: 'sha256:t05087-spec',
      startRequestHash: 'sha256:t05087-start',
      selectedProfileHash: 'sha256:t05087-profile',
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

function installBrokerDispatchStub(): { dispatchInputs: Array<Record<string, unknown>> } {
  const state = { dispatchInputs: [] as Array<Record<string, unknown>> }
  ;(server as any).getHarnessBrokerController = () => ({
    dispatchInput: async (request: {
      runtimeId: string
      input: { inputId: string; metadata?: { runId?: string } }
    }) => {
      state.dispatchInputs.push(request as unknown as Record<string, unknown>)
      const runId = request.input.metadata?.runId
      if (!runId) throw new Error('test dispatch input missing runId metadata')

      appendBrokerTurn(request.runtimeId, runId, request.input.inputId)
      markRunCompletedAndRuntimeReady(request.runtimeId, runId)

      return {
        ok: true,
        response: {
          inputId: request.input.inputId,
          accepted: true,
          disposition: 'started',
        },
      }
    },
    waitForAttachedStartReady: async () => Promise.reject(new Error('not applicable')),
  })
  return state
}

function appendBrokerTurn(
  runtimeId: string,
  runId: string,
  inputId: string,
  correlation?: Record<string, unknown>
): InvocationEventEnvelope[] {
  const db = openHrcDatabase(fixture.dbPath)
  const invocationId = db.runtimes.getByRuntimeId(runtimeId)?.activeInvocationId ?? INVOCATION_ID
  const startSeq = db.brokerInvocationEvents.maxBrokerSeq(invocationId)
  const now = new Date().toISOString()
  const envelopes: InvocationEventEnvelope[] = [
    {
      invocationId,
      seq: startSeq + 1,
      time: now,
      type: 'input.accepted',
      inputId: inputId as InvocationEventEnvelope['inputId'],
      payload: { inputId, accepted: true },
      ...(correlation !== undefined ? { correlation } : {}),
    } as InvocationEventEnvelope,
    {
      invocationId,
      seq: startSeq + 2,
      time: now,
      type: 'assistant.message.completed',
      inputId: inputId as InvocationEventEnvelope['inputId'],
      itemId: `item-${runId}`,
      payload: { id: `item-${runId}`, text: `ok:${runId}` },
      ...(correlation !== undefined ? { correlation } : {}),
    } as InvocationEventEnvelope,
    {
      invocationId,
      seq: startSeq + 3,
      time: now,
      type: 'turn.completed',
      inputId: inputId as InvocationEventEnvelope['inputId'],
      payload: { status: 'completed', finalOutput: `ok:${runId}` },
      ...(correlation !== undefined ? { correlation } : {}),
    } as InvocationEventEnvelope,
  ]

  try {
    for (const envelope of envelopes) {
      db.brokerInvocationEvents.appendEvent({
        invocationId,
        seq: envelope.seq,
        time: envelope.time,
        type: envelope.type,
        runId,
        runtimeId,
        payload: envelope.payload,
        envelopeJson: JSON.stringify(envelope),
        projectionStatus: 'projected',
      })
    }
  } finally {
    db.close()
  }
  return envelopes
}

function markRunCompletedAndRuntimeReady(runtimeId: string, runId: string): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = new Date().toISOString()
  try {
    db.runs.markCompleted(runId, { status: 'completed', completedAt: now, updatedAt: now })
    db.runtimes.update(runtimeId, {
      status: 'ready',
      activeRunId: undefined,
      lastActivityAt: now,
      updatedAt: now,
    })
    const runtime = db.runtimes.getByRuntimeId(runtimeId)
    if (runtime?.activeInvocationId) {
      db.brokerInvocations.update(runtime.activeInvocationId, {
        invocationState: 'ready',
        runId,
        updatedAt: now,
      })
    }
  } finally {
    db.close()
  }
}

async function dispatchTurn(
  hostSessionId: string,
  prompt: string,
  extra: Record<string, unknown> = {}
): Promise<any> {
  const res = await fixture.postJson('/v1/turns', {
    hostSessionId,
    prompt,
    runtimeIntent: headlessBrokerIntent(),
    waitForCompletion: false,
    ...extra,
  })
  expect(res.status).toBe(200)
  return await res.json()
}

async function readBrokerEvents(observationBroker: any): Promise<InvocationEventEnvelope[]> {
  const selector = observationBroker.selector
  const params = new URLSearchParams({
    invocationId: selector.invocationId,
    runId: selector.runId,
    runtimeId: selector.runtimeId,
    generation: String(selector.generation),
    afterSeq: String(observationBroker.afterSeq),
    follow: 'false',
  })
  const res = await fixture.fetchSocket(`/v1/broker-events?${params}`)
  expect(res.status).toBe(200)
  const text = await res.text()
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InvocationEventEnvelope)
}

function getRunCorrelation(runId: string): unknown {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const json = db.runs.getCorrelationJson(runId)
    return json ? JSON.parse(json) : null
  } finally {
    db.close()
  }
}

describe('T-05078/15 broker multi-turn dispatch segmentation', () => {
  it('reuses one invocation, returns distinct run-fenced cursors, and prevents N/N+1 bleed', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    seedReusableBrokerRuntime(hostSessionId, SCOPE_REF, generation)
    installBrokerDispatchStub()

    const turn1 = await dispatchTurn(hostSessionId, 'turn one')
    const turn2 = await dispatchTurn(hostSessionId, 'turn two')
    const turn3 = await dispatchTurn(hostSessionId, 'turn three')

    expect(turn1.startIdentity).toEqual({ kind: 'broker', invocationId: INVOCATION_ID })
    expect(turn2.startIdentity).toEqual({ kind: 'broker', invocationId: INVOCATION_ID })
    expect(turn3.startIdentity).toEqual({ kind: 'broker', invocationId: INVOCATION_ID })
    expect(new Set([turn1.runId, turn2.runId, turn3.runId]).size).toBe(3)

    expect(turn1.observation.broker.afterSeq).toBe(0)
    expect(turn2.observation.broker.afterSeq).toBe(3)
    expect(turn3.observation.broker.afterSeq).toBe(6)

    const turn1Events = await readBrokerEvents(turn1.observation.broker)
    const turn2Events = await readBrokerEvents(turn2.observation.broker)
    const turn3Events = await readBrokerEvents(turn3.observation.broker)

    expect(turn1Events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(turn2Events.map((event) => event.seq)).toEqual([4, 5, 6])
    expect(turn3Events.map((event) => event.seq)).toEqual([7, 8, 9])
    expect(turn1Events.every((event) => event.payload && turn1.runId)).toBe(true)

    // Negative guard: a watcher opened for turn N at its run-fenced cursor must
    // not see turn N+1 rows even though they share the same invocationId.
    expect(turn1Events.some((event) => event.seq >= 4)).toBe(false)
    expect(turn2Events.some((event) => event.seq >= 7)).toBe(false)
  }, 15_000)
})

describe('T-05078/16 and /23 JSON repair dispatch correlation', () => {
  it('maps repair to follow-up dispatchTurn with source-run correlation and repair-run raw cursor', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    seedReusableBrokerRuntime(hostSessionId, SCOPE_REF, generation)
    const stub = installBrokerDispatchStub()

    const source = await dispatchTurn(hostSessionId, 'source turn with invalid JSON')
    const repair = await dispatchTurn(hostSessionId, 'repair the JSON response', {
      repair: {
        kind: 'json_validation',
        sourceRunId: source.runId,
        reason: 'schema_validation_failed',
      },
    })

    expect(stub.dispatchInputs).toHaveLength(2)
    expect(repair.startIdentity).toEqual({ kind: 'broker', invocationId: INVOCATION_ID })
    expect(repair.runId).not.toBe(source.runId)
    expect(repair.observation.broker.selector).toMatchObject({
      invocationId: INVOCATION_ID,
      runId: repair.runId,
    })
    expect(repair.observation.broker.afterSeq).toBe(3)

    const repairEvents = await readBrokerEvents(repair.observation.broker)
    expect(repairEvents.map((event) => event.seq)).toEqual([4, 5, 6])

    // RED: Phase E needs a repair-correlation contract on dispatchTurn. The
    // current parser ignores the repair metadata and no run correlation is
    // stamped, so this is null today.
    expect(getRunCorrelation(repair.runId)).toMatchObject({
      kind: 'json_repair',
      sourceRunId: source.runId,
      failedValidationRunId: source.runId,
      repairRunId: repair.runId,
    })

    // Projection/raw-plane guard: the repair raw events themselves must preserve
    // the same source linkage so a run-fenced observer can reconstruct why this
    // follow-up turn exists.
    expect(
      repairEvents.every((event) => (event as any).correlation?.sourceRunId === source.runId)
    ).toBe(true)
  }, 15_000)
})

describe('T-05078/14 between-turn reap and reprovision', () => {
  it('dispatchTurn after a reaped runtime provisions a fresh broker descriptor and preserves same-gen continuation', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    seedReusableBrokerRuntime(hostSessionId, SCOPE_REF, generation, 'rt-t05087-reaped')
    installBrokerDispatchStub()

    const first = await dispatchTurn(hostSessionId, 'before reap')
    expect(first.startIdentity).toEqual({ kind: 'broker', invocationId: INVOCATION_ID })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.update(first.runtimeId, {
        status: 'stale',
        activeRunId: undefined,
        activeInvocationId: undefined,
        runtimeStateJson: { status: 'stale', staleReason: 'test-between-turn-reap' },
        updatedAt: new Date().toISOString(),
      })
      db.sessions.updateContinuation(
        hostSessionId,
        { provider: PROVIDER, key: 'thread-t05087' },
        new Date().toISOString()
      )
    } finally {
      db.close()
    }
    ;(server as any).startHeadlessBrokerRuntime = async (
      session: any,
      _intent: any,
      _prompt: string,
      runId: string
    ) => {
      const db = openHrcDatabase(fixture.dbPath)
      const now = new Date().toISOString()
      const runtimeId = 'rt-t05087-reprovisioned'
      try {
        expect(session.continuation).toMatchObject({ provider: PROVIDER, key: 'thread-t05087' })
        db.runtimes.insert({
          runtimeId,
          hostSessionId,
          scopeRef: SCOPE_REF,
          laneRef: 'default',
          generation,
          transport: 'headless',
          harness: 'codex-cli',
          provider: PROVIDER,
          status: 'ready',
          supportsInflightInput: false,
          adopted: false,
          controllerKind: 'harness-broker',
          activeOperationId: OPERATION_ID,
          activeInvocationId: REPROVISIONED_INVOCATION_ID,
          continuation: { provider: PROVIDER, key: 'thread-t05087' },
          createdAt: now,
          updatedAt: now,
        })
        db.runs.insert({
          runId,
          hostSessionId,
          runtimeId,
          scopeRef: SCOPE_REF,
          laneRef: 'default',
          generation,
          transport: 'headless',
          status: 'accepted',
          acceptedAt: now,
          updatedAt: now,
          operationId: OPERATION_ID,
          invocationId: REPROVISIONED_INVOCATION_ID,
        })
        db.brokerInvocations.insert({
          invocationId: REPROVISIONED_INVOCATION_ID,
          operationId: OPERATION_ID,
          runtimeId,
          runId,
          brokerProtocol: 'harness-broker/0.2',
          brokerDriver: 'codex-app-server',
          invocationState: 'ready',
          capabilitiesJson: JSON.stringify({ turns: 'multi' }),
          continuationJson: JSON.stringify({ provider: PROVIDER, key: 'thread-t05087' }),
          specHash: 'sha256:t05087-reprovisioned-spec',
          startRequestHash: 'sha256:t05087-reprovisioned-start',
          selectedProfileHash: 'sha256:t05087-reprovisioned-profile',
          createdAt: now,
          updatedAt: now,
        })
        appendBrokerTurn(runtimeId, runId, `input-${runId}`)
        markRunCompletedAndRuntimeReady(runtimeId, runId)
        return db.runtimes.getByRuntimeId(runtimeId)
      } finally {
        db.close()
      }
    }

    const afterReap = await dispatchTurn(hostSessionId, 'after reap')

    expect(afterReap.runtimeId).toBe('rt-t05087-reprovisioned')
    expect(afterReap.runtimeId).not.toBe(first.runtimeId)
    expect(afterReap.generation).toBe(generation)
    expect(afterReap.startIdentity).toEqual({
      kind: 'broker',
      invocationId: REPROVISIONED_INVOCATION_ID,
    })
    expect(afterReap.observation.broker.selector).toMatchObject({
      invocationId: REPROVISIONED_INVOCATION_ID,
      runId: afterReap.runId,
      runtimeId: afterReap.runtimeId,
      generation,
    })
    expect(await readBrokerEvents(afterReap.observation.broker)).toHaveLength(3)
  }, 15_000)
})
