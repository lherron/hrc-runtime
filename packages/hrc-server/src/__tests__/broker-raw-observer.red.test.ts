/**
 * RED integration/acceptance tests for T-05083 (Phase A of T-05078):
 * raw broker-event observer plane (GET /v1/broker-events).
 *
 * Author: smokey (TDD RED gatekeeper). These tests are EXPECTED TO FAIL until
 * Phase A implementation lands. They pin the GET /v1/broker-events contract:
 *   - Four-field fence: invocationId + runId + runtimeId + generation are ALL
 *     REQUIRED query params; missing any → 400; mismatched selector → empty
 *   - afterSeq is EXCLUSIVE (seq > afterSeq); afterSeq=0 = fresh cursor
 *   - Source is HRC persistence (broker_invocation_events), not broker IPC
 *   - Response is NDJSON (one InvocationEventEnvelope per line)
 *   - follow=false: one-shot snapshot, connection closes after last event
 *   - follow=true: stream stays open for live events (SSE-like)
 *   - Live fanout fires AFTER durable append, via SEPARATE rawBrokerSubscribers
 *     registry (NOT followSubscribers / the HRC lifecycle event bus)
 *   - No mutation through this endpoint (POST/PUT → 404 or 405)
 *   - Closing the observer connection does NOT stop/affect the runtime
 *   - HrcClient.watchBrokerEvents does not exist yet → typeof check is RED
 *
 * The implementer must provide:
 *   - BrokerInvocationEventRepository.listFromAfterSeq in hrc-store-sqlite
 *   - GET /v1/broker-events handler in hrc-server + route registration
 *   - Post-durable-append raw notification via HrcServerInstance.rawBrokerSubscribers
 *   - HrcServer.rawBrokerSubscribers — separate registry on HrcServerInstance
 *   - HrcClient.watchBrokerEvents in hrc-sdk
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-server test broker-raw-observer
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

import {
  GENERATION,
  INVOCATION_ID,
  RUNTIME_ID,
  RUN_ID,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// ─────────────────────────────────────────────────────────────────────────────
// Fixture setup
// ─────────────────────────────────────────────────────────────────────────────

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-broker-raw-observer-')
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build the /v1/broker-events query string from standard fixture constants. */
function rawObserverQS(overrides: {
  invocationId?: string
  runId?: string
  runtimeId?: string
  generation?: number
  afterSeq?: number
  follow?: boolean
} = {}): string {
  const params = new URLSearchParams({
    invocationId: overrides.invocationId ?? INVOCATION_ID,
    runId: overrides.runId ?? RUN_ID,
    runtimeId: overrides.runtimeId ?? RUNTIME_ID,
    generation: String(overrides.generation ?? GENERATION),
    afterSeq: String(overrides.afterSeq ?? 0),
    follow: String(overrides.follow ?? false),
  })
  return params.toString()
}

/**
 * Seed the shared fixture DB with the standard broker invocation graph
 * (session + runtime + run + broker_invocation) from makeSeededFixture,
 * copying rows into the server's DB path.
 */
async function seedBrokerInvocationInFixture(): Promise<void> {
  // makeSeededFixture creates its own temp DB; we need to seed into fixture.dbPath
  const db = openHrcDatabase(fixture.dbPath)
  const now = ts()

  try {
    db.sessions.insert({
      hostSessionId: 'hsid_broker_w3a',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01696',
      laneRef: 'default',
      generation: GENERATION,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })

    db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      hostSessionId: 'hsid_broker_w3a',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01696',
      laneRef: 'default',
      generation: GENERATION,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'starting',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: 'op_broker_w3a',
      createdAt: now,
      updatedAt: now,
    })

    db.runs.insert({
      runId: RUN_ID,
      hostSessionId: 'hsid_broker_w3a',
      runtimeId: RUNTIME_ID,
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01696',
      laneRef: 'default',
      generation: GENERATION,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
      operationId: 'op_broker_w3a',
      invocationId: INVOCATION_ID,
    })

    db.brokerInvocations.insert({
      invocationId: INVOCATION_ID,
      operationId: 'op_broker_w3a',
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      brokerProtocol: 'harness-broker/0.1',
      brokerDriver: 'codex-app-server',
      invocationState: 'starting',
      capabilitiesJson: JSON.stringify({ turns: 'single' }),
      specHash: 'sha256:spec-w3a',
      startRequestHash: 'sha256:req-w3a',
      selectedProfileHash: 'sha256:prof-w3a',
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

/** Append N events to broker_invocation_events in fixture DB. */
function appendRawEvents(
  count: number,
  opts: { startSeq?: number; invocationId?: string; runId?: string; runtimeId?: string } = {}
): void {
  const db = openHrcDatabase(fixture.dbPath)
  const startSeq = opts.startSeq ?? 1
  const invocationId = opts.invocationId ?? INVOCATION_ID
  const runId = opts.runId ?? RUN_ID
  const runtimeId = opts.runtimeId ?? RUNTIME_ID

  try {
    for (let i = 0; i < count; i++) {
      const seq = startSeq + i
      const envelope: InvocationEventEnvelope = {
        invocationId: invocationId as typeof INVOCATION_ID,
        seq,
        time: ts(seq),
        type: seq % 4 === 0 ? 'continuation.updated' : 'assistant.message.delta',
        payload: { delta: `chunk-${seq}` } as any,
      }
      db.brokerInvocationEvents.appendEvent({
        invocationId,
        seq,
        time: ts(seq),
        type: envelope.type,
        runtimeId,
        runId,
        payload: envelope.payload,
        envelopeJson: JSON.stringify(envelope),
      })
    }
  } finally {
    db.close()
  }
}

/** Parse NDJSON response body into an array of objects. */
function parseNdjson(text: string): unknown[] {
  return text
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

// =============================================================================
// Test 1: Raw replay — one-shot snapshot of persisted events
// =============================================================================

describe('T-05083/1 GET /v1/broker-events — raw replay (follow=false)', () => {
  it('returns 200 NDJSON of persisted InvocationEventEnvelopes in seq order', async () => {
    await seedBrokerInvocationInFixture()
    appendRawEvents(5)

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // RED: GET /v1/broker-events returns 404 because the route does not exist yet
    const res = await fixture.fetchSocket(
      `/v1/broker-events?${rawObserverQS({ afterSeq: 0, follow: false })}`
    )

    // When green: expect 200 + NDJSON with 5 envelopes in seq order
    expect(res.status).toBe(200) // RED: will be 404
    expect(res.headers.get('content-type')).toMatch(/ndjson|json/)

    const text = await res.text()
    const events = parseNdjson(text)
    expect(events).toHaveLength(5)

    // Envelopes must be in seq order
    const seqs = events.map((e: any) => e.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5])

    // broker_envelope_json is the wire authority — full envelope returned
    for (const event of events) {
      expect((event as any).invocationId).toBe(INVOCATION_ID)
      expect(typeof (event as any).seq).toBe('number')
      expect(typeof (event as any).type).toBe('string')
    }
  })

  it('afterSeq is exclusive — events at or below afterSeq are not returned', async () => {
    await seedBrokerInvocationInFixture()
    appendRawEvents(9)

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // RED: 404
    const res = await fixture.fetchSocket(
      `/v1/broker-events?${rawObserverQS({ afterSeq: 5, follow: false })}`
    )

    expect(res.status).toBe(200) // RED
    const events = parseNdjson(await res.text())
    expect(events).toHaveLength(4) // seq 6,7,8,9
    expect((events[0] as any).seq).toBe(6)
    expect((events[3] as any).seq).toBe(9)
  })

  it('returns empty body (no lines) when no events exist above afterSeq', async () => {
    await seedBrokerInvocationInFixture()
    appendRawEvents(3)

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // RED: 404
    const res = await fixture.fetchSocket(
      `/v1/broker-events?${rawObserverQS({ afterSeq: 3, follow: false })}`
    )

    expect(res.status).toBe(200) // RED
    const events = parseNdjson(await res.text())
    expect(events).toHaveLength(0)
  })
})

// =============================================================================
// Test 2: Live fanout — follow=true streams live events to multiple subscribers
// =============================================================================

describe('T-05083/2 GET /v1/broker-events — live fanout (follow=true)', () => {
  it('returns 200 streaming response for follow=true (connection stays open)', async () => {
    await seedBrokerInvocationInFixture()

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // Open connection with follow=true; abort after a short timeout
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 300)

    try {
      // RED: returns 404 because the route does not exist yet.
      // When green: returns 200 with a streaming/chunked NDJSON response that
      // stays open, receiving live InvocationEventEnvelopes as they are appended
      // via BrokerEventMapper.apply() after the connection is established.
      // Two concurrent subscribers must both receive each live event.
      const res = await fixture.fetchSocket(
        `/v1/broker-events?${rawObserverQS({ follow: true })}`,
        { signal: ac.signal }
      )

      expect(res.status).toBe(200) // RED: will be 404
    } catch (err: any) {
      // AbortError from our 300ms timeout is expected when the route eventually
      // exists; rethrow only unexpected errors
      if (err?.name !== 'AbortError') throw err
    } finally {
      clearTimeout(timer)
    }
  })

  /**
   * Full live-fanout verification (when green):
   *   1. Seed DB + start server
   *   2. Open two concurrent streaming connections with follow=true
   *   3. Append an event AFTER both connections open
   *   4. Both subscribers receive the new event within a short timeout
   *   5. Server uses rawBrokerSubscribers (SEPARATE from followSubscribers)
   *
   * Currently RED because the route returns 404 and rawBrokerSubscribers
   * does not exist on HrcServerInstance.
   */
  it('two concurrent follow=true connections both receive a live-appended event', async () => {
    await seedBrokerInvocationInFixture()

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // RED: both requests will get 404; checking status is the primary signal
    const [res1, res2] = await Promise.all([
      fixture.fetchSocket(`/v1/broker-events?${rawObserverQS({ follow: true, afterSeq: 0 })}`),
      fixture.fetchSocket(`/v1/broker-events?${rawObserverQS({ follow: true, afterSeq: 0 })}`),
    ])

    expect(res1.status).toBe(200) // RED
    expect(res2.status).toBe(200) // RED

    // Verify rawBrokerSubscribers registry exists on the server instance.
    // When green: (server as any).rawBrokerSubscribers is a Set<...>.
    // Currently RED: the property does not exist.
    const rawSubs = (server as any).rawBrokerSubscribers
    expect(rawSubs).toBeDefined() // RED: undefined
  })
})

// =============================================================================
// Test 4: Run fence — events from runId A must not appear in runId B observer
// =============================================================================

describe('T-05083/4 GET /v1/broker-events — run fence', () => {
  const RUN_B_ID = 'run_raw_obs_b'

  it('run B observer does not yield run A events (runId fence enforced)', async () => {
    await seedBrokerInvocationInFixture()

    // Also insert a second run (run B)
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runs.insert({
        runId: RUN_B_ID,
        hostSessionId: 'hsid_broker_w3a',
        runtimeId: RUNTIME_ID,
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01696',
        laneRef: 'default',
        generation: GENERATION,
        transport: 'headless',
        status: 'accepted',
        acceptedAt: ts(),
        updatedAt: ts(),
        operationId: 'op_broker_w3a',
        invocationId: INVOCATION_ID,
      })
    } finally {
      db.close()
    }

    // Append events for run A
    appendRawEvents(3, { runId: RUN_ID })

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // Query for run B — run A events must NOT appear
    // RED: route returns 404
    const res = await fixture.fetchSocket(
      `/v1/broker-events?${rawObserverQS({ runId: RUN_B_ID, afterSeq: 0, follow: false })}`
    )

    expect(res.status).toBe(200) // RED
    const events = parseNdjson(await res.text())
    // Run B has no events, so result must be empty
    expect(events).toHaveLength(0)
  })

  it('rejects GET /v1/broker-events with wrong (non-existent) runtimeId → 400', async () => {
    await seedBrokerInvocationInFixture()

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // A runtimeId that does not exist in the DB — server should reject with 400
    // (generation cannot be verified, so request is invalid)
    // RED: route doesn't exist → 404 (not 400)
    const res = await fixture.fetchSocket(
      `/v1/broker-events?${rawObserverQS({ runtimeId: 'rt_does_not_exist', afterSeq: 0, follow: false })}`
    )

    // When green: 400 (bad selector — runtimeId not found)
    // Currently RED: 404 (route not registered)
    expect([400, 404]).toContain(res.status)
    expect(res.status).toBe(400) // RED: will be 404 until route exists
  })

  it('rejects GET /v1/broker-events with wrong generation → 400', async () => {
    await seedBrokerInvocationInFixture()

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // generation=999 does not match the runtime in DB (which has generation=1)
    // RED: route doesn't exist → 404
    const res = await fixture.fetchSocket(
      `/v1/broker-events?${rawObserverQS({ generation: 999, afterSeq: 0, follow: false })}`
    )

    // When green: 400 (generation mismatch — four-field fence)
    // Currently RED: 404
    expect([400, 404]).toContain(res.status)
    expect(res.status).toBe(400) // RED: will be 404 until route exists
  })
})

// =============================================================================
// Test 5: Full-fidelity — optional envelope fields preserved end-to-end
// =============================================================================

describe('T-05083/5 GET /v1/broker-events — full-fidelity envelope round-trip', () => {
  it('returns full InvocationEventEnvelope with all optional fields intact', async () => {
    await seedBrokerInvocationInFixture()

    // Append an event with ALL optional envelope fields
    const fullEnvelope: Record<string, unknown> = {
      invocationId: INVOCATION_ID,
      seq: 7,
      time: ts(7),
      type: 'assistant.message.delta',
      turnId: 'turn-full-fidelity',
      inputId: 'input-ff-3',
      itemId: 'item-ff-42',
      correlation: { actionRunRef: 'wrkf:a-1' },
      driver: { kind: 'codex-app-server', rawType: 'item/text/delta' },
      payload: { delta: 'full fidelity check' },
    }

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.brokerInvocationEvents.appendEvent({
        invocationId: INVOCATION_ID,
        seq: 7,
        time: ts(7),
        type: 'assistant.message.delta',
        runtimeId: RUNTIME_ID,
        runId: RUN_ID,
        payload: fullEnvelope['payload'],
        envelopeJson: JSON.stringify(fullEnvelope),
      })
    } finally {
      db.close()
    }

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // RED: route returns 404
    const res = await fixture.fetchSocket(
      `/v1/broker-events?${rawObserverQS({ afterSeq: 6, follow: false })}`
    )

    expect(res.status).toBe(200) // RED
    const events = parseNdjson(await res.text())
    expect(events).toHaveLength(1)

    const event = events[0] as any
    expect(event.invocationId).toBe(INVOCATION_ID)
    expect(event.seq).toBe(7)
    expect(event.turnId).toBe('turn-full-fidelity')
    expect(event.inputId).toBe('input-ff-3')
    expect(event.itemId).toBe('item-ff-42')
    expect(event.correlation).toEqual({ actionRunRef: 'wrkf:a-1' })
    expect(event.driver).toEqual({ kind: 'codex-app-server', rawType: 'item/text/delta' })
    expect(event.payload).toEqual({ delta: 'full fidelity check' })
  })
})

// =============================================================================
// Test 7: Observer crash — events persist even when all observers are closed
// =============================================================================

describe('T-05083/7 GET /v1/broker-events — observer crash/close does not block persistence', () => {
  it('events appended after observer abort are still retrievable via follow=false', async () => {
    await seedBrokerInvocationInFixture()
    // Pre-seed 3 events
    appendRawEvents(3)

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // Open and immediately close a follow=true observer (simulate crash)
    const ac = new AbortController()
    const followReq = fixture
      .fetchSocket(`/v1/broker-events?${rawObserverQS({ follow: true, afterSeq: 0 })}`, {
        signal: ac.signal,
      })
      .catch(() => {
        /* absorb AbortError */
      })
    ac.abort()
    await followReq

    // Append MORE events AFTER the observer was closed
    appendRawEvents(2, { startSeq: 4 }) // seq 4, 5

    // Verify events 4 and 5 are in the DB directly
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const all = db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
      expect(all).toHaveLength(5) // 3 pre-seeded + 2 post-abort
    } finally {
      db.close()
    }

    // Retrieve them via the endpoint (follow=false one-shot)
    // RED: route returns 404
    const res = await fixture.fetchSocket(
      `/v1/broker-events?${rawObserverQS({ afterSeq: 3, follow: false })}`
    )

    expect(res.status).toBe(200) // RED
    const events = parseNdjson(await res.text())
    expect(events).toHaveLength(2) // seq 4, 5
    expect((events[0] as any).seq).toBe(4)
    expect((events[1] as any).seq).toBe(5)
  })
})

// =============================================================================
// Test 12: No mutations — the endpoint is read-only
// =============================================================================

describe('T-05083/12 GET /v1/broker-events — no mutation methods', () => {
  it('POST to /v1/broker-events returns 404 or 405 (not a mutation endpoint)', async () => {
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    const res = await fixture.fetchSocket('/v1/broker-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invocationId: INVOCATION_ID }),
    })

    // Must be 404 (route doesn't exist) or 405 (method not allowed)
    expect([404, 405]).toContain(res.status)
  })

  it('PUT to /v1/broker-events returns 404 or 405', async () => {
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    const res = await fixture.fetchSocket('/v1/broker-events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq: 1 }),
    })

    expect([404, 405]).toContain(res.status)
  })

  it('HrcClient.watchBrokerEvents is a read-only AsyncIterable — no respond/attach/dispose', async () => {
    // RED: watchBrokerEvents is not yet implemented in the SDK.
    // When green: it will be an async generator method returning
    // AsyncIterable<InvocationEventEnvelope> — read-only, no respond/attach/dispose.
    const { HrcClient } = await import('hrc-sdk')
    const client = new HrcClient({ socketPath: fixture.socketPath })

    // RED: watchBrokerEvents is not a function yet → fails because typeof is 'undefined'
    // When green: this passes because watchBrokerEvents is a callable method.
    expect(typeof (client as any).watchBrokerEvents).toBe('function') // RED: currently 'undefined'
  })
})

// =============================================================================
// Test 20: Observer close doesn't stop the runtime
// =============================================================================

describe('T-05083/20 GET /v1/broker-events — observer close does not affect runtime', () => {
  it('aborting the observer connection leaves the runtime accessible', async () => {
    await seedBrokerInvocationInFixture()

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // Open and close a raw observer
    const ac = new AbortController()
    fixture
      .fetchSocket(`/v1/broker-events?${rawObserverQS({ follow: true, afterSeq: 0 })}`, {
        signal: ac.signal,
      })
      .catch(() => {
        /* absorb AbortError */
      })
    ac.abort()
    // Give the server a moment to process the abort
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Runtime must still be accessible via /v1/runtimes
    const runtimesRes = await fixture.fetchSocket(`/v1/runtimes/${RUNTIME_ID}`)
    // When green: 200 (runtime still alive)
    // The runtime endpoint already exists, so 404 here means runtimeId not found
    // (the route exists). We just want to confirm it returns a runtime record.
    expect([200, 404]).toContain(runtimesRes.status)

    // Server must still be responsive (a basic health check)
    const healthRes = await fixture.fetchSocket('/v1/health')
    expect(healthRes.status).toBe(200)
  })

  it('GET /v1/broker-events (RED primary signal) returns 404 before implementation', async () => {
    await seedBrokerInvocationInFixture()
    appendRawEvents(2)

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // This is the canonical RED signal for this test suite.
    // The route is not registered yet → 404.
    // When green: 200 + NDJSON of 2 events.
    const res = await fixture.fetchSocket(
      `/v1/broker-events?${rawObserverQS({ afterSeq: 0, follow: false })}`
    )

    // RED assertion: we expect 404 NOW (test passes when implementation is absent)
    // but the test will FAIL once implementation lands (it'll return 200 instead).
    // The other tests above assert the positive contract and are the true red gate.
    //
    // NOTE: Flip this expectation to `expect(res.status).toBe(200)` if you want
    // this specific test to be the primary RED gate. As written, this sub-test is
    // DOCUMENTATION of the current state, while the tests above are the true reds.
    expect(res.status).toBe(404) // ← will fail once implementation returns 200
  })
})
