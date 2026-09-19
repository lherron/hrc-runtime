import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcStatusResponse, SubscriberDeclareResponse } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

/**
 * T-08608 contract: named delivery-consumer subscribers for the commit-ordinal
 * follow route — declaration, header admission (absent and undeclared are both
 * 400), per-page heartbeat through the existing consumer-receipt accounting,
 * retained refusal for named consumers, and the `mailKicker` status readback.
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-server test t08608-named-subscribers
 */

const NAME = 't08608-injector'
const RUNTIME_ID = 'rt-t08608-01'
const HOST_SESSION_ID = 'hsid-t08608-01'
const SCOPE = 'agent:t08608:project:hrc-runtime:task:subscribers'
const INVOCATION_ID = 'inv-t08608-01'

let fixture: HrcServerTestFixture
let server: HrcServer

function seedEvent(seq: number, type: string, payload: unknown): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq,
      time: `2026-09-19T03:00:${String(seq).padStart(2, '0')}.000Z`,
      type,
      runtimeId: RUNTIME_ID,
      payload,
      projectionStatus: 'projected',
    })
  } finally {
    db.close()
  }
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
      createdAt: now,
      updatedAt: now,
    })
    db.brokerInvocations.insert({
      invocationId: INVOCATION_ID,
      operationId: 'op-t08608-01',
      runtimeId: RUNTIME_ID,
      invocationState: 'ready',
      currentHarnessGeneration: 1,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      capabilitiesJson: JSON.stringify({}),
      specHash: 'sha256:spec-t08608',
      startRequestHash: 'sha256:req-t08608',
      selectedProfileHash: 'sha256:prof-t08608',
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

async function declare(body: Record<string, unknown>): Promise<Response> {
  return fixture.postJson('/v1/server/subscribers', body)
}

function followHeaders(name?: string): Record<string, string> {
  return name === undefined ? {} : { 'x-hrc-subscriber-name': name }
}

async function snapshotActive(): Promise<Array<{ name?: string; subscriberId: string }>> {
  const res = await fixture.fetchSocket('/v1/server/subscribers')
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    active: Array<{ name?: string; subscriberId: string }>
  }
  return body.active
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08608-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

describe('POST /v1/server/subscribers', () => {
  it('declares a named consumer and re-declare is idempotent', async () => {
    const first = await declare({ name: NAME })
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as SubscriberDeclareResponse
    expect(firstBody).toMatchObject({ name: NAME, route: 'broker-events', receiptMode: 'none' })
    expect(firstBody.subscriberId).toMatch(/^sub-/)
    expect(firstBody).not.toHaveProperty('receiptToken')

    const second = await declare({ name: NAME })
    expect(second.status).toBe(200)
    expect(((await second.json()) as SubscriberDeclareResponse).subscriberId).toBe(
      firstBody.subscriberId
    )
    const active = await snapshotActive()
    expect(active.filter((entry) => entry.name === NAME)).toHaveLength(1)
  })

  it('mints a receipt token for consumer-ack-v1', async () => {
    const res = await declare({ name: `${NAME}-ack`, receiptMode: 'consumer-ack-v1' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SubscriberDeclareResponse
    expect(body.receiptMode).toBe('consumer-ack-v1')
    expect(body.receiptToken).toMatch(/^receipt-/)
  })

  it('400s a bad declaration', async () => {
    for (const body of [
      {},
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(129) },
      { name: NAME, route: 'nope' },
      { name: NAME, receiptMode: 'manual' },
    ]) {
      const res = await declare(body)
      expect(res.status).toBe(400)
    }
  })
})

describe('GET /v1/broker-events/follow admission', () => {
  it('400s an absent name and an undeclared name', async () => {
    seedBase()
    const absent = await fixture.fetchSocket('/v1/broker-events/follow?afterCommit=0')
    expect(absent.status).toBe(400)
    const undeclared = await fixture.fetchSocket('/v1/broker-events/follow?afterCommit=0', {
      headers: followHeaders('never-declared'),
    })
    expect(undeclared.status).toBe(400)
  })

  it('400s a name declared for the other route', async () => {
    const res = await declare({ name: `${NAME}-events`, route: 'events' })
    expect(res.status).toBe(200)
    const follow = await fixture.fetchSocket('/v1/broker-events/follow?afterCommit=0', {
      headers: followHeaders(`${NAME}-events`),
    })
    expect(follow.status).toBe(400)
  })

  it('heartbeats the named admission on every served page', async () => {
    seedBase()
    seedEvent(1, 'input.accepted', { inputId: 'in-1' })
    seedEvent(2, 'input.accepted', { inputId: 'in-2' })
    await declare({ name: NAME })
    const before = (await snapshotActive()).find((entry) => entry.name === NAME)
    expect(before).toMatchObject({ name: NAME })

    const page = await fixture.fetchSocket('/v1/broker-events/follow?afterCommit=0&limit=1', {
      headers: followHeaders(NAME),
    })
    expect(page.status).toBe(200)
    const after = (await snapshotActive()).find((entry) => entry.name === NAME)
    expect(after).toMatchObject({ name: NAME })
    // The heartbeat advanced the stream-accepted head through the existing
    // accounting (visible in the shared snapshot the operators read).
    const snap = await (await fixture.fetchSocket('/v1/server/subscribers')).json()
    const entry = (snap as { active: Array<Record<string, unknown>> }).active.find(
      (candidate) => candidate['name'] === NAME
    )
    expect(entry?.['lastStreamAcceptedSeq']).toBe(1)
    expect(entry?.['lastStreamAcceptedAt']).toBeTruthy()
  })

  it('refuses includeRetained for a named consumer', async () => {
    seedBase()
    await declare({ name: NAME })
    const res = await fixture.fetchSocket(
      '/v1/broker-events/follow?afterCommit=0&includeRetained=true',
      { headers: followHeaders(NAME) }
    )
    expect(res.status).toBe(400)
  })

  it('serves a declared consumer end to end over the SDK', async () => {
    seedBase()
    seedEvent(1, 'input.accepted', { inputId: 'in-sdk' })
    const client = new HrcClient(fixture.socketPath)
    const declared = await client.declareSubscriber({ name: `${NAME}-sdk` })
    expect(declared.name).toBe(`${NAME}-sdk`)
    const page = await client.followBrokerEvents({ afterCommit: 0 }, `${NAME}-sdk`)
    expect(page.events.map((event) => event.commitOrdinal)).toEqual([1])
    expect(page.events[0]?.evidenceOrigin).toBe('live')
    expect(page.nextCommit).toBe(1)
  })
})

describe('hrc status mailKicker readback', () => {
  it('reports the constructed kicker posture, not a constant', async () => {
    const res = await fixture.fetchSocket('/v1/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as HrcStatusResponse
    // The fixture server does not enable the in-process kicker.
    expect(body.mailKicker).toEqual({ enabled: false })
  })

  it('reads enabled when the server is constructed with the kicker on', async () => {
    await server.stop()
    await fixture.cleanup()
    fixture = await createHrcTestFixture('hrc-t08608-kicker-')
    server = await createHrcServer(fixture.serverOpts({ hrcMailKickerEnabled: true }))
    const res = await fixture.fetchSocket('/v1/status')
    expect(res.status).toBe(200)
    expect(((await res.json()) as HrcStatusResponse).mailKicker).toEqual({ enabled: true })
  })
})
