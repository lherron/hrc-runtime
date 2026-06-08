/**
 * RED tests (T-01815 / T-01801 Phase 6 — ACTIVATION) — wire the durable
 * interactive broker route into the LIVE start path.
 *
 * Governing task: T-01815 (parent T-01801; architect fix-shape cody C-03119, DM
 * #4962). All of P0–P5 are green + closed, yet HRC_BROKER_DURABLE_IPC_ENABLED
 * does NOTHING on the live interactive START path: `getHarnessBrokerController()`
 * (broker-interactive-handlers.ts) hardcodes the LEGACY single-window stdio
 * allocator (createLeaseSession), so these Phase-1/3 symbols have no live caller:
 *   - resolveBrokerDurableIpcEnabled        (the flag)
 *   - decideBrokerDurableInteractiveRoute   (the route guard)
 *   - createBrokerDurableTmuxAllocator      (the durable allocator)
 * The controller's start() internal branch (controller.ts:461-473) is ALREADY
 * correct: if the injected allocator returns `brokerIpcSocketPath` it dials
 * `brokerUnixClientFactory`/connectUnix, else it keeps the stdio spawn. So
 * activation == constructing the cached HarnessBrokerController with the DURABLE
 * allocator + unix client factory when the durable route is enabled.
 *
 * THE FIX (cody-approved seam — at construction, NOT per-turn) lives entirely in
 * `getHarnessBrokerController()`:
 *   when resolveBrokerDurableIpcEnabled(this.options) === true AND
 *   decideBrokerDurableInteractiveRoute({durableIpcEnabled, endpointKind:
 *   'unix-jsonrpc-ndjson', interactionMode:'interactive'}) === 'durable-ipc':
 *     tmuxAllocator = createBrokerDurableTmuxAllocator(this.options, {
 *       tmuxManagerFactory, generateAttachToken })
 *     + pass brokerUnixClientFactory through to the controller.
 *   otherwise: keep the LEGACY single-window stdio allocator (createLeaseSession).
 * Plus the hello sub-gap: controller.start() hello hardcodes
 *   protocolVersions:[BROKER_PROTOCOL_VERSION] (v1). The durable route must
 *   negotiate harness-broker/0.2 + unix transport (per-route expected
 *   transport/protocol via admitBrokerHello) — stdio headless stays v1/stdio.
 *
 * ── TEST SEAMS THE IMPLEMENTER MUST HONOR ─────────────────────────────────────
 * These optional fields on the server instance (`this`) let the acceptance test
 * drive getHarnessBrokerController().start() with NO real tmux / NO real broker.
 * `getHarnessBrokerController()` MUST consult them when present (default to the
 * production factories when absent):
 *   - this.brokerTmuxManagerFactory?:  (opts:{socketPath}) => DurableTmuxManagerLike
 *       used as createBrokerDurableTmuxAllocator's `tmuxManagerFactory` AND as the
 *       legacy allocator's tmux manager (default: createTmuxManager).
 *   - this.generateBrokerAttachToken?: () => string
 *       used as createBrokerDurableTmuxAllocator's `generateAttachToken`.
 *   - this.brokerClientFactory?:       BrokerClientFactory     (stdio spy)
 *   - this.brokerUnixClientFactory?:   BrokerUnixClientFactory (unix spy)
 *       passed through to the HarnessBrokerController constructor deps.
 *
 * RED at HEAD: getHarnessBrokerController() ignores the flag AND the seams above,
 * so the durable allocator never runs (no broker+tui windows, no connectUnix),
 * the persisted endpoint stays stdio, and the hello stays v1. Tests only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
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

import { getHarnessBrokerController } from '../broker-interactive-handlers'
import type { HarnessBrokerController } from '../broker/controller'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

import {
  makeBrokerProfile,
  makeCompileResponse,
  makeIdentity,
  makeInteractiveTmuxProfile,
} from './broker-compile-fixtures'

const NOW = '2026-06-01T22:00:00.000Z'

// ── A fake tmux manager satisfying BOTH allocators ───────────────────────────
// durable: initialize + createWindowWithCommand + createOrInspectWindow + inspectPaneProcess
// legacy:  initialize + createLeaseSession
type PaneShape = {
  socketPath: string
  sessionId: string
  windowId: string
  paneId: string
  sessionName: string
  windowName: string
}

class FakeBifunctionalTmuxManager {
  initialized = false
  readonly windowWithCommandCalls: Array<{
    sessionName: string
    windowName: string
    command: string
  }> = []
  readonly orInspectCalls: Array<{ sessionName: string; windowName: string }> = []
  readonly leaseSessionCalls: string[] = []

  constructor(private readonly socketPath: string) {}

  async initialize(): Promise<void> {
    this.initialized = true
  }

  // ── durable named-window surface ──
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

  async inspectPaneProcess(
    _paneId: string
  ): Promise<{ command: string; pid: number; dead: boolean } | null> {
    return { command: 'harness-broker', pid: 4242, dead: false }
  }

  // ── legacy single-pane surface ──
  async createLeaseSession(sessionName: string): Promise<PaneShape> {
    this.leaseSessionCalls.push(sessionName)
    return this.pane(sessionName, 'main', '@9', '%9')
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

// ── A broker client usable as the stdio OR unix spy target ───────────────────
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

class EmptyEvents implements AsyncIterable<InvocationEventEnvelope> {
  close(): void {}
  // biome-ignore lint/correctness/useYield: intentionally-empty async iterator for tests; emits no events.
  async *[Symbol.asyncIterator](): AsyncIterator<InvocationEventEnvelope> {
    return
  }
}

class FakeBrokerClient {
  readonly events = new EmptyEvents()
  readonly helloCalls: Array<{ protocolVersions?: string[] }> = []
  helloResponse: BrokerHelloResponse

  constructor(protocolVersion: 'harness-broker/0.1' | 'harness-broker/0.2') {
    this.helloResponse = {
      brokerInfo: { name: 'harness-broker', version: '0.1.1-test' },
      protocolVersion,
      capabilities: {
        multiInvocation: false,
        transports: ['stdio-jsonrpc-ndjson', 'unix-jsonrpc-ndjson'],
        eventNotifications: true,
        brokerToClientRequests: true,
        // The durable (harness-broker/0.2) broker advertises attachReplay, which
        // the durable-ipc route REQUIRES (T-01816 Phase 7). The legacy v1 broker
        // does not. Reflect that per-version so durable admission is realistic
        // while the legacy stdio route stays unchanged.
        attachReplay: protocolVersion === 'harness-broker/0.2',
      },
      drivers: [
        {
          kind: 'claude-code-tmux',
          version: '0.1.1-test',
          available: true,
          capabilities: fullInvocationCapabilities(),
        },
        {
          kind: 'codex-app-server',
          version: '0.1.1-test',
          available: true,
          capabilities: fullInvocationCapabilities(),
        },
      ],
    } as unknown as BrokerHelloResponse
  }

  startResponse: InvocationStartResponse = {
    invocationId: 'invocation_tmux',
    state: 'ready',
    capabilities: fullInvocationCapabilities(),
  }

  onPermissionRequest(): void {}
  onClose(): void {}
  async hello(req?: { protocolVersions?: string[] }): Promise<BrokerHelloResponse> {
    this.helloCalls.push(req ?? {})
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

// ── Fixture: real HRC SQLite + a session row to start against ─────────────────
type Harness = {
  this: HrcServerInstanceForHandlers
  managers: FakeBifunctionalTmuxManager[]
  stdioCalls: unknown[]
  unixCalls: Array<{ socketPath: string }>
  stdioFake: FakeBrokerClient
  unixFake: FakeBrokerClient
}

function makeServerInstance(db: HrcDatabase, dir: string, durableFlag: boolean): Harness {
  const managers: FakeBifunctionalTmuxManager[] = []
  const stdioCalls: unknown[] = []
  const unixCalls: Array<{ socketPath: string }> = []
  const stdioFake = new FakeBrokerClient('harness-broker/0.1')
  const unixFake = new FakeBrokerClient('harness-broker/0.2')

  const instance = {
    options: { runtimeRoot: dir, brokerDurableIpcEnabled: durableFlag },
    db,
    harnessBrokerController: undefined,
    notifyEvent: () => {},
    // ── PROPOSED test seams (RED: ignored at HEAD) ──
    brokerTmuxManagerFactory: (opts: { socketPath: string }) => {
      const m = new FakeBifunctionalTmuxManager(opts.socketPath)
      managers.push(m)
      return m
    },
    generateBrokerAttachToken: () => 'attach-token-secret',
    brokerClientFactory: async (opts: unknown) => {
      stdioCalls.push(opts)
      return stdioFake
    },
    brokerUnixClientFactory: async (opts: { socketPath: string }) => {
      unixCalls.push(opts)
      return unixFake
    },
  } as unknown as HrcServerInstanceForHandlers

  return { this: instance, managers, stdioCalls, unixCalls, stdioFake, unixFake }
}

function seedSession(db: HrcDatabase): void {
  db.sessions.insert({
    hostSessionId: 'hostSession_w2',
    scopeRef: 'agent:larry:project:hrc-runtime:task:T-01815',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
}

// Kill any real tmux servers the UNFIXED (seam-ignoring) path may have spawned
// under <dir>/btmux/*.sock, so a RED run leaves no lingering tmux servers.
async function killBtmuxServers(dir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(join(dir, 'btmux'))
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith('.sock')) continue
    try {
      const { exited } = Bun.spawn(['tmux', '-S', join(dir, 'btmux', entry), 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine when no server exists
    }
  }
}

let dir: string
let db: HrcDatabase
let savedBrokerCmd: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-durable-activation-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  seedSession(db)
  // Neutralize the UNFIXED default stdio factory: if getHarnessBrokerController
  // ignores the injected brokerClientFactory seam (RED), BrokerClient.start would
  // otherwise spawn the REAL `harness-broker` binary. Point it at a nonexistent
  // command so the real spawn fails fast instead of launching a live broker.
  savedBrokerCmd = process.env['HRC_HARNESS_BROKER_CMD']
  process.env['HRC_HARNESS_BROKER_CMD'] = 'hrc-nonexistent-broker-stub-xyz'
})

afterEach(async () => {
  db.close()
  await killBtmuxServers(dir)
  await rm(dir, { recursive: true, force: true })
  if (savedBrokerCmd === undefined) {
    process.env['HRC_HARNESS_BROKER_CMD'] = undefined
  } else {
    process.env['HRC_HARNESS_BROKER_CMD'] = savedBrokerCmd
  }
})

function interactiveStartInput() {
  const identity = makeIdentity({
    runtimeId: 'runtime_tmux',
    invocationId: 'invocation_tmux',
    runId: 'run_tmux',
  })
  const { profile, startRequest } = makeInteractiveTmuxProfile(identity)
  const response = makeCompileResponse(identity, [profile])
  if (!response.ok) throw new Error('fixture compile response unexpectedly failed')
  return {
    // NOTE: the durable interactive START must NOT pre-supply a brokerClient —
    // the controller allocates the durable btmux lease (which launches the broker
    // in its own window over --transport unix) and dials the allocated socket.
    plan: response.plan,
    profile,
    startRequest,
    specHash: profile.harnessInvocation.specHash,
    startRequestHash: profile.harnessInvocation.startRequestHash,
    identity,
    dispatchEnv: { HRC_DISPATCH: 'yes' },
  }
}

function headlessStartInput() {
  const identity = makeIdentity({
    runtimeId: 'runtime_headless',
    invocationId: 'invocation_headless',
    runId: 'run_headless',
  })
  const { profile, startRequest } = makeBrokerProfile(identity)
  const response = makeCompileResponse(identity, [profile])
  if (!response.ok) throw new Error('fixture compile response unexpectedly failed')
  return {
    plan: response.plan,
    profile,
    startRequest,
    specHash: profile.harnessInvocation.specHash,
    startRequestHash: profile.harnessInvocation.startRequestHash,
    identity,
    dispatchEnv: { HRC_DISPATCH: 'yes' },
  }
}

describe('T-01815 Phase 6 — getHarnessBrokerController() ACTIVATES the durable interactive route', () => {
  it('flag ON + interactive broker-tmux START ⇒ DURABLE allocator (broker+tui windows), NOT the legacy createLeaseSession path (RED)', async () => {
    const h = makeServerInstance(db, dir, true)
    const controller: HarnessBrokerController = getHarnessBrokerController.call(h.this)
    const result = await controller.start(interactiveStartInput() as never)

    // DIAGNOSTIC RED LEAD: at HEAD getHarnessBrokerController() ignores the flag
    // and the brokerTmuxManagerFactory seam, so the durable allocator never runs
    // and the injected fake tmux manager is never constructed (length 0).
    expect(h.managers.length).toBeGreaterThanOrEqual(1)
    const manager = h.managers[0]
    // The durable allocator ran on the injected tmux manager: a 'broker' window
    // launched exec-form over --transport unix + an idempotent 'tui' window.
    expect(manager?.windowWithCommandCalls).toHaveLength(1)
    const brokerCall = manager?.windowWithCommandCalls[0]
    expect(brokerCall?.windowName).toBe('broker')
    expect(brokerCall?.command).toContain('harness-broker')
    expect(brokerCall?.command).toContain('--transport')
    expect(brokerCall?.command).toContain('unix')
    expect(manager?.orInspectCalls).toEqual([
      { sessionName: expect.stringContaining('claude-code-tmux'), windowName: 'tui' },
    ])
    // The LEGACY single-window path must NOT run.
    expect(manager?.leaseSessionCalls).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('flag ON + interactive START ⇒ dials brokerUnixClientFactory/connectUnix with the allocated broker IPC socket, NOT the stdio brokerClientFactory (RED)', async () => {
    const h = makeServerInstance(db, dir, true)
    const controller: HarnessBrokerController = getHarnessBrokerController.call(h.this)
    const result = await controller.start(interactiveStartInput() as never)

    // DIAGNOSTIC RED LEAD: the durable route must dial the unix client factory
    // with the allocated broker IPC socket. At HEAD the flag is inert, so the
    // unix factory is never dialed (length 0).
    expect(h.unixCalls).toHaveLength(1)
    expect(typeof h.unixCalls[0]?.socketPath).toBe('string')
    expect(String(h.unixCalls[0]?.socketPath)).toContain('/bipc/')
    expect(String(h.unixCalls[0]?.socketPath).endsWith('/b.sock')).toBe(true)
    // The fresh durable interactive start must NOT spawn a stdio broker child.
    expect(h.stdioCalls).toHaveLength(0)
    expect(result.ok).toBe(true)
  })

  it('flag ON + interactive START ⇒ persists runtime_state_json.broker.endpoint.kind === unix-jsonrpc-ndjson + broker/tui identity (RED)', async () => {
    const h = makeServerInstance(db, dir, true)
    const controller: HarnessBrokerController = getHarnessBrokerController.call(h.this)
    const result = await controller.start(interactiveStartInput() as never)

    // DIAGNOSTIC RED LEAD: persisted endpoint must record the durable Unix
    // identity. At HEAD the legacy stdio allocator runs, so on success the
    // endpoint is stdio (and at HEAD the neutralized stdio spawn fails before the
    // broker block is even written) — never unix-jsonrpc-ndjson.
    const runtime = db.runtimes.getByRuntimeId('runtime_tmux')
    const broker = runtime?.runtimeStateJson?.['broker'] as Record<string, unknown> | undefined
    expect(broker).toBeDefined()
    const endpoint = broker?.['endpoint'] as Record<string, unknown> | undefined
    expect(endpoint?.['kind']).toBe('unix-jsonrpc-ndjson')
    expect(String(endpoint?.['socketPath']).endsWith('/b.sock')).toBe(true)
    expect(result.ok).toBe(true)
    // The raw attach token must NEVER be persisted.
    expect(JSON.stringify(runtime?.runtimeStateJson)).not.toContain('attach-token-secret')
    const brokerWindow = broker?.['brokerWindow'] as Record<string, unknown> | undefined
    const tuiWindow = broker?.['tuiWindow'] as Record<string, unknown> | undefined
    expect(brokerWindow?.['windowName']).toBe('broker')
    expect(tuiWindow?.['windowName']).toBe('tui')
  })

  it('flag ON + interactive START ⇒ hello negotiates harness-broker/0.2 on the durable route (RED — controller hello hardcodes v1)', async () => {
    const h = makeServerInstance(db, dir, true)
    const controller: HarnessBrokerController = getHarnessBrokerController.call(h.this)
    const result = await controller.start(interactiveStartInput() as never)

    // DIAGNOSTIC RED LEAD: the unix client (durable route) must be the one that
    // handshakes, and the hello must offer v0.2 — controller.start() currently
    // hardcodes protocolVersions:[BROKER_PROTOCOL_VERSION] (v1) AND at HEAD the
    // unix client is never reached at all (handshake count 0).
    expect(h.unixFake.helloCalls).toHaveLength(1)
    const offered = h.unixFake.helloCalls[0]?.protocolVersions ?? []
    expect(offered).toContain('harness-broker/0.2')
    // The stdio client must not have handshook on the durable route.
    expect(h.stdioFake.helloCalls).toHaveLength(0)
    expect(result.ok).toBe(true)
  })

  it('flag OFF + legacy stdio interactive broker ⇒ HRC offers ONLY v0.2 and REJECTS the v0.1 broker (broker_protocol_unsupported) — T-01866', async () => {
    const h = makeServerInstance(db, dir, false)
    const controller: HarnessBrokerController = getHarnessBrokerController.call(h.this)
    const result = await controller.start(interactiveStartInput() as never)

    // Flag OFF still routes through the legacy single-window stdio seam: the legacy
    // allocator runs on the injected tmux manager and the stdio factory is dialed
    // (never the unix factory).
    expect(h.stdioCalls).toHaveLength(1)
    expect(h.unixCalls).toHaveLength(0)
    const manager = h.managers[0]
    expect(manager).toBeDefined()
    expect(manager?.leaseSessionCalls.length).toBeGreaterThanOrEqual(1)
    expect(manager?.windowWithCommandCalls).toEqual([])

    // T-01866: HRC negotiates ONLY harness-broker/0.2 — never the decommissioned
    // v0.1 — even on the legacy stdio seam. The stdioFake advertises v0.1, so the
    // start is fail-closed with a clear unsupported-protocol error (no v0.1
    // fallback, no v0.2-over-stdio masquerade).
    expect(h.stdioFake.helloCalls).toHaveLength(1)
    const offered = h.stdioFake.helloCalls[0]?.protocolVersions ?? []
    expect(offered).toContain('harness-broker/0.2')
    expect(offered).not.toContain('harness-broker/0.1')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('broker_protocol_unsupported')
    }
    // Nothing durable was persisted for the rejected v0.1 broker.
    expect(db.runtimes.getByRuntimeId('runtime_tmux')).toBeNull()
  })

  it('HEADLESS broker START ⇒ DURABLE leased-tmux + Unix v0.2 (presentation=none), never stdio — T-01866', async () => {
    const h = makeServerInstance(db, dir, true)
    const controller: HarnessBrokerController = getHarnessBrokerController.call(h.this)
    const result = await controller.start(headlessStartInput() as never)

    // T-01866: the headless cutover is UNCONDITIONAL. A leased-tmux broker window
    // is allocated (exec-form over --transport unix) and dialed over the Unix v0.2
    // client; the stdio daemon-child path is gone.
    expect(h.managers.length).toBeGreaterThanOrEqual(1)
    const manager = h.managers[0]
    const brokerCall = manager?.windowWithCommandCalls[0]
    expect(brokerCall?.windowName).toBe('broker')
    expect(brokerCall?.command).toContain('harness-broker')
    expect(brokerCall?.command).toContain('--transport')
    expect(brokerCall?.command).toContain('unix')
    // presentation='none': a headless runtime creates NO operator tui window.
    expect(manager?.orInspectCalls).toEqual([])

    expect(h.unixCalls).toHaveLength(1)
    expect(h.stdioCalls).toHaveLength(0)
    expect(h.unixFake.helloCalls).toHaveLength(1)
    const offered = h.unixFake.helloCalls[0]?.protocolVersions ?? []
    expect(offered).toContain('harness-broker/0.2')
    expect(h.stdioFake.helloCalls).toHaveLength(0)

    const runtime = db.runtimes.getByRuntimeId('runtime_headless')
    const broker = runtime?.runtimeStateJson?.['broker'] as Record<string, unknown> | undefined
    const endpoint = broker?.['endpoint'] as Record<string, unknown> | undefined
    expect(endpoint?.['kind']).toBe('unix-jsonrpc-ndjson')
    // presentation='none' → no tui window persisted.
    expect(broker?.['tuiWindow']).toBeUndefined()
    expect(result.ok).toBe(true)
  })
})
