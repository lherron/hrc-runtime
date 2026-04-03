/**
 * RED/GREEN tests for T-01007: Fix /v1/bridges/target appSession selector support
 *
 * BUG: POST /v1/bridges/target with the canonical selector-first payload
 * { selector: { appSession: {...} }, bridge: "legacy-agentchat" } returns
 * 400 "transport is required" because parseBridgeTargetRequest() unconditionally
 * calls requireTrimmedStringField(input, 'transport').
 *
 * The canonical form sends ONLY selector + bridge (profile name). No top-level
 * transport or target. The handler must:
 *   1. Accept { selector, bridge } without transport/target
 *   2. Resolve the session via selector.appSession -> appManagedSessions
 *   3. Resolve transport from the bridge profile (bridge field = transport)
 *   4. Resolve the active runtime for the managed session
 *   5. Create a localBridges record usable by deliver-text
 *
 * Pass conditions for Larry (T-01007):
 *   T7-1. POST /v1/bridges/target with { selector.appSession, bridge } (no
 *          transport/target) => 200 with valid bridge record. Response must
 *          include hostSessionId, runtimeId resolved from managed session.
 *   T7-2. The returned bridge works with POST /v1/bridges/deliver-text,
 *          injecting text into a real tmux pane.
 *   T7-3. POST /v1/bridges/target with non-existent selector.appSession
 *          (and no transport/target) => 404 UNKNOWN_APP_SESSION.
 *   T7-4. Legacy form with top-level transport/target still works (backwards
 *          compat regression guard).
 *
 * Implementation notes for Larry:
 *   - parseBridgeTargetRequest() must make transport/target optional when
 *     selector + bridge are present.
 *   - handleRegisterBridgeTarget() must resolve transport from bridge field
 *     and target/runtimeId from the managed session's active runtime when
 *     not provided top-level.
 *   - The bridge field value (e.g. "legacy-agentchat") becomes the stored
 *     transport in the localBridges record.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcHttpError, HrcLocalBridgeRecord, HrcManagedSessionRecord } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { TmuxManager } from '../tmux'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let fixture: HrcServerTestFixture
let server: HrcServer

type EnsureResponse = {
  session: HrcManagedSessionRecord
  created: boolean
  restarted: boolean
  status: string
  runtimeId?: string
}

/**
 * Ensure a managed app-session via the server API.
 * Creates the session in db.appManagedSessions (the canonical table).
 */
async function ensureManagedSession(
  appId: string,
  appSessionKey: string,
  kind: 'harness' | 'command' = 'harness'
): Promise<EnsureResponse & { hostSessionId: string; generation: number }> {
  const res = await fixture.postJson('/v1/app-sessions/ensure', {
    selector: { appId, appSessionKey },
    spec: {
      kind,
      ...(kind === 'harness'
        ? {
            runtimeIntent: {
              placement: 'workspace',
              harness: { provider: 'anthropic', interactive: true },
            },
          }
        : {
            command: { argv: ['echo', 'hello'] },
          }),
    },
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as EnsureResponse
  return {
    ...body,
    hostSessionId: body.session.activeHostSessionId,
    generation: body.session.generation,
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-bridge-appsession-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

// ---------------------------------------------------------------------------
// T7-1. Canonical selector-first bridge acquisition: { selector, bridge }
//
// RED on current HEAD: parseBridgeTargetRequest() requires transport field.
// Actual response: 400 { error: { code: "malformed_request", message: "transport is required" } }
// ---------------------------------------------------------------------------
describe('POST /v1/bridges/target — canonical selector + bridge (T-01007)', () => {
  it('resolves to 200 with selector.appSession + bridge, no transport/target (T7-1)', async () => {
    const { hostSessionId } = await ensureManagedSession('bridge-t7', 'worker-1')

    // Seed a runtime so the handler can resolve runtimeId from the session
    const runtimeId = `rt-t7-${Date.now()}`
    fixture.seedTmuxRuntime(hostSessionId, 'app:bridge-t7', runtimeId, {
      status: 'ready',
    })

    // Canonical form: selector + bridge profile, NO transport/target
    const res = await fixture.postJson('/v1/bridges/target', {
      selector: {
        appSession: {
          appId: 'bridge-t7',
          appSessionKey: 'worker-1',
        },
      },
      bridge: 'legacy-agentchat',
    })

    // Pass condition: 200 with bridge record resolving from managed session
    expect(res.status).toBe(200)
    const bridge = (await res.json()) as HrcLocalBridgeRecord
    expect(bridge.bridgeId).toBeDefined()
    expect(bridge.bridgeId.length).toBeGreaterThan(0)
    expect(bridge.hostSessionId).toBe(hostSessionId)
    expect(bridge.runtimeId).toBe(runtimeId)
    expect(bridge.status).toBe('active')
    // Bridge profile name becomes stored transport
    expect(bridge.transport).toBe('legacy-agentchat')
  })

  it('resolves hostSessionId and generation from managed session continuity (T7-1)', async () => {
    const { hostSessionId } = await ensureManagedSession('bridge-t7-cont', 'cont-1')

    const runtimeId = `rt-t7-cont-${Date.now()}`
    fixture.seedTmuxRuntime(hostSessionId, 'app:bridge-t7-cont', runtimeId, {
      status: 'ready',
    })

    const res = await fixture.postJson('/v1/bridges/target', {
      selector: {
        appSession: {
          appId: 'bridge-t7-cont',
          appSessionKey: 'cont-1',
        },
      },
      bridge: 'legacy-agentchat',
    })

    expect(res.status).toBe(200)
    const bridge = (await res.json()) as HrcLocalBridgeRecord
    // Bridge must be anchored to the continuity-resolved host session
    expect(bridge.hostSessionId).toBe(hostSessionId)
  })
})

// ---------------------------------------------------------------------------
// T7-2. deliver-text through canonical appSession-resolved bridge
//
// RED on current HEAD: bridge registration itself 400s (T7-1), so this
// cannot succeed. When T7-1 is green, this validates end-to-end PTY
// injection through the bridge created via selector + bridge profile.
// ---------------------------------------------------------------------------
describe('POST /v1/bridges/deliver-text — via canonical appSession bridge (T-01007)', () => {
  it('injects text into a real tmux pane through a selector-resolved bridge (T7-2)', async () => {
    const { hostSessionId, generation } = await ensureManagedSession(
      'bridge-t7-tmux',
      'worker-tmux'
    )

    // Set up a real tmux pane
    const tmux = new TmuxManager(fixture.tmuxSocketPath)
    await tmux.initialize()
    const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')

    // Seed tmux runtime with real pane info
    const runtimeId = `rt-t7-tmux-${Date.now()}`
    fixture.seedTmuxRuntime(hostSessionId, 'app:bridge-t7-tmux', runtimeId, {
      status: 'ready',
    })

    // Register bridge using canonical form (selector + bridge, no transport/target)
    const regRes = await fixture.postJson('/v1/bridges/target', {
      selector: {
        appSession: {
          appId: 'bridge-t7-tmux',
          appSessionKey: 'worker-tmux',
        },
      },
      bridge: 'legacy-agentchat',
    })

    expect(regRes.status).toBe(200)
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord
    expect(bridge.bridgeId).toBeDefined()

    // Deliver text through the bridge
    const deliverRes = await fixture.postJson('/v1/bridges/deliver-text', {
      bridgeId: bridge.bridgeId,
      text: 'T01007_CANONICAL_MARKER',
      enter: false,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    expect(deliverRes.status).toBe(200)
    const deliverBody = (await deliverRes.json()) as { delivered: boolean; bridgeId: string }
    expect(deliverBody.delivered).toBe(true)
    expect(deliverBody.bridgeId).toBe(bridge.bridgeId)

    // Verify text actually landed in the tmux pane
    await Bun.sleep(300)
    const captured = await tmux.capture(pane.paneId)
    expect(captured).toContain('T01007_CANONICAL_MARKER')
  })
})

// ---------------------------------------------------------------------------
// T7-3. Missing appSession with canonical form => 404 UNKNOWN_APP_SESSION
//
// RED on current HEAD: 400 "transport is required" (parsing fails before
// session resolution). When parsing is fixed, must yield 404 from
// resolveBridgeTargetSession().
// ---------------------------------------------------------------------------
describe('POST /v1/bridges/target — missing appSession canonical (T-01007)', () => {
  it('returns 404 UNKNOWN_APP_SESSION for non-existent appSession (T7-3)', async () => {
    const res = await fixture.postJson('/v1/bridges/target', {
      selector: {
        appSession: {
          appId: 'does-not-exist',
          appSessionKey: 'also-missing',
        },
      },
      bridge: 'legacy-agentchat',
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: HrcHttpError }
    expect(body.error).toBeDefined()
    expect(body.error.code).toBe(HrcErrorCode.UNKNOWN_APP_SESSION)
  })

  it('returns 404 UNKNOWN_APP_SESSION for removed appSession (T7-3)', async () => {
    await ensureManagedSession('bridge-t7-rm', 'to-remove')
    const removeRes = await fixture.postJson('/v1/app-sessions/remove', {
      selector: {
        appId: 'bridge-t7-rm',
        appSessionKey: 'to-remove',
      },
    })
    expect(removeRes.status).toBe(200)

    const res = await fixture.postJson('/v1/bridges/target', {
      selector: {
        appSession: {
          appId: 'bridge-t7-rm',
          appSessionKey: 'to-remove',
        },
      },
      bridge: 'legacy-agentchat',
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: HrcHttpError }
    expect(body.error).toBeDefined()
    expect(body.error.code).toBe(HrcErrorCode.UNKNOWN_APP_SESSION)
  })
})

// ---------------------------------------------------------------------------
// T7-4. Legacy backwards compatibility: top-level transport/target still works
//
// This must stay GREEN — regression guard for existing callers.
// ---------------------------------------------------------------------------
describe('POST /v1/bridges/target — legacy transport/target compat (T-01007)', () => {
  it('still accepts top-level transport/target without selector (T7-4)', async () => {
    const { hostSessionId, generation, runtimeId } =
      await fixture.ensureRuntime('bridge-legacy-compat')

    const res = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: 'legacy-compat@test',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    expect(res.status).toBe(200)
    const bridge = (await res.json()) as HrcLocalBridgeRecord
    expect(bridge.bridgeId).toBeDefined()
    expect(bridge.transport).toBe('tmux')
    expect(bridge.target).toBe('legacy-compat@test')
    expect(bridge.hostSessionId).toBe(hostSessionId)
  })

  it('still accepts selector.appSession WITH transport/target (T7-4)', async () => {
    const { hostSessionId } = await ensureManagedSession('bridge-t7-both', 'both-1')

    const runtimeId = `rt-t7-both-${Date.now()}`
    fixture.seedTmuxRuntime(hostSessionId, 'app:bridge-t7-both', runtimeId, {
      status: 'ready',
    })

    const res = await fixture.postJson('/v1/bridges/target', {
      selector: {
        appSession: {
          appId: 'bridge-t7-both',
          appSessionKey: 'both-1',
        },
      },
      transport: 'tmux',
      target: 'explicit-target@test',
      runtimeId,
    })

    expect(res.status).toBe(200)
    const bridge = (await res.json()) as HrcLocalBridgeRecord
    expect(bridge.transport).toBe('tmux')
    expect(bridge.target).toBe('explicit-target@test')
    expect(bridge.hostSessionId).toBe(hostSessionId)
  })
})
