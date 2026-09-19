import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { RuntimeSeatResponse, WithdrawSubmissionResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

/**
 * T-08606 contract: `GET /v1/runtimes/{runtimeId}/seat` and
 * `POST /v1/submissions/withdraw` against a real hrc-server on a temp socket.
 * Broker IPC is stubbed at the controller seam (established pattern); the DB
 * rows, handler path, routing, and response serialization are real.
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-server test t08606-seat-withdraw
 */

const RUNTIME_ID = 'rt-t08606-seat-01'
const HOST_SESSION_ID = 'hsid-t08606-seat-01'
const SCOPE_REF = 'agent:test-seat'
const OPERATION_ID = 'op-t08606-seat-01'
const INVOCATION_ID = 'inv-t08606-seat-01'

let fixture: HrcServerTestFixture
let server: HrcServer

const withdrawCalls: unknown[] = []
let probeResult: unknown

function stubController(): void {
  probeResult = {
    ok: true,
    response: {
      invocationId: INVOCATION_ID,
      seat: { state: 'idle' },
      brokerHeldDepth: 0,
    },
  }
  ;(server as any).getHarnessBrokerController = () => ({
    seatProbe: async (_runtimeId: string) => probeResult,
    withdraw: async (input: unknown) => {
      withdrawCalls.push(input)
      return { ok: true, response: { outcome: 'withdrawn' } }
    },
  })
}

function seedSeat(options: { capabilitiesJson?: string | undefined } = {}): void {
  fixture.seedSession(HOST_SESSION_ID, SCOPE_REF)
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: 3,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'codex',
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
      capabilitiesJson:
        options.capabilitiesJson ?? JSON.stringify({ admission: { classes: ['steer', 'queue'] } }),
      specHash: 'sha256:spec-t08606',
      startRequestHash: 'sha256:req-t08606',
      selectedProfileHash: 'sha256:prof-t08606',
      createdAt: now,
      updatedAt: now,
    })
    for (const seq of [1, 2]) {
      db.brokerInvocationEvents.appendEvent({
        invocationId: INVOCATION_ID,
        seq,
        time: now,
        type: 'input.accepted',
        runtimeId: RUNTIME_ID,
        payload: { seq },
        projectionStatus: 'projected',
      })
    }
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08606-seat-')
  server = await createHrcServer(fixture.serverOpts())
  withdrawCalls.length = 0
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

describe('GET /v1/runtimes/{runtimeId}/seat', () => {
  it('returns the probe plus frozen invocation facts in one read', async () => {
    seedSeat()
    stubController()
    const res = await fixture.fetchSocket(`/v1/runtimes/${RUNTIME_ID}/seat`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as RuntimeSeatResponse
    expect(body).toMatchObject({
      runtimeId: RUNTIME_ID,
      invocationId: INVOCATION_ID,
      generation: 3,
      admissionClasses: ['steer', 'queue'],
      currentBrokerSeq: 2,
      probe: {
        invocationId: INVOCATION_ID,
        seat: { state: 'idle' },
        brokerHeldDepth: 0,
      },
      probeError: null,
    })
  })

  it('404s an unknown runtime', async () => {
    stubController()
    const res = await fixture.fetchSocket('/v1/runtimes/rt-nope/seat')
    expect(res.status).toBe(404)
  })

  it('keeps the committed facts when the live probe fails', async () => {
    seedSeat()
    stubController()
    probeResult = {
      ok: false,
      error: { code: 'broker_seat_probe_failed', message: 'broker unreachable' },
    }
    const res = await fixture.fetchSocket(`/v1/runtimes/${RUNTIME_ID}/seat`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as RuntimeSeatResponse
    expect(body.invocationId).toBe(INVOCATION_ID)
    expect(body.currentBrokerSeq).toBe(2)
    expect(body.probe).toBeNull()
    expect(body.probeError).toMatchObject({ code: 'broker_seat_probe_failed' })
  })

  it('reports silence as null admission classes, never as a refusal', async () => {
    seedSeat({ capabilitiesJson: JSON.stringify({}) })
    stubController()
    const res = await fixture.fetchSocket(`/v1/runtimes/${RUNTIME_ID}/seat`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as RuntimeSeatResponse
    expect(body.admissionClasses).toBeNull()
  })
})

describe('POST /v1/submissions/withdraw', () => {
  it('passes a submissionId withdraw through with the runtime echoed', async () => {
    seedSeat()
    stubController()
    const res = await fixture.postJson('/v1/submissions/withdraw', {
      runtimeId: RUNTIME_ID,
      submissionId: 'submission-abc',
      reason: 'injector superseded',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as WithdrawSubmissionResponse
    expect(body).toMatchObject({ runtimeId: RUNTIME_ID, outcome: 'withdrawn' })
    expect(withdrawCalls).toHaveLength(1)
    expect(withdrawCalls[0]).toMatchObject({
      runtimeId: RUNTIME_ID,
      submissionId: 'submission-abc',
      reason: 'injector superseded',
    })
  })

  it('accepts an envelopeId withdraw', async () => {
    seedSeat()
    stubController()
    const res = await fixture.postJson('/v1/submissions/withdraw', {
      runtimeId: RUNTIME_ID,
      envelopeId: 'en-123',
      reason: 'injector superseded',
    })
    expect(res.status).toBe(200)
    expect(withdrawCalls[0]).toMatchObject({ envelopeId: 'en-123' })
  })

  it('400s when neither submissionId nor envelopeId is named', async () => {
    seedSeat()
    stubController()
    const res = await fixture.postJson('/v1/submissions/withdraw', {
      runtimeId: RUNTIME_ID,
      reason: 'injector superseded',
    })
    expect(res.status).toBe(400)
  })

  it('400s when both submissionId and envelopeId are named', async () => {
    seedSeat()
    stubController()
    const res = await fixture.postJson('/v1/submissions/withdraw', {
      runtimeId: RUNTIME_ID,
      submissionId: 'submission-abc',
      envelopeId: 'en-123',
      reason: 'injector superseded',
    })
    expect(res.status).toBe(400)
  })

  it('404s an unknown runtime', async () => {
    stubController()
    const res = await fixture.postJson('/v1/submissions/withdraw', {
      runtimeId: 'rt-nope',
      submissionId: 'submission-abc',
      reason: 'injector superseded',
    })
    expect(res.status).toBe(404)
  })
})
