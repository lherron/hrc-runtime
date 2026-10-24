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
import { type BrokerClientLike, HarnessBrokerController } from '../broker/controller'

import {
  makeHrcPolicy,
  makeIdentity,
  makeSelectedExecution,
  makeSelectedExecutionPlan,
} from './broker-compile-fixtures'
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

  const { execution } = makeSelectedExecution(identity)

  return {
    execution,
    plan: makeSelectedExecutionPlan(),
    hrcPolicy: { ...makeHrcPolicy(), permissionPolicy },
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

describe('T-05078/10 permissions deny — policy response and event projection', () => {
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
  })
})

// =============================================================================
// Test 11 — Permissions allow: policy-resolved allow with audit provenance
// =============================================================================

describe('T-05078/11 permissions allow — policy response and event projection', () => {
  /**
   * When permissionPolicy.mode='allow' and no permissionChannel, the controller
   * must return decision:'allow' to the broker (not 'deny').
   *
   * RED: HarnessBrokerController.handlePermissionRequest currently ALWAYS
   * returns 'deny' regardless of the profile policy. No 'allow' path exists.
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

    const rows = fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
    const resolved = rows.find((row) => row.type === 'permission.resolved')
    expect(resolved).toBeDefined()
    expect(JSON.parse(resolved!.brokerEventJson)).toMatchObject({
      decision: 'allow',
      decidedBy: 'policy',
    })
  })
})
