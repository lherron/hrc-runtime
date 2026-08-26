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
import { canOperatorAttach, parseBrokerRuntimeHostingState } from '../broker/runtime-hosting'
import * as tmuxSocket from '../tmux-socket'

import { makeBrokerProfile, makeCompileResponse, makeIdentity } from './broker-compile-fixtures'

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
const decideCodexAppServerPresentation = (
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
const _createBrokerTmuxTuiAllocator = (
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
const _getBrokerObserverSocketPath = (
  tmuxSocket as unknown as {
    getBrokerObserverSocketPath?: (
      options: { runtimeRoot: string },
      driverKind: string,
      runtimeId: string
    ) => string
  }
).getBrokerObserverSocketPath

// ── Shared tmux-tui profile fixture (headless codex-app-server) ─────────────────
// HARD CONSTRAINT: hashed CodexAppServerDriverSpec / startRequest UNCHANGED.
// The profile is identical to ordinary headless — only the route decision differs.

function makeViewerProfile(identity: ReturnType<typeof makeIdentity>): {
  profile: BrokerExecutionProfile
  startRequest: InvocationStartRequest
} {
  // Same as makeBrokerProfile — no new fields. The tmux-tui route is HRC-side routing
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
// What createBrokerTmuxTuiAllocator.allocate() should return:
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

// These shared builders stay available for focused sibling execution.
void makeViewerProfile
void viewerAllocationStub

// ── Test 1: Pure route-decision (broker-decisions.ts) ─────────────────────────

describe('T-04921 Test 3 — negative: ordinary headless codex-app-server (RED)', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeFixture()
  })
  afterEach(async () => {
    await fixture.cleanup()
  })

  it('decideCodexAppServerPresentation must exist to test the negative gate (RED — undefined at HEAD)', () => {
    // This makes the ENTIRE describe block RED: the negative gate cannot be
    // validated without the decider function. Implementer must provide the function.
    expect(typeof decideCodexAppServerPresentation).toBe('function')
  })

  it('no operatorPresentation → decideCodexAppServerPresentation returns "none" (ordinary headless) (RED)', () => {
    // Guards that ordinary headless stays ordinary. No tmux-tui route without explicit policy.
    const result = decideCodexAppServerPresentation!({
      operatorPresentation: undefined,
      brokerDriver: 'codex-app-server',
    })
    expect(result).toBe('none')
  })

  it('ordinary headless controller dispatch: presentation="none", no terminalSurface, canOperatorAttach=false (RED via symbol)', async () => {
    // This test verifies the current (correct) ordinary-headless behavior, but
    // it is RED because the first assertion (decideCodexAppServerPresentation)
    // must pass before we can trust the routing gate.
    expect(typeof decideCodexAppServerPresentation).toBe('function')

    const identity = makeIdentity({
      runtimeId: 'runtime_ordinary_headless' as ReturnType<typeof makeIdentity>['runtimeId'],
      invocationId: 'invocation_ordinary' as ReturnType<typeof makeIdentity>['invocationId'],
      runId: 'run_ordinary' as ReturnType<typeof makeIdentity>['runId'],
      hostSessionId: 'hostSession_viewer' as ReturnType<typeof makeIdentity>['hostSessionId'],
    })
    const { profile, startRequest } = makeBrokerProfile(identity, {
      brokerDriver: 'codex-app-server',
    })
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('fixture compile response failed')

    const unixClient = new FakeUnixBrokerClient()

    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => unixClient as unknown as BrokerClientLike,
      brokerUnixClientFactory: async () => unixClient,
      // NO tmuxTuiAllocator — ordinary headless must never reach it.
      // headlessSubstrateAllocator provided for the plain headless path.
      headlessSubstrateAllocator: {
        allocate: async () => {
          const ipcDir = `${fixture.dir}/bipc/ordinary`
          const brokerIpcSocketPath = `${ipcDir}/b.sock`
          const btmuxSocketPath = `${fixture.dir}/btmux/codex-app-server-${identity.runtimeId}.sock`
          const sessionName = `hrc-codex-app-server-${identity.runtimeId}`
          return {
            socketPath: btmuxSocketPath,
            allocatedAt: NOW,
            generation: 1,
            brokerIpcSocketPath,
            attachToken: 'ordinary-tok',
            attachTokenRef: { kind: 'file', path: `${ipcDir}/attach.token`, redacted: true },
            brokerCommand: `exec harness-broker run --transport unix --socket ${brokerIpcSocketPath}`,
            brokerPid: 4444,
            brokerWindow: {
              socketPath: btmuxSocketPath,
              sessionId: '$3',
              windowId: '@3',
              paneId: '%3',
              sessionName,
              windowName: 'broker',
            },
            // NO tuiWindow, NO lease: presentation='none'
            sessionId: '$3',
            windowId: '@3',
            paneId: '%3',
            sessionName,
            windowName: 'broker',
          }
        },
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
      // No routeDecision.operatorPresentation = 'tmux-tui' → ordinary headless.
      routeDecision: { operatorPresentation: undefined },
    } as unknown as Parameters<typeof controller.start>[0])

    expect(result.ok).toBe(true)

    const runtime = fixture.db.runtimes.getByRuntimeId(String(identity.runtimeId))
    expect(runtime).toBeDefined()

    // Ordinary headless: transport='headless'
    expect(runtime!.transport).toBe('headless')

    // Ordinary headless: presentation='none', NO operator attach.
    const hosting = parseBrokerRuntimeHostingState(runtime!)
    expect(hosting?.presentation.kind).toBe('none')
    expect(canOperatorAttach(runtime!)).toBe(false)

    // Ordinary headless: dispatch runtime has NO terminalSurface (no operator pane).
    const startCall = unixClient.startCalls[0]
    if (startCall !== undefined) {
      expect(startCall.runtime?.terminalSurface).toBeUndefined()
      expect(startCall.runtime?.terminalSurfaceRequired).toBeUndefined()
    }
  })
})

// ── Test 4: Observer integration ──────────────────────────────────────────────
