/**
 * RED/GREEN tests for AgentchatBridge (T-00971 / Phase 5)
 *
 * Tests the hrc-bridge-agentchat package which adapts HRC local bridge
 * registration/delivery to agentchat DM transport:
 *   - registerTarget() registers a local bridge with HRC and returns bridgeId
 *   - deliver() sends text through the bridge via HRC deliver endpoint
 *   - deliver() rejects with stale fence error when context has rotated
 *   - close() closes the bridge registration
 *   - Constructor wires HrcClient + agentchat transport config
 *
 * This package wraps HRC SDK calls. Tests use a real HRC server (no mocks).
 *
 * Pass conditions for Curly (T-00971):
 *   1. AgentchatBridge class is exported from hrc-bridge-agentchat
 *   2. Constructor accepts { socketPath, transport, target } (or HrcClient + bridge config)
 *   3. registerTarget() calls POST /v1/bridges/local-target and returns { bridgeId }
 *   4. registerTarget() with fence params stores expectedHostSessionId + expectedGeneration
 *   5. deliver(text) calls POST /v1/bridges/deliver with bridgeId + text
 *   6. deliver() returns { delivered: true } on success
 *   7. deliver() throws/rejects with stale_context when fence fails
 *   8. close() calls POST /v1/bridges/close and marks bridge closed
 *   9. close() is idempotent (calling twice does not error)
 *  10. After close(), deliver() rejects (bridge no longer active)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// RED GATE: AgentchatBridge class does not exist yet
import { AgentchatBridge } from '../agentchat-bridge'

let fixture: HrcServerTestFixture

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-bridge-agentchat-test-')
})

afterEach(async () => {
  await fixture.cleanup()
})

// ---------------------------------------------------------------------------
// 1. AgentchatBridge construction and registerTarget
// ---------------------------------------------------------------------------
describe('AgentchatBridge.registerTarget', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('registers a local bridge target and returns bridgeId', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } = await fixture.ensureRuntime('bridge-reg-test')

    const bridge = new AgentchatBridge({
      socketPath: fixture.socketPath,
      transport: 'legacy-agentchat',
      target: 'reg-test@agent-spaces',
    })

    const result = await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    expect(result.bridgeId).toBeDefined()
    expect(typeof result.bridgeId).toBe('string')
  })

  it('stores fence params from registration', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } = await fixture.ensureRuntime('bridge-fence-reg')

    const bridge = new AgentchatBridge({
      socketPath: fixture.socketPath,
      transport: 'legacy-agentchat',
      target: 'fence-reg@agent-spaces',
    })

    const result = await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    // Verify via DB that fence was stored
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const record = db.localBridges.findById(result.bridgeId)
      expect(record).not.toBeNull()
      expect(record!.expectedHostSessionId).toBe(hostSessionId)
      expect(record!.expectedGeneration).toBe(generation)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. AgentchatBridge.deliver
// ---------------------------------------------------------------------------
describe('AgentchatBridge.deliver', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('delivers text through the bridge', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } = await fixture.ensureRuntime('bridge-deliver')

    const bridge = new AgentchatBridge({
      socketPath: fixture.socketPath,
      transport: 'legacy-agentchat',
      target: 'deliver@agent-spaces',
    })

    await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    const result = await bridge.deliver('Hello from agentchat bridge')
    expect(result.delivered).toBe(true)
  })

  it('rejects with stale_context when fence has rotated', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } = await fixture.ensureRuntime('bridge-stale')

    const bridge = new AgentchatBridge({
      socketPath: fixture.socketPath,
      transport: 'legacy-agentchat',
      target: 'stale@agent-spaces',
    })

    await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    // Simulate context rotation by bumping the session's generation via
    // raw SQL. Fence validation checks the session, so this makes the
    // bridge's registered fence stale.
    const db = openHrcDatabase(fixture.dbPath)
    db.sqlite.exec(
      `UPDATE sessions SET generation = ${generation + 100} WHERE host_session_id = '${hostSessionId}'`
    )
    db.close()

    // The bridge still holds the original fence from registerTarget,
    // which now mismatches the session's current generation — expect 409
    await expect(bridge.deliver('Should fail')).rejects.toThrow(/stale_context/)
  })
})

// ---------------------------------------------------------------------------
// 3. AgentchatBridge.close
// ---------------------------------------------------------------------------
describe('AgentchatBridge.close', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('closes the bridge registration', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } = await fixture.ensureRuntime('bridge-close')

    const bridge = new AgentchatBridge({
      socketPath: fixture.socketPath,
      transport: 'legacy-agentchat',
      target: 'close@agent-spaces',
    })

    await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    await bridge.close()

    // Verify via DB
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const record = db.localBridges.findByTarget('legacy-agentchat', 'close@agent-spaces')
      expect(record).not.toBeNull()
      expect(record!.closedAt).toBeDefined()
    } finally {
      db.close()
    }
  })

  it('is idempotent — calling close twice does not error', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-close-idem')

    const bridge = new AgentchatBridge({
      socketPath: fixture.socketPath,
      transport: 'legacy-agentchat',
      target: 'close-idem@agent-spaces',
    })

    await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    await bridge.close()
    // Second close should not throw
    await bridge.close()
  })

  it('deliver rejects after close', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-deliver-closed')

    const bridge = new AgentchatBridge({
      socketPath: fixture.socketPath,
      transport: 'legacy-agentchat',
      target: 'deliver-closed@agent-spaces',
    })

    await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    await bridge.close()

    // Deliver after close should fail
    await expect(bridge.deliver('Should fail')).rejects.toThrow()
  })
})
