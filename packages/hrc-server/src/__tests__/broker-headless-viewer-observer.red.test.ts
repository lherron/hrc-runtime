/**
 * RED tests — T-04921 / T-04905 Phase A: Codex app-server headless viewer route.
 *
 * Four test groups (daedalus's required tests 1-4). ALL FAIL at HEAD:
 *
 * 1. Pure route-decision: `decideCodexAppServerPresentation` does not exist in
 *    broker-decisions.ts → namespace reference is undefined → typeof check fails.
 *
 * 2. Controller allocation/dispatch for viewer route:
 *    - `createBrokerHeadlessViewerAllocator` does not exist in substrate-allocator.ts
 *    - Even if wired, controller ignores viewer presentation for headless profiles
 *      (dispatch.ts line 258 forces dispatchRuntime=undefined for all headless)
 *    - transport='tmux' for interactive allocations; headless viewer must stay 'headless'
 *    - terminalSurfaceRequired: true is not set in dispatchRuntime today
 *
 * 3. Negative headless (guard — RED via new symbol test):
 *    - `decideCodexAppServerPresentation` is undefined → typeof check fails.
 *    - Guards that ordinary headless (no operatorPresentation) MUST NOT get viewer route.
 *
 * 4. Observer integration:
 *    - `getBrokerObserverSocketPath` does not exist in tmux-socket.ts → undefined.
 *    - brokerCommand in the viewer allocation does NOT include
 *      `--experimental-observer-socket` today.
 *    - dispatchEnv for viewer route does NOT include `HARNESS_BROKER_OBSERVER_SOCKET`.
 *    - MUST FAIL if only the renderer env is set but broker does not serve the socket.
 *
 * Governing task: T-04921 (Phase A subtask, T-04905). Architecture: daedalus DM #8645.
 *
 * Implementation targets (symbols that do NOT exist at HEAD):
 *   - `decideCodexAppServerPresentation` in broker-decisions.ts
 *   - `createBrokerHeadlessViewerAllocator` in broker-interactive-handlers/substrate-allocator.ts
 *   - `getBrokerObserverSocketPath` in tmux-socket.ts
 *   - `headlessViewerAllocator` slot on HarnessBrokerController / AllocationContext
 *   - `operatorPresentation` field routing in allocation.ts + dispatch.ts
 *   - Observer socket flag in brokerCommand + HARNESS_BROKER_OBSERVER_SOCKET in dispatchEnv
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'
import type {
  BrokerHelloResponse,
  InvocationEventEnvelope,
  InvocationRuntimeContext,
  InvocationStartRequest,
  InvocationStartResponse,
} from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import * as brokerDecisions from '../broker-decisions'
import * as substrateAllocator from '../broker-interactive-handlers/substrate-allocator'
import type { BrokerClientLike } from '../broker/controller'
import { HarnessBrokerController } from '../broker/controller'
import * as tmuxSocket from '../tmux-socket'

import { makeBrokerProfile, makeCompileResponse, makeIdentity } from './broker-compile-fixtures'

const NOW = '2026-06-18T10:00:00.000Z'

// ── Undefined-at-HEAD namespace references (clean RED guards) ─────────────────

/**
 * T-04921: pure route-decision function.
 * Inputs: { operatorPresentation?: 'tmux-tui' | 'none'; brokerDriver: string; ghosttyViewersEnabled: boolean }
 * Output: 'tmux-tui' | 'none'
 *
 * HARD CONSTRAINT: trigger is the POLICY (operatorPresentation), NOT the driver
 * name alone. A codex-app-server profile with no policy → 'none'. A codex-app-server
 * profile with policy='tmux-tui' + viewers enabled → 'tmux-tui'. A non-codex-app-server
 * driver with policy='tmux-tui' → 'none' (policy applicable only when driver can present).
 */
const _decideCodexAppServerPresentation = (
  brokerDecisions as unknown as {
    decideCodexAppServerPresentation?: (input: {
      operatorPresentation: string | undefined
      brokerDriver: string
      ghosttyViewersEnabled: boolean
    }) => 'tmux-tui' | 'none'
    shouldSpawnGhosttyViewer?: (value?: string | undefined) => boolean
    parseGhosttyViewerLingerSeconds?: (value: string | undefined, defaultSeconds: number) => number
  }
).decideCodexAppServerPresentation
const _shouldSpawnGhosttyViewer = (
  brokerDecisions as unknown as {
    shouldSpawnGhosttyViewer?: (value?: string | undefined) => boolean
  }
).shouldSpawnGhosttyViewer
const _parseGhosttyViewerLingerSeconds = (
  brokerDecisions as unknown as {
    parseGhosttyViewerLingerSeconds?: (value: string | undefined, defaultSeconds: number) => number
  }
).parseGhosttyViewerLingerSeconds

/**
 * T-04921: viewer substrate allocator factory.
 * Analogous to createBrokerDurableTmuxAllocator but persists transport='headless'
 * and returns a BrokerTmuxAllocation that carries lease + tuiWindow (for
 * runtime.terminalSurface) while NEVER setting transport='tmux'.
 */
const createBrokerHeadlessViewerAllocator = (
  substrateAllocator as unknown as {
    createBrokerHeadlessViewerAllocator?: (
      options: { runtimeRoot: string },
      deps: Record<string, unknown>
    ) => { allocate: (...args: unknown[]) => Promise<Record<string, unknown>> }
  }
).createBrokerHeadlessViewerAllocator

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

// ── Shared viewer profile fixture (headless codex-app-server) ─────────────────
// HARD CONSTRAINT: hashed CodexAppServerDriverSpec / startRequest UNCHANGED.
// The profile is identical to ordinary headless — only the route decision differs.

function makeViewerProfile(identity: ReturnType<typeof makeIdentity>): {
  profile: BrokerExecutionProfile
  startRequest: InvocationStartRequest
} {
  // Same as makeBrokerProfile — no new fields. The viewer route is HRC-side routing
  // via routeDecision / operatorPresentation, NOT a profile-level marker.
  return makeBrokerProfile(identity, { brokerDriver: 'codex-app-server' })
}

// ── Minimal fake broker client ─────────────────────────────────────────────────

class FakeEvents implements AsyncIterable<InvocationEventEnvelope> {
  [Symbol.asyncIterator]() {
    return { next: async () => ({ done: true as const, value: undefined }) }
  }
}

class FakeUnixBrokerClient {
  readonly startCalls: Array<{
    request: InvocationStartRequest
    dispatchEnvOrOptions?: unknown
    runtime?: InvocationRuntimeContext
  }> = []
  readonly events = new FakeEvents()

  get helloResponse(): BrokerHelloResponse {
    return {
      brokerInfo: { name: 'harness-broker', version: '0.2.0-test' },
      protocolVersion: 'harness-broker/0.2',
      capabilities: {
        multiInvocation: false,
        transports: ['unix-jsonrpc-ndjson'],
        eventNotifications: true,
        brokerToClientRequests: true,
        attachReplay: true,
      },
      drivers: [
        {
          kind: 'codex-app-server',
          version: '0.2.0-test',
          available: true,
          capabilities: minimalCapabilities(),
        },
      ],
    }
  }

  startResponse: InvocationStartResponse = {
    invocationId: 'invocation_viewer',
    state: 'ready',
    capabilities: minimalCapabilities(),
  }

  onPermissionRequest(): void {}
  onClose(): void {}
  async hello(): Promise<BrokerHelloResponse> {
    return this.helloResponse
  }
  async health() {
    return { status: 'ok' as const, activeInvocations: 0, drivers: [] }
  }
  async startInvocationFromRequest(
    request: InvocationStartRequest,
    dispatchEnvOrOptions?: unknown,
    runtime?: InvocationRuntimeContext
  ) {
    this.startCalls.push({ request, dispatchEnvOrOptions, runtime })
    return {
      invocationId: this.startResponse.invocationId,
      response: this.startResponse,
      events: this.events,
    }
  }
  async input() {
    return { inputId: 'i', accepted: true, disposition: 'started' as const }
  }
  async interrupt() {
    return { accepted: true, effect: 'turn_interrupted' as const }
  }
  async stop() {
    return { accepted: true, state: 'stopping' as const }
  }
  async status() {
    return this.startResponse
  }
  async dispose() {}
  async close() {}
  async attach() {
    return {}
  }
  async snapshot() {
    return {}
  }
  async eventsSince() {
    return { events: [] }
  }
  async ackEvents() {
    return {}
  }
  async permissionRespond() {
    return {}
  }
}

function minimalCapabilities(): InvocationStartResponse['capabilities'] {
  return {
    input: {
      user: true,
      steer: false,
      appendContext: false,
      localImages: false,
      fileRefs: false,
      queue: false,
    },
    turns: { concurrency: 'single', interrupt: 'protocol' },
    continuation: { supported: false, provider: 'openai', keyKind: 'session' },
    events: {
      assistantDeltas: true,
      toolCalls: true,
      usage: false,
      diagnostics: false,
      replay: false,
      ack: false,
    },
    control: { stop: true, dispose: true, status: true, attach: false },
    permissions: { brokerToClientRequests: true, eventAudit: false },
  } as unknown as InvocationStartResponse['capabilities']
}

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
    ancestorScopeRefs: [],
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

// ── Viewer allocation stub ─────────────────────────────────────────────────────
// What createBrokerHeadlessViewerAllocator.allocate() should return:
// - presentation='tmux-tui' (has tuiWindow + lease)
// - brokerCommand includes --experimental-observer-socket <observerSocketPath>
// - observerSocketPath same as in dispatch env

function viewerAllocationStub(runtimeRoot: string, runtimeId: string): Record<string, unknown> {
  const ipcHash = '0b2ef1c4d7a3' // synthetic hash for test
  const ipcDir = `${runtimeRoot}/bipc/${ipcHash}`
  const brokerIpcSocketPath = `${ipcDir}/b.sock`
  const observerSocketPath = `${ipcDir}/observer.sock`
  const btmuxSocketPath = `${runtimeRoot}/btmux/codex-app-server-${runtimeId}.sock`
  const sessionName = `hrc-codex-app-server-${runtimeId}`
  const tuiPane = {
    socketPath: btmuxSocketPath,
    sessionId: '$2',
    windowId: '@2',
    paneId: '%2',
    sessionName,
    windowName: 'tui',
  }
  const tuiLease = {
    kind: 'tmux-pane' as const,
    ownership: 'hrc' as const,
    socketPath: btmuxSocketPath,
    sessionId: '$2',
    windowId: '@2',
    paneId: '%2',
    sessionName,
    windowName: 'tui',
    allowedOps: {
      inspect: true as const,
      sendInput: true as const,
      sendInterrupt: true as const,
      capture: true,
      resize: false,
    },
  }
  return {
    socketPath: btmuxSocketPath,
    allocatedAt: NOW,
    generation: 1,
    brokerIpcSocketPath,
    observerSocketPath,
    attachToken: 'viewer-attach-token',
    attachTokenRef: { kind: 'file', path: `${ipcDir}/attach.token`, redacted: true },
    // IMPORTANT: brokerCommand MUST include --experimental-observer-socket so the broker
    // actually SERVES the observer socket (not just set in env). HRC passes ONE path.
    brokerCommand:
      `exec harness-broker run --transport unix --socket ${brokerIpcSocketPath}` +
      ` --event-ledger ${ipcDir}/events.ndjson` +
      ` --experimental-observer-socket ${observerSocketPath}`,
    brokerPid: 7777,
    brokerWindow: {
      socketPath: btmuxSocketPath,
      sessionId: '$1',
      windowId: '@1',
      paneId: '%1',
      sessionName,
      windowName: 'broker',
    },
    tuiWindow: tuiPane,
    lease: tuiLease,
    // Legacy single-pane mirror for backward compat
    sessionId: '$2',
    windowId: '@2',
    paneId: '%2',
    sessionName,
    windowName: 'tui',
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

  it('viewer allocation brokerCommand includes --experimental-observer-socket <observerSocketPath> (RED)', async () => {
    // The broker MUST be told to serve the observer socket (flag in launch command).
    // TODAY FAILS: createBrokerHeadlessViewerAllocator does not exist, and even if it did,
    // allocateBrokerSubstrate does not include --experimental-observer-socket in brokerCommand.
    expect(typeof createBrokerHeadlessViewerAllocator).toBe('function')

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

    const allocator = createBrokerHeadlessViewerAllocator!(
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

  it('brokerCommand observer path and dispatchEnv HARNESS_BROKER_OBSERVER_SOCKET are the SAME (RED)', async () => {
    // HRC selects ONE observer socket path and passes it to BOTH the broker launch
    // command (so the broker SERVES it) and the renderer dispatch env (so the renderer
    // CONNECTS to it). Two independent derivations would break: they could diverge.
    // TODAY FAILS: neither is wired.

    const identity = makeIdentity({
      runtimeId: 'runtime_obstest' as ReturnType<typeof makeIdentity>['runtimeId'],
      invocationId: 'invocation_obstest' as ReturnType<typeof makeIdentity>['invocationId'],
      runId: 'run_obstest' as ReturnType<typeof makeIdentity>['runId'],
      hostSessionId: 'hostSession_viewer' as ReturnType<typeof makeIdentity>['hostSessionId'],
    })
    const { profile, startRequest } = makeViewerProfile(identity)
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('compile fixture failed')

    const unixClient = new FakeUnixBrokerClient()
    const stub = viewerAllocationStub(fixture.dir, String(identity.runtimeId))
    const observerSocketPath = stub['observerSocketPath'] as string

    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => unixClient as unknown as BrokerClientLike,
      brokerUnixClientFactory: async () => unixClient,
      headlessViewerAllocator: {
        allocate: async () => stub,
      },
      now: () => NOW,
    } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])

    const result = await controller.start({
      plan: response.plan,
      profile,
      startRequest,
      specHash: profile.harnessInvocation.specHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      identity,
      routeDecision: { operatorPresentation: 'tmux-tui' },
      dispatchEnv: { HRC_DISPATCH: 'viewer-obs' },
    } as unknown as Parameters<typeof controller.start>[0])

    expect(result.ok).toBe(true)

    // The dispatch env sent to the broker must include HARNESS_BROKER_OBSERVER_SOCKET
    // pointing to the SAME path that the brokerCommand carries.
    // TODAY FAILS: dispatch env does not include HARNESS_BROKER_OBSERVER_SOCKET.
    const startCall = unixClient.startCalls[0]
    expect(startCall).toBeDefined()

    const sentDispatchEnv =
      (startCall?.dispatchEnvOrOptions as Record<string, string> | undefined) ?? {}

    const envObserverPath = sentDispatchEnv['HARNESS_BROKER_OBSERVER_SOCKET']
    expect(typeof envObserverPath).toBe('string') // ← RED today (undefined)
    expect(envObserverPath).toBe(observerSocketPath) // ← RED today (path mismatch or undefined)

    // Belt-and-suspenders: the brokerCommand in the stub already carries the flag.
    // The persisted state must also reflect the observer socket path.
    const runtime = fixture.db.runtimes.getByRuntimeId(String(identity.runtimeId))
    const brokerState = runtime?.runtimeStateJson?.['broker'] as Record<string, unknown> | undefined
    const endpoint = brokerState?.['endpoint'] as Record<string, unknown> | undefined
    // The endpoint block should note the observer socket alongside the main IPC socket.
    // TODAY FAILS: observerSocketPath is not persisted in endpoint.
    expect(endpoint?.['observerSocketPath']).toBe(observerSocketPath) // ← RED today
  })

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

  it('viewer allocation includes observerSocketPath field for single-source routing (RED)', async () => {
    // The allocation must carry observerSocketPath so the handler layer can inject
    // it into the dispatch env (HARNESS_BROKER_OBSERVER_SOCKET) without re-deriving
    // the path independently. Two independent derivations → divergence risk.
    // TODAY FAILS: createBrokerHeadlessViewerAllocator does not exist.
    expect(typeof createBrokerHeadlessViewerAllocator).toBe('function')

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

    const allocator = createBrokerHeadlessViewerAllocator!(
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
    })

    // TODAY FAILS: observerSocketPath field does not exist in any current allocator.
    const observerSocketPath = allocation['observerSocketPath']
    expect(typeof observerSocketPath).toBe('string') // ← RED today
    expect(String(observerSocketPath).endsWith('.sock')).toBe(true)
    expect(String(observerSocketPath)).toContain('/bipc/') // same dir as b.sock
  })
})
