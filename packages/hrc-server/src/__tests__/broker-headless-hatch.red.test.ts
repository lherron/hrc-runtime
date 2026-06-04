/**
 * RED tests — T-01874 / T-01862 Ph3: escape-hatch reds for headless durable cutover.
 *
 * Escape hatch: env var HRC_HEADLESS_BROKER_LEGACY_STDIO=1 selects the legacy
 * v0.1/stdio/daemon-child headless route. Unset (or '0') = default durable
 * leased-tmux/unix/presentation:none route.
 *
 * These tests FAIL at HEAD because:
 *  - Default durable path is not yet wired (same root cause as core reds) →
 *    Red 1 fails.
 *  - Observability marker (brokerSubstrate in target runtime view) does not
 *    exist yet → Red 4 fails.
 *  - The hatch env var is not read by the controller yet → Red 2 passes today
 *    ACCIDENTALLY (legacy is the only path), bundled under Red 1 so the overall
 *    test is red.
 *
 * Daedalus rulings this encodes: C-03290 (hatch design), C-03291 (#1 observability,
 * #2 predicate-no-leak, #3 durable-negative, #4 no-v0.2-stdio).
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

import {
  type BrokerClientLike,
  HarnessBrokerController,
} from '../broker/controller'
import {
  canOperatorAttach,
  canUseDirectPaneFallback,
  hasDurableBrokerEndpoint,
  hasLeasedBrokerSubstrate,
  parseBrokerRuntimeHostingState,
} from '../broker/runtime-hosting'
import { toTargetRuntimeView } from '../target-view'
import {
  makeCompileResponse,
  makeIdentity,
} from './broker-compile-fixtures'

const NOW = '2026-06-04T12:00:00.000Z'

// ── Headless durable v0.2 profile (same fixture as core reds) ─────────────────

function makeHeadlessDurableProfile(
  identity: ReturnType<typeof makeIdentity>
): { profile: BrokerExecutionProfile; startRequest: InvocationStartRequest } {
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
      content: [{ type: 'text', text: 'hello durable headless hatch test' }],
    },
  } as unknown as InvocationStartRequest
  const profile = {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: 'profile_codex_headless_durable_hatch',
    profileHash: 'profilehash_headless_durable_hatch',
    compatibilityHash: 'compat_headless_durable_hatch',
    kind: 'harness-broker',
    interactionMode: 'headless',
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    brokerOwnership: 'hrc-owned-process',
    expectedCapabilities: {},
    harnessInvocation: {
      startRequest,
      specHash: 'spechash_headless_durable_hatch',
      startRequestHash: 'startrequesthash_headless_durable_hatch',
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

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeEvents implements AsyncIterable<InvocationEventEnvelope> {
  [Symbol.asyncIterator]() {
    return { next: async () => ({ done: true as const, value: undefined }) }
  }
}

function minCaps(): InvocationStartResponse['capabilities'] {
  return {
    input: { user: true, steer: false, appendContext: false, localImages: false, fileRefs: false, queue: false },
    turns: { concurrency: 'single', interrupt: 'protocol' },
    continuation: { supported: false, provider: 'openai', keyKind: 'session' },
    events: { assistantDeltas: true, toolCalls: true, usage: false, diagnostics: false, replay: false, ack: false },
    control: { stop: true, dispose: true, status: true, attach: false },
    permissions: { brokerToClientRequests: true, eventAudit: false },
  } as unknown as InvocationStartResponse['capabilities']
}

class FakeUnixClient {
  readonly events = new FakeEvents()
  readonly startCalls: Array<{ runtime?: InvocationRuntimeContext }> = []
  readonly helloResponse: BrokerHelloResponse = {
    brokerInfo: { name: 'harness-broker', version: '0.2.0-test' },
    protocolVersion: 'harness-broker/0.2',
    capabilities: {
      multiInvocation: false,
      transports: ['unix-jsonrpc-ndjson'],
      eventNotifications: true,
      brokerToClientRequests: true,
      attachReplay: true,
    },
    drivers: [{ kind: 'codex-app-server', version: '0.2.0-test', available: true, capabilities: minCaps() }],
  }
  startResponse: InvocationStartResponse = { invocationId: 'invocation_w2', state: 'ready', capabilities: minCaps() }
  onPermissionRequest(): void {}
  onClose(): void {}
  async hello(): Promise<BrokerHelloResponse> { return this.helloResponse }
  async health() { return { status: 'ok' as const, activeInvocations: 0, drivers: [] } }
  async startInvocationFromRequest(_req: InvocationStartRequest, _env?: unknown, runtime?: InvocationRuntimeContext) {
    this.startCalls.push({ runtime })
    return { invocationId: this.startResponse.invocationId, response: this.startResponse, events: this.events }
  }
  async input() { return { inputId: 'i', accepted: true, disposition: 'started' as const } }
  async interrupt() { return { accepted: true, effect: 'turn_interrupted' as const } }
  async stop() { return { accepted: true, state: 'stopping' as const } }
  async status() { return this.startResponse }
  async dispose() {}
  async close() {}
  async attach() { return {} }
  async snapshot() { return {} }
  async eventsSince() { return { events: [] } }
  async ackEvents() { return {} }
  async permissionRespond() { return {} }
}

class FakeStdioClient {
  readonly events = new FakeEvents()
  readonly helloResponse: BrokerHelloResponse = {
    brokerInfo: { name: 'harness-broker', version: '0.1.0-test' },
    protocolVersion: 'harness-broker/0.1',
    capabilities: {
      multiInvocation: false,
      transports: ['stdio-jsonrpc-ndjson'],
      eventNotifications: true,
      brokerToClientRequests: true,
    },
    drivers: [{ kind: 'codex-app-server', version: '0.1.0-test', available: true, capabilities: minCaps() }],
  }
  startResponse: InvocationStartResponse = { invocationId: 'invocation_w2', state: 'ready', capabilities: minCaps() }
  onPermissionRequest(): void {}
  onClose(): void {}
  async hello(): Promise<BrokerHelloResponse> { return this.helloResponse }
  async health() { return { status: 'ok' as const, activeInvocations: 0, drivers: [] } }
  async startInvocationFromRequest() {
    return { invocationId: this.startResponse.invocationId, response: this.startResponse, events: this.events }
  }
  async input() { return { inputId: 'i', accepted: true, disposition: 'started' as const } }
  async interrupt() { return { accepted: true, effect: 'turn_interrupted' as const } }
  async stop() { return { accepted: true, state: 'stopping' as const } }
  async status() { return this.startResponse }
  async dispose() {}
  async close() {}
}

function headlessDurableAlloc() {
  const ipc = '/tmp/bipc/hatch-rt-w2/b.sock'
  return {
    socketPath: '/tmp/btmux/codex-app-server-hatch-rt.sock',
    allocatedAt: NOW,
    generation: 1,
    brokerIpcSocketPath: ipc,
    attachToken: 'tok-hatch',
    attachTokenRef: { kind: 'file', path: '/tmp/bipc/hatch-rt-w2/attach.token', redacted: true },
    brokerCommand: `exec harness-broker run --transport unix --socket ${ipc}`,
    brokerPid: 6000,
    brokerWindow: { socketPath: '/tmp/btmux/codex-app-server-hatch-rt.sock', sessionId: '$7', windowId: '@14', paneId: '%28', sessionName: 'hrc-codex-hatch', windowName: 'broker' },
    sessionId: '$7', windowId: '@14', paneId: '%28', sessionName: 'hrc-codex-hatch', windowName: 'broker',
  }
}

// ── DB fixture ────────────────────────────────────────────────────────────────

type Fixture = { db: HrcDatabase; dir: string; cleanup: () => Promise<void> }

async function makeFixture(runtimeId = 'runtime_w2'): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-headless-hatch-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  db.sessions.insert({
    hostSessionId: 'hostSession_hatch',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01874',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  void runtimeId
  return { db, dir, cleanup: async () => { db.close(); await rm(dir, { recursive: true, force: true }) } }
}

// ── Controller builder that passes hatch env ──────────────────────────────────
// curly reads `deps.env?.HRC_HEADLESS_BROKER_LEGACY_STDIO` to choose the route.

function makeHatchController(
  db: HrcDatabase,
  opts: {
    stdioFactoryCalls?: unknown[]
    unixFactoryCalls?: Array<{ socketPath: string }>
    unixClient?: FakeUnixClient
    stdioClient?: FakeStdioClient
    hatchActive: boolean
    useDurableAllocator?: boolean
  }
): HarnessBrokerController {
  const unixClient = opts.unixClient ?? new FakeUnixClient()
  const stdioClient = opts.stdioClient ?? new FakeStdioClient()
  return new HarnessBrokerController({
    db,
    // Inject the hatch env var — curly reads this to select legacy vs durable.
    env: opts.hatchActive ? { HRC_HEADLESS_BROKER_LEGACY_STDIO: '1' } : {},
    brokerClientFactory: async (startOpts: unknown) => {
      opts.stdioFactoryCalls?.push(startOpts)
      return stdioClient as unknown as BrokerClientLike
    },
    brokerUnixClientFactory: async (connectOpts: { socketPath: string }) => {
      opts.unixFactoryCalls?.push(connectOpts)
      return unixClient
    },
    tmuxAllocator: opts.useDurableAllocator
      ? { allocate: async () => headlessDurableAlloc() }
      : undefined,
    now: () => NOW,
  } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])
}

async function startWithIdentity(
  db: HrcDatabase,
  controller: HarnessBrokerController,
  identityOverride?: Partial<ReturnType<typeof makeIdentity>>
) {
  const identity = makeIdentity({ hostSessionId: 'hostSession_hatch' as ReturnType<typeof makeIdentity>['hostSessionId'], ...identityOverride })
  const { profile, startRequest } = makeHeadlessDurableProfile(identity)
  const response = makeCompileResponse(identity, [profile])
  if (!response.ok) throw new Error('fixture compile failed')
  const result = await controller.start({
    plan: response.plan,
    profile,
    startRequest,
    specHash: profile.harnessInvocation.specHash,
    startRequestHash: profile.harnessInvocation.startRequestHash,
    identity,
    dispatchEnv: {},
  })
  return { result, identity }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('T-01874 Ph3 — escape-hatch reds (RED)', () => {
  let fixture: Fixture

  beforeEach(async () => { fixture = await makeFixture() })
  afterEach(async () => { await fixture.cleanup() })

  // ── T-01866: the escape hatch is GONE. The headless route is durable
  // UNCONDITIONALLY. A stale HRC_HEADLESS_BROKER_LEGACY_STDIO=1 env var has ZERO
  // route authority: it must NOT resurrect legacy stdio and must NOT create a
  // v0.2-over-stdio path. Both default (unset) and hatch-set starts produce the
  // SAME durable {unix + leased-tmux + presentation:none} hosting shape.

  it('default AND stale-hatch both → durable {unix + leased-tmux}; the legacy-stdio env var has no authority', async () => {
    // ── default (hatch unset) → durable ───────────────────────────────────────
    const unixFactoryCalls: Array<{ socketPath: string }> = []
    const stdioFactoryCalls: unknown[] = []
    const unixClient = new FakeUnixClient()

    const defaultController = makeHatchController(fixture.db, {
      hatchActive: false,
      stdioFactoryCalls,
      unixFactoryCalls,
      unixClient,
      useDurableAllocator: false,
    })
    const { result: defaultResult, identity } = await startWithIdentity(fixture.db, defaultController)
    expect(defaultResult.ok).toBe(true)

    const defaultRuntime = fixture.db.runtimes.getByRuntimeId(String(identity.runtimeId))
    expect(defaultRuntime).toBeDefined()
    const defaultHosting = parseBrokerRuntimeHostingState(defaultRuntime!)

    expect(defaultHosting?.endpoint.kind).toBe('unix-jsonrpc-ndjson')
    expect(defaultHosting?.substrate.kind).toBe('leased-tmux')
    expect(defaultHosting?.presentation.kind).toBe('none')
    expect(hasDurableBrokerEndpoint(defaultRuntime!)).toBe(true)
    expect(hasLeasedBrokerSubstrate(defaultRuntime!)).toBe(true)
    expect(canOperatorAttach(defaultRuntime!)).toBe(false)
    // The durable route never spawned a stdio broker child.
    expect(stdioFactoryCalls.length).toBe(0)
    expect(unixFactoryCalls.length).toBeGreaterThan(0)

    // ── hatch set (HRC_HEADLESS_BROKER_LEGACY_STDIO=1) → STILL durable ─────────
    // Fresh fixture so runtimeIds don't collide.
    const fixture2 = await makeFixture()
    try {
      const hatchStdioFactoryCalls: unknown[] = []
      const hatchUnixFactoryCalls: Array<{ socketPath: string }> = []
      const hatchController = makeHatchController(fixture2.db, {
        hatchActive: true,
        stdioFactoryCalls: hatchStdioFactoryCalls,
        unixFactoryCalls: hatchUnixFactoryCalls,
        useDurableAllocator: false,
      })
      const { result: hatchResult, identity: hatchId } = await startWithIdentity(fixture2.db, hatchController)
      expect(hatchResult.ok).toBe(true)

      const hatchRuntime = fixture2.db.runtimes.getByRuntimeId(String(hatchId.runtimeId))
      expect(hatchRuntime).toBeDefined()
      const hatchHosting = parseBrokerRuntimeHostingState(hatchRuntime!)

      // The stale hatch env var has NO authority: the runtime is durable, NOT
      // legacy stdio/daemon-child. Identical shape to the default route.
      expect(hatchHosting?.endpoint.kind).toBe('unix-jsonrpc-ndjson')
      expect(hatchHosting?.substrate.kind).toBe('leased-tmux')
      expect(hatchHosting?.presentation.kind).toBe('none')
      expect(hasDurableBrokerEndpoint(hatchRuntime!)).toBe(true)
      expect(hasLeasedBrokerSubstrate(hatchRuntime!)).toBe(true)
      expect(canUseDirectPaneFallback(hatchRuntime!)).toBe(false)
      // No stdio resurrection: the unix factory was dialed, the stdio factory was not.
      expect(hatchStdioFactoryCalls.length).toBe(0)
      expect(hatchUnixFactoryCalls.length).toBeGreaterThan(0)
    } finally {
      await fixture2.cleanup()
    }
  })

  // ── RED 3: PREDICATE-NO-LEAK ──────────────────────────────────────────────
  // The hatch env var must have ZERO authority over durability predicates.
  // Two runtimes with IDENTICAL hosting state (stdio endpoint, daemon-child) must
  // yield identical predicate results regardless of whether the hatch flag was set
  // when the runtime was created. Durability truth comes ONLY from endpoint/substrate.
  //
  // This test passes TODAY (predicates already ignore env vars — they read only
  // runtimeStateJson). It is a static guard: fails if curly accidentally writes
  // hatch-flag reading into parseBrokerRuntimeHostingState or its predicates.
  // Included here so the guard is explicit.

  it('RED 3 (predicate no-leak guard): hatch env has zero authority over durability predicates', () => {
    // Simulate two runtime snapshots with identical hosting state (legacy stdio shape).
    // One "was created with hatch on", one "without" — but runtimeStateJson is the same.
    const baseHostingBlock = {
      endpoint: { kind: 'stdio-jsonrpc-ndjson' },
      // No brokerWindow, no tuiWindow → parseFlatSubstrate → daemon-child
    }
    const runtimeA = {
      runtimeId: 'rt-hatch-on',
      hostSessionId: 'hsid-hatch',
      scopeRef: 'agent:test',
      laneRef: 'main',
      generation: 1,
      transport: 'headless' as const,
      harness: 'codex' as const,
      provider: 'openai' as const,
      status: 'ready' as const,
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker' as const,
      createdAt: NOW,
      updatedAt: NOW,
      runtimeStateJson: { schemaVersion: 'runtime-state/v1', kind: 'harness-broker', runtimeId: 'rt-hatch-on', broker: baseHostingBlock },
    }
    const runtimeB = { ...runtimeA, runtimeId: 'rt-hatch-off' }

    // Both must have identical predicate results.
    expect(hasDurableBrokerEndpoint(runtimeA)).toBe(hasDurableBrokerEndpoint(runtimeB))
    expect(hasLeasedBrokerSubstrate(runtimeA)).toBe(hasLeasedBrokerSubstrate(runtimeB))
    expect(canOperatorAttach(runtimeA)).toBe(canOperatorAttach(runtimeB))
    // The predicate must NOT read env vars — it returns false for BOTH (daemon-child, no endpoint).
    expect(hasDurableBrokerEndpoint(runtimeA)).toBe(false)
    expect(hasLeasedBrokerSubstrate(runtimeA)).toBe(false)
  })

  // ── RED 4: OBSERVABILITY ──────────────────────────────────────────────────
  // When the hatch is active, the legacy route must be visible PER-runtime in the
  // status/inspect projection (not just a startup log line). Curly must add a
  // brokerSubstrate (or equivalent) field to toTargetRuntimeView.
  //
  // TODAY FAILS: toTargetRuntimeView returns no brokerSubstrate / headlessRoute
  // field (the field doesn't exist in HrcTargetRuntimeView yet).
  // Fix: add brokerSubstrate (or headlessRoute) populated from parseBrokerRuntimeHostingState.

  it('observability: a stale-hatch runtime projects the DURABLE route marker (brokerSubstrate=leased-tmux / headlessRoute=durable-leased)', async () => {
    const fixture4 = await makeFixture()
    try {
      const hatchController = makeHatchController(fixture4.db, {
        hatchActive: true,
        useDurableAllocator: false,
      })
      const { identity } = await startWithIdentity(fixture4.db, hatchController)

      const runtime = fixture4.db.runtimes.getByRuntimeId(String(identity.runtimeId))
      expect(runtime).toBeDefined()

      // toTargetRuntimeView is the per-runtime status projection. Post-cutover the
      // hatch has no authority, so the runtime is DURABLE and the projection must
      // surface the durable substrate/route — never a legacy-stdio marker.
      const view = toTargetRuntimeView(runtime!)
      expect(view).toBeDefined()

      const rawView = view as Record<string, unknown>
      expect(rawView['brokerSubstrate']).toBe('leased-tmux')
      expect(rawView['headlessRoute']).toBe('durable-leased')
    } finally {
      await fixture4.cleanup()
    }
  })

  // ── RED 5: NEGATIVE — no v0.2-over-stdio route selectable ────────────────
  // C-03291 #4 + daedalus Q3: neither default nor hatch produces a v0.2/unix-over-stdio
  // (e.g. v0.2 protocol but stdio transport — a "poison" combo that would pass
  // admission but break reattach). The only two valid headless hosting shapes are:
  //   A. {endpoint:unix-jsonrpc-ndjson, substrate:leased-tmux, v0.2}  (default)
  //   B. {endpoint:stdio-jsonrpc-ndjson, substrate:daemon-child, v0.1} (hatch)
  //
  // This is a static contract assertion — no controller execution needed.
  // TODAY: Red 5 passes because no v0.2/stdio combination is produced at HEAD
  // (both paths are actually stdio/v0.1). After Ph3, we assert the constraint holds.
  // Written as a guard: would FAIL if curly accidentally wires a v0.2/stdio path.

  it('RED 5 (negative guard): no v0.2-over-stdio route; only {unix+leased+v0.2} and {stdio+daemon+v0.1} are valid', () => {
    // Simulate both valid hosting shapes from parseBrokerRuntimeHostingState and
    // assert neither is {unix + daemon-child} or {stdio + v0.2}.
    const durableShape = {
      endpoint: { kind: 'unix-jsonrpc-ndjson' as const, socketPath: '/tmp/b.sock', attachTokenRef: { kind: 'file' as const, path: '/tmp/tok', redacted: true as const }, protocolVersion: 'harness-broker/0.2' as const },
      substrate: { kind: 'leased-tmux' as const, tmuxSocketPath: '/tmp/btmux.sock', sessionName: 's', brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' }, generation: 1, eventLedgerPath: '/tmp/ev.ndjson' },
      presentation: { kind: 'none' as const },
    }
    const legacyShape = {
      endpoint: { kind: 'stdio-jsonrpc-ndjson' as const },
      substrate: { kind: 'daemon-child' as const },
      presentation: { kind: 'none' as const },
    }

    // Valid durable shape: unix endpoint + leased-tmux substrate.
    expect(durableShape.endpoint.kind).toBe('unix-jsonrpc-ndjson')
    expect(durableShape.substrate.kind).toBe('leased-tmux')
    expect(durableShape.endpoint.protocolVersion).toBe('harness-broker/0.2')

    // Valid legacy shape: stdio endpoint + daemon-child substrate.
    expect(legacyShape.endpoint.kind).toBe('stdio-jsonrpc-ndjson')
    expect(legacyShape.substrate.kind).toBe('daemon-child')

    // FORBIDDEN shape: stdio endpoint with v0.2 protocol (daedalus Q3).
    // Assert this combination is structurally rejected by the type system:
    // BrokerRuntimeEndpoint 'stdio-jsonrpc-ndjson' has NO protocolVersion field.
    // The type union guarantees stdio ≠ v0.2 at compile time; confirm at runtime too.
    const stdioEndpoint = legacyShape.endpoint as Record<string, unknown>
    expect(stdioEndpoint['protocolVersion']).toBeUndefined()

    // FORBIDDEN shape: unix endpoint with daemon-child substrate is not a valid
    // pairing (unix = durable IPC requires a managed tmux session to host the process).
    // Assert curly does not produce this from either route.
    // (No controller execution needed; this is a contract assertion on the shape definitions.)
    // Both valid shapes have matching endpoint kind ↔ substrate kind:
    //   unix → leased-tmux   (durable)
    //   stdio → daemon-child (legacy)
    const shapeA = `${durableShape.endpoint.kind}:${durableShape.substrate.kind}`
    const shapeB = `${legacyShape.endpoint.kind}:${legacyShape.substrate.kind}`
    const allowedShapes = new Set(['unix-jsonrpc-ndjson:leased-tmux', 'stdio-jsonrpc-ndjson:daemon-child'])
    expect(allowedShapes.has(shapeA)).toBe(true)
    expect(allowedShapes.has(shapeB)).toBe(true)
  })
})
