/**
 * RED tests (T-01732 / T-01730) — HRC pane-lease DISPATCH contract.
 *
 * Governing plan: C-02889 on T-01730. These tests pin the broker-facing
 * dispatch contract the pre-HRC harness already certified against the REAL
 * claude/codex binaries (packages/agent-spaces/src/testing/
 * pre-hrc-interactive-tmux-runner.ts + pre-hrc-tmux-allocator.ts), which HRC's
 * HarnessBrokerController must mirror exactly. They are EXPECTED TO FAIL at HEAD
 * and turn green only once the controller dispatches a `runtime.terminalSurface`
 * pane lease instead of the legacy `runtime.tmux` socket shim.
 *
 * Coverage:
 *   #1  toDispatchRuntime emits `runtime.terminalSurface` (kind 'tmux-pane',
 *       ownership 'hrc') for interactive broker-tmux dispatch — NOT the legacy
 *       `runtime.tmux` socket. Covers BOTH claude-code-tmux and codex-cli-tmux.
 *   #2  Structural hash boundary: the compiled InvocationStartRequest carries no
 *       runtime; no tmux pane ids leak into the persisted plan projection, the
 *       start-request projection, or the spec/start-request hashes. The pane
 *       lease lives ONLY in the dispatch-time runtime overlay.
 *
 * Boundary note: this file imports only the controller-under-test, the broker
 * protocol TYPES, the W2 compile fixtures, and persistence. It launches/execs
 * nothing; the controller stays inert behind the fake broker client.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'
import type {
  BrokerHealthRequest,
  BrokerHealthResponse,
  BrokerHelloRequest,
  BrokerHelloResponse,
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationEventEnvelope,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationRuntimeContext,
  InvocationStartRequest,
  InvocationStartResponse,
  InvocationStatusRequest,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import { project } from 'spaces-runtime-contracts'
import type {
  BrokerExecutionProfile,
  RuntimeIdentityAllocation,
} from 'spaces-runtime-contracts'

import {
  type BrokerClientLike,
  type BrokerTmuxAllocation,
  HarnessBrokerController,
} from '../broker/controller'

import { makeCompileResponse, makeIdentity } from './broker-compile-fixtures'

const NOW = '2026-05-27T12:34:56.000Z'

/** The runtime-owned terminal-surface pane lease shape, derived from protocol. */
type TerminalSurfaceLease = NonNullable<InvocationRuntimeContext['terminalSurface']>

type TmuxDriver = 'claude-code-tmux' | 'codex-cli-tmux'

type TestFixture = {
  db: HrcDatabase
  dir: string
  cleanup: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Per-driver lease fixtures (pane ids follow the protocol shape rules:
// sessionId ^\$\d+$, windowId ^@\d+$, paneId ^%\d+$).
// ---------------------------------------------------------------------------
function leaseFor(driver: TmuxDriver, runtimeId: string): TerminalSurfaceLease {
  const idx = driver === 'claude-code-tmux' ? { s: '$3', w: '@7', p: '%12' } : { s: '$5', w: '@9', p: '%21' }
  return {
    kind: 'tmux-pane',
    ownership: 'hrc',
    socketPath: `/tmp/hrc-runtime/${driver}/${runtimeId}/tmux.sock`,
    sessionId: idx.s,
    windowId: idx.w,
    paneId: idx.p,
    sessionName: `hrc-${driver}-${runtimeId}`,
    windowName: 'main',
    allowedOps: {
      inspect: true,
      sendInput: true,
      sendInterrupt: true,
      capture: true,
      resize: false,
    },
  }
}

/** Interactive broker-tmux profile for the given driver, honest hashes. */
function interactiveTmuxProfile(
  identity: RuntimeIdentityAllocation,
  driver: TmuxDriver
): { profile: BrokerExecutionProfile; startRequest: InvocationStartRequest } {
  const frontend = driver === 'claude-code-tmux' ? 'claude' : 'codex'
  const provider = driver === 'claude-code-tmux' ? 'anthropic' : 'openai'
  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: identity.invocationId,
    harness: { frontend, provider, driver },
    process: {
      command: frontend,
      args: [],
      cwd: '/tmp/work',
      lockedEnv: {},
      harnessTransport: { kind: 'pty' },
    },
    interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: { kind: driver },
    correlation: {
      requestId: String(identity.requestId),
      operationId: String(identity.operationId),
      runtimeId: String(identity.runtimeId),
      invocationId: String(identity.invocationId),
    },
  } as unknown as HarnessInvocationSpec

  const startRequest: InvocationStartRequest = {
    spec,
    ...(identity.initialInputId
      ? {
          initialInput: {
            inputId: identity.initialInputId,
            kind: 'user',
            content: [{ type: 'text', text: 'hello interactive tmux' }],
          },
        }
      : {}),
  } as InvocationStartRequest

  const specHash = (project(spec, 'spec') as { specHash: string }).specHash
  const startRequestHash = (project(startRequest, 'start-request') as { startRequestHash: string })
    .startRequestHash

  const profile = {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: `profile_${driver}`,
    profileHash: `profilehash_${driver}`,
    compatibilityHash: `compat_${driver}`,
    kind: 'harness-broker',
    interactionMode: 'interactive',
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: driver,
    brokerOwnership: 'hrc-owned-process',
    brokerTerminal: { host: 'tmux' },
    expectedCapabilities: {},
    harnessInvocation: { startRequest, specHash, startRequestHash },
    policy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {},
      exposurePolicy: {},
    },
    observability: {},
  } as unknown as BrokerExecutionProfile

  return { profile, startRequest }
}

// ---------------------------------------------------------------------------
// Minimal fake broker client capturing the dispatch runtime overlay.
// ---------------------------------------------------------------------------
class FakeBrokerClient implements BrokerClientLike {
  readonly startCalls: Array<{
    request: InvocationStartRequest
    dispatchEnv?: Record<string, string> | undefined
    runtime?: InvocationRuntimeContext | undefined
  }> = []

  constructor(
    private readonly driverKind: string,
    private readonly invocationId: string
  ) {}

  private closeHandler?: (error: Error) => void

  onPermissionRequest(
    _handler: (request: PermissionRequestParams) => Promise<PermissionDecision>
  ): void {}

  onClose(handler: (error: Error) => void): void {
    this.closeHandler = handler
  }

  async hello(_req: BrokerHelloRequest): Promise<BrokerHelloResponse> {
    return {
      brokerInfo: { name: 'harness-broker', version: '0.2.0-test' },
      protocolVersion: 'harness-broker/0.2',
      capabilities: {
        multiInvocation: false,
        transports: ['stdio-jsonrpc-ndjson'],
        eventNotifications: true,
        brokerToClientRequests: true,
      },
      drivers: [
        {
          kind: this.driverKind,
          version: '0.1.1-test',
          available: true,
          capabilities: invocationCapabilities(),
        },
      ],
    } as BrokerHelloResponse
  }

  async health(_req: BrokerHealthRequest = {}): Promise<BrokerHealthResponse> {
    return { status: 'ok', activeInvocations: 1, drivers: [] }
  }

  async startInvocationFromRequest(
    request: InvocationStartRequest,
    dispatchEnv?: Record<string, string>,
    runtime?: InvocationRuntimeContext
  ): Promise<{
    invocationId: string
    response: InvocationStartResponse
    events: AsyncIterable<InvocationEventEnvelope>
  }> {
    this.startCalls.push({ request, dispatchEnv, runtime })
    return {
      invocationId: this.invocationId,
      response: {
        invocationId: this.invocationId,
        state: 'ready',
        capabilities: invocationCapabilities(),
      } as InvocationStartResponse,
      events: emptyEvents(),
    }
  }

  async input(_req: InvocationInputRequest): Promise<InvocationInputResponse> {
    return { inputId: 'input_later', accepted: true, disposition: 'started' }
  }

  async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
    return { accepted: true, effect: 'turn_interrupted' }
  }

  async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
    return { accepted: true, state: 'stopping' }
  }

  async status(_req: InvocationStatusRequest): Promise<InvocationStatusResponse> {
    return {
      invocationId: this.invocationId,
      state: 'ready',
      capabilities: invocationCapabilities(),
    } as InvocationStatusResponse
  }

  async dispose(): Promise<void> {}

  async close(): Promise<void> {
    this.closeHandler?.(new Error('closed'))
  }
}

function emptyEvents(): AsyncIterable<InvocationEventEnvelope> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InvocationEventEnvelope> {
      return {
        next: () => Promise.resolve({ done: true, value: undefined }),
      }
    },
  }
}

function invocationCapabilities(): InvocationCapabilities {
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
    continuation: { supported: true, provider: 'openai', keyKind: 'thread' },
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
  }
}

let fixture: TestFixture

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

async function makeFixture(): Promise<TestFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-pane-lease-dispatch-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  db.sessions.insert({
    hostSessionId: 'hostSession_w2',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01732',
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

/** Drive controller.start() through a tmux pane allocation for a given driver. */
async function startWithLease(
  driver: TmuxDriver
): Promise<{ fake: FakeBrokerClient; lease: TerminalSurfaceLease; identity: RuntimeIdentityAllocation }> {
  const runtimeId = `runtime_${driver.replace(/-/g, '_')}`
  const invocationId = `invocation_${driver.replace(/-/g, '_')}`
  const identity = makeIdentity({
    runtimeId: runtimeId as RuntimeIdentityAllocation['runtimeId'],
    invocationId: invocationId as RuntimeIdentityAllocation['invocationId'],
    runId: `run_${driver.replace(/-/g, '_')}` as RuntimeIdentityAllocation['runId'],
  })
  const { profile, startRequest } = interactiveTmuxProfile(identity, driver)
  const response = makeCompileResponse(identity, [profile])
  if (!response.ok) throw new Error('fixture compile response unexpectedly failed')

  const lease = leaseFor(driver, runtimeId)
  const fake = new FakeBrokerClient(driver, invocationId)

  // The allocator returns the FULL pane lease. At HEAD the controller only
  // reads `.socketPath`; the GREEN target widens the allocation to carry the
  // pane ids and dispatches them via runtime.terminalSurface.
  const allocation = {
    socketPath: lease.socketPath,
    allocatedAt: NOW,
    lease,
    sessionId: lease.sessionId,
    windowId: lease.windowId,
    paneId: lease.paneId,
    sessionName: lease.sessionName,
    windowName: lease.windowName,
  } as unknown as BrokerTmuxAllocation

  const controller = new HarnessBrokerController({
    db: fixture.db,
    brokerClientFactory: async () => fake,
    tmuxAllocator: {
      async allocate() {
        return allocation
      },
    },
    now: () => NOW,
  })

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

  return { fake, lease, identity }
}

// ---------------------------------------------------------------------------
// #1 — dispatch emits runtime.terminalSurface pane lease, not legacy tmux
// ---------------------------------------------------------------------------
describe('RED #1: pane-lease dispatch (runtime.terminalSurface, not runtime.tmux)', () => {
  for (const driver of ['claude-code-tmux', 'codex-cli-tmux'] as const) {
    it(`dispatches a tmux-pane terminalSurface lease for ${driver}`, async () => {
      const { fake, lease } = await startWithLease(driver)

      const dispatched = fake.startCalls[0]?.runtime
      expect(dispatched).toBeDefined()

      // The lease is dispatched as terminalSurface (kind tmux-pane, hrc-owned).
      expect(dispatched?.terminalSurface).toEqual(lease)

      // The legacy `runtime.tmux` socket shim is NOT used on the new path.
      expect(dispatched?.tmux).toBeUndefined()
    })
  }
})

// ---------------------------------------------------------------------------
// #2 — structural hash boundary: lease lives only in the runtime overlay
// ---------------------------------------------------------------------------
describe('RED #2: structural hash boundary (lease only in runtime arg)', () => {
  for (const driver of ['claude-code-tmux', 'codex-cli-tmux'] as const) {
    it(`keeps tmux pane ids out of the compiled request / hashes for ${driver}`, async () => {
      const { fake, lease, identity } = await startWithLease(driver)

      // The compiled InvocationStartRequest carries no runtime overlay.
      const dispatchedRequest = fake.startCalls[0]?.request as unknown as {
        runtime?: unknown
      }
      expect(dispatchedRequest.runtime).toBeUndefined()

      // The pane lease IS present in the dispatch-time runtime overlay.
      const runtimeJson = JSON.stringify(fake.startCalls[0]?.runtime ?? null)
      expect(runtimeJson).toContain(lease.paneId)
      expect(runtimeJson).toContain(lease.sessionId)
      expect(runtimeJson).toContain(lease.windowId)

      // ...and is ABSENT from every persisted/hashable projection.
      const invocation = fixture.db.brokerInvocations.getByInvocationId(
        String(identity.invocationId)
      )!
      const plan = fixture.db.compiledRuntimePlans.getByPlanHash('planhash_w2')!
      const persisted = JSON.stringify({ invocation, plan })

      for (const tmuxId of [lease.paneId, lease.sessionId, lease.windowId]) {
        expect(persisted).not.toContain(tmuxId)
      }
      // Hashes never carry the lease either.
      expect(invocation.startRequestHash).not.toContain(lease.paneId)
      expect(invocation.specHash).not.toContain(lease.paneId)
    })
  }
})
