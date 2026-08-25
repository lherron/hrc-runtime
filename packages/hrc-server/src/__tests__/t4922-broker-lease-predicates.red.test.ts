/**
 * RED tests — T-04922 / T-04905 Phase B: presentation-aware predicates.
 *
 * Tests 5 and 6 (daedalus required, per T-04922 description).
 *
 * ALL non-characterization tests FAIL AT HEAD because the following transport
 * gates use `runtime.transport === 'tmux'` instead of broker hosting PRESENTATION
 * predicates from broker/runtime-hosting.ts:
 *   - target-view.ts: supportsCapture, supportsLiteralSend (toTargetRuntimeView)
 *   - target-view.ts: sendReady, peekReady (toTargetCapabilities)
 *   - runtime-list-adopt-handlers.ts ~83: adopt gate rejects non-tmux transport
 *   - runtime-inspect-handlers.ts ~85: tmux status view absent for headless transport
 *   - runtime-io-handlers.ts ~83-87: reconcileTmuxRuntimeLiveness skips headless
 *   - controller-factory.ts ~167: reapBrokerTmuxLease returns early for headless
 *
 * A headless+tmux-tui runtime (transport='headless', presentation.kind='tmux-tui')
 * — the codex-app-server viewer shape produced by Phase A (T-04921) — is
 * MISCLASSIFIED as non-attachable/non-capturable by ALL these gates today.
 *
 * ─── Test 5: Presentation-aware surface ───────────────────────────────────────
 *   5a. toTargetRuntimeView POSITIVE (headless+tmux-tui): supportsCapture and
 *       supportsLiteralSend should be true → RED (transport gate says false)
 *   5b. toTargetCapabilities POSITIVE (headless+tmux-tui): sendReady and
 *       peekReady should be true → RED (transport gate says false)
 *   5c. POST /v1/runtimes/adopt POSITIVE (headless+tmux-tui): should succeed →
 *       RED (transport gate throws "cannot adopt a non-tmux runtime")
 *   5d. POST /v1/runtimes/inspect (headless+tmux-tui): should include `tmux`
 *       field with TUI window info → RED (transport gate omits it)
 *   5e. GET /v1/runtimes reconcile admission (headless+tmux-tui with dead socket):
 *       runtime should be reconciled and go stale → RED (transport gate skips it)
 *   5f. Characterization NEGATIVE (headless+none): not attachable stays correct
 *       — these pass TODAY and must stay correct after fix.
 *
 * ─── Test 6: /quit lifecycle ──────────────────────────────────────────────────
 *   6a. reconcileTmuxRuntimeLiveness for headless+tmux-tui with a persisted
 *       continuation.cleared(reason=prompt_input_exit) event: runtime should be
 *       classified USER-INITIATED and terminated → RED (reconcile never enters
 *       the broker branch for headless transport; runtime stays 'ready').
 *   6b. reapBrokerTmuxLease transport gate: the controller-factory closure
 *       early-returns for headless transport → broker-tmux lease is NOT reaped
 *       after user /quit on a headless+tmux-tui runtime → RED.
 *       (Verified via direct HarnessBrokerController instantiation + tmuxManager shim.)
 *
 * Architecture: daedalus DM #8645. Phase A prereq: T-04921 @ 43199b6.
 * Predicates to use after fix: canOperatorAttach / hasLeasedBrokerSubstrate from
 * broker/runtime-hosting.ts — already key on presentation.kind, never transport.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { getHarnessBrokerController } from '../broker-interactive-handlers'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'
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

// This file shares the complete presentation fixture vocabulary with the
// surface-contract half so either half can be run independently.
void makeHeadlessTuiRuntime
void makeHeadlessNoneRuntime
void seedHeadlessTuiRuntimeInFixture

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 5: Presentation-aware surface predicates
// ═══════════════════════════════════════════════════════════════════════════════

describe('RED test 6a: /quit lifecycle — USER-INITIATED classification missing for headless+tmux-tui (T-04922)', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t4922-quit-')
    server = await createHrcServer(fixture.serverOpts())
  })

  afterEach(async () => {
    if (server) await server.stop()
    await fixture.cleanup()
  })

  it('headless+tmux-tui + continuation.cleared(prompt_input_exit) + dead socket → terminated USER-INITIATED (RED)', async () => {
    // Scenario: renderer /quit on a headless+tmux-tui runtime.
    // Broker emitted continuation.cleared(reason='prompt_input_exit') before dying.
    // reconcileTmuxRuntimeLiveness should:
    //   (a) admit the runtime (gate change)
    //   (b) find continuation.cleared via findUserInitiatedContinuationClearReason
    //   (c) call markRuntimeTerminatedAfterUserExit →
    //       status='terminated', terminationReason='user_initiated_session_end'
    //
    // TODAY (RED): gate at runtime-io-handlers.ts ~83-87 skips headless entirely
    // → runtime stays 'ready' → no user-initiated classification.

    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
    const runtimeId = 'rt-4922-quit-tui'
    const hostSessionId = 'hsid-4922-quit-tui'
    const invocationId = 'inv-4922-quit-tui'
    const runId = 'run-4922-quit-tui'
    const operationId = 'op-4922-quit-tui'

    try {
      db.sessions.insert({
        hostSessionId,
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:quit-tui',
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:quit-tui',
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        controllerKind: 'harness-broker',
        activeInvocationId: invocationId,
        activeRunId: runId,
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
              attachCommand: `tmux -S ${BTMUX_SOCKET} attach -t ${SESSION_NAME}:tui`,
            },
          },
          control: { mode: 'broker-ipc', brokerAttached: false },
        },
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
      db.runs.insert({
        runId,
        hostSessionId,
        runtimeId,
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:quit-tui',
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        status: 'accepted',
        acceptedAt: now,
        updatedAt: now,
        operationId,
        invocationId,
      })
      db.brokerInvocations.insert({
        invocationId,
        operationId,
        runtimeId,
        runId,
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: 'codex-app-server',
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({ turns: 'single' }),
        specHash: 'sha256:spec-quit',
        startRequestHash: 'sha256:req-quit',
        selectedProfileHash: 'sha256:prof-quit',
        createdAt: now,
        updatedAt: now,
      })
      // continuation.cleared(prompt_input_exit) — user-initiated /quit signal.
      // USER_INITIATED_CONTINUATION_CLEAR_REASONS = { 'prompt_input_exit', 'logout', 'clear' }
      db.brokerInvocationEvents.appendEvent({
        invocationId,
        seq: 5,
        time: now,
        type: 'continuation.cleared',
        runtimeId,
        payload: { reason: 'prompt_input_exit' },
      })
      db.brokerInvocationEvents.appendEvent({
        invocationId,
        seq: 6,
        time: now,
        type: 'invocation.exited',
        runtimeId,
        payload: { exitCode: 0, signal: null },
      })
    } finally {
      db.close()
    }

    const listRes = await fixture.fetchSocket('/v1/runtimes')
    expect(listRes.status).toBe(200)

    const dbAfter = openHrcDatabase(fixture.dbPath)
    let runtimeAfter: HrcRuntimeSnapshot | null = null
    try {
      runtimeAfter = dbAfter.runtimes.getByRuntimeId(runtimeId)
    } finally {
      dbAfter.close()
    }

    // AT HEAD: gate skips headless → stays 'ready', no classification.
    // AFTER FIX: reconcile finds prompt_input_exit → markRuntimeTerminatedAfterUserExit
    //   → status='terminated', terminationReason='user_initiated_session_end'.
    //
    // RED assertions (both fail today — runtime stays 'ready')
    expect(runtimeAfter?.status).toBe('terminated')
    expect(runtimeAfter?.runtimeStateJson?.['terminationReason']).toBe('user_initiated_session_end')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 6b: reapBrokerTmuxLease transport gate (controller-factory.ts ~167)
//
// Tests the closure directly via a fake HrcServerInstanceForHandlers — no
// createHrcServer (brokerTmuxManagerFactory is not in HrcServerOptions).
// Pattern: broker-durable-activation.red.test.ts line 295.
//
// reapBrokerTmuxLease (controller-factory.ts ~156-187):
//   const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
//   if (!runtime || runtime.controllerKind !== 'harness-broker' || runtime.transport !== 'tmux') {
//     return  // ← BUG: transport='headless' !== 'tmux' → early return, NO kill
//   }
//   const leaseSocket = getBrokerRuntimeTmuxSocketPath(runtime)
//   ...
//   await leaseTmux.killServer()
//
// AFTER FIX: guard uses hasLeasedBrokerSubstrate(runtime) → admits headless+tmux-tui
// ═══════════════════════════════════════════════════════════════════════════════

describe('RED test 6b: reapBrokerTmuxLease transport gate — lease NOT killed for headless+tmux-tui (T-04922)', () => {
  it('reapBrokerTmuxLease early-returns for headless transport, broker-tmux server NOT killed (RED)', async () => {
    const killServerCalls: string[] = []

    // Isolated temp DB — independent from any HTTP server fixture
    const tmpDir = mkdtempSync(join(tmpdir(), 'hrc-t4922-reap-'))
    const dbPath = join(tmpDir, 'state.sqlite')
    const db = openHrcDatabase(dbPath)

    try {
      const now = new Date().toISOString()
      const runtimeId = 'rt-4922-reap-unit'
      const hostSessionId = 'hsid-4922-reap-unit'

      db.sessions.insert({
        hostSessionId,
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:reap-unit',
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      // transport='headless' — this is the value that triggers the current transport gate
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04922:reap-unit',
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

      // Minimal fake HrcServerInstanceForHandlers (same pattern as
      // broker-durable-activation.red.test.ts line 295).
      // Only the fields read by getHarnessBrokerController and the reap closure
      // need to be present. brokerTmuxManagerFactory is the key injection point.
      const fakeInstance = {
        options: { runtimeRoot: tmpDir, brokerDurableIpcEnabled: true },
        db,
        harnessBrokerController: undefined,
        notifyEvent: () => {},
        ghostmux: {
          ensureHeadlessViewer: async () => ({ status: 'failed', error: 'test-stub' }),
        },
        // Key injection: factory is captured by controller-factory.ts line 39
        // `const tmuxManagerFactory = this.brokerTmuxManagerFactory ?? createTmuxManager`
        // and used in reapBrokerTmuxLease to create the lease tmux manager.
        brokerTmuxManagerFactory: (opts: { socketPath: string }) => ({
          initialize: async () => {},
          killServer: async () => {
            killServerCalls.push(opts.socketPath)
          },
          inspectSession: async () => null,
          inspectPaneLiveness: async () => null,
          terminate: async () => {},
          createLeaseSession: async () => {
            throw new Error('createLeaseSession not expected in reap test')
          },
          waitForAttachedClient: async () => {},
        }),
        generateBrokerAttachToken: () => 'test-reap-token',
        // reconcileTmuxRuntimeLiveness is called by reapBrokerTmuxLease AFTER the kill.
        // Stub to avoid side effects (the kill is what we're testing, not the reconcile).
        reconcileTmuxRuntimeLiveness: async () => db.runtimes.getByRuntimeId(runtimeId),
        brokerClientFactory: async () => {
          throw new Error('brokerClientFactory unexpected in reap test')
        },
        brokerUnixClientFactory: async () => {
          throw new Error('brokerUnixClientFactory unexpected in reap test')
        },
      } as unknown as HrcServerInstanceForHandlers

      // Instantiate HarnessBrokerController via the factory function.
      // getHarnessBrokerController (broker-interactive-handlers/controller-factory.ts)
      // creates the reapBrokerTmuxLease closure that captures `this.brokerTmuxManagerFactory`.
      const controller = getHarnessBrokerController.call(fakeInstance)

      // Access the reapBrokerTmuxLease closure via its private field name.
      // We use index access to avoid TS private-field errors in tests.
      const reap = (controller as Record<string, unknown>)['reapBrokerTmuxLease'] as
        | ((runtimeId: string) => Promise<void>)
        | undefined
      expect(reap).toBeDefined()

      // Call the closure with the headless+tmux-tui runtimeId.
      await reap!(runtimeId)

      // AT HEAD (controller-factory.ts ~167):
      //   const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
      //   if (!runtime || runtime.controllerKind !== 'harness-broker' || runtime.transport !== 'tmux') {
      //     return  // ← transport='headless' → 'headless' !== 'tmux' → TRUE → early return
      //   }
      //   // killServer is NEVER reached
      //
      // AFTER FIX: guard uses hasLeasedBrokerSubstrate(runtime):
      //   substrate.kind='leased-tmux' → TRUE → admitted → killServer called with BTMUX_SOCKET.
      //
      // RED today: killServerCalls is EMPTY (reap early-returned due to transport gate)
      expect(killServerCalls).toContain(BTMUX_SOCKET)
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
