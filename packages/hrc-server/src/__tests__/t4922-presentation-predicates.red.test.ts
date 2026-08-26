import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { toTargetCapabilities, toTargetRuntimeView, toTargetState } from '../target-view'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// ─── Fixture constants ─────────────────────────────────────────────────────────
//
// These paths do NOT exist on disk — the broker tmux socket is absent so
// reconcileTmuxRuntimeLiveness (once it admits headless+tmux-tui) will
// classify the runtime as stale/terminated, not keep it alive.

const BTMUX_SOCKET = '/tmp/hrc-t4922/btmux/codex-app-server-rt-4922-tui.sock'
const BROKER_IPC_SOCKET = '/tmp/hrc-t4922/bipc/a1b2c3d4e5f6/b.sock'
const ATTACH_TOKEN_PATH = '/tmp/hrc-t4922/bipc/a1b2c3d4e5f6/attach.token'
const EVENT_LEDGER = '/tmp/hrc-t4922/bipc/a1b2c3d4e5f6/events.ndjson'
const SESSION_NAME = 'hrc-codex-app-server-rt-4922-tui'

// Separate broker process window (substrate) and TUI window (presentation).
const BROKER_WINDOW = { sessionId: '$10', windowId: '@10', paneId: '%10' }
const TUI_WINDOW = { sessionId: '$10', windowId: '@11', paneId: '%11' }

// ─── Runtime snapshot builders ────────────────────────────────────────────────

/**
 * Phase A headless+tmux-tui runtime (transport='headless', presentation.kind='tmux-tui').
 * Normalized hosting-state shape (substrate + presentation keys, not flat brokerWindow/tuiWindow).
 * This is the codex-app-server viewer shape produced by T-04921.
 */
function makeHeadlessTuiRuntime(overrides: Partial<HrcRuntimeSnapshot> = {}): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-4922-tui',
    hostSessionId: 'hsid-4922-tui',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:tui',
    laneRef: 'main',
    generation: 1,
    // KEY: transport='headless' — this is the Phase B misclassification trigger.
    // After fix the gates switch to presentation predicates, NOT transport.
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    // tmuxJson carries the TUI window identity used by reconcileTmuxRuntimeLiveness
    // to probe pane liveness (getBrokerRuntimeTmuxSocketPath reads socketPath here).
    tmuxJson: {
      socketPath: BTMUX_SOCKET,
      sessionName: SESSION_NAME,
      sessionId: TUI_WINDOW.sessionId,
      windowId: TUI_WINDOW.windowId,
      paneId: TUI_WINDOW.paneId,
      windowName: 'tui',
    },
    // Normalized broker hosting state (Phase A output shape):
    //   substrate:    leased-tmux (broker lives in a leased tmux session)
    //   presentation: tmux-tui    (TUI window is operator-attachable)
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: 'rt-4922-tui',
      broker: {
        protocolVersion: 'harness-broker/0.2',
        ownerServerInstanceId: 'hrc-server-test-4922',
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: BROKER_IPC_SOCKET,
          attachTokenRef: { kind: 'file', path: ATTACH_TOKEN_PATH, redacted: true },
        },
        substrate: {
          kind: 'leased-tmux',
          tmuxSocketPath: BTMUX_SOCKET,
          sessionName: SESSION_NAME,
          brokerWindow: BROKER_WINDOW,
          generation: 1,
          eventLedgerPath: EVENT_LEDGER,
        },
        presentation: {
          kind: 'tmux-tui',
          tuiWindow: TUI_WINDOW,
          operatorAttachTarget: true,
          attachCommand: `tmux -S ${BTMUX_SOCKET} attach -t ${SESSION_NAME}:tui`,
        },
      },
      control: { mode: 'broker-ipc', brokerAttached: false },
    },
    createdAt: '2026-06-18T10:00:00.000Z',
    updatedAt: '2026-06-18T10:00:00.000Z',
    lastActivityAt: '2026-06-18T10:00:00.000Z',
    ...overrides,
  } as unknown as HrcRuntimeSnapshot
}

/**
 * Standard headless runtime with presentation.kind='none' (no TUI window).
 * These runtimes must NOT gain attach/capture/send capabilities after fix.
 */
function makeHeadlessNoneRuntime(overrides: Partial<HrcRuntimeSnapshot> = {}): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-4922-none',
    hostSessionId: 'hsid-4922-none',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:none',
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      broker: {
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: '/tmp/hrc-t4922/bipc/none/b.sock',
          attachTokenRef: {
            kind: 'file',
            path: '/tmp/hrc-t4922/bipc/none/attach.token',
            redacted: true,
          },
        },
        substrate: {
          kind: 'leased-tmux',
          tmuxSocketPath: '/tmp/hrc-t4922/btmux/none.sock',
          sessionName: 'hrc-codex-none-rt-4922',
          brokerWindow: { sessionId: '$20', windowId: '@20', paneId: '%20' },
          generation: 1,
          eventLedgerPath: '/tmp/hrc-t4922/bipc/none/events.ndjson',
        },
        // INTENTIONALLY: presentation='none' — no TUI window
        presentation: { kind: 'none' },
      },
    },
    createdAt: '2026-06-18T10:00:00.000Z',
    updatedAt: '2026-06-18T10:00:00.000Z',
    lastActivityAt: '2026-06-18T10:00:00.000Z',
    ...overrides,
  } as unknown as HrcRuntimeSnapshot
}

// ─── Shared DB seeder for HTTP tests ──────────────────────────────────────────

function seedHeadlessTuiRuntimeInFixture(
  fixture: HrcServerTestFixture,
  runtimeStatus = 'dead'
): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.sessions.insert({
      hostSessionId: 'hsid-4922-http-tui',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:http-tui',
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: 'rt-4922-http-tui',
      hostSessionId: 'hsid-4922-http-tui',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:http-tui',
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      tmuxJson: {
        socketPath: BTMUX_SOCKET,
        sessionName: SESSION_NAME,
        sessionId: TUI_WINDOW.sessionId,
        windowId: TUI_WINDOW.windowId,
        paneId: TUI_WINDOW.paneId,
        windowName: 'tui',
      },
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId: 'rt-4922-http-tui',
        broker: {
          protocolVersion: 'harness-broker/0.2',
          ownerServerInstanceId: 'hrc-server-test-4922-http',
          endpoint: {
            kind: 'unix-jsonrpc-ndjson',
            socketPath: BROKER_IPC_SOCKET,
            attachTokenRef: { kind: 'file', path: ATTACH_TOKEN_PATH, redacted: true },
          },
          substrate: {
            kind: 'leased-tmux',
            tmuxSocketPath: BTMUX_SOCKET,
            sessionName: SESSION_NAME,
            brokerWindow: BROKER_WINDOW,
            generation: 1,
            eventLedgerPath: EVENT_LEDGER,
          },
          presentation: {
            kind: 'tmux-tui',
            tuiWindow: TUI_WINDOW,
            operatorAttachTarget: true,
            attachCommand: `tmux -S ${BTMUX_SOCKET} attach -t ${SESSION_NAME}:tui`,
          },
        },
        control: { mode: 'broker-ipc', brokerAttached: false },
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    if (runtimeStatus !== 'ready') {
      db.runtimes.update('rt-4922-http-tui', { status: runtimeStatus, updatedAt: now })
    }
  } finally {
    db.close()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 5: Presentation-aware surface predicates
// ═══════════════════════════════════════════════════════════════════════════════

describe('RED test 5a: toTargetRuntimeView — headless+tmux-tui POSITIVE misclassified (T-04922)', () => {
  const tuiRuntime = makeHeadlessTuiRuntime()

  it('supportsCapture should be true for headless+tmux-tui (RED — transport gate returns false)', () => {
    // AT HEAD: `supportsCapture: runtime.transport !== 'headless'` → false (transport IS 'headless')
    // AFTER FIX: should gate on canOperatorAttach(runtime) → true (presentation='tmux-tui')
    const view = toTargetRuntimeView(tuiRuntime)
    expect(view).toBeDefined()
    // RED today: supportsCapture === false because transport==='headless'
    expect(view!.supportsCapture).toBe(true)
  })

  it('supportsLiteralSend should be true for headless+tmux-tui (RED — transport gate returns false)', () => {
    // AT HEAD: `supportsLiteralSend: runtime.transport === 'tmux' || ...` → false
    // AFTER FIX: should gate on canOperatorAttach(runtime) → true (presentation='tmux-tui')
    const view = toTargetRuntimeView(tuiRuntime)
    expect(view).toBeDefined()
    // RED today: supportsLiteralSend === false because transport!=='tmux'
    expect(view!.supportsLiteralSend).toBe(true)
  })
})

describe('RED test 5b: toTargetCapabilities — headless+tmux-tui POSITIVE misclassified (T-04922)', () => {
  const tuiRuntime = makeHeadlessTuiRuntime()
  const stubSession = {
    hostSessionId: 'hsid-4922-tui',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:tui',
    laneRef: 'main',
    generation: 1,
    status: 'active' as const,
    createdAt: '2026-06-18T10:00:00.000Z',
    updatedAt: '2026-06-18T10:00:00.000Z',
    ancestorScopeRefs: [],
    continuation: null,
  }

  it('sendReady should be true for headless+tmux-tui (RED — transport gate returns false)', () => {
    // AT HEAD: send readiness follows the runtime's supported tmux transport.
    // → false (transport === 'headless')
    // AFTER FIX: gate on canOperatorAttach(runtime) → true (presentation='tmux-tui')
    const runtimeView = toTargetRuntimeView(tuiRuntime)
    const state = toTargetState(stubSession, runtimeView)
    const caps = toTargetCapabilities(stubSession, runtimeView, state)
    // RED today: sendReady === false
    expect(caps.sendReady).toBe(true)
  })

  it('peekReady should be true for headless+tmux-tui (RED — transport gate returns false)', () => {
    // AT HEAD: `peekReady: runtime !== undefined && runtime.transport !== 'headless'`
    // → false (transport IS 'headless')
    // AFTER FIX: gate on canOperatorAttach(runtime) → true (presentation='tmux-tui')
    const runtimeView = toTargetRuntimeView(tuiRuntime)
    const state = toTargetState(stubSession, runtimeView)
    const caps = toTargetCapabilities(stubSession, runtimeView, state)
    // RED today: peekReady === false because transport==='headless'
    expect(caps.peekReady).toBe(true)
  })
})

describe('[CHARACTERIZATION] test 5f: headless+none NEGATIVE — not attachable (preserved correct)', () => {
  // These tests are GREEN now and must stay GREEN after fix.
  // They prove presentation-based predicates discriminate correctly:
  // headless+none should NOT gain attach/capture/send capabilities.
  const noneRuntime = makeHeadlessNoneRuntime()
  const stubSession = {
    hostSessionId: 'hsid-4922-none',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:none',
    laneRef: 'main',
    generation: 1,
    status: 'active' as const,
    createdAt: '2026-06-18T10:00:00.000Z',
    updatedAt: '2026-06-18T10:00:00.000Z',
    ancestorScopeRefs: [],
    continuation: null,
  }

  it('supportsCapture = false for headless+none (characterization — stays correct)', () => {
    const view = toTargetRuntimeView(noneRuntime)
    expect(view).toBeDefined()
    // presentation.kind='none' → NOT capturable. Must stay false after fix.
    expect(view!.supportsCapture).toBe(false)
  })

  it('supportsLiteralSend = false for headless+none (characterization — stays correct)', () => {
    const view = toTargetRuntimeView(noneRuntime)
    expect(view).toBeDefined()
    expect(view!.supportsLiteralSend).toBe(false)
  })

  it('sendReady = false for headless+none (characterization — stays correct)', () => {
    const runtimeView = toTargetRuntimeView(noneRuntime)
    const state = toTargetState(stubSession, runtimeView)
    const caps = toTargetCapabilities(stubSession, runtimeView, state)
    expect(caps.sendReady).toBe(false)
  })

  it('peekReady = false for headless+none (characterization — stays correct)', () => {
    const runtimeView = toTargetRuntimeView(noneRuntime)
    const state = toTargetState(stubSession, runtimeView)
    const caps = toTargetCapabilities(stubSession, runtimeView, state)
    expect(caps.peekReady).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP-level tests: 5c (adopt), 5d (inspect), 5e (reconcile), 6a (/quit)
//
// Each describe block owns its own fixture + server with its own unique temp path.
// beforeEach creates a fresh fixture, afterEach stops the server and cleans up.
// There is NO shared beforeEach/afterEach at the module level.
// ═══════════════════════════════════════════════════════════════════════════════

describe('RED test 5c: POST /v1/runtimes/adopt — headless+tmux-tui rejected by transport gate (T-04922)', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t4922-adopt-')
    server = await createHrcServer(fixture.serverOpts())
  })

  afterEach(async () => {
    if (server) await server.stop()
    await fixture.cleanup()
  })

  it('adopt of headless+tmux-tui should succeed (RED — transport gate 400s it today)', async () => {
    seedHeadlessTuiRuntimeInFixture(fixture, 'dead')

    const res = await fixture.postJson('/v1/runtimes/adopt', { runtimeId: 'rt-4922-http-tui' })
    // AT HEAD: runtime-list-adopt-handlers.ts ~83
    //   `if (runtime.transport !== 'tmux')` → throw HrcBadRequestError → 400
    // AFTER FIX: gate on canOperatorAttach(runtime) → has tmux-tui presentation → 200

    const body = (await res.json()) as Record<string, unknown>

    // If 400, verify the error message confirms the transport gate is the cause
    // (not an unrelated bug). Error shape: { error: { code, message, detail } }
    if (res.status === 400) {
      const errObj = body['error'] as Record<string, unknown> | undefined
      const msg = String(errObj?.['message'] ?? '')
      expect(msg).toContain('non-tmux')
    }

    // RED assertion: after fix the status should be 200 (adopted)
    expect(res.status).toBe(200)
  })
})

describe('RED test 5d: POST /v1/runtimes/inspect — tmux view absent for headless+tmux-tui (T-04922)', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t4922-insp-')
    server = await createHrcServer(fixture.serverOpts())
  })

  afterEach(async () => {
    if (server) await server.stop()
    await fixture.cleanup()
  })

  it('inspect response should include tmux field for headless+tmux-tui (RED — absent today)', async () => {
    // Seed with status='ready' for inspect (not dead)
    seedHeadlessTuiRuntimeInFixture(fixture, 'ready')

    const res = await fixture.postJson('/v1/runtimes/inspect', {
      runtimeId: 'rt-4922-http-tui',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    // transport is still 'headless' — preserved by fix (only gate logic changes)
    expect(body['transport']).toBe('headless')

    // AT HEAD: runtime-inspect-handlers.ts ~85
    //   `...(runtime.transport === 'tmux' ? { tmux: toStatusTmuxView(runtime.tmuxJson) } : {})`
    // → transport='headless' → no tmux field in response
    // AFTER FIX: gate on canOperatorAttach(runtime) → presentation='tmux-tui' → tmux field present
    //
    // RED: body['tmux'] is undefined today
    expect(body['tmux']).toBeDefined()
    const tmux = body['tmux'] as Record<string, unknown>
    // TUI window paneId is the attach target
    expect(tmux['paneId']).toBe(TUI_WINDOW.paneId)
    expect(tmux['windowId']).toBe(TUI_WINDOW.windowId)
  })
})

describe('RED test 5e: reconcileTmuxRuntimeLiveness — headless+tmux-tui not admitted (T-04922)', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t4922-recon-')
    server = await createHrcServer(fixture.serverOpts())
  })

  afterEach(async () => {
    if (server) await server.stop()
    await fixture.cleanup()
  })

  it('headless+tmux-tui with dead broker socket should be reconciled (stale), not pass-through (RED)', async () => {
    // BTMUX_SOCKET does NOT exist on disk — reconcile should find the pane dead
    // and mark the runtime stale (or terminated). Transport gate prevents this today.
    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
    const runtimeId = 'rt-4922-reconcile-tui'
    try {
      db.sessions.insert({
        hostSessionId: 'hsid-4922-reconcile-tui',
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:reconcile-tui',
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId,
        hostSessionId: 'hsid-4922-reconcile-tui',
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:reconcile-tui',
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        controllerKind: 'harness-broker',
        tmuxJson: {
          socketPath: BTMUX_SOCKET,
          sessionName: SESSION_NAME,
          sessionId: TUI_WINDOW.sessionId,
          windowId: TUI_WINDOW.windowId,
          paneId: TUI_WINDOW.paneId,
          windowName: 'tui',
        },
        runtimeStateJson: {
          schemaVersion: 'runtime-state/v1',
          kind: 'harness-broker',
          broker: {
            protocolVersion: 'harness-broker/0.2',
            endpoint: {
              kind: 'unix-jsonrpc-ndjson',
              socketPath: BROKER_IPC_SOCKET,
              attachTokenRef: { kind: 'file', path: ATTACH_TOKEN_PATH, redacted: true },
            },
            substrate: {
              kind: 'leased-tmux',
              tmuxSocketPath: BTMUX_SOCKET,
              sessionName: SESSION_NAME,
              brokerWindow: BROKER_WINDOW,
              generation: 1,
              eventLedgerPath: EVENT_LEDGER,
            },
            presentation: {
              kind: 'tmux-tui',
              tuiWindow: TUI_WINDOW,
              operatorAttachTarget: true,
            },
          },
          control: { mode: 'broker-ipc', brokerAttached: false },
        },
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
    } finally {
      db.close()
    }

    // Trigger reconcile via GET /v1/runtimes
    const res = await fixture.fetchSocket('/v1/runtimes')
    expect(res.status).toBe(200)

    const dbAfter = openHrcDatabase(fixture.dbPath)
    let runtimeAfter: HrcRuntimeSnapshot | null = null
    try {
      runtimeAfter = dbAfter.runtimes.getByRuntimeId(runtimeId)
    } finally {
      dbAfter.close()
    }

    // AT HEAD: reconcileTmuxRuntimeLiveness (runtime-io-handlers.ts ~83-87):
    //   `runtime.controllerKind === 'harness-broker' && runtime.transport === 'tmux' && ...`
    // For headless+tmux-tui (transport='headless'), gate FAILS → skipped → stays 'ready'.
    // AFTER FIX: gate uses presentation predicates → admitted → dead socket → stale/terminated.
    //
    // RED today: status stays 'ready' (reconcile never runs for headless transport)
    expect(runtimeAfter?.status).not.toBe('ready')
  })

  it('does not downgrade an already-crashed broker runtime to stale during reconciliation', async () => {
    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
    const runtimeId = 'rt-t06846-crashed'
    const hostSessionId = 'hsid-t06846-crashed'
    const invocationId = 'inv-t06846-crashed'
    try {
      db.sessions.insert({
        hostSessionId,
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-06846:crashed',
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert(
        makeHeadlessTuiRuntime({
          runtimeId,
          hostSessionId,
          scopeRef: 'agent:smokey:project:hrc-runtime:task:T-06846:crashed',
          status: 'crashed',
          activeInvocationId: invocationId,
          createdAt: now,
          updatedAt: now,
          lastActivityAt: now,
        })
      )
      db.brokerInvocations.insert({
        invocationId,
        operationId: 'op-t06846-crashed',
        runtimeId,
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: 'claude-code-tmux',
        invocationState: 'exited',
        lifecycleTerminalReason: 'process-exit',
        capabilitiesJson: JSON.stringify({ input: { queue: true } }),
        specHash: 'sha256:t06846-spec',
        startRequestHash: 'sha256:t06846-start',
        selectedProfileHash: 'sha256:t06846-profile',
        createdAt: now,
        updatedAt: now,
      })
    } finally {
      db.close()
    }

    const res = await fixture.fetchSocket('/v1/runtimes')
    expect(res.status).toBe(200)

    const dbAfter = openHrcDatabase(fixture.dbPath)
    try {
      expect(dbAfter.runtimes.getByRuntimeId(runtimeId)?.status).toBe('crashed')
      expect(
        dbAfter.hrcEvents
          .listFromHrcSeq(1, { runtimeId })
          .filter((event) => event.eventKind === 'runtime.stale')
      ).toHaveLength(0)
    } finally {
      dbAfter.close()
    }
  })
})
