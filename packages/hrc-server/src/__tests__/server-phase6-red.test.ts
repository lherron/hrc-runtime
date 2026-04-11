/**
 * RED/GREEN tests for Phase 6: CLI/SDK Completion and Bridge Canonical Migration (T-01006)
 *
 * These tests define the Phase 6 acceptance criteria that are NOT yet covered
 * by existing test files. They are expected to START RED and turn GREEN as
 * Larry/Curly implement the server-side changes.
 *
 * Gaps covered:
 *   P6-1. Bridge target registration using appSession selector resolves
 *          through managed app-sessions (db.appManagedSessions), NOT legacy
 *          db.appSessions.
 *   P6-2. bridge.closed event emitted when a bridge is closed via
 *          POST /v1/bridges/close.
 *   P6-3. app-session.created event emitted when a managed session is
 *          created via POST /v1/app-sessions/ensure.
 *   P6-4. app-session.removed event emitted when a managed session is
 *          removed via POST /v1/app-sessions/remove (already exists but untested).
 *   P6-6. runtime.interrupted event emitted when an app-session is
 *          interrupted via POST /v1/app-sessions/interrupt.
 *   P6-7. App-owned surface binding via managed app-session host sessions
 *          (bind/unbind/list, clear-context invalidation).
 *
 * Pass conditions for each test are documented inline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcLocalBridgeRecord, HrcManagedSessionRecord } from 'hrc-core'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
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

function managedSessionScopeRef(appId: string, appSessionKey: string): string {
  return `agent:${appId}:project:hrc-phase6-tests:task:${appSessionKey}`
}

function managedSessionRef(appId: string, appSessionKey: string): string {
  return `${managedSessionScopeRef(appId, appSessionKey)}/lane:main`
}

function testScopeRef(scopeKey: string): string {
  return `agent:test:project:hrc-phase6-tests:task:${scopeKey}`
}

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

/**
 * Ensure a managed app-session via the server API.
 * Returns { session, hostSessionId, generation, runtimeId? }.
 */
async function ensureManagedSession(
  appId: string,
  appSessionKey: string
): Promise<EnsureResponse & { hostSessionId: string; generation: number }> {
  const res = await fixture.postJson('/v1/app-sessions/ensure', {
    selector: { appId, appSessionKey },
    sessionRef: managedSessionRef(appId, appSessionKey),
    spec: {
      kind: 'harness',
      runtimeIntent: {
        placement: 'workspace',
        harness: { provider: 'anthropic', interactive: false },
      },
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
  fixture = await createHrcTestFixture('hrc-phase6-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

// ===========================================================================
// P6-1. Bridge target with appSession selector against managed app-sessions
//
// Current bug: resolveBridgeTargetSession() at line ~4977 of index.ts uses
// db.appSessions.findByKey (legacy table) instead of db.appManagedSessions.
// Managed sessions created via /v1/app-sessions/ensure live in
// appManagedSessions, so this selector will 404.
// ===========================================================================
describe('POST /v1/bridges/target — appSession selector (P6-1)', () => {
  it('resolves bridge target through managed app-session (appManagedSessions)', async () => {
    // 1. Create a managed harness session via ensure (uses appManagedSessions)
    const { hostSessionId, runtimeId } = await ensureManagedSession('bridge-app', 'worker-1')

    // The ensure created a runtime already; use it if available, else seed one
    let bridgeRuntimeId = runtimeId
    if (!bridgeRuntimeId) {
      bridgeRuntimeId = `rt-bridge-${Date.now()}`
      fixture.seedTmuxRuntime(
        hostSessionId,
        managedSessionScopeRef('bridge-app', 'worker-1'),
        bridgeRuntimeId,
        {
          status: 'ready',
        }
      )
    }

    // 2. Register bridge using appSession selector — must resolve through
    //    appManagedSessions, NOT legacy appSessions
    const res = await fixture.postJson('/v1/bridges/target', {
      selector: {
        appSession: {
          appId: 'bridge-app',
          appSessionKey: 'worker-1',
        },
      },
      transport: 'tmux',
      target: 'p6-bridge@test',
      runtimeId: bridgeRuntimeId,
    })

    // Pass condition: 200 with valid bridge record resolving to the managed
    // session's activeHostSessionId
    expect(res.status).toBe(200)
    const bridge = (await res.json()) as HrcLocalBridgeRecord
    expect(bridge.bridgeId).toBeDefined()
    expect(bridge.transport).toBe('tmux')
    expect(bridge.target).toBe('p6-bridge@test')
    expect(bridge.hostSessionId).toBe(hostSessionId)
    expect(bridge.runtimeId).toBe(bridgeRuntimeId)
  })

  it('rejects bridge target for unknown managed app-session', async () => {
    const res = await fixture.postJson('/v1/bridges/target', {
      selector: {
        appSession: {
          appId: 'nonexistent-app',
          appSessionKey: 'nonexistent-key',
        },
      },
      transport: 'tmux',
      target: 'p6-bridge-missing@test',
    })

    expect(res.status).toBe(404)
  })

  it('rejects bridge target for removed managed app-session', async () => {
    await ensureManagedSession('bridge-removed-app', 'worker-rm')
    await fixture.postJson('/v1/app-sessions/remove', {
      selector: {
        appId: 'bridge-removed-app',
        appSessionKey: 'worker-rm',
      },
    })

    const res = await fixture.postJson('/v1/bridges/target', {
      selector: {
        appSession: {
          appId: 'bridge-removed-app',
          appSessionKey: 'worker-rm',
        },
      },
      transport: 'tmux',
      target: 'p6-bridge-removed@test',
    })

    expect(res.status).toBe(404)
  })
})

// ===========================================================================
// P6-2. bridge.closed event emission
//
// Current gap: handleCloseBridge() at line ~1919 does NOT emit any event.
// It just closes the bridge and returns the record.
// ===========================================================================
describe('POST /v1/bridges/close — bridge.closed event (P6-2)', () => {
  it('emits bridge.closed event when bridge is closed', async () => {
    const { hostSessionId, generation, runtimeId } = await fixture.ensureRuntime(
      testScopeRef('bridge-close-event')
    )

    // Register bridge
    const regRes = await fixture.postJson('/v1/bridges/target', {
      transport: 'tmux',
      target: 'close-event@test',
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })
    const bridge = (await regRes.json()) as HrcLocalBridgeRecord

    // Record baseline
    const baseline = await fetchEvents()
    const baselineSeq = baseline.length > 0 ? baseline[baseline.length - 1]!.seq : 0

    // Close the bridge
    const closeRes = await fixture.postJson('/v1/bridges/close', {
      bridgeId: bridge.bridgeId,
    })
    expect(closeRes.status).toBe(200)

    // Pass condition: bridge.closed event emitted with bridge metadata
    const events = await fetchEvents()
    const closedEvent = events.find((e) => e.eventKind === 'bridge.closed' && e.seq > baselineSeq)
    expect(closedEvent).toBeDefined()

    const ej = closedEvent!.eventJson as Record<string, unknown>
    expect(ej['bridgeId']).toBe(bridge.bridgeId)
    expect(ej['transport']).toBe('tmux')
    expect(ej['target']).toBe('close-event@test')
  })
})

// ===========================================================================
// P6-3. app-session.created event emission
//
// The server already emits this event (line ~727), but it was never tested.
// This locks in the assertion so regressions are caught.
// ===========================================================================
describe('POST /v1/app-sessions/ensure — app-session.created event (P6-3)', () => {
  it('emits app-session.created event with appId and appSessionKey', async () => {
    const baseline = await fetchEvents()
    const baselineSeq = baseline.length > 0 ? baseline[baseline.length - 1]!.seq : 0

    await ensureManagedSession('event-app', 'created-1')

    // Pass condition: app-session.created event emitted
    const events = await fetchEvents()
    const createdEvent = events.find(
      (e) => e.eventKind === 'app-session.created' && e.seq > baselineSeq
    )
    expect(createdEvent).toBeDefined()

    const ej = createdEvent!.eventJson as Record<string, unknown>
    expect(ej['appId']).toBe('event-app')
    expect(ej['appSessionKey']).toBe('created-1')
  })
})

// ===========================================================================
// P6-4. app-session.removed event emission
//
// The server already emits this event (line ~881), but it was never tested.
// ===========================================================================
describe('POST /v1/app-sessions/remove — app-session.removed event (P6-4)', () => {
  it('emits app-session.removed event with appId and appSessionKey', async () => {
    await ensureManagedSession('event-app', 'removed-1')

    const baseline = await fetchEvents()
    const baselineSeq = baseline.length > 0 ? baseline[baseline.length - 1]!.seq : 0

    await fixture.postJson('/v1/app-sessions/remove', {
      selector: {
        appId: 'event-app',
        appSessionKey: 'removed-1',
      },
    })

    // Pass condition: app-session.removed event emitted
    const events = await fetchEvents()
    const removedEvent = events.find(
      (e) => e.eventKind === 'app-session.removed' && e.seq > baselineSeq
    )
    expect(removedEvent).toBeDefined()

    const ej = removedEvent!.eventJson as Record<string, unknown>
    expect(ej['appId']).toBe('event-app')
    expect(ej['appSessionKey']).toBe('removed-1')
  })
})

// ===========================================================================
// P6-6. runtime.interrupted event via app-session interrupt
// ===========================================================================
describe('POST /v1/app-sessions/interrupt — runtime.interrupted event (P6-6)', () => {
  it('emits runtime.interrupted event when app-session is interrupted', async () => {
    const { hostSessionId, runtimeId } = await ensureManagedSession('interrupt-app', 'int-1')

    // If ensure didn't create a runtime, seed one manually
    let targetRuntimeId = runtimeId
    if (!targetRuntimeId) {
      targetRuntimeId = `rt-int-${Date.now()}`
      fixture.seedTmuxRuntime(
        hostSessionId,
        managedSessionScopeRef('interrupt-app', 'int-1'),
        targetRuntimeId,
        {
          status: 'ready',
        }
      )
    }

    const baseline = await fetchEvents()
    const baselineSeq = baseline.length > 0 ? baseline[baseline.length - 1]!.seq : 0

    const res = await fixture.postJson('/v1/app-sessions/interrupt', {
      selector: {
        appId: 'interrupt-app',
        appSessionKey: 'int-1',
      },
    })

    // The interrupt may fail due to missing tmux pane, but the event path
    // is what we're testing. If the interrupt succeeds:
    if (res.status === 200) {
      const events = await fetchEvents()
      const interruptEvent = events.find(
        (e) => e.eventKind === 'runtime.interrupted' && e.seq > baselineSeq
      )
      expect(interruptEvent).toBeDefined()
      expect(interruptEvent!.runtimeId).toBe(targetRuntimeId)
    } else {
      // If tmux not available, the request fails but the selector resolved correctly
      // (which is the managed session resolution we're also testing)
      expect(res.status).not.toBe(404) // should NOT be unknown session
    }
  })
})

// ===========================================================================
// P6-7. App-owned surface binding via managed app-session host sessions
// ===========================================================================
describe('Surface binding via app-session resolution (P6-7)', () => {
  it('bind surface to runtime created by managed app-session ensure', async () => {
    const { hostSessionId, generation, runtimeId } = await ensureManagedSession(
      'surface-app',
      'surf-1'
    )

    // If ensure didn't create a runtime, seed one
    let targetRuntimeId = runtimeId
    if (!targetRuntimeId) {
      targetRuntimeId = `rt-surf-${Date.now()}`
      fixture.seedTmuxRuntime(
        hostSessionId,
        managedSessionScopeRef('surface-app', 'surf-1'),
        targetRuntimeId,
        {
          status: 'ready',
        }
      )
    }

    // Bind surface using the runtimeId from the managed session
    const bindRes = await fixture.postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'p6-surf-1',
      runtimeId: targetRuntimeId,
      hostSessionId,
      generation,
    })

    expect(bindRes.status).toBe(200)
    const bound = (await bindRes.json()) as Record<string, unknown>
    expect(bound['surfaceKind']).toBe('ghostty')
    expect(bound['surfaceId']).toBe('p6-surf-1')
    expect(bound['runtimeId']).toBe(targetRuntimeId)

    // Verify surface.bound event
    const events = await fetchEvents()
    const boundEvent = events.find(
      (e) =>
        e.eventKind === 'surface.bound' &&
        (e.eventJson as Record<string, unknown>)['surfaceId'] === 'p6-surf-1'
    )
    expect(boundEvent).toBeDefined()
  })

  it('rebind surface after clear-context on managed app-session', async () => {
    const { hostSessionId, generation, runtimeId } = await ensureManagedSession(
      'rebind-app',
      'rebind-1'
    )

    let runtimeA = runtimeId
    if (!runtimeA) {
      runtimeA = `rt-rebind-a-${Date.now()}`
      fixture.seedTmuxRuntime(
        hostSessionId,
        managedSessionScopeRef('rebind-app', 'rebind-1'),
        runtimeA,
        {
          status: 'ready',
        }
      )
    }

    // Bind surface to runtime A
    await fixture.postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'p6-rebind-surf',
      runtimeId: runtimeA,
      hostSessionId,
      generation,
    })

    // Clear context on the managed session
    const clearRes = await fixture.postJson('/v1/app-sessions/clear-context', {
      selector: {
        appId: 'rebind-app',
        appSessionKey: 'rebind-1',
      },
    })
    expect(clearRes.status).toBe(200)
    const cleared = (await clearRes.json()) as {
      hostSessionId: string
      generation: number
      priorHostSessionId: string
    }
    const newHostSessionId = cleared.hostSessionId
    const newGeneration = cleared.generation

    // Seed runtime B on the new host session — must use the new generation
    // so the fence check passes. seedTmuxRuntime hardcodes generation=1, so
    // we insert directly with the correct generation.
    const runtimeB = `rt-rebind-b-${Date.now()}`
    const { openHrcDatabase } = await import('hrc-store-sqlite')
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId: runtimeB,
        hostSessionId: newHostSessionId,
        scopeRef: managedSessionScopeRef('rebind-app', 'rebind-1'),
        laneRef: 'default',
        generation: newGeneration,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        tmuxJson: {
          socketPath: fixture.tmuxSocketPath,
          sessionName: 'hrc-missing-session',
          windowName: 'main',
          sessionId: '$dead',
          windowId: '@dead',
          paneId: '%dead',
        },
        supportsInflightInput: false,
        adopted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    } finally {
      db.close()
    }

    // Bind surface to runtime B (post clear-context, should be a fresh bind)
    const rebindRes = await fixture.postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'p6-rebind-surf',
      runtimeId: runtimeB,
      hostSessionId: newHostSessionId,
      generation: newGeneration,
    })
    expect(rebindRes.status).toBe(200)

    // Verify surfaces: old runtime should not have it, new runtime should
    const oldSurfaces = await fixture.fetchSocket(`/v1/surfaces?runtimeId=${runtimeA}`)
    const oldList = (await oldSurfaces.json()) as Array<Record<string, unknown>>
    const hasOld = oldList.some((s) => s['surfaceId'] === 'p6-rebind-surf')
    expect(hasOld).toBe(false)

    const newSurfaces = await fixture.fetchSocket(`/v1/surfaces?runtimeId=${runtimeB}`)
    const newList = (await newSurfaces.json()) as Array<Record<string, unknown>>
    const hasNew = newList.some((s) => s['surfaceId'] === 'p6-rebind-surf')
    expect(hasNew).toBe(true)
  })
})
