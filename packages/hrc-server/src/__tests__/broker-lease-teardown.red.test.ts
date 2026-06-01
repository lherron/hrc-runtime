/**
 * RED acceptance tests for T-01813 (T-01801 Phase 4) — broker+TUI WINDOW-AWARE
 * reconcile/reassociate, and the invalidateHostContext SCOPE GAP teardown.
 *
 * Phase 3 persists TWO named windows ('broker' + 'tui') under ONE per-runtime
 * btmux socket (runtime_state_json.broker.brokerWindow / .tuiWindow). But the
 * landed reconcile path still verifies only the OLD single pane id:
 *   - `brokerLeaseIdsMatch(runtime, observed)` compares one TmuxPaneState to the
 *     single pane in `tmuxJson`;
 *   - `reassociateBrokerTmuxLease(runtime)` inspects ONE session and id-matches
 *     that single pane.
 * Neither is aware of the broker vs tui windows, so a runtime whose TUI is alive
 * but whose BROKER window died (or vice-versa) wrongly looks "matched".
 *
 * Separately, `runtime-control-handlers.invalidateHostContext()` tears down tmux
 * for ALL tmux runtimes via the DEFAULT single-pane manager (`this.tmux`),
 * including harness-broker runtimes whose tmux lives on a per-runtime LEASE
 * socket with two windows. Clear / rotation / invalidation must use
 * broker-lease-aware teardown, not the default single-pane terminate.
 *
 * ── Expected production entry points (named for the implementer) ─────────────
 * In packages/hrc-server/src/startup-reconcile.ts:
 *   export type BrokerWindowObservation = {
 *     brokerWindow: TmuxPaneState | null
 *     tuiWindow: TmuxPaneState | null
 *   }
 *   export function brokerLeaseWindowsMatch(
 *     runtime: HrcRuntimeSnapshot, observed: BrokerWindowObservation
 *   ): boolean      // true IFF BOTH persisted windows exist and BOTH ids match
 *   export function reassociateBrokerTmuxWindows(
 *     runtime: HrcRuntimeSnapshot,
 *     inspect: (runtime: HrcRuntimeSnapshot) => Promise<BrokerWindowObservation>
 *   ): Promise<boolean>
 *
 * In packages/hrc-server/src/runtime-control-handlers.ts:
 *   invalidateHostContext() must NOT route a harness-broker tmux runtime through
 *   the default `this.tmux.terminate`; it must use broker-lease-aware teardown.
 *
 * These are RED NOW: the window-aware symbols are `undefined` on the module
 * namespace, and invalidateHostContext still calls the default tmux manager for
 * harness-broker runtimes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { HrcRuntimeSnapshot } from 'hrc-core'

import type { TmuxPaneState } from '../tmux'
import * as reconcile from '../startup-reconcile'
import { invalidateHostContext } from '../runtime-control-handlers'

const HOST_SESSION_ID = 'hsid_teardown'
const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-01813'
const LANE_REF = 'main'
const GENERATION = 1

const LEASE_SOCKET = '/tmp/hrc-teardown/btmux/claude-code-tmux-runtime_teardown.sock'
const SESSION_NAME = 'hrc-claude-code-tmux-runtime_teardown'

const BROKER_WINDOW: TmuxPaneState = {
  socketPath: LEASE_SOCKET,
  sessionName: SESSION_NAME,
  windowName: 'broker',
  sessionId: '$1',
  windowId: '@20',
  paneId: '%20',
}
const TUI_WINDOW: TmuxPaneState = {
  socketPath: LEASE_SOCKET,
  sessionName: SESSION_NAME,
  windowName: 'tui',
  sessionId: '$1',
  windowId: '@21',
  paneId: '%21',
}

let dir: string
let db: HrcDatabase

function nowTs(): string {
  return '2026-06-01T00:00:00.000Z'
}

function seedSession(): void {
  const now = nowTs()
  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

function seedBrokerRuntime(runtimeId: string): HrcRuntimeSnapshot {
  const now = nowTs()
  db.runtimes.insert({
    runtimeId,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    tmuxJson: {
      socketPath: LEASE_SOCKET,
      sessionName: SESSION_NAME,
      windowName: 'tui',
      sessionId: TUI_WINDOW.sessionId,
      windowId: TUI_WINDOW.windowId,
      paneId: TUI_WINDOW.paneId,
      brokerDriver: 'claude-code-tmux',
    },
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId,
      hostSessionId: HOST_SESSION_ID,
      generation: GENERATION,
      status: 'ready',
      broker: {
        protocolVersion: 'harness-broker/0.2',
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: '/tmp/hrc-teardown/bipc/b.sock',
          attachTokenRef: { kind: 'file', path: '/tmp/hrc-teardown/bipc/t.token', redacted: true },
        },
        generation: GENERATION,
        brokerWindow: BROKER_WINDOW,
        tuiWindow: TUI_WINDOW,
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) throw new Error('seed failed')
  return runtime
}

function seedLegacyTmuxRuntime(runtimeId: string): HrcRuntimeSnapshot {
  const now = nowTs()
  db.runtimes.insert({
    runtimeId,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    // No controllerKind => a legacy single-pane tmux runtime on the DEFAULT server.
    tmuxJson: {
      socketPath: '/tmp/default-tmux.sock',
      sessionName: 'legacy-session',
      windowName: 'main',
      sessionId: '$9',
      windowId: '@90',
      paneId: '%90',
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) throw new Error('seed failed')
  return runtime
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-teardown-'))
  db = openHrcDatabase(join(dir, 'test.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

// ───────────────────────────────────────────────────────────────────────────
// 5. Reconcile / reassociate is broker+TUI-WINDOW aware: BOTH window identities
//    must match, not just the single old pane id.
// ───────────────────────────────────────────────────────────────────────────
describe('Phase 4: broker+TUI window-aware reassociation', () => {
  it('brokerLeaseWindowsMatch is true only when BOTH persisted windows match', () => {
    seedSession()
    const runtime = seedBrokerRuntime('runtime_teardown')

    expect(
      reconcile.brokerLeaseWindowsMatch(runtime, {
        brokerWindow: BROKER_WINDOW,
        tuiWindow: TUI_WINDOW,
      })
    ).toBe(true)

    // Broker window pane drifted => NOT a match (even though TUI still matches).
    expect(
      reconcile.brokerLeaseWindowsMatch(runtime, {
        brokerWindow: { ...BROKER_WINDOW, paneId: '%99999' },
        tuiWindow: TUI_WINDOW,
      })
    ).toBe(false)

    // Broker window gone entirely => NOT a match.
    expect(
      reconcile.brokerLeaseWindowsMatch(runtime, {
        brokerWindow: null,
        tuiWindow: TUI_WINDOW,
      })
    ).toBe(false)

    // TUI window gone => NOT a match.
    expect(
      reconcile.brokerLeaseWindowsMatch(runtime, {
        brokerWindow: BROKER_WINDOW,
        tuiWindow: null,
      })
    ).toBe(false)
  })

  it('reassociateBrokerTmuxWindows re-associates only when BOTH windows inspect-match', async () => {
    seedSession()
    const runtime = seedBrokerRuntime('runtime_teardown')

    // Both windows live & matching => re-associate.
    expect(
      await reconcile.reassociateBrokerTmuxWindows(runtime, async () => ({
        brokerWindow: BROKER_WINDOW,
        tuiWindow: TUI_WINDOW,
      }))
    ).toBe(true)

    // Broker window dead but TUI alive => do NOT re-associate (broker is the
    // control channel; a live TUI alone is the degraded case, not healthy).
    expect(
      await reconcile.reassociateBrokerTmuxWindows(runtime, async () => ({
        brokerWindow: null,
        tuiWindow: TUI_WINDOW,
      }))
    ).toBe(false)

    // TUI window drifted (operator surface lost) => do NOT re-associate.
    expect(
      await reconcile.reassociateBrokerTmuxWindows(runtime, async () => ({
        brokerWindow: BROKER_WINDOW,
        tuiWindow: { ...TUI_WINDOW, paneId: '%99999' },
      }))
    ).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 6. SCOPE GAP: invalidateHostContext uses broker-lease-aware teardown, not the
//    default single-pane tmux manager, for harness-broker runtimes.
// ───────────────────────────────────────────────────────────────────────────
describe('Phase 4 scope gap: invalidateHostContext broker-lease-aware teardown', () => {
  it('does NOT terminate a harness-broker runtime via the default single-pane tmux manager', async () => {
    seedSession()
    seedBrokerRuntime('runtime_teardown')

    const defaultTmuxTerminations: string[] = []
    const brokerDisposeCalls: string[] = []
    const fakeThis = {
      db,
      tmux: {
        async inspectSession(sessionName: string) {
          return {
            socketPath: '/tmp/default-tmux.sock',
            sessionName,
            windowName: 'main',
            sessionId: '$1',
            windowId: '@20',
            paneId: '%20',
          }
        },
        async terminate(sessionName: string) {
          defaultTmuxTerminations.push(sessionName)
        },
      },
      getHarnessBrokerController() {
        return {
          async dispose(runtimeId: string) {
            brokerDisposeCalls.push(runtimeId)
            return { ok: true as const }
          },
        }
      },
    }

    const result = await (
      invalidateHostContext as unknown as (
        this: unknown,
        hostSessionId: string,
        reason: string
      ) => Promise<{ runtimesTerminated: number }>
    ).call(fakeThis, HOST_SESSION_ID, 'rotation')

    expect(result.runtimesTerminated).toBe(1)
    // The DEFAULT single-pane manager must NOT have been used to terminate the
    // broker lease session (it lives on a per-runtime lease socket with two
    // windows). This is the scope gap: at HEAD it IS used => RED.
    expect(defaultTmuxTerminations).not.toContain(SESSION_NAME)
    // Broker-lease-aware teardown ran instead.
    expect(brokerDisposeCalls).toContain('runtime_teardown')
    // The runtime is still terminated.
    expect(db.runtimes.getByRuntimeId('runtime_teardown')?.status).toBe('terminated')
  })

  it('still terminates a LEGACY single-pane tmux runtime via the default manager', async () => {
    seedSession()
    seedLegacyTmuxRuntime('runtime_legacy')

    const defaultTmuxTerminations: string[] = []
    const fakeThis = {
      db,
      tmux: {
        async inspectSession(sessionName: string) {
          return {
            socketPath: '/tmp/default-tmux.sock',
            sessionName,
            windowName: 'main',
            sessionId: '$9',
            windowId: '@90',
            paneId: '%90',
          }
        },
        async terminate(sessionName: string) {
          defaultTmuxTerminations.push(sessionName)
        },
      },
      getHarnessBrokerController() {
        return {
          async dispose() {
            return { ok: true as const }
          },
        }
      },
    }

    await (
      invalidateHostContext as unknown as (
        this: unknown,
        hostSessionId: string,
        reason: string
      ) => Promise<{ runtimesTerminated: number }>
    ).call(fakeThis, HOST_SESSION_ID, 'rotation')

    // Legacy runtimes still use the default single-pane teardown.
    expect(defaultTmuxTerminations).toContain('legacy-session')
  })
})
