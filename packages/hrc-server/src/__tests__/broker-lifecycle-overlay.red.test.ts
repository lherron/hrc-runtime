/**
 * RED boundary tests for T-01787 (T-01783 Workstream A):
 * HRC route lifecycle overlay assembly + dispatch + hash-invariance boundary.
 *
 * Author: smokey (TDD RED gatekeeper). These tests are written BEFORE the
 * implementation and are EXPECTED TO FAIL until WS-A lands. They pin the
 * critical INV-14.4 compiler-closure boundary: a broker lifecycle overlay must
 * ride ONLY on the dispatch envelope (InvocationDispatchRequest.lifecyclePolicy
 * / the broker client's dispatch options) and NEVER leak into the compiled
 * InvocationStartRequest, HarnessInvocationSpec, the selected execution
 * profile, or startRequestHash material.
 *
 * The implementer (WS-A) must provide:
 *   - packages/hrc-server/src/broker/lifecycle-overlay.ts exporting
 *       resolveLifecyclePolicyOverlay(ctx): BrokerLifecyclePolicyOverlay | undefined
 *       lifecyclePolicyIdForRoute(routeId: string): string
 *       preflightLifecyclePolicyCapabilities(overlay, capabilities): void
 *       LifecyclePolicyCapabilityError (typed, fail-closed)
 *   - BrokerControllerStartInput.lifecyclePolicy threading (controller.ts), with
 *       BrokerClientLike.startInvocationFromRequest widened to carry the overlay
 *       via the real client's dispatch-options form.
 *   - Persistence of the dispatched overlay via WS-B's lifecyclePolicies repo +
 *       broker_invocations.lifecycle_policy_hash.
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-server test broker-lifecycle-overlay
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'
import {
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
  canonicalLifecyclePolicyJson,
  conservativeDefaultLifecyclePolicyOverlay,
  lifecyclePolicyHash,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerHealthRequest,
  BrokerHealthResponse,
  BrokerHelloRequest,
  BrokerHelloResponse,
  BrokerLifecyclePolicyOverlay,
  InvocationCapabilities,
  InvocationEventEnvelope,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationLifecycleCapabilities,
  InvocationRuntimeContext,
  InvocationStartRequest,
  InvocationStartResponse,
  InvocationStatusRequest,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import { project } from 'spaces-runtime-contracts'
import type { BrokerExecutionProfile, CompiledRuntimePlan } from 'spaces-runtime-contracts'

import { type BrokerClientLike, HarnessBrokerController } from '../broker/controller'
// RED: this module does not exist yet — the import fails until WS-A lands it.
import {
  LifecyclePolicyCapabilityError,
  lifecyclePolicyIdForRoute,
  preflightLifecyclePolicyCapabilities,
  resolveLifecyclePolicyOverlay,
} from '../broker/lifecycle-overlay'

import { makeBrokerProfile, makeCompileResponse, makeIdentity } from './broker-compile-fixtures'

const NOW = '2026-06-01T12:34:56.000Z'

/** The real broker client's dispatch-options form (not re-exported from root). */
type DispatchOptions = {
  dispatchEnv?: Record<string, string> | undefined
  runtime?: InvocationRuntimeContext | undefined
  lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
}

type TestFixture = {
  db: HrcDatabase
  dir: string
  cleanup: () => Promise<void>
}

class PushableEvents implements AsyncIterable<InvocationEventEnvelope> {
  private queue: InvocationEventEnvelope[] = []
  private waiters: Array<(result: IteratorResult<InvocationEventEnvelope>) => void> = []
  private closed = false

  next(): Promise<IteratorResult<InvocationEventEnvelope>> {
    const event = this.queue.shift()
    if (event) return Promise.resolve({ done: false, value: event })
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<InvocationEventEnvelope> {
    return this
  }
}

/**
 * Fake broker client mirroring the REAL client's union signature
 * (request, dispatchEnvOrOptions?, runtime?). It records the resolved
 * lifecyclePolicy regardless of which calling convention the implementer picks,
 * so this test pins the *boundary*, not the *call shape*.
 */
class FakeBrokerClient implements BrokerClientLike {
  readonly events = new PushableEvents()
  readonly startCalls: Array<{
    request: InvocationStartRequest
    dispatchEnv?: Record<string, string> | undefined
    runtime?: InvocationRuntimeContext | undefined
    lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
  }> = []
  private closeHandler?: (error: Error) => void

  helloResponse: BrokerHelloResponse = {
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
        kind: 'codex-app-server',
        version: '0.1.1-test',
        available: true,
        capabilities: invocationCapabilities(),
      },
    ],
  }

  startResponse: InvocationStartResponse = {
    invocationId: 'invocation_w2',
    state: 'ready',
    capabilities: invocationCapabilities(),
  }

  onPermissionRequest(): void {}

  onClose(handler: (error: Error) => void): void {
    this.closeHandler = handler
  }

  async hello(_req: BrokerHelloRequest): Promise<BrokerHelloResponse> {
    return this.helloResponse
  }

  async health(_req: BrokerHealthRequest = {}): Promise<BrokerHealthResponse> {
    return { status: 'ok', activeInvocations: 1, drivers: this.helloResponse.drivers }
  }

  async startInvocationFromRequest(
    request: InvocationStartRequest,
    dispatchEnvOrOptions?: Record<string, string> | DispatchOptions,
    runtime?: InvocationRuntimeContext
  ): Promise<{
    invocationId: string
    response: InvocationStartResponse
    events: AsyncIterable<InvocationEventEnvelope>
  }> {
    const opts = normalizeDispatchArgs(dispatchEnvOrOptions, runtime)
    this.startCalls.push({ request, ...opts })
    return {
      invocationId: this.startResponse.invocationId,
      response: this.startResponse,
      events: this.events,
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
    return { invocationId: 'invocation_w2', state: 'ready', capabilities: invocationCapabilities() }
  }

  async dispose(): Promise<void> {
    this.events.close()
  }

  async close(): Promise<void> {
    this.events.close()
  }

  emitClose(error: Error): void {
    this.closeHandler?.(error)
  }
}

/**
 * Normalize the real client's overloaded (dispatchEnvOrOptions, runtime) args
 * into a flat { dispatchEnv, runtime, lifecyclePolicy }. Detects the options
 * form by the presence of any known option key.
 */
function normalizeDispatchArgs(
  dispatchEnvOrOptions: Record<string, string> | DispatchOptions | undefined,
  runtime: InvocationRuntimeContext | undefined
): {
  dispatchEnv?: Record<string, string>
  runtime?: InvocationRuntimeContext
  lifecyclePolicy?: BrokerLifecyclePolicyOverlay
} {
  if (
    dispatchEnvOrOptions &&
    ('lifecyclePolicy' in dispatchEnvOrOptions ||
      'dispatchEnv' in dispatchEnvOrOptions ||
      'runtime' in dispatchEnvOrOptions)
  ) {
    const opts = dispatchEnvOrOptions as DispatchOptions
    return {
      dispatchEnv: opts.dispatchEnv,
      runtime: opts.runtime ?? runtime,
      lifecyclePolicy: opts.lifecyclePolicy,
    }
  }
  return { dispatchEnv: dispatchEnvOrOptions as Record<string, string> | undefined, runtime }
}

let fixture: TestFixture

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

// ──────────────────────────────────────────────────────────────────────────
// 1. HASH-INVARIANCE BOUNDARY (the critical acceptance gate)
// ──────────────────────────────────────────────────────────────────────────
describe('T-01787 lifecycle overlay — hash-invariance boundary', () => {
  it('dispatch WITH a lifecycle overlay yields a BYTE-IDENTICAL InvocationStartRequest and identical startRequestHash vs WITHOUT', async () => {
    const overlay = conservativeDefaultLifecyclePolicyOverlay('policy_route_codex')

    const fakeWithout = new FakeBrokerClient()
    const without = await makeController(fakeWithout).start({
      ...makeStartInput(),
      brokerClient: fakeWithout,
    })
    expect(without.ok).toBe(true)

    // Fresh fixture so the second dispatch reuses the same identity cleanly.
    await fixture.cleanup()
    fixture = await makeFixture()

    const fakeWith = new FakeBrokerClient()
    const withResult = await makeController(fakeWith).start({
      ...makeStartInput(),
      lifecyclePolicy: overlay,
      brokerClient: fakeWith,
    })
    expect(withResult.ok).toBe(true)

    const reqWithout = fakeWithout.startCalls[0]?.request
    const reqWith = fakeWith.startCalls[0]?.request
    expect(reqWithout).toBeDefined()
    expect(reqWith).toBeDefined()

    // BYTE-IDENTICAL serialization of the compiled start request.
    expect(JSON.stringify(reqWith)).toBe(JSON.stringify(reqWithout))

    // Identical recomputed startRequestHash, and equal to the compiled hash.
    const hashWithout = (project(reqWithout, 'start-request') as { startRequestHash: string })
      .startRequestHash
    const hashWith = (project(reqWith, 'start-request') as { startRequestHash: string })
      .startRequestHash
    expect(hashWith).toBe(hashWithout)
    expect(hashWith).toBe(makeStartInput().startRequestHash)

    // Persisted startRequestHash is unchanged by the overlay.
    expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')?.startRequestHash).toBe(
      hashWithout
    )

    // The overlay rode ONLY on the dispatch envelope.
    expect(fakeWith.startCalls[0]?.lifecyclePolicy).toEqual(overlay)
    expect(fakeWithout.startCalls[0]?.lifecyclePolicy).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 2. NO lifecycle fields in spec / process / HarnessInvocationSpec /
//    InvocationStartRequest / selected execution profile.
// ──────────────────────────────────────────────────────────────────────────
describe('T-01787 lifecycle overlay — compiler-closure boundary guard', () => {
  it('never writes lifecycle fields into spec.driver / spec.process.* / the start request / the selected profile', async () => {
    const overlay = conservativeDefaultLifecyclePolicyOverlay('policy_route_codex')
    const input = { ...makeStartInput(), lifecyclePolicy: overlay }

    const fake = new FakeBrokerClient()
    const result = await makeController(fake).start({ ...input, brokerClient: fake })
    expect(result.ok).toBe(true)

    const dispatched = fake.startCalls[0]?.request as InvocationStartRequest
    expect(dispatched).toBeDefined()

    // The dispatched start request and its spec carry no lifecycle leakage.
    expect(Object.hasOwn(dispatched, 'lifecyclePolicy')).toBe(false)
    const spec = dispatched.spec as Record<string, unknown>
    expect(Object.hasOwn(spec, 'lifecyclePolicy')).toBe(false)
    expect(Object.hasOwn(spec.driver as object, 'lifecyclePolicy')).toBe(false)
    expect(Object.hasOwn(spec.process as object, 'lifecyclePolicy')).toBe(false)
    expect(serialize(dispatched)).not.toContain('lifecycle')
    expect(serialize(dispatched)).not.toContain('keep-alive')
    expect(serialize(dispatched)).not.toContain(overlay.policyHash)

    // The selected execution profile is untouched.
    expect(serialize(input.profile.harnessInvocation.startRequest)).not.toContain('lifecycle')
    expect(Object.hasOwn(input.profile as object, 'lifecyclePolicy')).toBe(false)

    // But the overlay WAS delivered out-of-band.
    expect(fake.startCalls[0]?.lifecyclePolicy).toEqual(overlay)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 3. resolveLifecyclePolicyOverlay: conservative default for broker routes
//    with a STABLE per-route policyId; NO overlay for non-broker routes.
// ──────────────────────────────────────────────────────────────────────────
describe('T-01787 resolveLifecyclePolicyOverlay', () => {
  it('materializes the conservative default (keep-alive/none/none) for a broker route', () => {
    const overlay = resolveLifecyclePolicyOverlay({
      routeId: 'route-codex-headless',
      brokerRoute: true,
    })
    expect(overlay).toBeDefined()
    expect(overlay?.retention.mode).toBe('keep-alive')
    expect(overlay?.harnessRecovery.mode).toBe('none')
    expect(overlay?.turnRetry.mode).toBe('none')
    expect(overlay?.schemaVersion).toBe('harness-broker.lifecycle-policy/v1')
    // policyHash is self-consistent with canonical policy JSON.
    expect(overlay?.policyHash).toBe(lifecyclePolicyHash(overlay as BrokerLifecyclePolicyOverlay))
  })

  it('derives a STABLE per-route policyId (same route → same id; different route → different id)', () => {
    const a1 = resolveLifecyclePolicyOverlay({ routeId: 'route-A', brokerRoute: true })
    const a2 = resolveLifecyclePolicyOverlay({ routeId: 'route-A', brokerRoute: true })
    const b1 = resolveLifecyclePolicyOverlay({ routeId: 'route-B', brokerRoute: true })

    expect(a1?.policyId).toBe(lifecyclePolicyIdForRoute('route-A'))
    expect(a1?.policyId).toBe(a2?.policyId)
    expect(a1?.policyHash).toBe(a2?.policyHash)
    expect(a1?.policyId).not.toBe(b1?.policyId)
    expect(typeof a1?.policyId).toBe('string')
    expect((a1?.policyId ?? '').length).toBeGreaterThan(0)
  })

  it('sends NO overlay for non-broker routes (raw broker omission stays legacy)', () => {
    expect(
      resolveLifecyclePolicyOverlay({ routeId: 'route-sdk', brokerRoute: false })
    ).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 4. Capability preflight: fail-closed typed error when modes exceed
//    capabilities; passes for the conservative default.
// ──────────────────────────────────────────────────────────────────────────
describe('T-01787 preflightLifecyclePolicyCapabilities', () => {
  it('passes for the conservative default against CONSERVATIVE_LIFECYCLE_CAPABILITIES', () => {
    const overlay = conservativeDefaultLifecyclePolicyOverlay('policy_route_codex')
    expect(() =>
      preflightLifecyclePolicyCapabilities(overlay, CONSERVATIVE_LIFECYCLE_CAPABILITIES)
    ).not.toThrow()
  })

  it('throws a typed LifecyclePolicyCapabilityError when an overlay mode exceeds capabilities', () => {
    // An idle-ttl retention overlay is NOT in the conservative capability set.
    const uncertified: BrokerLifecyclePolicyOverlay = {
      schemaVersion: 'harness-broker.lifecycle-policy/v1',
      policyId: 'policy_idle_ttl',
      policyHash: 'unused',
      retention: {
        mode: 'idle-ttl',
        idleTtlMs: 60_000,
        retire: { mode: 'driver-retire', graceMs: 5_000, onTimeout: 'fail-invocation' },
      },
      harnessRecovery: { mode: 'none' },
      turnRetry: { mode: 'none' },
    }
    const caps: InvocationLifecycleCapabilities = CONSERVATIVE_LIFECYCLE_CAPABILITIES
    expect(() => preflightLifecyclePolicyCapabilities(uncertified, caps)).toThrow(
      LifecyclePolicyCapabilityError
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 5. Persistence: dispatched overlay recorded via WS-B's repo + invocation col.
// ──────────────────────────────────────────────────────────────────────────
describe('T-01787 lifecycle overlay persistence (audit material)', () => {
  it('persists the dispatched overlay into lifecycle_policies and broker_invocations.lifecycle_policy_hash', async () => {
    const overlay = conservativeDefaultLifecyclePolicyOverlay('policy_route_codex')
    const fake = new FakeBrokerClient()
    const result = await makeController(fake).start({
      ...makeStartInput(),
      lifecyclePolicy: overlay,
      brokerClient: fake,
    })
    expect(result.ok).toBe(true)

    const persistedPolicy = fixture.db.lifecyclePolicies.getByPolicyHash(overlay.policyHash)
    expect(persistedPolicy).not.toBeNull()
    expect(persistedPolicy?.policyId).toBe(overlay.policyId)
    expect(persistedPolicy?.canonicalPolicyJson).toBe(canonicalLifecyclePolicyJson(overlay))

    expect(
      fixture.db.brokerInvocations.getByInvocationId('invocation_w2')?.lifecyclePolicyHash
    ).toBe(overlay.policyHash)
  })
})

// ── helpers ────────────────────────────────────────────────────────────────

function serialize(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function makeController(fake: FakeBrokerClient): HarnessBrokerController {
  return new HarnessBrokerController({
    db: fixture.db,
    brokerClientFactory: async () => fake,
    now: () => NOW,
    serverInstanceId: 'server-test',
  })
}

async function makeFixture(): Promise<TestFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-lifecycle-overlay-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  db.sessions.insert({
    hostSessionId: 'hostSession_w2',
    scopeRef: 'agent:larry:project:hrc-runtime:task:T-01787',
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

function makeStartInput(): {
  plan: CompiledRuntimePlan
  profile: BrokerExecutionProfile
  startRequest: InvocationStartRequest
  specHash: string
  startRequestHash: string
  identity: ReturnType<typeof makeIdentity>
  dispatchEnv: Record<string, string>
} {
  const identity = makeIdentity()
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
