/**
 * RED/GREEN tests for Phase 2 canonical bridge endpoints (T-00999)
 *
 * Tests the new canonical bridge surface that replaces legacy bridge endpoints:
 *   - POST /v1/bridges/target  (canonical registration, replaces /v1/bridges/local-target)
 *   - POST /v1/bridges/deliver-text  (real PTY injection, replaces /v1/bridges/deliver)
 *
 * Phase 2 scope:
 *   - deliver-text injects literal text into a real tmux pane
 *   - stale fence rejection on deliver-text
 *   - --enter behavior (append Enter keystroke after text)
 *   - oobSuffix append behavior (append out-of-band suffix to injected text)
 *   - bridge.delivered event contains metadata only (no raw text):
 *       payloadLength, enter, oobSuffixLength, hostSessionId, generation, runtimeId
 *   - capability status reports actualPtyInjection=true, enter=true, oobSuffix=true
 *
 * Pass conditions for Larry (T-00999):
 *   P2-1. POST /v1/bridges/target => 200 + bridge record with bridgeId
 *   P2-2. POST /v1/bridges/deliver-text with valid bridge => 200 + { delivered: true }
 *   P2-3. deliver-text actually injects text into the tmux pane (capture verifies)
 *   P2-4. deliver-text with enter=true appends Enter keystroke (newline in pane capture)
 *   P2-5. deliver-text with oobSuffix appends suffix to injected text
 *   P2-6. deliver-text with stale fence => 409 STALE_CONTEXT
 *   P2-7. bridge.delivered event contains payloadLength, enter, oobSuffixLength,
 *          hostSessionId, generation, runtimeId — but NOT the raw text
 *   P2-8. GET /v1/status reports bridgeDelivery.actualPtyInjection=true,
 *          enter=true, oobSuffix=true
 *   P2-9. deliver-text to closed bridge => 404
 *  P2-10. deliver-text with enter=false does NOT append Enter keystroke
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcCapabilityStatus, HrcHttpError, HrcLocalBridgeRecord } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { TmuxManager } from '../tmux'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture

/**
 * Helper: fetch all events and return parsed envelopes.
 */
async function fetchEvents(): Promise<
  Array<{ hrcSeq: number; eventKind: string; payload: unknown; runtimeId?: string }>
> {
  const res = await fixture.fetchSocket('/v1/events')
  const text = await res.text()
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

/**
 * Helper: set up a tmux pane for bridge testing.
 * Creates a real tmux session via the fixture's tmux socket,
 * seeds a session + runtime with transport=tmux, and returns
 * everything needed to register and deliver through a bridge.
 */
async function setupTmuxBridgeEnv(label: string) {
  const tmux = new TmuxManager(fixture.tmuxSocketPath)
  await tmux.initialize()

  const { hostSessionId, generation } = await fixture.resolveSession(label)
  const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')
  const runtimeId = `rt-tmux-${label}-${Date.now()}`

  // Seed a tmux runtime directly so the bridge can target it
  fixture.seedTmuxRuntime(hostSessionId, label, runtimeId, {
    status: 'ready',
  })

  return { tmux, hostSessionId, generation, runtimeId, pane }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-bridge-phase2-')
})

afterEach(async () => {
  await fixture.cleanup()
})

// ---------------------------------------------------------------------------
// P2-1. POST /v1/bridges/target — canonical registration
// ---------------------------------------------------------------------------
describe('POST /v1/bridges/target', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('registers a bridge and returns the record (P2-1)', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-target-reg')

    const res = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: 'smokey-pane@test',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    expect(res.status).toBe(200)
    const bridge = (await res.json()) as HrcLocalBridgeRecord
    expect(bridge.bridgeId).toBeDefined()
    expect(bridge.transport).toBe('tmux')
    expect(bridge.target).toBe('smokey-pane@test')
    expect(bridge.hostSessionId).toBe(hostSessionId)
    expect(bridge.runtimeId).toBe(runtimeId)
  })
})

// ---------------------------------------------------------------------------
// P2-2 / P2-3. POST /v1/bridges/deliver-text — real PTY injection
// ---------------------------------------------------------------------------
describe('POST /v1/bridges/deliver-text', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('delivers text and returns { delivered: true } (P2-2)', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('deliver-text-basic')

    // Register via canonical endpoint
    const regRes = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: 'basic-deliver@test',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    const res = await fixture.postJson('/v1/bridges/deliver-text', {
      bridgeId: bridge.bridgeId,
      text: 'Hello Phase 2',
      enter: false,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivered: boolean; bridgeId: string }
    expect(body.delivered).toBe(true)
    expect(body.bridgeId).toBe(bridge.bridgeId)
  })

  it('injects literal text into a real tmux pane (P2-3)', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { tmux, hostSessionId, generation, runtimeId, pane } =
      await setupTmuxBridgeEnv('pty-inject')

    // Register bridge targeting the real pane
    const regRes = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: pane.paneId,
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    // Deliver text
    await fixture.postJson('/v1/bridges/deliver-text', {
      bridgeId: bridge.bridgeId,
      text: 'SMOKEY_INJECTION_MARKER',
      enter: false,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    // tmux delivery can take a few scheduler ticks before capture reflects it.
    let captured = ''
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Bun.sleep(100)
      captured = await tmux.capture(pane.paneId)
      if (captured.includes('SMOKEY_INJECTION_MARKER')) {
        break
      }
    }
    expect(captured).toContain('SMOKEY_INJECTION_MARKER')
  })

  // -------------------------------------------------------------------------
  // P2-4. enter=true appends Enter keystroke
  // -------------------------------------------------------------------------
  it('appends Enter keystroke when enter=true (P2-4)', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { tmux, hostSessionId, generation, runtimeId, pane } =
      await setupTmuxBridgeEnv('enter-true')

    const regRes = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: pane.paneId,
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    // Deliver with enter=true — should inject text + Enter
    await fixture.postJson('/v1/bridges/deliver-text', {
      bridgeId: bridge.bridgeId,
      text: 'echo ENTER_TEST_OK',
      enter: true,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    // The Enter should cause the shell to execute the echo command
    await Bun.sleep(500)
    const captured = await tmux.capture(pane.paneId)
    // Shell should have executed `echo ENTER_TEST_OK` and printed output
    expect(captured).toContain('ENTER_TEST_OK')
  })

  // -------------------------------------------------------------------------
  // P2-10. enter=false does NOT append Enter keystroke
  // -------------------------------------------------------------------------
  it('does NOT append Enter when enter=false (P2-10)', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { tmux, hostSessionId, generation, runtimeId, pane } =
      await setupTmuxBridgeEnv('enter-false')

    const regRes = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: pane.paneId,
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    // Deliver with enter=false — text typed but no Enter sent
    await fixture.postJson('/v1/bridges/deliver-text', {
      bridgeId: bridge.bridgeId,
      text: 'NO_ENTER_COMMAND',
      enter: false,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    await Bun.sleep(300)
    const captured = await tmux.capture(pane.paneId)
    // Text should appear on the prompt line but NOT be executed
    // The text should be visible but since no Enter was sent, there should
    // be no command output (only the typed text in the prompt line)
    expect(captured).toContain('NO_ENTER_COMMAND')
    // Split lines — the text should only appear once (on the prompt line),
    // not twice (which would mean the command was executed and echoed output)
    const lines = captured.split('\n').filter((l: string) => l.includes('NO_ENTER_COMMAND'))
    expect(lines.length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // P2-5. oobSuffix append behavior
  // -------------------------------------------------------------------------
  it('appends oobSuffix to the injected text (P2-5)', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { tmux, hostSessionId, generation, runtimeId, pane } =
      await setupTmuxBridgeEnv('oob-suffix')

    const regRes = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: pane.paneId,
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    await fixture.postJson('/v1/bridges/deliver-text', {
      bridgeId: bridge.bridgeId,
      text: 'PAYLOAD',
      oobSuffix: '_OOB_MARKER',
      enter: false,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    await Bun.sleep(200)
    const captured = await tmux.capture(pane.paneId)
    // The full injected text should be PAYLOAD + _OOB_MARKER concatenated
    expect(captured).toContain('PAYLOAD_OOB_MARKER')
  })

  // -------------------------------------------------------------------------
  // P2-6. Stale fence rejection on deliver-text
  // -------------------------------------------------------------------------
  it('rejects deliver-text with stale expectedHostSessionId (P2-6)', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('deliver-text-stale-hsid')

    const regRes = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: 'stale-hsid@test',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    const res = await fixture.postJson('/v1/bridges/deliver-text', {
      bridgeId: bridge.bridgeId,
      text: 'Should be rejected',
      enter: false,
      expectedHostSessionId: 'wrong-session-id',
      expectedGeneration: generation,
    })

    expect(res.status).toBe(409)
    const err = (await res.json()) as { error: HrcHttpError }
    expect(err.error.code).toBe(HrcErrorCode.STALE_CONTEXT)
  })

  it('rejects deliver-text with stale expectedGeneration (P2-6)', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('deliver-text-stale-gen')

    const regRes = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: 'stale-gen@test',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    const res = await fixture.postJson('/v1/bridges/deliver-text', {
      bridgeId: bridge.bridgeId,
      text: 'Should be rejected',
      enter: false,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: 999,
    })

    expect(res.status).toBe(409)
    const err = (await res.json()) as { error: HrcHttpError }
    expect(err.error.code).toBe(HrcErrorCode.STALE_CONTEXT)
  })

  // -------------------------------------------------------------------------
  // P2-9. deliver-text to closed bridge => 404
  // -------------------------------------------------------------------------
  it('returns 404 when delivering to a closed bridge (P2-9)', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('deliver-text-closed')

    const regRes = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: 'closed@test',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    // Close the bridge
    await fixture.postJson('/v1/bridges/close', { bridgeId: bridge.bridgeId })

    const res = await fixture.postJson('/v1/bridges/deliver-text', {
      bridgeId: bridge.bridgeId,
      text: 'Should 404',
      enter: false,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// P2-7. bridge.delivered event — metadata only, no raw text
// ---------------------------------------------------------------------------
describe('bridge.delivered event metadata (P2-7)', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('contains payloadLength, enter, oobSuffixLength, hostSessionId, generation, runtimeId', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } = await fixture.ensureRuntime('event-metadata')

    const regRes = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: 'event-meta@test',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    await fixture.postJson('/v1/bridges/deliver-text', {
      bridgeId: bridge.bridgeId,
      text: 'Hello event world',
      enter: true,
      oobSuffix: '__OOB',
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    const events = await fetchEvents()
    const delivered = events.find((e) => e.eventKind === 'bridge.delivered')
    expect(delivered).toBeDefined()

    const ej = delivered!.payload as Record<string, unknown>

    // Required metadata fields
    expect(ej['payloadLength']).toBe(17) // 'Hello event world'.length
    expect(ej['enter']).toBe(true)
    expect(ej['oobSuffixLength']).toBe(5) // '__OOB'.length
    expect(delivered!.hostSessionId).toBe(hostSessionId)
    expect(delivered!.generation).toBe(generation)
    expect(delivered!.runtimeId).toBe(runtimeId)

    // MUST NOT contain raw text — security/privacy requirement
    expect(ej['text']).toBeUndefined()
  })

  it('reports oobSuffixLength=0 when no oobSuffix provided', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const { hostSessionId, generation, runtimeId } = await fixture.ensureRuntime('event-no-oob')

    const regRes = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: 'event-no-oob@test',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    await fixture.postJson('/v1/bridges/deliver-text', {
      bridgeId: bridge.bridgeId,
      text: 'No suffix test',
      enter: false,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    const events = await fetchEvents()
    const delivered = events.find((e) => e.eventKind === 'bridge.delivered')
    expect(delivered).toBeDefined()

    const ej = delivered!.payload as Record<string, unknown>
    expect(ej['payloadLength']).toBe(14) // 'No suffix test'.length
    expect(ej['enter']).toBe(false)
    expect(ej['oobSuffixLength']).toBe(0)
    expect(ej['text']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// P2-8. Capability status reports actualPtyInjection=true
// ---------------------------------------------------------------------------
describe('GET /v1/status capability flags (P2-8)', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('reports bridgeDelivery with actualPtyInjection=true, enter=true, oobSuffix=true', async () => {
    server = await createHrcServer(fixture.serverOpts())

    const res = await fixture.fetchSocket('/v1/status')
    expect(res.status).toBe(200)
    const status = (await res.json()) as HrcCapabilityStatus

    expect(status.capabilities.bridgeDelivery.actualPtyInjection).toBe(true)
    expect(status.capabilities.bridgeDelivery.enter).toBe(true)
    expect(status.capabilities.bridgeDelivery.oobSuffix).toBe(true)
    expect(status.capabilities.bridgeDelivery.freshnessFence).toBe(true)
  })
})
