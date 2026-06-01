/**
 * RED tests (T-01812 / T-01801 Phase 3) — durable broker allocator shape,
 * connectUnix wiring, and persisted broker identity beyond pane ids.
 *
 * Governing task: T-01812 (parent T-01801, refinement C-03099). Phase 3 turns the
 * single-window btmux lease into a TWO-window durable broker runtime:
 *   - a 'broker' window launched EXEC-FORM with `harness-broker … --transport unix`,
 *   - a 'tui' window whose pane lease is handed to runtime.terminalSurface,
 *   - a per-runtime broker IPC dir (owner-only) + attach token,
 *   - the controller dials the allocated Unix socket via BrokerClient.connectUnix
 *     (NOT a stdio spawn) on the durable-interactive route,
 *   - broker launch IDENTITY (socket path, attach-token ref, generation, broker pid,
 *     broker command) persisted into runtime_state_json — pane ids alone are weak.
 *
 * Proposed NEW symbols (implementer matches):
 *   - createBrokerDurableTmuxAllocator(options, deps): BrokerTmuxAllocator
 *       deps: { tmuxManagerFactory, generateAttachToken, now? }
 *       allocate(...) → BrokerTmuxAllocation extended with:
 *         brokerIpcSocketPath, attachToken, attachTokenRef{kind,path,redacted},
 *         brokerWindow, tuiWindow, brokerCommand, brokerPid?, lease(==tui pane)
 *   - HarnessBrokerController dep `brokerUnixClientFactory`:
 *       (opts:{ socketPath:string; timeoutMs?:number }) => Promise<DurableBrokerClientLike>
 *       default: (opts) => BrokerClient.connectUnix(opts)
 *   - runtime_state_json.broker identity block:
 *       { endpoint:{kind:'unix-jsonrpc-ndjson',socketPath,attachTokenRef},
 *         generation, brokerCommand, brokerPid?, brokerWindow, tuiWindow }
 *
 * These symbols/fields do NOT exist at HEAD → namespace refs are `undefined`
 * (clean RED), the stdio factory is still used (RED), and the broker identity
 * block is absent from runtime_state_json (RED). Tests only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
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

import * as brokerInteractiveHandlers from '../broker-interactive-handlers'
import { HarnessBrokerController } from '../broker/controller'
import type { BrokerClientLike } from '../broker/controller'

import {
  makeCompileResponse,
  makeIdentity,
  makeInteractiveTmuxProfile,
} from './broker-compile-fixtures'

const NOW = '2026-06-01T20:00:00.000Z'

// ── undefined-at-HEAD allocator factory (namespace ref → clean RED) ───────────
const createBrokerDurableTmuxAllocator = (
  brokerInteractiveHandlers as unknown as {
    createBrokerDurableTmuxAllocator?: (options: unknown, deps: unknown) => BrokerTmuxAllocatorLike
  }
).createBrokerDurableTmuxAllocator

type PaneShape = {
  socketPath: string
  sessionId: string
  windowId: string
  paneId: string
  sessionName: string
  windowName: string
}

type BrokerTmuxAllocatorLike = {
  allocate(input: {
    runtimeId: string
    hostSessionId: string
    generation: number
    brokerDriver: string
  }): Promise<Record<string, unknown>>
}

// ── Fake named-window tmux manager (records the exec-form launch) ─────────────
class FakeWindowTmuxManager {
  initialized = false
  readonly windowWithCommandCalls: Array<{
    sessionName: string
    windowName: string
    command: string
  }> = []
  readonly orInspectCalls: Array<{ sessionName: string; windowName: string }> = []

  constructor(private readonly socketPath: string) {}

  async initialize(): Promise<void> {
    this.initialized = true
  }

  async createWindowWithCommand(input: {
    sessionName: string
    windowName: string
    command: string
  }): Promise<PaneShape> {
    this.windowWithCommandCalls.push(input)
    return this.pane(input.sessionName, input.windowName, '@1', '%1')
  }

  async createOrInspectWindow(input: {
    sessionName: string
    windowName: string
  }): Promise<PaneShape> {
    this.orInspectCalls.push(input)
    return this.pane(input.sessionName, input.windowName, '@2', '%2')
  }

  private pane(
    sessionName: string,
    windowName: string,
    windowId: string,
    paneId: string
  ): PaneShape {
    return {
      socketPath: this.socketPath,
      sessionId: '$1',
      windowId,
      paneId,
      sessionName,
      windowName,
    }
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-durable-alloc-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('T-01812 Phase 3 — createBrokerDurableTmuxAllocator shape', () => {
  it('produces a broker window (exec harness-broker --transport unix) + a tui pane lease + an attach token (RED)', async () => {
    expect(typeof createBrokerDurableTmuxAllocator).toBe('function')

    const managers: FakeWindowTmuxManager[] = []
    const allocator = createBrokerDurableTmuxAllocator(
      { runtimeRoot: dir },
      {
        tmuxManagerFactory: (opts: { socketPath: string }) => {
          const m = new FakeWindowTmuxManager(opts.socketPath)
          managers.push(m)
          return m
        },
        generateAttachToken: () => 'attach-token-secret',
        now: () => NOW,
      }
    )

    const allocation = await allocator.allocate({
      runtimeId: 'runtime_p3',
      hostSessionId: 'hostSession_w2',
      generation: 4,
      brokerDriver: 'claude-code-tmux',
    })

    const manager = managers[0]
    expect(manager).toBeDefined()

    // Broker window created EXEC-FORM with the harness-broker unix command.
    expect(manager?.windowWithCommandCalls).toHaveLength(1)
    const brokerCall = manager?.windowWithCommandCalls[0]
    expect(brokerCall?.windowName).toBe('broker')
    expect(brokerCall?.command).toContain('harness-broker')
    expect(brokerCall?.command).toContain('--transport')
    expect(brokerCall?.command).toContain('unix')
    expect(brokerCall?.command).toContain(String(allocation['brokerIpcSocketPath']))

    // TUI window created idempotently.
    expect(manager?.orInspectCalls).toEqual([
      { sessionName: expect.stringContaining('claude-code-tmux'), windowName: 'tui' },
    ])

    // Durable allocation fields beyond the single-pane shape.
    const ipcSocket = allocation['brokerIpcSocketPath']
    expect(typeof ipcSocket).toBe('string')
    expect(String(ipcSocket).endsWith('/b.sock')).toBe(true)
    expect(allocation['attachToken']).toBe('attach-token-secret')

    const tokenRef = allocation['attachTokenRef'] as Record<string, unknown> | undefined
    expect(tokenRef?.['redacted']).toBe(true)
    expect(tokenRef?.['kind']).toBe('file')

    const brokerWindow = allocation['brokerWindow'] as PaneShape | undefined
    const tuiWindow = allocation['tuiWindow'] as PaneShape | undefined
    expect(brokerWindow?.windowName).toBe('broker')
    expect(tuiWindow?.windowName).toBe('tui')

    // The lease handed to runtime.terminalSurface is the TUI pane (NOT the broker pane).
    const lease = allocation['lease'] as Record<string, unknown> | undefined
    expect(lease?.['kind']).toBe('tmux-pane')
    expect(lease?.['ownership']).toBe('hrc')
    expect(lease?.['paneId']).toBe(tuiWindow?.paneId)
    expect(allocation['generation']).toBe(4)
  })

  it('creates the broker IPC dir owner-only (0700) (RED)', async () => {
    expect(typeof createBrokerDurableTmuxAllocator).toBe('function')
    const allocator = createBrokerDurableTmuxAllocator(
      { runtimeRoot: dir },
      {
        tmuxManagerFactory: (opts: { socketPath: string }) =>
          new FakeWindowTmuxManager(opts.socketPath),
        generateAttachToken: () => 'tok',
        now: () => NOW,
      }
    )
    const allocation = await allocator.allocate({
      runtimeId: 'runtime_mode',
      hostSessionId: 'hostSession_w2',
      generation: 1,
      brokerDriver: 'claude-code-tmux',
    })
    const ipcSocket = String(allocation['brokerIpcSocketPath'])
    const ipcDir = ipcSocket.slice(0, ipcSocket.lastIndexOf('/'))
    const st = await stat(ipcDir)
    // Owner-only directory: rwx for owner, nothing for group/other.
    expect(st.mode & 0o777).toBe(0o700)
  })

  it('runs the sockaddr_un preflight BEFORE spawning tmux (over-budget rejects, no window created) (RED)', async () => {
    expect(typeof createBrokerDurableTmuxAllocator).toBe('function')
    // A pathologically long runtimeRoot forces the hashed b.sock path past the
    // platform sockaddr_un budget. The allocator must reject in preflight BEFORE
    // touching the tmux manager.
    const hugeRoot = join(dir, 'x'.repeat(200))
    const managers: FakeWindowTmuxManager[] = []
    const allocator = createBrokerDurableTmuxAllocator(
      { runtimeRoot: hugeRoot },
      {
        tmuxManagerFactory: (opts: { socketPath: string }) => {
          const m = new FakeWindowTmuxManager(opts.socketPath)
          managers.push(m)
          return m
        },
        generateAttachToken: () => 'tok',
        now: () => NOW,
      }
    )

    let threw: unknown
    try {
      await allocator.allocate({
        runtimeId: 'runtime_toolong',
        hostSessionId: 'hostSession_w2',
        generation: 1,
        brokerDriver: 'claude-code-tmux',
      })
    } catch (error) {
      threw = error
    }
    expect(threw).toBeInstanceOf(Error)
    expect(String((threw as Error)?.message)).toMatch(/socket path too long/i)
    // Preflight is BEFORE spawn: no tmux manager should have created a window.
    expect(managers.every((m) => m.windowWithCommandCalls.length === 0)).toBe(true)
  })
})

// ── Minimal broker client usable as BOTH the stdio spy target and the unix one ─
function fullInvocationCapabilities(): InvocationStartResponse['capabilities'] {
  return {
    input: {
      user: true,
      steer: true,
      appendContext: true,
      localImages: true,
      fileRefs: true,
      queue: false,
    },
    turns: { concurrency: 'single', interrupt: 'protocol' },
    continuation: { supported: true, provider: 'anthropic', keyKind: 'session' },
    events: {
      assistantDeltas: true,
      toolCalls: true,
      usage: true,
      diagnostics: true,
      replay: false,
      ack: false,
    },
    control: { stop: true, dispose: true, status: true, attach: false },
    permissions: { brokerToClientRequests: true, eventAudit: true },
  } as unknown as InvocationStartResponse['capabilities']
}

class PushableEvents implements AsyncIterable<InvocationEventEnvelope> {
  close(): void {}
  [Symbol.asyncIterator](): AsyncIterator<InvocationEventEnvelope> {
    return {
      next: async () => ({ done: true, value: undefined }),
    }
  }
}

class FakeDurableBrokerClient {
  readonly events = new PushableEvents()
  helloResponse: BrokerHelloResponse = {
    brokerInfo: { name: 'harness-broker', version: '0.1.1-test' },
    protocolVersion: 'harness-broker/0.2',
    capabilities: {
      multiInvocation: false,
      transports: ['stdio-jsonrpc-ndjson', 'unix-jsonrpc-ndjson'],
      eventNotifications: true,
      brokerToClientRequests: true,
      // The durable broker advertises attachReplay (T-01816 Phase 7): the
      // durable-ipc route REQUIRES it, so the real harness-broker/0.2 hello
      // carries attachReplay:true. Fixture must reflect the real durable broker.
      attachReplay: true,
    },
    drivers: [
      {
        kind: 'claude-code-tmux',
        version: '0.1.1-test',
        available: true,
        capabilities: fullInvocationCapabilities(),
      },
    ],
  }
  startResponse: InvocationStartResponse = {
    invocationId: 'invocation_tmux',
    state: 'ready',
    capabilities: fullInvocationCapabilities(),
  }

  onPermissionRequest(): void {}
  onClose(): void {}
  async hello(): Promise<BrokerHelloResponse> {
    return this.helloResponse
  }
  async health(): Promise<{ status: 'ok'; activeInvocations: number; drivers: unknown[] }> {
    return { status: 'ok', activeInvocations: 1, drivers: this.helloResponse.drivers }
  }
  async startInvocationFromRequest(
    _request: InvocationStartRequest,
    _envOrOpts?: unknown,
    _runtime?: InvocationRuntimeContext
  ): Promise<{
    invocationId: string
    response: InvocationStartResponse
    events: AsyncIterable<InvocationEventEnvelope>
  }> {
    return {
      invocationId: this.startResponse.invocationId,
      response: this.startResponse,
      events: this.events,
    }
  }
  async input(): Promise<{ inputId: string; accepted: boolean; disposition: 'started' }> {
    return { inputId: 'i', accepted: true, disposition: 'started' }
  }
  async interrupt(): Promise<{ accepted: boolean; effect: 'turn_interrupted' }> {
    return { accepted: true, effect: 'turn_interrupted' }
  }
  async stop(): Promise<{ accepted: boolean; state: 'stopping' }> {
    return { accepted: true, state: 'stopping' }
  }
  async status(): Promise<InvocationStartResponse> {
    return this.startResponse
  }
  async dispose(): Promise<void> {}
  async close(): Promise<void> {}
  // v2 durability surface (so the same fake satisfies DurableBrokerClientLike)
  async attach(): Promise<unknown> {
    return {}
  }
  async snapshot(): Promise<unknown> {
    return {}
  }
  async eventsSince(): Promise<unknown> {
    return { events: [] }
  }
  async ackEvents(): Promise<unknown> {
    return {}
  }
  async permissionRespond(): Promise<unknown> {
    return {}
  }
}

type Fixture = { db: HrcDatabase; cleanup: () => Promise<void> }

async function makeFixture(): Promise<Fixture> {
  const fdir = await mkdtemp(join(tmpdir(), 'hrc-durable-ctrl-'))
  const db = openHrcDatabase(join(fdir, 'state.sqlite'))
  db.sessions.insert({
    hostSessionId: 'hostSession_w2',
    scopeRef: 'agent:larry:project:hrc-runtime:task:T-01812',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  return {
    db,
    cleanup: async () => {
      db.close()
      await rm(fdir, { recursive: true, force: true })
    },
  }
}

/** A durable two-window allocation the Phase-3 allocator is expected to return. */
function durableAllocationStub(): Record<string, unknown> {
  const brokerIpcSocketPath = '/tmp/bipc/deadbeef/b.sock'
  const tuiLease = {
    kind: 'tmux-pane' as const,
    ownership: 'hrc' as const,
    socketPath: '/tmp/btmux/claude-code-tmux-runtime_tmux.sock',
    sessionId: '$1',
    windowId: '@2',
    paneId: '%2',
    sessionName: 'hrc-claude-code-tmux-runtime_tmux',
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
    socketPath: '/tmp/btmux/claude-code-tmux-runtime_tmux.sock',
    allocatedAt: NOW,
    generation: 1,
    lease: tuiLease,
    brokerIpcSocketPath,
    attachToken: 'attach-token-secret',
    attachTokenRef: { kind: 'file', path: '/tmp/bipc/deadbeef/attach.token', redacted: true },
    brokerCommand: `exec harness-broker run --transport unix --socket ${brokerIpcSocketPath}`,
    brokerPid: 4242,
    brokerWindow: {
      socketPath: '/tmp/btmux/claude-code-tmux-runtime_tmux.sock',
      sessionId: '$1',
      windowId: '@1',
      paneId: '%1',
      sessionName: 'hrc-claude-code-tmux-runtime_tmux',
      windowName: 'broker',
    },
    tuiWindow: {
      socketPath: '/tmp/btmux/claude-code-tmux-runtime_tmux.sock',
      sessionId: '$1',
      windowId: '@2',
      paneId: '%2',
      sessionName: 'hrc-claude-code-tmux-runtime_tmux',
      windowName: 'tui',
    },
    // TUI pane ids for the legacy single-pane fields.
    sessionId: '$1',
    windowId: '@2',
    paneId: '%2',
    sessionName: 'hrc-claude-code-tmux-runtime_tmux',
    windowName: 'tui',
  }
}

describe('T-01812 Phase 3 — connectUnix wiring + persisted broker identity', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeFixture()
  })
  afterEach(async () => {
    await fixture.cleanup()
  })

  it('dials the allocated Unix socket via brokerUnixClientFactory (connectUnix), NOT a stdio spawn (RED)', async () => {
    const identity = makeIdentity({
      runtimeId: 'runtime_tmux',
      invocationId: 'invocation_tmux',
      runId: 'run_tmux',
    })
    const { profile, startRequest } = makeInteractiveTmuxProfile(identity)
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('fixture compile response unexpectedly failed')

    const stdioFactoryCalls: unknown[] = []
    const unixFactoryCalls: Array<{ socketPath: string }> = []
    const fake = new FakeDurableBrokerClient()

    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async (opts: unknown) => {
        stdioFactoryCalls.push(opts)
        return fake as unknown as BrokerClientLike
      },
      // Phase-3 dep (absent at HEAD): the durable-interactive route must dial here.
      brokerUnixClientFactory: async (opts: { socketPath: string }) => {
        unixFactoryCalls.push(opts)
        return fake
      },
      tmuxAllocator: { allocate: async () => durableAllocationStub() },
      now: () => NOW,
    } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])

    const result = await controller.start({
      plan: response.plan,
      profile,
      startRequest,
      specHash: profile.harnessInvocation.specHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      identity,
      dispatchEnv: { HRC_DISPATCH: 'yes' },
    })

    expect(result.ok).toBe(true)
    // Durable-interactive route dials the allocated Unix socket.
    expect(unixFactoryCalls).toHaveLength(1)
    expect(unixFactoryCalls[0]?.socketPath).toBe('/tmp/bipc/deadbeef/b.sock')
    // …and does NOT spawn a stdio broker child.
    expect(stdioFactoryCalls).toHaveLength(0)
  })

  it('persists broker launch IDENTITY (endpoint, attach-token ref, generation, command, pid) into runtime_state_json (RED)', async () => {
    const identity = makeIdentity({
      runtimeId: 'runtime_tmux',
      invocationId: 'invocation_tmux',
      runId: 'run_tmux',
    })
    const { profile, startRequest } = makeInteractiveTmuxProfile(identity)
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('fixture compile response unexpectedly failed')

    const fake = new FakeDurableBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake as unknown as BrokerClientLike,
      brokerUnixClientFactory: async () => fake,
      tmuxAllocator: { allocate: async () => durableAllocationStub() },
      now: () => NOW,
    } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])

    const result = await controller.start({
      plan: response.plan,
      profile,
      startRequest,
      specHash: profile.harnessInvocation.specHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      identity,
      dispatchEnv: { HRC_DISPATCH: 'yes' },
    })
    expect(result.ok).toBe(true)

    const runtime = fixture.db.runtimes.getByRuntimeId('runtime_tmux')
    const broker = runtime?.runtimeStateJson?.['broker'] as Record<string, unknown> | undefined
    expect(broker).toBeDefined()

    const endpoint = broker?.['endpoint'] as Record<string, unknown> | undefined
    expect(endpoint?.['kind']).toBe('unix-jsonrpc-ndjson')
    expect(endpoint?.['socketPath']).toBe('/tmp/bipc/deadbeef/b.sock')

    const tokenRef = endpoint?.['attachTokenRef'] as Record<string, unknown> | undefined
    expect(tokenRef?.['redacted']).toBe(true)
    // The raw secret must NEVER be persisted.
    expect(JSON.stringify(runtime?.runtimeStateJson)).not.toContain('attach-token-secret')

    expect(broker?.['generation']).toBe(1)
    expect(String(broker?.['brokerCommand'])).toContain('harness-broker')
    expect(broker?.['brokerPid']).toBe(4242)

    // Both windows persisted by NAME (pane ids alone are known weak).
    const brokerWindow = broker?.['brokerWindow'] as Record<string, unknown> | undefined
    const tuiWindow = broker?.['tuiWindow'] as Record<string, unknown> | undefined
    expect(brokerWindow?.['windowName']).toBe('broker')
    expect(tuiWindow?.['windowName']).toBe('tui')
  })
})
