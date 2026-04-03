/**
 * RED/GREEN tests for HRC server bridge endpoints (T-00971 / Phase 5)
 *
 * Tests the local bridge registration, delivery, and listing surface:
 *   - POST /v1/bridges/local-target registers a new bridge
 *   - POST /v1/bridges/deliver sends text through a bridge
 *   - POST /v1/bridges/deliver with stale fence => 409
 *   - POST /v1/bridges/deliver emits bridge.delivered event
 *   - GET /v1/bridges?runtimeId= lists active bridges
 *   - Bridge closure via POST /v1/bridges/close
 *
 * Pass conditions for Larry (T-00971):
 *   1. POST /v1/bridges/local-target => 200 + bridge record with bridgeId
 *   2. Bridge record includes transport, target, hostSessionId, runtimeId
 *   3. POST /v1/bridges/deliver with valid bridge => 200 + { delivered: true }
 *   4. Events stream contains bridge.delivered with bridgeId, text payload
 *   5. POST /v1/bridges/deliver with stale expectedHostSessionId => 409 stale_context
 *   6. POST /v1/bridges/deliver with stale expectedGeneration => 409 stale_context
 *   7. GET /v1/bridges?runtimeId=X => 200 + array of active bridges
 *   8. GET /v1/bridges excludes closed bridges
 *   9. POST /v1/bridges/close => 200 + bridge with closedAt set
 *  10. POST /v1/bridges/deliver to closed bridge => 404
 *  11. GET /v1/bridges returns 400 when runtimeId is missing
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcHttpError } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'

// RED GATE: server must handle bridge endpoints
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// RED GATE: this type does not exist yet in hrc-core
import type { HrcLocalBridgeRecord } from 'hrc-core'

let fixture: HrcServerTestFixture

/**
 * Helper: fetch all events and return parsed envelopes.
 */
async function fetchEvents(): Promise<
  Array<{ seq: number; eventKind: string; eventJson: unknown; runtimeId?: string }>
> {
  const res = await fixture.fetchSocket('/v1/events')
  const text = await res.text()
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-server-bridges-test-')
})

afterEach(async () => {
  await fixture.cleanup()
})

// ---------------------------------------------------------------------------
// 1. POST /v1/bridges/local-target — register a bridge
// ---------------------------------------------------------------------------
describe('POST /v1/bridges/local-target', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('registers a new local bridge and returns the record', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-register-test')

    const res = await fixture.postJson('/v1/bridges/local-target', {
      transport: 'legacy-agentchat',
      target: 'smokey@agent-spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    expect(res.status).toBe(200)
    const bridge = (await res.json()) as HrcLocalBridgeRecord
    expect(bridge.bridgeId).toBeDefined()
    expect(bridge.transport).toBe('legacy-agentchat')
    expect(bridge.target).toBe('smokey@agent-spaces')
    expect(bridge.hostSessionId).toBe(hostSessionId)
    expect(bridge.runtimeId).toBe(runtimeId)
    expect(bridge.closedAt).toBeUndefined()
  })

  it('returns existing bridge when same transport+target already registered', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-dedup-test')

    const body = {
      transport: 'legacy-agentchat',
      target: 'dedup@agent-spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    }

    const res1 = await fixture.postJson('/v1/bridges/local-target', body)
    const bridge1 = (await res1.json()) as HrcLocalBridgeRecord

    const res2 = await fixture.postJson('/v1/bridges/local-target', body)
    const bridge2 = (await res2.json()) as HrcLocalBridgeRecord

    expect(bridge2.bridgeId).toBe(bridge1.bridgeId)
  })
})

// ---------------------------------------------------------------------------
// 2. POST /v1/bridges/deliver — deliver text through a bridge
// ---------------------------------------------------------------------------
describe('POST /v1/bridges/deliver', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('delivers text through a valid bridge', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-deliver-test')

    // Register bridge
    const regRes = await fixture.postJson('/v1/bridges/local-target', {
      transport: 'legacy-agentchat',
      target: 'deliver-target@spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    // Deliver text
    const res = await fixture.postJson('/v1/bridges/deliver', {
      bridgeId: bridge.bridgeId,
      text: 'Hello from smoke test',
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivered: boolean }
    expect(body.delivered).toBe(true)
  })

  it('emits bridge.delivered event', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-event-test')

    const regRes = await fixture.postJson('/v1/bridges/local-target', {
      transport: 'legacy-agentchat',
      target: 'event-target@spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    await fixture.postJson('/v1/bridges/deliver', {
      bridgeId: bridge.bridgeId,
      text: 'Event test payload',
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    const events = await fetchEvents()
    const deliveredEvent = events.find((e) => e.eventKind === 'bridge.delivered')
    expect(deliveredEvent).toBeDefined()
    const ej = deliveredEvent!.eventJson as Record<string, unknown>
    expect(ej['bridgeId']).toBe(bridge.bridgeId)
    expect(ej['payloadLength']).toBe('Event test payload'.length)
    expect(ej['enter']).toBe(true)
    expect(ej['oobSuffixLength']).toBe(0)
    expect(ej['text']).toBeUndefined()
  })

  it('rejects delivery with stale expectedHostSessionId (409)', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-stale-hsid')

    const regRes = await fixture.postJson('/v1/bridges/local-target', {
      transport: 'legacy-agentchat',
      target: 'stale-hsid@spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    const res = await fixture.postJson('/v1/bridges/deliver', {
      bridgeId: bridge.bridgeId,
      text: 'Should fail',
      expectedHostSessionId: 'wrong-hsid',
      expectedGeneration: generation,
    })

    expect(res.status).toBe(409)
    const err = (await res.json()) as { error: HrcHttpError }
    expect(err.error.code).toBe(HrcErrorCode.STALE_CONTEXT)
  })

  it('rejects delivery with stale expectedGeneration (409)', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } = await fixture.ensureRuntime('bridge-stale-gen')

    const regRes = await fixture.postJson('/v1/bridges/local-target', {
      transport: 'legacy-agentchat',
      target: 'stale-gen@spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    const res = await fixture.postJson('/v1/bridges/deliver', {
      bridgeId: bridge.bridgeId,
      text: 'Should fail',
      expectedHostSessionId: hostSessionId,
      expectedGeneration: 999,
    })

    expect(res.status).toBe(409)
    const err = (await res.json()) as { error: HrcHttpError }
    expect(err.error.code).toBe(HrcErrorCode.STALE_CONTEXT)
  })

  it('returns 404 when delivering to a closed bridge', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-closed-deliver')

    const regRes = await fixture.postJson('/v1/bridges/local-target', {
      transport: 'legacy-agentchat',
      target: 'closed-deliver@spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    // Close the bridge
    await fixture.postJson('/v1/bridges/close', { bridgeId: bridge.bridgeId })

    // Try to deliver
    const res = await fixture.postJson('/v1/bridges/deliver', {
      bridgeId: bridge.bridgeId,
      text: 'Should fail',
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// 3. GET /v1/bridges — list active bridges
// ---------------------------------------------------------------------------
describe('GET /v1/bridges', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns active bridges for the given runtimeId', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } = await fixture.ensureRuntime('bridge-list-test')

    await fixture.postJson('/v1/bridges/local-target', {
      transport: 'legacy-agentchat',
      target: 'list-a@spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    await fixture.postJson('/v1/bridges/local-target', {
      transport: 'legacy-agentchat',
      target: 'list-b@spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    const res = await fixture.fetchSocket(`/v1/bridges?runtimeId=${runtimeId}`)
    expect(res.status).toBe(200)
    const bridges = (await res.json()) as HrcLocalBridgeRecord[]
    expect(bridges.length).toBe(2)
    expect(bridges.map((b) => b.target).sort()).toEqual(['list-a@spaces', 'list-b@spaces'])
  })

  it('excludes closed bridges', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-list-exclude')

    const reg1 = await fixture.postJson('/v1/bridges/local-target', {
      transport: 'legacy-agentchat',
      target: 'still-open@spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    await reg1.json()

    const reg2 = await fixture.postJson('/v1/bridges/local-target', {
      transport: 'legacy-agentchat',
      target: 'now-closed@spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge2 = (await reg2.json()) as HrcLocalBridgeRecord

    await fixture.postJson('/v1/bridges/close', { bridgeId: bridge2.bridgeId })

    const res = await fixture.fetchSocket(`/v1/bridges?runtimeId=${runtimeId}`)
    const bridges = (await res.json()) as HrcLocalBridgeRecord[]
    expect(bridges.length).toBe(1)
    expect(bridges[0].target).toBe('still-open@spaces')
  })

  it('returns 400 when runtimeId is missing', async () => {
    server = await createHrcServer(fixture.serverOpts())

    const res = await fixture.fetchSocket('/v1/bridges')
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// 4. POST /v1/bridges/close — close a bridge
// ---------------------------------------------------------------------------
describe('POST /v1/bridges/close', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('closes a bridge and returns the record with closedAt', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-close-test')

    const regRes = await fixture.postJson('/v1/bridges/local-target', {
      transport: 'legacy-agentchat',
      target: 'close-me@spaces',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    const res = await fixture.postJson('/v1/bridges/close', { bridgeId: bridge.bridgeId })
    expect(res.status).toBe(200)
    const closed = (await res.json()) as HrcLocalBridgeRecord
    expect(closed.closedAt).toBeDefined()
    expect(closed.bridgeId).toBe(bridge.bridgeId)
  })

  it('returns 404 for unknown bridgeId', async () => {
    server = await createHrcServer(fixture.serverOpts())

    const res = await fixture.postJson('/v1/bridges/close', { bridgeId: 'nonexistent' })
    expect(res.status).toBe(404)
  })
})
