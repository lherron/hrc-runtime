import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type {
  BrokerEventsFollowResponse,
  BrokerEventsQueryResponse,
  EventsHeadResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

/**
 * T-08607 contract: `GET /v1/events/head`, `GET /v1/broker-events/query`
 * (event-drive's five committed-evidence reads), and
 * `POST /v1/broker-events/follow` (node-wide commit-ordinal pages), with the
 * retained-evidence fence on every row read — against a real hrc-server on a
 * temp socket.
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-server test t08607-evidence-routes
 */

const RUNTIME_ID = 'rt-t08607-evidence-01'
const HOST_SESSION_ID = 'hsid-t08607-evidence-01'
const SCOPE = 'agent:t08607:project:hrc-runtime:task:evidence'
const INVOCATION_ID = 'inv-t08607-01'
const SUB = 'submission-t08607-a'
const SUB2 = 'submission-t08607-b'
const SUB3 = 'submission-t08607-c'
const SUB_RETAINED = 'submission-t08607-retained'
const ENV = 'en-t08607-a'
const INPUT = 'input-t08607-a'
const TURN = 'turn-t08607-a'

let fixture: HrcServerTestFixture
let server: HrcServer

function ts(seq: number): string {
  return `2026-09-19T02:00:${String(seq).padStart(2, '0')}.000Z`
}

function seedBase(): void {
  fixture.seedSession(HOST_SESSION_ID, SCOPE)
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE,
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'codex',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: 'op-t08607-01',
      activeInvocationId: INVOCATION_ID,
      createdAt: now,
      updatedAt: now,
    })
    db.brokerInvocations.insert({
      invocationId: INVOCATION_ID,
      operationId: 'op-t08607-01',
      runtimeId: RUNTIME_ID,
      invocationState: 'ready',
      currentHarnessGeneration: 1,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      capabilitiesJson: JSON.stringify({ admission: { classes: ['steer', 'queue'] } }),
      specHash: 'sha256:spec-t08607',
      startRequestHash: 'sha256:req-t08607',
      selectedProfileHash: 'sha256:prof-t08607',
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

function appendBrokerEvent(
  seq: number,
  type: string,
  payload: unknown,
  evidenceOrigin?: 'retained' | undefined
): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq,
      time: ts(seq),
      type,
      runtimeId: RUNTIME_ID,
      payload,
      projectionStatus: 'projected',
      ...(evidenceOrigin !== undefined ? { evidenceOrigin } : {}),
    })
  } finally {
    db.close()
  }
}

function seedEvidence(): void {
  seedBase()
  appendBrokerEvent(1, 'admission.requested', { submissionId: SUB, origin: { envelopeId: ENV } })
  appendBrokerEvent(2, 'admission.rejected', {
    submissionId: SUB,
    layer: 'policy',
    reason: 'guarded turn',
  })
  appendBrokerEvent(3, 'submission.absorbed', { submissionId: SUB, turnId: TURN })
  appendBrokerEvent(4, 'input.accepted', { inputId: INPUT })
  // The protocol's InputDispositionPayload carries the submission as inputId.
  appendBrokerEvent(5, 'input.rejected', { inputId: SUB2, deliveryEvidence: 'not_written' })
  appendBrokerEvent(6, 'submission.executed', { submissionId: SUB, turnId: TURN })
  appendBrokerEvent(7, 'admission.requested', { submissionId: SUB3, origin: { envelopeId: ENV } })
  appendBrokerEvent(
    8,
    'submission.absorbed',
    { submissionId: SUB_RETAINED, turnId: 'turn-retained' },
    'retained'
  )
}

async function query(params: Record<string, string>): Promise<BrokerEventsQueryResponse> {
  const qs = new URLSearchParams(params).toString()
  const res = await fixture.fetchSocket(`/v1/broker-events/query?${qs}`)
  expect(res.status).toBe(200)
  return (await res.json()) as BrokerEventsQueryResponse
}

const SUBSCRIBER = 't08607-follow'

async function declareSubscriber(name: string): Promise<void> {
  const res = await fixture.postJson('/v1/server/subscribers', { name })
  expect(res.status).toBe(200)
}

async function follow(
  params: Record<string, string>,
  name: string = SUBSCRIBER
): Promise<BrokerEventsFollowResponse> {
  const qs = new URLSearchParams(params).toString()
  const res = await fixture.fetchSocket(`/v1/broker-events/follow?${qs}`, {
    headers: { 'x-hrc-subscriber-name': name },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as BrokerEventsFollowResponse
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08607-')
  server = await createHrcServer(fixture.serverOpts())
  await declareSubscriber(SUBSCRIBER)
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

describe('GET /v1/events/head', () => {
  it('reports zero high-water on an empty ledger', async () => {
    const res = await fixture.fetchSocket('/v1/events/head')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hrcSeq: 0, brokerCommit: 0 })
  })

  it('reports the highest commit row across both tables', async () => {
    seedEvidence()
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.hrcEvents.append({
        ts: ts(1),
        hostSessionId: HOST_SESSION_ID,
        scopeRef: SCOPE,
        laneRef: 'default',
        generation: 1,
        runtimeId: RUNTIME_ID,
        category: 'turn',
        eventKind: 'turn.started',
        transport: 'headless',
        payload: {},
      })
      db.hrcEvents.append({
        ts: ts(2),
        hostSessionId: HOST_SESSION_ID,
        scopeRef: SCOPE,
        laneRef: 'default',
        generation: 1,
        runtimeId: RUNTIME_ID,
        category: 'turn',
        eventKind: 'turn.completed',
        transport: 'headless',
        payload: {},
      })
    } finally {
      db.close()
    }
    const res = await fixture.fetchSocket('/v1/events/head')
    expect(res.status).toBe(200)
    const body = (await res.json()) as EventsHeadResponse
    expect(body.hrcSeq).toBe(2)
    // Eight broker commits (seven live, one retained): the high-water is
    // positional and unfenced.
    expect(body.brokerCommit).toBe(8)
  })
})

describe('GET /v1/broker-events/query', () => {
  it('answers all five event-drive rows', async () => {
    seedEvidence()
    const q = { runtimeId: RUNTIME_ID }
    expect(await query({ ...q, op: 'admission-rejection', submissionId: SUB })).toEqual({
      result: { op: 'admission-rejection', layer: 'policy', reason: 'guarded turn' },
    })
    expect(await query({ ...q, op: 'input-accepted', inputId: INPUT })).toEqual({
      result: { op: 'input-accepted', accepted: true },
    })
    expect(await query({ ...q, op: 'input-accepted', inputId: 'input-absent' })).toEqual({
      result: { op: 'input-accepted', accepted: false },
    })
    expect(
      await query({
        ...q,
        op: 'unique-submission-after',
        invocationId: INVOCATION_ID,
        envelopeId: 'en-absent',
        afterSeq: '0',
      })
    ).toEqual({ result: null })
    expect(await query({ ...q, op: 'disposition', submissionId: SUB })).toEqual({
      result: { op: 'disposition', type: 'submission.absorbed', turnId: TURN },
    })
    expect(await query({ ...q, op: 'disposition', submissionId: 'sub-absent' })).toEqual({
      result: null,
    })
    expect(await query({ ...q, op: 'input-rejection-evidence', submissionId: SUB2 })).toEqual({
      result: { op: 'input-rejection-evidence', deliveryEvidence: 'not_written' },
    })
  })

  it('a twice-minted envelope has no unique submission', async () => {
    seedEvidence()
    expect(
      await query({
        runtimeId: RUNTIME_ID,
        op: 'unique-submission-after',
        invocationId: INVOCATION_ID,
        envelopeId: ENV,
        afterSeq: '0',
      })
    ).toEqual({ result: null })
  })

  it('400s a bad op, missing params, and 404s an unknown runtime', async () => {
    seedEvidence()
    const badOp = await fixture.fetchSocket(
      `/v1/broker-events/query?op=nope&runtimeId=${RUNTIME_ID}`
    )
    expect(badOp.status).toBe(400)
    const missing = await fixture.fetchSocket(
      `/v1/broker-events/query?op=disposition&runtimeId=${RUNTIME_ID}`
    )
    expect(missing.status).toBe(400)
    const unknown = await fixture.fetchSocket(
      `/v1/broker-events/query?op=disposition&runtimeId=rt-nope&submissionId=${SUB}`
    )
    expect(unknown.status).toBe(404)
  })

  it('the retained fence reads a retained-only match as absent', async () => {
    seedEvidence()
    const q = { runtimeId: RUNTIME_ID, op: 'disposition', submissionId: SUB_RETAINED }
    expect(await query(q)).toEqual({ result: null })
    expect(await query({ ...q, includeRetained: 'true' })).toEqual({
      result: { op: 'disposition', type: 'submission.absorbed', turnId: 'turn-retained' },
    })
  })
})

describe('POST /v1/broker-events/follow', () => {
  it('pages commit-ascending with explicit origins and a resume cursor', async () => {
    seedEvidence()
    const first = await follow({ afterCommit: '0', limit: '3' })
    expect(first.events.map((event) => event.commitOrdinal)).toEqual([1, 2, 3])
    for (const event of first.events) {
      expect(event.evidenceOrigin).toBe('live')
    }
    expect(first.nextCommit).toBe(3)
    // Newer-or-equal: resuming at the cursor re-observes the boundary row.
    const second = await follow({ afterCommit: String(first.nextCommit), limit: '100' })
    expect(second.events[0]?.commitOrdinal).toBe(3)
    expect(second.events[0]).toEqual(first.events[2])
    expect(second.nextCommit).toBe(7)
  })

  it('excludes retained rows and marks every origin', async () => {
    seedEvidence()
    const fenced = await follow({ afterCommit: '7', limit: '100' })
    expect(fenced.events.map((event) => event.commitOrdinal)).toEqual([7])
    expect(fenced.events[0]?.evidenceOrigin).toBe('live')
    // A named delivery consumer asking for retained rows is refused (T-08608):
    // the fenced page is the only answer follow gives.
    const refused = await fixture.fetchSocket(
      '/v1/broker-events/follow?afterCommit=7&limit=100&includeRetained=true',
      { headers: { 'x-hrc-subscriber-name': SUBSCRIBER } }
    )
    expect(refused.status).toBe(400)
  })

  it('an empty page never rewinds the cursor', async () => {
    seedEvidence()
    const page = await follow({ afterCommit: '999', limit: '100' })
    expect(page.events).toEqual([])
    expect(page.nextCommit).toBe(999)
  })

  it('400s bad query params', async () => {
    for (const qs of ['', 'afterCommit=-1', 'afterCommit=0&limit=0', 'afterCommit=1.5']) {
      const res = await fixture.fetchSocket(`/v1/broker-events/follow?${qs}`, {
        headers: { 'x-hrc-subscriber-name': SUBSCRIBER },
      })
      expect(res.status).toBe(400)
    }
  })

  it('commit ordinals interleave monotonically across commit sources', async () => {
    seedBase()
    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
    try {
      db.brokerInvocations.insert({
        invocationId: 'inv-t08607-second',
        operationId: 'op-t08607-02',
        runtimeId: RUNTIME_ID,
        invocationState: 'ready',
        currentHarnessGeneration: 1,
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: 'codex-app-server',
        capabilitiesJson: JSON.stringify({}),
        specHash: 'sha256:spec-b',
        startRequestHash: 'sha256:req-b',
        selectedProfileHash: 'sha256:prof-b',
        createdAt: now,
        updatedAt: now,
      })
    } finally {
      db.close()
    }
    // Alternating appends from two interleaved commit sources (the in-process
    // mapper and the ingest listener commit through the same append path).
    const order: Array<[string, number]> = [
      [INVOCATION_ID, 1],
      ['inv-t08607-second', 1],
      [INVOCATION_ID, 2],
      ['inv-t08607-second', 2],
    ]
    for (const [invocationId, seq] of order) {
      const db2 = openHrcDatabase(fixture.dbPath)
      try {
        db2.brokerInvocationEvents.appendEvent({
          invocationId,
          seq,
          time: ts(seq),
          type: 'input.accepted',
          runtimeId: RUNTIME_ID,
          payload: { inputId: `${invocationId}-in-${seq}` },
          projectionStatus: 'projected',
        })
      } finally {
        db2.close()
      }
    }
    const page = await follow({ afterCommit: '0', limit: '100' })
    const ordinals = page.events.map((event) => event.commitOrdinal)
    expect(ordinals).toEqual([1, 2, 3, 4])
    expect(page.events.map((event) => event.invocationId)).toEqual([
      INVOCATION_ID,
      'inv-t08607-second',
      INVOCATION_ID,
      'inv-t08607-second',
    ])
  })

  it('retention pruning the old end cannot alias a cursor (static)', async () => {
    seedEvidence()
    // Simulate the six-month retention prune deleting the old end.
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.sqlite.run('DELETE FROM broker_invocation_events WHERE id <= 5')
    } finally {
      db.close()
    }
    appendBrokerEvent(9, 'input.accepted', { inputId: 'input-after-prune' })
    const page = await follow({ afterCommit: '0', limit: '100' })
    // AUTOINCREMENT never reuses ids: the new row continues past the prune.
    expect(page.events.map((event) => event.commitOrdinal)).toEqual([6, 7, 9])
    // A cursor pointing into pruned history still streams newer-or-equal.
    const resumed = await follow({ afterCommit: '3', limit: '100' })
    expect(resumed.events.map((event) => event.commitOrdinal)).toEqual([6, 7, 9])
  })
})
