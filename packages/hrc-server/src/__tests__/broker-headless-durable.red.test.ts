/**
 * RED tests — T-01874 / T-01862 Ph3: headless broker cutover to leased-tmux
 * substrate + Unix v0.2 IPC (presentation=none).
 *
 * All five tests FAIL at HEAD because the headless-durable path is not yet
 * wired: the controller falls through to the stdio/daemon-child path, which
 * persists the wrong hosting state and stamps the wrong protocol version.
 *
 * Curly's impl wires the new branch; smokey verifies green.
 *
 * Failure reason today:
 *  - Reds 1/2/5: endpoint='stdio-jsonrpc-ndjson', substrate='daemon-child',
 *    brokerClientFactory called (stdio spawn) — no leased-tmux allocation.
 *  - Red 4: brokerProtocol stamped as BROKER_PROTOCOL_VERSION ('harness-broker/0.1')
 *    instead of the negotiated 'harness-broker/0.2'.
 *  - Red 3: guard test — currently passes (no terminalSurface on headless path
 *    today). Fails if curly's impl accidentally passes the broker-window pane as
 *    runtime.terminalSurface; bundled with Red 1/2 so the combined test is red.
 *
 * Architecture constraint (spec §10.4):
 *  - Headless public/API transport stays 'headless' even with leased-tmux substrate.
 *  - controller.start() must NOT receive a pre-created stdio brokerClient for
 *    the durable headless path (that bypasses substrate allocation → daemon-child).
 *  - G1 (daedalus): brokerInvocations.brokerProtocol must reflect the protocol
 *    NEGOTIATED in broker.hello, not a compile-time constant.
 *
 * Fix sites (for curly):
 *  - broker/controller.ts:1392  brokerProtocol: BROKER_PROTOCOL_VERSION  ← G1 stamp
 *  - broker/controller.ts:568   isBrokerTmuxProfile gate — headless durable needs
 *    a parallel branch (or predicate) to reach allocateBrokerSubstrate(presentation:'none')
 *  - broker/controller.ts:1315  transport = tmuxAllocation ? 'tmux' : 'headless'
 *    — durable headless must force transport='headless' even when tmuxAllocation is set
 *  - broker-headless-handlers.ts:93  brokerClient: asBrokerClient(client) — must
 *    be omitted on the durable headless path
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

import { type BrokerClientLike, HarnessBrokerController } from '../broker/controller'
import {
  canOperatorAttach,
  canUseDirectPaneFallback,
  parseBrokerRuntimeHostingState,
} from '../broker/runtime-hosting'

import { makeCompileResponse, makeIdentity } from './broker-compile-fixtures'

const NOW = '2026-06-04T00:00:00.000Z'

// ── Durable headless v0.2 profile fixture ─────────────────────────────────────
// interactionMode='headless', brokerProtocol='harness-broker/0.2' (not v0.1).
// NO brokerTerminal.host='tmux' — headless has no operator TUI.
// After Ph3 curly wires this profile to allocateBrokerSubstrate(presentation:'none').

function makeHeadlessDurableProfile(identity: ReturnType<typeof makeIdentity>): {
  profile: BrokerExecutionProfile
  startRequest: InvocationStartRequest
} {
  // Build a minimal valid spec/request; hashes not exercised here so use stubs.
  const spec = {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: identity.invocationId,
    harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
    process: {
      command: 'codex',
      args: ['app-server'],
      cwd: '/tmp/work',
      lockedEnv: { CODEX_HOME: '/tmp/work/.codex' },
      harnessTransport: { kind: 'jsonrpc-stdio' },
    },
    interaction: { mode: 'headless', turnConcurrency: 'single' },
    driver: { kind: 'codex-app-server', model: 'gpt-5-codex' },
    correlation: {
      requestId: String(identity.requestId),
      operationId: String(identity.operationId),
      runtimeId: String(identity.runtimeId),
      invocationId: String(identity.invocationId),
    },
  }
  const startRequest = {
    spec,
    initialInput: {
      inputId: String(identity.initialInputId),
      kind: 'user',
      content: [{ type: 'text', text: 'hello durable headless' }],
    },
  } as unknown as InvocationStartRequest

  const profile = {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: 'profile_codex_headless_durable',
    profileHash: 'profilehash_headless_durable',
    compatibilityHash: 'compat_headless_durable',
    kind: 'harness-broker',
    interactionMode: 'headless',
    // v0.2 marks the durable-unix path; v0.1 = legacy stdio daemon-child
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    brokerOwnership: 'hrc-owned-process',
    // No brokerTerminal.host='tmux' — headless has no operator TUI.
    expectedCapabilities: {},
    harnessInvocation: {
      startRequest,
      specHash: 'spechash_headless_durable',
      startRequestHash: 'startrequesthash_headless_durable',
    },
    policy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {},
      exposurePolicy: {},
    },
    observability: {},
  } as unknown as BrokerExecutionProfile

  return { profile, startRequest }
}

// ── Fake unix client — v0.2 hello with attachReplay (durable path) ────────────

class FakeUnixBrokerClient {
  readonly events = new FakeEvents()
  readonly startCalls: Array<{
    request: InvocationStartRequest
    dispatchEnv?: unknown
    runtime?: InvocationRuntimeContext
  }> = []

  readonly driverKind: string
  constructor(driverKind = 'codex-app-server') {
    this.driverKind = driverKind
  }

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
          kind: this.driverKind,
          version: '0.2.0-test',
          available: true,
          capabilities: minimalInvocationCapabilities(),
        },
      ],
    }
  }

  startResponse: InvocationStartResponse = {
    invocationId: 'invocation_w2',
    state: 'ready',
    capabilities: minimalInvocationCapabilities(),
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
    dispatchEnv?: unknown,
    runtime?: InvocationRuntimeContext
  ) {
    this.startCalls.push({ request, dispatchEnv, runtime })
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
  // Durable-surface methods (DurableBrokerClientLike)
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

// ── Fake stdio client — v0.1 hello (legacy fallback, should NOT be used) ──────

class FakeStdioBrokerClient {
  readonly events = new FakeEvents()
  helloResponse: BrokerHelloResponse = {
    brokerInfo: { name: 'harness-broker', version: '0.1.0-test' },
    protocolVersion: 'harness-broker/0.1',
    capabilities: {
      multiInvocation: false,
      transports: ['stdio-jsonrpc-ndjson'],
      eventNotifications: true,
      brokerToClientRequests: true,
    },
    drivers: [
      {
        kind: 'codex-app-server',
        version: '0.1.0-test',
        available: true,
        capabilities: minimalInvocationCapabilities(),
      },
    ],
  }
  startResponse: InvocationStartResponse = {
    invocationId: 'invocation_w2',
    state: 'ready',
    capabilities: minimalInvocationCapabilities(),
  }
  onPermissionRequest(): void {}
  onClose(): void {}
  async hello(): Promise<BrokerHelloResponse> {
    return this.helloResponse
  }
  async health() {
    return { status: 'ok' as const, activeInvocations: 0, drivers: [] }
  }
  async startInvocationFromRequest() {
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
}

class FakeEvents implements AsyncIterable<InvocationEventEnvelope> {
  [Symbol.asyncIterator]() {
    return { next: async () => ({ done: true as const, value: undefined }) }
  }
}

function minimalInvocationCapabilities(): InvocationStartResponse['capabilities'] {
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

// ── Durable headless allocation stub ──────────────────────────────────────────
// Simulates what allocateBrokerSubstrate(presentation:'none') returns, mapped
// to the BrokerTmuxAllocation shape the controller persists via buildRuntimeStateJson.
// presentation='none': no tuiWindow, no lease (no terminalSurface).

function headlessDurableAllocationStub() {
  const brokerIpcSocketPath = '/tmp/bipc/headless-rt-w2/b.sock'
  return {
    socketPath: '/tmp/btmux/codex-app-server-runtime_w2.sock',
    allocatedAt: NOW,
    generation: 1,
    // NO lease — presentation='none' has no TUI pane
    brokerIpcSocketPath,
    attachToken: 'attach-token-headless',
    attachTokenRef: { kind: 'file', path: '/tmp/bipc/headless-rt-w2/attach.token', redacted: true },
    brokerCommand: `exec harness-broker run --transport unix --socket ${brokerIpcSocketPath}`,
    brokerPid: 5000,
    brokerWindow: {
      socketPath: '/tmp/btmux/codex-app-server-runtime_w2.sock',
      sessionId: '$5',
      windowId: '@10',
      paneId: '%20',
      sessionName: 'hrc-codex-app-server-runtime_w2',
      windowName: 'broker',
    },
    // NO tuiWindow — presentation='none'
    sessionId: '$5',
    windowId: '@10',
    paneId: '%20',
    sessionName: 'hrc-codex-app-server-runtime_w2',
    windowName: 'broker',
  }
}

// ── DB fixture ────────────────────────────────────────────────────────────────

type Fixture = { db: HrcDatabase; dir: string; cleanup: () => Promise<void> }

async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-headless-durable-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  db.sessions.insert({
    hostSessionId: 'hostSession_w2',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01874',
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

// ── Shared controller builder ─────────────────────────────────────────────────

function makeController(
  db: HrcDatabase,
  opts: {
    stdioFactoryCalls: unknown[]
    unixFactoryCalls: Array<{ socketPath: string }>
    unixClient: FakeUnixBrokerClient
    stdioClient: FakeStdioBrokerClient
    useDurableAllocator?: boolean
  }
): HarnessBrokerController {
  return new HarnessBrokerController({
    db,
    brokerClientFactory: async (startOpts: unknown) => {
      opts.stdioFactoryCalls.push(startOpts)
      return opts.stdioClient as unknown as BrokerClientLike
    },
    brokerUnixClientFactory: async (connectOpts: { socketPath: string }) => {
      opts.unixFactoryCalls.push(connectOpts)
      return opts.unixClient
    },
    // Ph3: inject the durable headless allocator (returns presentation='none' stub)
    tmuxAllocator: opts.useDurableAllocator
      ? { allocate: async () => headlessDurableAllocationStub() }
      : undefined,
    now: () => NOW,
  } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('T-01874 Ph3 — headless broker durable cutover (RED)', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeFixture()
  })
  afterEach(async () => {
    await fixture.cleanup()
  })

  // ── RED 1+2+3: leased substrate + unix endpoint + presentation=none + no terminalSurface ──

  it('RED 1/2/3: new headless start → endpoint=unix, substrate=leased-tmux, presentation=none, transport=headless, no terminalSurface', async () => {
    const identity = makeIdentity()
    const { profile, startRequest } = makeHeadlessDurableProfile(identity)
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('fixture compile response unexpectedly failed')

    const stdioFactoryCalls: unknown[] = []
    const unixFactoryCalls: Array<{ socketPath: string }> = []
    const unixClient = new FakeUnixBrokerClient()
    const stdioClient = new FakeStdioBrokerClient()

    const controller = makeController(fixture.db, {
      stdioFactoryCalls,
      unixFactoryCalls,
      unixClient,
      stdioClient,
      // Without the durable allocator wired, the controller falls to stdio.
      // Ph3 impl MUST inject it (or equivalent) for the headless durable route.
      useDurableAllocator: false,
    })

    const result = await controller.start({
      plan: response.plan,
      profile,
      startRequest,
      specHash: profile.harnessInvocation.specHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      identity,
      dispatchEnv: {},
    })

    // Controller MUST succeed (start result ok) regardless of which path is taken.
    expect(result.ok).toBe(true)

    const runtime = fixture.db.runtimes.getByRuntimeId(String(identity.runtimeId))
    expect(runtime).toBeDefined()

    // RED 1: hosting state must show unix endpoint + leased-tmux substrate.
    // TODAY FAILS: endpoint is 'stdio-jsonrpc-ndjson', substrate is 'daemon-child'.
    const hosting = parseBrokerRuntimeHostingState(runtime!)
    expect(hosting?.endpoint.kind).toBe('unix-jsonrpc-ndjson') // ← RED today (stdio)
    expect(hosting?.substrate.kind).toBe('leased-tmux') // ← RED today (daemon-child)

    // RED 2: presentation must be 'none'; no operator attach.
    // (presentation.kind='none' accidentally passes today; substrate=leased-tmux is the gate)
    expect(hosting?.presentation.kind).toBe('none')
    expect(canOperatorAttach(runtime!)).toBe(false)
    expect(canUseDirectPaneFallback(runtime!)).toBe(false)
    // No tuiWindow in the persisted substrate or presentation.
    const broker = (runtime!.runtimeStateJson as Record<string, unknown>)?.['broker'] as
      | Record<string, unknown>
      | undefined
    expect(broker?.['tuiWindow']).toBeUndefined()

    // RED 1: transport must stay 'headless' (not 'tmux') even with leased-tmux substrate.
    // TODAY PASSES (headless → transport='headless'). Guard: fails if curly forgets this.
    expect(runtime!.transport).toBe('headless')

    // RED 3: invocation dispatch must NOT include runtime.terminalSurface.
    // The broker-window pane must NEVER become terminalSurface (only TUI pane can).
    // TODAY PASSES (no tmux allocation → dispatchRuntime=undefined → no terminalSurface).
    // Guard: fails if curly's impl accidentally passes broker pane as terminalSurface.
    const startCall = unixClient.startCalls[0]
    // NOTE: startCalls is empty today (unix client not called); guard fires after Ph3 impl.
    if (startCall !== undefined) {
      expect(startCall.runtime?.terminalSurface).toBeUndefined()
    }
  })

  // ── RED 4: G1 — truthful protocol persistence ─────────────────────────────

  it('RED 4 (G1): persisted brokerInvocations.brokerProtocol equals hello.protocolVersion (harness-broker/0.2), not the BROKER_PROTOCOL_VERSION constant', async () => {
    // Use the interactive durable path (already wired at HEAD) to prove the G1 bug
    // exists independently of the headless route. The controller stamps
    // BROKER_PROTOCOL_VERSION ('harness-broker/0.1') regardless of the negotiated
    // hello, which is wrong for all durable v0.2 rows (G1, daedalus).
    //
    // Fix site: broker/controller.ts:1392
    //   brokerProtocol: BROKER_PROTOCOL_VERSION  ← must become: hello.protocolVersion

    // Import the interactive fixture so we can drive the already-wired durable path.
    const { makeInteractiveTmuxProfile } = await import('./broker-compile-fixtures')
    const identityTmux = makeIdentity({
      runtimeId: 'runtime_tmux' as ReturnType<typeof makeIdentity>['runtimeId'],
      invocationId: 'invocation_tmux' as ReturnType<typeof makeIdentity>['invocationId'],
      runId: 'run_tmux' as ReturnType<typeof makeIdentity>['runId'],
    })
    const { profile: tmuxProfile, startRequest: tmuxStartRequest } =
      makeInteractiveTmuxProfile(identityTmux)
    const tmuxResponse = makeCompileResponse(identityTmux, [tmuxProfile])
    if (!tmuxResponse.ok) throw new Error('tmux fixture failed')

    // Use the 'claude-code-tmux' driver to match the interactive tmux profile.
    const unixClient = new FakeUnixBrokerClient('claude-code-tmux')
    // Wire the known-durable interactive allocator (same stub pattern as Ph2 tests).
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => new FakeStdioBrokerClient() as unknown as BrokerClientLike,
      brokerUnixClientFactory: async () => unixClient,
      tmuxAllocator: {
        allocate: async () => ({
          socketPath: '/tmp/btmux/claude-code-tmux-rt.sock',
          allocatedAt: NOW,
          generation: 1,
          brokerIpcSocketPath: '/tmp/bipc/claude-code-tmux-rt/b.sock',
          attachToken: 'tok',
          attachTokenRef: {
            kind: 'file',
            path: '/tmp/bipc/claude-code-tmux-rt/attach.token',
            redacted: true,
          },
          brokerCommand:
            'exec harness-broker run --transport unix --socket /tmp/bipc/claude-code-tmux-rt/b.sock',
          brokerPid: 9999,
          brokerWindow: {
            socketPath: '/tmp/btmux/claude-code-tmux-rt.sock',
            sessionId: '$1',
            windowId: '@1',
            paneId: '%1',
            sessionName: 'hrc-rt',
            windowName: 'broker',
          },
          tuiWindow: {
            socketPath: '/tmp/btmux/claude-code-tmux-rt.sock',
            sessionId: '$1',
            windowId: '@2',
            paneId: '%2',
            sessionName: 'hrc-rt',
            windowName: 'tui',
          },
          lease: {
            kind: 'tmux-pane',
            ownership: 'hrc',
            socketPath: '/tmp/btmux/claude-code-tmux-rt.sock',
            sessionId: '$1',
            windowId: '@2',
            paneId: '%2',
            sessionName: 'hrc-rt',
            windowName: 'tui',
            allowedOps: {
              inspect: true,
              sendInput: true,
              sendInterrupt: true,
              capture: true,
              resize: false,
            },
          },
          sessionId: '$1',
          windowId: '@2',
          paneId: '%2',
          sessionName: 'hrc-rt',
          windowName: 'tui',
        }),
      },
      now: () => NOW,
    } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])

    const result = await controller.start({
      plan: tmuxResponse.plan,
      profile: tmuxProfile,
      startRequest: tmuxStartRequest,
      specHash: tmuxProfile.harnessInvocation.specHash,
      startRequestHash: tmuxProfile.harnessInvocation.startRequestHash,
      identity: identityTmux,
      dispatchEnv: {},
    })

    expect(result.ok).toBe(true)

    // The hello response negotiates 'harness-broker/0.2'. The persisted row must
    // store THAT value — not the compile-time BROKER_PROTOCOL_VERSION constant.
    // TODAY FAILS: the row stores 'harness-broker/0.1' (the constant).
    const inv = fixture.db.brokerInvocations.getByInvocationId(String(identityTmux.invocationId))
    expect(inv).toBeDefined()
    expect(inv?.brokerProtocol).toBe(unixClient.helloResponse.protocolVersion) // 'harness-broker/0.2'

    // Belt-and-suspenders: explicitly assert the old constant is NOT stored.
    // This red fails if the code stamps BROKER_PROTOCOL_VERSION instead of reading hello.
    expect(inv?.brokerProtocol).not.toBe('harness-broker/0.1')
  })

  // ── RED 5: headless durable path uses unix allocation, NOT stdio spawn ────────

  it('RED 5: headless durable start does NOT call brokerClientFactory (stdio spawn); uses unix client factory', async () => {
    // Assert that for the new durable headless path, the controller goes through
    // the unix allocation (brokerUnixClientFactory called) and does NOT fall back
    // to the stdio spawn path (brokerClientFactory NOT called).
    //
    // TODAY FAILS: headless controller falls through to brokerClientFactory (stdio)
    // because isBrokerTmuxProfile returns false and no durable headless branch exists.

    const identity = makeIdentity()
    const { profile, startRequest } = makeHeadlessDurableProfile(identity)
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('fixture compile response unexpectedly failed')

    const stdioFactoryCalls: unknown[] = []
    const unixFactoryCalls: Array<{ socketPath: string }> = []
    const unixClient = new FakeUnixBrokerClient()
    const stdioClient = new FakeStdioBrokerClient()

    const controller = makeController(fixture.db, {
      stdioFactoryCalls,
      unixFactoryCalls,
      unixClient,
      stdioClient,
      useDurableAllocator: false, // Ph3 impl wires this; today it's absent
    })

    await controller.start({
      plan: response.plan,
      profile,
      startRequest,
      specHash: profile.harnessInvocation.specHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      identity,
      dispatchEnv: {},
    })

    // Durable headless must dial unix, NOT spawn stdio.
    // TODAY FAILS: stdioFactoryCalls.length === 1 (stdio spawned), unixFactoryCalls.length === 0.
    expect(stdioFactoryCalls).toHaveLength(0) // ← RED today (stdio IS called)
    expect(unixFactoryCalls).toHaveLength(1) // ← RED today (unix NOT called)
    expect(unixFactoryCalls[0]?.socketPath).toContain('b.sock')
  })
})
