/**
 * RED tests — T-04921 / T-04905 Phase A: Codex app-server tmux-tui route.
 *
 * Four test groups (daedalus's required tests 1-4). ALL FAIL at HEAD:
 *
 * 1. Pure route-decision: `decideCodexAppServerPresentation` does not exist in
 *    broker-decisions.ts → namespace reference is undefined → typeof check fails.
 *
 * 2. Controller allocation/dispatch for tmux-tui route:
 *    - `createBrokerTmuxTuiAllocator` does not exist in substrate-allocator.ts
 *    - Even if wired, controller ignores tmux-tui presentation for headless profiles
 *      (dispatch.ts line 258 forces dispatchRuntime=undefined for all headless)
 *    - transport='tmux' for interactive allocations; tmux-tui must stay 'headless'
 *    - terminalSurfaceRequired: true is not set in dispatchRuntime today
 *
 * 3. Negative headless (guard — RED via new symbol test):
 *    - `decideCodexAppServerPresentation` is undefined → typeof check fails.
 *    - Guards that ordinary headless (no operatorPresentation) MUST NOT get tmux-tui route.
 *
 * 4. Observer integration:
 *    - `getBrokerObserverSocketPath` does not exist in tmux-socket.ts → undefined.
 *    - brokerCommand in the tmux-tui allocation does NOT include
 *      `--experimental-observer-socket` today.
 *    - dispatchEnv for tmux-tui route does NOT include `HARNESS_BROKER_OBSERVER_SOCKET`.
 *    - MUST FAIL if only the renderer env is set but broker does not serve the socket.
 *
 * Governing task: T-04921 (Phase A subtask, T-04905). Architecture: daedalus DM #8645.
 *
 * Implementation targets (symbols that do NOT exist at HEAD):
 *   - `decideCodexAppServerPresentation` in broker-decisions.ts
 *   - `createBrokerTmuxTuiAllocator` in broker-interactive-handlers/substrate-allocator.ts
 *   - `getBrokerObserverSocketPath` in tmux-socket.ts
 *   - `tmuxTuiAllocator` slot on HarnessBrokerController / AllocationContext
 *   - `operatorPresentation` field routing in allocation.ts + dispatch.ts
 *   - Observer socket flag in brokerCommand + HARNESS_BROKER_OBSERVER_SOCKET in dispatchEnv
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import * as brokerDecisions from '../broker-decisions'
import * as substrateAllocator from '../broker-interactive-handlers/substrate-allocator'
import * as tmuxSocket from '../tmux-socket'
import { makeFrozenWorkerLaunch } from './fixtures/frozen-substrate'

const NOW = '2026-06-18T10:00:00.000Z'

// ── Undefined-at-HEAD namespace references (clean RED guards) ─────────────────

/**
 * T-04921: pure route-decision function.
 * Inputs: { operatorPresentation?: 'tmux-tui' | 'none'; brokerDriver: string }
 * Output: 'tmux-tui' | 'none'
 *
 * HARD CONSTRAINT: trigger is the POLICY (operatorPresentation), NOT the driver
 * name alone. A codex-app-server profile with no policy → 'none'. A codex-app-server
 * profile with policy='tmux-tui' → 'tmux-tui'. A non-codex-app-server
 * driver with policy='tmux-tui' → 'none' (policy applicable only when driver can present).
 */
const _decideCodexAppServerPresentation = (
  brokerDecisions as unknown as {
    decideCodexAppServerPresentation?: (input: {
      operatorPresentation: string | undefined
      brokerDriver: string
    }) => 'tmux-tui' | 'none'
  }
).decideCodexAppServerPresentation

/**
 * T-04921: tmux-tui substrate allocator factory.
 * Analogous to createBrokerDurableTmuxAllocator but persists transport='headless'
 * and returns a BrokerTmuxAllocation that carries lease + tuiWindow (for
 * runtime.terminalSurface) while NEVER setting transport='tmux'.
 */
const createBrokerTmuxTuiAllocator = (
  substrateAllocator as unknown as {
    createBrokerTmuxTuiAllocator?: (
      options: { runtimeRoot: string },
      deps: Record<string, unknown>
    ) => { allocate: (...args: unknown[]) => Promise<Record<string, unknown>> }
  }
).createBrokerTmuxTuiAllocator

/**
 * T-04921: HRC-owned observer socket path helper.
 * Lives under the same owner-only bipc/<hash>/ dir as the broker IPC socket so
 * HRC selects ONE path shared between broker launch command and renderer dispatch env.
 */
const getBrokerObserverSocketPath = (
  tmuxSocket as unknown as {
    getBrokerObserverSocketPath?: (
      options: { runtimeRoot: string },
      driverKind: string,
      runtimeId: string
    ) => string
  }
).getBrokerObserverSocketPath

// ── DB fixture ────────────────────────────────────────────────────────────────

type Fixture = { db: HrcDatabase; dir: string; cleanup: () => Promise<void> }

async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-viewer-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  db.sessions.insert({
    hostSessionId: 'hostSession_viewer',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04921',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  })
  return {
    db,
    dir,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

// ── Test 1: Pure route-decision (broker-decisions.ts) ─────────────────────────

describe('T-04921 Test 4 — observer integration: observer socket wiring (RED)', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeFixture()
  })
  afterEach(async () => {
    await fixture.cleanup()
  })

  it('getBrokerObserverSocketPath is exported from tmux-socket (RED — does not exist)', () => {
    // At HEAD this is undefined; after implementation it is a function that returns
    // a path under <runtimeRoot>/bipc/<hash>/ (same directory as the broker IPC socket).
    expect(typeof getBrokerObserverSocketPath).toBe('function')
  })

  it('observer socket path is under the same bipc/<hash>/ dir as broker IPC socket (RED)', () => {
    const observerPath = getBrokerObserverSocketPath!(
      { runtimeRoot: fixture.dir },
      'codex-app-server',
      'runtime_viewer'
    )
    expect(typeof observerPath).toBe('string')
    expect(observerPath.length).toBeGreaterThan(0)

    // Observer socket lives under bipc/<hash>/ — same leaf dir as b.sock.
    // This ensures HRC owns ONE path, not two independent derivations.
    const { getBrokerIpcSocketPath } = tmuxSocket
    const ipcPath = getBrokerIpcSocketPath(
      { runtimeRoot: fixture.dir },
      'codex-app-server',
      'runtime_viewer'
    )
    const ipcDir = ipcPath.slice(0, ipcPath.lastIndexOf('/'))
    const observerDir = observerPath.slice(0, observerPath.lastIndexOf('/'))
    expect(observerDir).toBe(ipcDir)
  })

  it('tmux-tui allocation brokerCommand includes --experimental-observer-socket <observerSocketPath> (RED)', async () => {
    // The broker MUST be told to serve the observer socket (flag in launch command).
    // TODAY FAILS: createBrokerTmuxTuiAllocator does not exist, and even if it did,
    // allocateBrokerSubstrate does not include --experimental-observer-socket in brokerCommand.
    expect(typeof createBrokerTmuxTuiAllocator).toBe('function')

    class FakeTmux {
      initialized = false
      windowWithCommandCalls: Array<{ sessionName: string; windowName: string; command: string }> =
        []
      orInspectCalls: Array<{ sessionName: string; windowName: string }> = []
      async initialize() {
        this.initialized = true
      }
      async createWindowWithCommand(input: {
        sessionName: string
        windowName: string
        command: string
      }) {
        this.windowWithCommandCalls.push(input)
        return {
          socketPath: '/tmp/btmux/viewer-test.sock',
          sessionId: '$1',
          windowId: '@1',
          paneId: '%1',
          sessionName: input.sessionName,
          windowName: input.windowName,
        }
      }
      async createOrInspectWindow(input: { sessionName: string; windowName: string }) {
        this.orInspectCalls.push(input)
        return {
          socketPath: '/tmp/btmux/viewer-test.sock',
          sessionId: '$1',
          windowId: '@2',
          paneId: '%2',
          sessionName: input.sessionName,
          windowName: input.windowName,
        }
      }
    }

    const allocator = createBrokerTmuxTuiAllocator!(
      { runtimeRoot: fixture.dir },
      {
        tmuxManagerFactory: () => new FakeTmux(),
        generateAttachToken: () => 'viewer-tok',
        now: () => NOW,
      }
    )

    const allocation = await allocator.allocate({
      runtimeId: 'runtime_viewer',
      hostSessionId: 'hostSession_viewer',
      generation: 1,
      brokerDriver: 'codex-app-server',
      workerLaunch: await makeFrozenWorkerLaunch({
        runtimeRoot: fixture.dir,
        driverKind: 'codex-app-server',
        runtimeId: 'runtime_viewer',
        hostSessionId: 'hostSession_viewer',
        generation: 1,
        withObserverSocket: true,
      }),
    })

    // The broker MUST be told to serve the observer socket via the launch command.
    // TODAY FAILS: allocateBrokerSubstrate does not include --experimental-observer-socket.
    const brokerCommand = allocation['brokerCommand'] as string
    expect(brokerCommand).toContain('--experimental-observer-socket') // ← RED today

    // The observer socket path must appear in the command.
    const observerSocketPath = allocation['observerSocketPath'] as string
    expect(typeof observerSocketPath).toBe('string') // ← RED today (field doesn't exist)
    expect(brokerCommand).toContain(observerSocketPath) // ← RED today

    // The path must be under the bipc directory (same dir as broker IPC socket).
    expect(observerSocketPath).toContain('/bipc/')
  })

  // T-04921 is completed. The brokerCommand/dispatchEnv observer-socket
  // identity is pinned green on the current viewer route in
  // t08554-app-server-viewer; its pre-v2 red twin here was removed (T-09746).

  it('MUST FAIL: connecting to observer socket without broker serving it rejects (negative invariant)', async () => {
    // This test verifies the observer socket is SERVER-SIDE (broker must serve it).
    // If ONLY the renderer env is set (HARNESS_BROKER_OBSERVER_SOCKET) but the broker
    // was NOT launched with --experimental-observer-socket, the connect must fail.
    // This is a NEGATIVE invariant: it should be TRUE both now and after implementation.
    // It is included in the red suite because the POSITIVE (connection succeeds when
    // broker serves it) is the RED assertion that fails at HEAD.

    const nonExistentSocketPath = join(fixture.dir, 'observer-not-served.sock')

    // Attempt to connect to the observer socket path (not being served by anyone).
    const connectionResult = await new Promise<{ connected: boolean; error: string | null }>(
      (resolve) => {
        const socket = connect({ path: nonExistentSocketPath })
        const timeout = setTimeout(() => {
          socket.destroy()
          resolve({ connected: false, error: 'timeout' })
        }, 500)
        socket.on('connect', () => {
          clearTimeout(timeout)
          socket.destroy()
          resolve({ connected: true, error: null })
        })
        socket.on('error', (err) => {
          clearTimeout(timeout)
          resolve({ connected: false, error: err.message })
        })
      }
    )

    // Connecting to a non-existent socket must fail (ENOENT or ECONNREFUSED).
    // This proves the broker MUST serve the socket; an env var alone is insufficient.
    expect(connectionResult.connected).toBe(false)
    expect(connectionResult.error).not.toBeNull()
  })

  it('tmux-tui allocation includes observerSocketPath field for single-source routing (RED)', async () => {
    // The allocation must carry observerSocketPath so the handler layer can inject
    // it into the dispatch env (HARNESS_BROKER_OBSERVER_SOCKET) without re-deriving
    // the path independently. Two independent derivations → divergence risk.
    // TODAY FAILS: createBrokerTmuxTuiAllocator does not exist.
    expect(typeof createBrokerTmuxTuiAllocator).toBe('function')

    class FakeTmux2 {
      async initialize() {}
      async createWindowWithCommand(input: {
        sessionName: string
        windowName: string
        command: string
      }) {
        return {
          socketPath: '/tmp/btmux/viewer-single.sock',
          sessionId: '$1',
          windowId: '@1',
          paneId: '%1',
          sessionName: input.sessionName,
          windowName: input.windowName,
        }
      }
      async createOrInspectWindow(input: { sessionName: string; windowName: string }) {
        return {
          socketPath: '/tmp/btmux/viewer-single.sock',
          sessionId: '$1',
          windowId: '@2',
          paneId: '%2',
          sessionName: input.sessionName,
          windowName: input.windowName,
        }
      }
    }

    const allocator = createBrokerTmuxTuiAllocator!(
      { runtimeRoot: fixture.dir },
      {
        tmuxManagerFactory: () => new FakeTmux2(),
        generateAttachToken: () => 'tok-single',
        now: () => NOW,
      }
    )

    const allocation = await allocator.allocate({
      runtimeId: 'runtime_single_path',
      hostSessionId: 'hostSession_viewer',
      generation: 1,
      brokerDriver: 'codex-app-server',
      workerLaunch: await makeFrozenWorkerLaunch({
        runtimeRoot: fixture.dir,
        driverKind: 'codex-app-server',
        runtimeId: 'runtime_single_path',
        hostSessionId: 'hostSession_viewer',
        generation: 1,
        withObserverSocket: true,
      }),
    })

    // TODAY FAILS: observerSocketPath field does not exist in any current allocator.
    const observerSocketPath = allocation['observerSocketPath']
    expect(typeof observerSocketPath).toBe('string') // ← RED today
    expect(String(observerSocketPath).endsWith('.sock')).toBe(true)
    expect(String(observerSocketPath)).toContain('/bipc/') // same dir as b.sock
  })
})
