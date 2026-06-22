/**
 * RED unit tests for T-05085 (Phase C of T-05078):
 * permission policy — deny/allow (HRC-resolved), raw stream, audit provenance.
 *
 * Author: smokey (TDD RED gatekeeper). These tests are EXPECTED TO FAIL until
 * Phase C implementation lands. They pin tests 10 and 11 from the full
 * T-05078 gate (§4 permissions):
 *
 *   Test 10 — Permissions deny: runs without responder (no permissionChannel);
 *              raw `permission.requested` + `permission.resolved` observable on
 *              broker_invocation_events; `permission_decisions` row with
 *              decision:'deny', decidedBy:'policy', policyJson reflects the
 *              configured deny profile (not a generic "no channel" message).
 *              RED signal: current policyJson has `reason: 'no HRC permission
 *              request channel configured'` instead of `{ mode:'deny', ... }`.
 *              Also asserts broker_invocation_events contains permission events.
 *
 *   Test 11 — Permissions allow: same flow with an 'allow' permission policy;
 *              permission_decisions.decision='allow', decidedBy='policy',
 *              policyJson reflects the allow profile with provenance.
 *              RED signal: HarnessBrokerController.handlePermissionRequest
 *              currently ALWAYS returns 'deny' regardless of the profile policy.
 *              No 'allow' path exists → test 11 is clearly RED.
 *
 * Both tests use the controller-unit-test pattern (FakeBrokerClient + direct
 * fake.permissionHandler invocation) — no live broker process required.
 *
 * Implementer must provide:
 *   - HarnessBrokerController reads the configured permissionPolicy from the
 *     broker invocation record (stored at start time from the profile) and
 *     applies it in handlePermissionRequest:
 *       mode:'deny'  → decision:'deny', policyJson:{mode:'deny', audit:true}
 *       mode:'allow' → decision:'allow', policyJson:{mode:'allow', provenance:{...}}
 *   - The stored permissionPolicy must be persisted in broker_invocations
 *     (new column: permission_policy_json TEXT) or carried via the lifecycle
 *     policy record — wherever the controller can read it back in handlePermissionRequest.
 *   - handlePermissionRequest MUST insert the permission_decisions row with
 *     the CORRECT policyJson (reflecting the actual configured policy, not
 *     a hardcoded "no channel" message).
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-server test broker-permission-policy
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'
import type {
  InvocationEventEnvelope,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import { type BrokerClientLike, HarnessBrokerController } from '../broker/controller'

import { makeBrokerProfile, makeCompileResponse, makeIdentity } from './broker-compile-fixtures'
import { envelope } from './broker-event-mapper-fixtures'

// ── Constants ─────────────────────────────────────────────────────────────────

// Match the broker-controller.test.ts fixture defaults so makeIdentity() works.
const NOW = '2026-06-22T12:00:00.000Z'
const INVOCATION_ID = 'invocation_w2'
const RUNTIME_ID = 'runtime_w2'
const RUN_ID = 'run_w2'
const SESSION_ID = 'hostSession_w2'

// ── Fixture ───────────────────────────────────────────────────────────────────

type TestFixture = {
  db: HrcDatabase
  dir: string
  cleanup: () => Promise<void>
}

async function makePermFixture(): Promise<TestFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-perm-policy-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  // Seed the same session ID that makeIdentity() defaults to (hostSession_w2).
  db.sessions.insert({
    hostSessionId: SESSION_ID,
    scopeRef: 'agent:larry:project:hrc-runtime:task:T-01697',
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

let fixture: TestFixture

beforeEach(async () => {
  fixture = await makePermFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

// ── PushableEvents ─────────────────────────────────────────────────────────────

/**
 * Minimal pushable async-iterable — reused from broker-controller.test.ts pattern.
 */
class PushableEvents implements AsyncIterable<InvocationEventEnvelope> {
  private queue: InvocationEventEnvelope[] = []
  private waiters: Array<(result: IteratorResult<InvocationEventEnvelope>) => void> = []
  private closed = false

  push(event: InvocationEventEnvelope): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value: event })
      return
    }
    this.queue.push(event)
  }

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

/** Minimal async tick for event loop flush. */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
}

// ── FakeBrokerClient ───────────────────────────────────────────────────────────

class FakeBrokerClient implements BrokerClientLike {
  readonly events = new PushableEvents()
  permissionHandler?: (request: PermissionRequestParams) => Promise<PermissionDecision>
  private closeHandler?: (error: Error) => void

  onPermissionRequest(
    handler: (request: PermissionRequestParams) => Promise<PermissionDecision>
  ): void {
    this.permissionHandler = handler
  }

  onClose(handler: (error: Error) => void): void {
    this.closeHandler = handler
  }

  async hello() {
    return {
      brokerInfo: { name: 'harness-broker', version: '0.2.0-test' },
      protocolVersion: 'harness-broker/0.2' as const,
      capabilities: {
        multiInvocation: false,
        transports: ['stdio-jsonrpc-ndjson', 'unix-jsonrpc-ndjson'] as const,
        eventNotifications: true,
        brokerToClientRequests: true,
        attachReplay: true,
      },
      drivers: [
        {
          kind: 'codex-app-server' as const,
          version: '0.1.1-test',
          available: true,
          capabilities: {
            input: {
              user: true,
              steer: true,
              appendContext: true,
              localImages: true,
              fileRefs: true,
              queue: false,
            },
            turns: { concurrency: 'single' as const, interrupt: 'protocol' as const },
            continuation: {
              supported: true,
              provider: 'openai' as const,
              keyKind: 'thread' as const,
            },
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
          },
        },
      ],
    }
  }

  async health() {
    return { status: 'ok' as const, activeInvocations: 1, drivers: [] }
  }

  async startInvocationFromRequest(request: { invocationId: string }) {
    const caps = {
      input: {
        user: true,
        steer: true,
        appendContext: true,
        localImages: true,
        fileRefs: true,
        queue: false,
      },
      turns: { concurrency: 'single' as const, interrupt: 'protocol' as const },
      continuation: {
        supported: true,
        provider: 'openai' as const,
        keyKind: 'thread' as const,
      },
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
    return {
      invocationId: request.invocationId,
      response: {
        invocationId: request.invocationId,
        state: 'ready' as const,
        capabilities: caps,
      },
      events: this.events,
    }
  }

  async input(_req: unknown) {
    return {
      inputId: 'input_perm_test',
      accepted: true,
      disposition: 'started',
    }
  }

  async status() {
    return {
      invocationId: INVOCATION_ID,
      state: 'ready' as const,
      capabilities: {
        input: {
          user: true,
          steer: false,
          appendContext: false,
          localImages: false,
          fileRefs: false,
          queue: false,
        },
        turns: { concurrency: 'single' as const, interrupt: 'protocol' as const },
        continuation: {
          supported: false,
          provider: 'openai' as const,
          keyKind: 'thread' as const,
        },
        events: {
          assistantDeltas: false,
          toolCalls: false,
          usage: false,
          diagnostics: false,
          replay: false,
          ack: false,
        },
        control: { stop: true, dispose: true, status: true, attach: false },
        permissions: { brokerToClientRequests: true, eventAudit: true },
      },
    }
  }

  async interrupt() {
    return { interrupted: true }
  }

  async stop() {
    return {}
  }

  async dispose() {
    return {}
  }

  async close() {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePermStartInput(
  permissionPolicy:
    | {
        mode: 'deny'
        audit: true
      }
    | {
        mode: 'allow'
        audit: true
        provenance: {
          source: 'test'
          requestId: string
          createdAt: string
        }
      }
) {
  const identity = makeIdentity({
    runtimeId: RUNTIME_ID as ReturnType<typeof makeIdentity>['runtimeId'],
    runId: RUN_ID as ReturnType<typeof makeIdentity>['runId'],
    invocationId: INVOCATION_ID as ReturnType<typeof makeIdentity>['invocationId'],
  })

  // Build profile with the specified permissionPolicy (override the default 'deny').
  const { profile: baseProfile, startRequest } = makeBrokerProfile(identity)
  const profile: BrokerExecutionProfile = {
    ...baseProfile,
    policy: {
      ...baseProfile.policy,
      permissionPolicy,
    },
  } as unknown as BrokerExecutionProfile

  const response = makeCompileResponse(identity, [profile])
  if (!response.ok) {
    throw new Error('fixture compile response unexpectedly failed')
  }

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

const PERM_REQUEST: PermissionRequestParams = {
  invocationId: INVOCATION_ID as PermissionRequestParams['invocationId'],
  permissionRequestId: 'perm-req-policy-01' as PermissionRequestParams['permissionRequestId'],
  kind: 'command',
  subject: { command: 'ls /tmp' },
  defaultDecision: 'allow',
}

// =============================================================================
// Test 10 — Permissions deny: policy-resolved deny with correct provenance
// =============================================================================

describe('T-05078/10 permissions deny — policy-resolved deny with audit provenance', () => {
  /**
   * When no permissionChannel (no coordinator responder) and permissionPolicy.mode='deny',
   * the controller must:
   *   1. Return decision:'deny' to the broker ✓ (already works)
   *   2. Insert permission_decisions with decidedBy:'policy' ✓ (already works)
   *   3. policyJson must reflect the CONFIGURED policy ({mode:'deny', audit:true})
   *      NOT a generic "no channel" message → RED
   *
   * Currently the controller inserts:
   *   policyJson: JSON.stringify({ mode: 'deny', reason: 'no HRC permission request channel configured' })
   * The new behavior must carry the CONFIGURED policy from the profile:
   *   policyJson: JSON.stringify({ mode: 'deny', audit: true })
   */
  it('permission_decisions policyJson reflects configured deny policy (not generic message)', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })

    const input = makePermStartInput({ mode: 'deny', audit: true })
    const started = await controller.start({ ...input, brokerClient: fake })
    expect(started.ok).toBe(true)

    // Trigger a permission request via the broker's registered handler.
    const decision = await fake.permissionHandler?.(PERM_REQUEST)

    // Decision must be 'deny' (already works today).
    expect(decision?.decision).toBe('deny')

    // The permission_decisions row must exist with the right fields.
    const row = fixture.db.permissionDecisions.getByPermissionRequestId(
      PERM_REQUEST.permissionRequestId
    )
    expect(row).not.toBeNull()
    expect(row?.decision).toBe('deny')
    expect(row?.decidedBy).toBe('policy')

    // ── RED: policyJson must reflect the CONFIGURED policy, not "no channel" ──
    // Currently: JSON.stringify({ mode:'deny', reason:'no HRC permission request channel configured' })
    // When green: JSON.stringify({ mode:'deny', audit:true }) carrying the actual
    //             configured policy from the profile (not a hardcoded reason string).
    const policyJson = row?.policyJson ? JSON.parse(row.policyJson) : null
    expect(policyJson?.mode).toBe('deny') // May already pass (current has mode:'deny')
    // ── RED: audit field from the configured policy must be carried through ──
    // Current policyJson has `reason:'no HRC permission...'` but NOT `audit:true`.
    // The configured deny policy is { mode:'deny', audit:true }.
    // When green: policyJson includes audit:true from the profile's permissionPolicy.
    expect(policyJson?.audit).toBe(true) // RED: current policyJson has 'reason', no 'audit'
  })

  /**
   * Permission events must be appended to broker_invocation_events so the
   * raw observer (/v1/broker-events) can serve them.
   *
   * The event-mapper already appends ALL broker events to broker_invocation_events
   * (including permission.requested + permission.resolved). This test verifies
   * that after the controller resolves a permission, the projected events are
   * in the store for the raw observer.
   */
  it('permission.requested + permission.resolved appear in broker_invocation_events', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })

    const input = makePermStartInput({ mode: 'deny', audit: true })
    const started = await controller.start({ ...input, brokerClient: fake })
    expect(started.ok).toBe(true)

    // Simulate broker emitting permission.requested (seq=1).
    fake.events.push(
      envelope(
        'permission.requested',
        1,
        {
          permissionRequestId: PERM_REQUEST.permissionRequestId,
          kind: PERM_REQUEST.kind,
          subjectDisplay: PERM_REQUEST.subject,
          defaultDecision: PERM_REQUEST.defaultDecision,
        },
        { invocationId: INVOCATION_ID as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()

    // Trigger the controller's permission handler (simulating broker->HRC callback).
    await fake.permissionHandler?.(PERM_REQUEST)

    // Simulate broker emitting permission.resolved (seq=2).
    fake.events.push(
      envelope(
        'permission.resolved',
        2,
        {
          permissionRequestId: PERM_REQUEST.permissionRequestId,
          decision: 'deny',
          decidedBy: 'policy',
        },
        { invocationId: INVOCATION_ID as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()

    // Both events must appear in broker_invocation_events.
    const rows = fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
    const permRequested = rows.filter((r) => r.type === 'permission.requested')
    const permResolved = rows.filter((r) => r.type === 'permission.resolved')

    // These assertions verify the event-mapper persists permission events.
    // This MAY already be green (Phase A persists all events).
    expect(permRequested).toHaveLength(1)
    expect(permResolved).toHaveLength(1)

    // The permission_decisions row must exist after permission.resolved is projected.
    const row = fixture.db.permissionDecisions.getByPermissionRequestId(
      PERM_REQUEST.permissionRequestId
    )
    expect(row?.decision).toBe('deny')
    expect(row?.decidedBy).toBe('policy')

    // ── RED: policyJson must reflect configured policy including audit field ─
    const policyJson = row?.policyJson ? JSON.parse(row.policyJson) : null
    expect(policyJson?.mode).toBe('deny') // May already pass (current has mode:'deny')
    // RED: configured policy {mode:'deny', audit:true} — audit must be carried through.
    expect(policyJson?.audit).toBe(true) // RED: current policyJson missing 'audit'
  })
})

// =============================================================================
// Test 11 — Permissions allow: policy-resolved allow with audit provenance
// =============================================================================

describe('T-05078/11 permissions allow — policy-resolved allow with provenance', () => {
  /**
   * When permissionPolicy.mode='allow' and no permissionChannel, the controller
   * must return decision:'allow' to the broker (not 'deny').
   *
   * RED: HarnessBrokerController.handlePermissionRequest currently ALWAYS
   * returns 'deny' regardless of the profile policy. No 'allow' path exists.
   * The policyJson must carry the 'allow' mode + provenance fields.
   */
  it('returns allow decision when permissionPolicy.mode=allow', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })

    const allowPolicy = {
      mode: 'allow' as const,
      audit: true as const,
      provenance: {
        source: 'test' as const,
        requestId: 'req-allow-test-01' as ReturnType<typeof makeIdentity>['runId'],
        createdAt: NOW,
      },
    }
    const input = makePermStartInput(allowPolicy)
    const started = await controller.start({ ...input, brokerClient: fake })
    expect(started.ok).toBe(true)

    // Trigger permission request.
    const decision = await fake.permissionHandler?.(PERM_REQUEST)

    // ── RED: currently always returns 'deny'; must return 'allow' when policy is 'allow' ──
    expect(decision?.decision).toBe('allow') // RED: currently 'deny'
  })

  it('permission_decisions row has decision:allow, decidedBy:policy with allow provenance', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })

    const allowPolicy = {
      mode: 'allow' as const,
      audit: true as const,
      provenance: {
        source: 'test' as const,
        requestId: 'req-allow-test-02' as ReturnType<typeof makeIdentity>['runId'],
        createdAt: NOW,
      },
    }
    const input = makePermStartInput(allowPolicy)
    const started = await controller.start({ ...input, brokerClient: fake })
    expect(started.ok).toBe(true)

    // Trigger and resolve permission.
    await fake.permissionHandler?.({
      ...PERM_REQUEST,
      permissionRequestId: 'perm-req-allow-02' as PermissionRequestParams['permissionRequestId'],
    })

    // Check the permission_decisions row.
    const row = fixture.db.permissionDecisions.getByPermissionRequestId('perm-req-allow-02')
    expect(row).not.toBeNull()

    // ── RED: decision must be 'allow' (currently 'deny') ─────────────────
    expect(row?.decision).toBe('allow') // RED: currently 'deny'
    expect(row?.decidedBy).toBe('policy') // May already be correct

    // ── RED: policyJson must reflect the allow policy + provenance ────────
    const policyJson = row?.policyJson ? JSON.parse(row.policyJson) : null
    expect(policyJson?.mode).toBe('allow') // RED: mode missing / wrong
    // Provenance must be preserved in the audit trail.
    expect(policyJson?.provenance).toBeDefined() // RED: no provenance currently
    expect(policyJson?.provenance?.source).toBe('test') // RED: missing
  })

  it('permission events for allow decision in broker_invocation_events', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })

    const allowPolicy = {
      mode: 'allow' as const,
      audit: true as const,
      provenance: {
        source: 'test' as const,
        requestId: 'req-allow-test-03' as ReturnType<typeof makeIdentity>['runId'],
        createdAt: NOW,
      },
    }
    const input = makePermStartInput(allowPolicy)
    const started = await controller.start({ ...input, brokerClient: fake })
    expect(started.ok).toBe(true)

    // Simulate broker emitting permission.requested.
    fake.events.push(
      envelope(
        'permission.requested',
        1,
        {
          permissionRequestId: 'perm-req-allow-03',
          kind: 'command',
          subjectDisplay: { command: 'ls' },
          defaultDecision: 'allow',
        },
        { invocationId: INVOCATION_ID as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()

    // Controller handles permission: must respond 'allow'.
    const decision = await fake.permissionHandler?.({
      ...PERM_REQUEST,
      permissionRequestId: 'perm-req-allow-03' as PermissionRequestParams['permissionRequestId'],
    })

    // ── RED: decision must be 'allow' ─────────────────────────────────────
    expect(decision?.decision).toBe('allow') // RED: currently 'deny'

    // Simulate broker emitting permission.resolved with 'allow'.
    fake.events.push(
      envelope(
        'permission.resolved',
        2,
        {
          permissionRequestId: 'perm-req-allow-03',
          decision: 'allow',
          decidedBy: 'policy',
        },
        { invocationId: INVOCATION_ID as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()

    // permission.resolved with decision='allow' must create the right DB row.
    const row = fixture.db.permissionDecisions.getByPermissionRequestId('perm-req-allow-03')
    // auditPermissionResolved reads decidedBy from the event payload.
    // This assertion depends on Phase C wiring the allow decision correctly.
    expect(row?.decision).toBe('allow') // RED if controller sent 'deny' back to broker
    expect(row?.decidedBy).toBe('policy')
  })
})
