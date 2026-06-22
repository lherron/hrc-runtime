/**
 * RED tests for T-05095 (daedalus review fixes for T-05078).
 *
 * These pin two review findings that survived the first T-05078 landing:
 * - when a queue-capable headless broker already has a live active run,
 *   dispatchTurn(..., whenBusy:'reject') must reject at admission with
 *   runtime_busy and create zero run/broker/lifecycle side effects.
 * - /v1/broker-events must return exactly the persisted broker_envelope_json;
 *   read-time DB correlation joins are not wire authority.
 *
 * Run with:
 *   TMPDIR=/tmp bun run --filter hrc-server test t05095-daedalus-review-fixes
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-05095'
const PROVIDER = 'openai' as const

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t05095-review-fixes-')
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

function installDispatchInputSpy(): { calls: Array<Record<string, unknown>> } {
  const state = { calls: [] as Array<Record<string, unknown>> }
  ;(server as any).getHarnessBrokerController = () => ({
    dispatchInput: async (request: Record<string, unknown>) => {
      state.calls.push(request)
      return {
        ok: true,
        response: {
          inputId: `input-t05095-${state.calls.length}`,
          accepted: true,
          disposition: 'queued',
        },
      }
    },
    waitForAttachedStartReady: async () => Promise.reject(new Error('not applicable')),
  })
  return state
}

function seedQueueCapableBrokerWithLiveRun(input: {
  hostSessionId: string
  generation: number
  runtimeId: string
  invocationId: string
  activeRunId: string
}): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = new Date().toISOString()
  const operationId = `op-${input.runtimeId}`

  try {
    db.runtimes.insert({
      runtimeId: input.runtimeId,
      hostSessionId: input.hostSessionId,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: input.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: PROVIDER,
      // The review gap is a "ready" reusable runtime whose activeRunId still
      // points at a live run. Queue capability must not override explicit reject.
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: operationId,
      activeInvocationId: input.invocationId,
      activeRunId: input.activeRunId,
      createdAt: now,
      updatedAt: now,
    })
    db.brokerInvocations.insert({
      invocationId: input.invocationId,
      operationId,
      runtimeId: input.runtimeId,
      runId: input.activeRunId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'turn_active',
      capabilitiesJson: JSON.stringify({ input: { queue: true } }),
      specHash: `sha256:spec-${input.runtimeId}`,
      startRequestHash: `sha256:req-${input.runtimeId}`,
      selectedProfileHash: `sha256:profile-${input.runtimeId}`,
      createdAt: now,
      updatedAt: now,
    })
    db.runs.insert({
      runId: input.activeRunId,
      hostSessionId: input.hostSessionId,
      runtimeId: input.runtimeId,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: input.generation,
      transport: 'headless',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
      operationId,
      invocationId: input.invocationId,
    })
  } finally {
    db.close()
  }
}

function runIdsForRuntime(runtimeId: string): string[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runs.listByRuntimeId(runtimeId).map((run) => run.runId)
  } finally {
    db.close()
  }
}

function turnUserPromptEventsForRuntime(runtimeId: string): unknown[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents
      .listFromHrcSeq(1, { runtimeId })
      .filter((event) => event.eventKind === 'turn.user_prompt')
  } finally {
    db.close()
  }
}

function seedBrokerEventFixture(input: {
  hostSessionId: string
  runtimeId: string
  runId: string
  invocationId: string
  generation: number
  envelope: InvocationEventEnvelope
  runCorrelation?: Record<string, unknown> | undefined
}): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = new Date().toISOString()
  const operationId = `op-${input.runtimeId}`

  try {
    db.runtimes.insert({
      runtimeId: input.runtimeId,
      hostSessionId: input.hostSessionId,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: input.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: PROVIDER,
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: operationId,
      activeInvocationId: input.invocationId,
      createdAt: now,
      updatedAt: now,
    })
    db.runs.insert({
      runId: input.runId,
      hostSessionId: input.hostSessionId,
      runtimeId: input.runtimeId,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: input.generation,
      transport: 'headless',
      status: 'completed',
      acceptedAt: now,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      operationId,
      invocationId: input.invocationId,
    })
    if (input.runCorrelation !== undefined) {
      db.runs.setCorrelationJson(input.runId, JSON.stringify(input.runCorrelation))
    }
    db.brokerInvocations.insert({
      invocationId: input.invocationId,
      operationId,
      runtimeId: input.runtimeId,
      runId: input.runId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'completed',
      capabilitiesJson: JSON.stringify({ input: { queue: true } }),
      specHash: `sha256:spec-${input.runtimeId}`,
      startRequestHash: `sha256:req-${input.runtimeId}`,
      selectedProfileHash: `sha256:profile-${input.runtimeId}`,
      createdAt: now,
      updatedAt: now,
    })
    db.brokerInvocationEvents.appendEvent({
      invocationId: input.invocationId,
      seq: input.envelope.seq,
      time: input.envelope.time,
      type: input.envelope.type,
      runtimeId: input.runtimeId,
      runId: input.runId,
      payload: input.envelope.payload,
      envelopeJson: JSON.stringify(input.envelope),
      projectionStatus: 'projected',
    })
  } finally {
    db.close()
  }
}

function brokerEventsPath(input: {
  invocationId: string
  runId: string
  runtimeId: string
  generation: number
  afterSeq?: number
}): string {
  const params = new URLSearchParams({
    invocationId: input.invocationId,
    runId: input.runId,
    runtimeId: input.runtimeId,
    generation: String(input.generation),
    afterSeq: String(input.afterSeq ?? 0),
    follow: 'false',
  })
  return `/v1/broker-events?${params.toString()}`
}

async function readBrokerEvents(input: {
  invocationId: string
  runId: string
  runtimeId: string
  generation: number
}): Promise<unknown[]> {
  const res = await fixture.fetchSocket(brokerEventsPath(input))
  expect(res.status).toBe(200)
  return (await res.text())
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

describe('T-05095 finding 1 — queue-capable broker busy reject is admission-fenced', () => {
  it('whenBusy:reject rejects a live queue-capable headless broker with zero side effects', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-t05095-queue-capable-busy'
    const invocationId = 'inv-t05095-queue-capable-busy'
    const activeRunId = 'run-t05095-active'

    seedQueueCapableBrokerWithLiveRun({
      hostSessionId,
      generation,
      runtimeId,
      invocationId,
      activeRunId,
    })
    const dispatchSpy = installDispatchInputSpy()
    const runIdsBefore = runIdsForRuntime(runtimeId)
    const userPromptsBefore = turnUserPromptEventsForRuntime(runtimeId)

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'second session input must reject, not queue',
      runtimeIntent: headlessBrokerIntent(),
      waitForCompletion: false,
      whenBusy: 'reject',
    })

    // RED today: the queue-capable path ignores the explicit reject marker,
    // allocates a new run, emits turn.user_prompt, and calls dispatchInput.
    const body = (await res.json()) as any
    expect({
      status: res.status,
      errorCode: body.error?.code,
      runIds: runIdsForRuntime(runtimeId),
      dispatchInputCalls: dispatchSpy.calls.length,
      turnUserPromptCount: turnUserPromptEventsForRuntime(runtimeId).length,
    }).toEqual({
      status: 409,
      errorCode: HrcErrorCode.RUNTIME_BUSY,
      runIds: runIdsBefore,
      dispatchInputCalls: 0,
      turnUserPromptCount: userPromptsBefore.length,
    })
  }, 15_000)
})

describe('T-05095 finding 2 — /v1/broker-events wire authority is persisted envelope JSON', () => {
  it('returns a non-repair envelope without read-time correlation injected from the run row', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-t05095-raw-exact'
    const runId = 'run-t05095-raw-exact'
    const invocationId = 'inv-t05095-raw-exact'
    const persistedEnvelope: InvocationEventEnvelope = {
      invocationId,
      seq: 1,
      time: new Date().toISOString(),
      type: 'assistant.message.completed',
      itemId: 'item-t05095-exact' as InvocationEventEnvelope['itemId'],
      payload: { id: 'item-t05095-exact', text: 'persisted only' } as any,
    }

    seedBrokerEventFixture({
      hostSessionId,
      runtimeId,
      runId,
      invocationId,
      generation,
      envelope: persistedEnvelope,
      runCorrelation: {
        kind: 'json_repair',
        sourceRunId: 'run-previous',
        failedValidationRunId: 'run-previous',
        repairRunId: runId,
      },
    })

    const events = await readBrokerEvents({ invocationId, runId, runtimeId, generation })

    // RED today: parseBrokerEnvelopeRow injects runs.correlation_json during
    // read, so the HTTP body is not JSON.parse(broker_envelope_json).
    expect(events).toEqual([persistedEnvelope])
    expect((events[0] as any).correlation).toBeUndefined()
  })

  it('does not overwrite broker-provided correlation while removing DB-side joins', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-t05095-broker-corr'
    const runId = 'run-t05095-broker-corr'
    const invocationId = 'inv-t05095-broker-corr'
    const brokerCorrelation = { brokerOwned: true, requestId: 'req-from-broker' }
    const persistedEnvelope: InvocationEventEnvelope = {
      invocationId,
      seq: 1,
      time: new Date().toISOString(),
      type: 'turn.completed',
      payload: { status: 'completed', finalOutput: 'done' } as any,
      correlation: brokerCorrelation,
    } as InvocationEventEnvelope

    seedBrokerEventFixture({
      hostSessionId,
      runtimeId,
      runId,
      invocationId,
      generation,
      envelope: persistedEnvelope,
      runCorrelation: {
        kind: 'json_repair',
        sourceRunId: 'run-db-should-not-win',
        failedValidationRunId: 'run-db-should-not-win',
        repairRunId: runId,
      },
    })

    const events = await readBrokerEvents({ invocationId, runId, runtimeId, generation })

    // Guard: the implementation must remove DB-side injection without
    // stripping or replacing correlation that the broker actually persisted.
    expect(events).toEqual([persistedEnvelope])
    expect((events[0] as any).correlation).toEqual(brokerCorrelation)
  })
})
