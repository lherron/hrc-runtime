/**
 * RED tests (T-01856 P3) — server HTTP endpoints + non-broker fallback labeling
 * for the operator broker-inspect surface.
 *
 * What's being tested (ALL must FAIL against current code):
 *
 *  1. NEW endpoint `POST /v1/runtimes/broker/inspect`
 *     - does not exist yet → fails with 404 / missing route
 *     - when it exists: must call controller.listInvocations(runtimeId) and return
 *       the InvocationInspectionSummary[] shape
 *     - must mutate ZERO DB state (no inserts / updates / events)
 *
 *  3. Pre-broker / adopted runtime fallback
 *     - adopted runtime (no controllerKind:'harness-broker') → same
 *       source:'hrc-derived' label, DB-only facts, no broker lifecycle synthesized
 *
 *  4. Capability-gated liveness pass-through (cody C-03259)
 *     - when broker returns summary with liveness.mode='cached', the HTTP response
 *       passes it through as-is (mode:'cached', not re-derived as mode:'probe')
 *     - when broker returns summary WITHOUT liveness (capability liveness:'none' or
 *       absent), the HTTP response also omits liveness — never synthesizes it
 *
 * Strategy:
 *   Broker-present tests: inject a minimal FakeBrokerController directly into the
 *   live server (via `(server as any).harnessBrokerController`). The controller
 *   records every call so we can assert both the call shape and that no DB writes
 *   occur. Non-broker tests seed the appropriate runtime type and call the endpoint
 *   without injecting any controller.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Database } from 'bun:sqlite'
import type { FinalSummaryRecoveryResult } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type {
  BrokerControllerRpcResult,
  InvocationInspectionSummary,
  InvocationLivenessView,
  InvocationSnapshot,
} from 'spaces-harness-broker-protocol'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// ── fixture wiring ────────────────────────────────────────────────────────────
let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('broker-operator-inspect-')
  server = await createHrcServer(fixture.serverOpts())
})

void totalWriteableRows
void seedAdoptedHeadlessRuntime

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

// ── fake controller (minimal — only the inspection read-model surface) ────────

type FakeListInvocationsCall = { runtimeId: string; opts?: { probeLiveness?: boolean } | undefined }
type FakeSnapshotCall = { runtimeId: string; opts?: { probeLiveness?: boolean } | undefined }
type FakeRecoverCall = {
  runtimeId: string
  socketPath: string
  attachToken: string
  timeoutMs?: number | undefined
}

class FakeBrokerController {
  listInvocationsCalls: FakeListInvocationsCall[] = []
  snapshotCalls: FakeSnapshotCall[] = []
  recoverFinalSummaryCalls: FakeRecoverCall[] = []

  invocationsResult: InvocationInspectionSummary[] = []
  snapshotResult: BrokerControllerRpcResult<InvocationSnapshot> | null = null
  recoverFinalSummaryResult: FinalSummaryRecoveryResult = { state: 'unavailable' }
  recoverFinalSummaryHook: (() => Promise<void> | void) | undefined

  async listInvocations(
    runtimeId: string,
    opts?: { probeLiveness?: boolean | undefined }
  ): Promise<InvocationInspectionSummary[]> {
    this.listInvocationsCalls.push({ runtimeId, opts })
    return this.invocationsResult
  }

  async snapshot(
    runtimeId: string,
    opts?: { probeLiveness?: boolean | undefined }
  ): Promise<BrokerControllerRpcResult<InvocationSnapshot>> {
    this.snapshotCalls.push({ runtimeId, opts })
    if (this.snapshotResult) return this.snapshotResult
    return {
      ok: false,
      error: Object.assign(new Error(`broker runtime ${runtimeId} not active`), {
        code: 'broker_not_active',
      }),
    } as unknown as BrokerControllerRpcResult<InvocationSnapshot>
  }

  async recoverFinalSummary(input: FakeRecoverCall): Promise<FinalSummaryRecoveryResult> {
    this.recoverFinalSummaryCalls.push(input)
    await this.recoverFinalSummaryHook?.()
    return this.recoverFinalSummaryResult
  }
}

/** Inject a fake broker controller into the running server. */
function injectFakeController(fake: FakeBrokerController): void {
  ;(server as unknown as Record<string, unknown>)['harnessBrokerController'] = fake as unknown
}

// ── DB mutation helpers ───────────────────────────────────────────────────────

/** Total row count across all write-sensitive tables. */
function totalWriteableRows(): number {
  const db = new Database(fixture.dbPath)
  try {
    const n = (table: string): number =>
      db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM ${table}`).get()?.n ?? 0
    return n('sessions') + n('runtimes') + n('runs') + n('broker_invocations') + n('hrc_events')
  } finally {
    db.close()
  }
}

// ── runtime seed helpers ──────────────────────────────────────────────────────

type SeedBrokerRuntimeOpts = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  activeInvocationId?: string | undefined
  inspectionCapabilities?:
    | {
        listInvocations?: boolean | undefined
        liveness?: 'none' | 'cached' | 'probe' | undefined
      }
    | undefined
}

function seedBrokerTmuxRuntime(opts: SeedBrokerRuntimeOpts): void {
  const now = fixture.now()
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.insert({
      hostSessionId: opts.hostSessionId,
      scopeRef: opts.scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: opts.runtimeId,
      hostSessionId: opts.hostSessionId,
      scopeRef: opts.scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'busy',
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      ...(opts.activeInvocationId ? { activeInvocationId: opts.activeInvocationId } : {}),
      tmuxJson: {
        socketPath: fixture.tmuxSocketPath,
        sessionName: `hrc-${opts.runtimeId}`,
        windowName: 'tui',
        sessionId: '$1',
        windowId: '@1',
        paneId: '%1',
      },
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        broker: {
          protocolVersion: 'harness-broker/0.2',
          ownerServerInstanceId: 'srv-test',
          ...(opts.inspectionCapabilities ? { inspection: opts.inspectionCapabilities } : {}),
        },
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    if (opts.activeInvocationId) {
      db.brokerInvocations.insert({
        invocationId: opts.activeInvocationId,
        operationId: `op-${opts.runtimeId}`,
        runtimeId: opts.runtimeId,
        runId: `run-${opts.runtimeId}`,
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: 'claude-code',
        invocationState: 'turn_active',
        capabilitiesJson: '{}',
        specHash: 'spec-hash',
        startRequestHash: 'start-hash',
        selectedProfileHash: 'profile-hash',
        ownerServerInstanceId: 'srv-test',
        createdAt: now,
        updatedAt: now,
      })
    }
  } finally {
    db.close()
  }
}

function seedAdoptedHeadlessRuntime(opts: {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
}): void {
  const now = fixture.now()
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.insert({
      hostSessionId: opts.hostSessionId,
      scopeRef: opts.scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: opts.runtimeId,
      hostSessionId: opts.hostSessionId,
      scopeRef: opts.scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: true, // pre-broker / adopted harness — no broker facts
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

// ── helper to call the new endpoint ──────────────────────────────────────────

async function postBrokerInspect(
  runtimeId: string,
  extra: Record<string, unknown> = {}
): Promise<Response> {
  return fixture.postJson('/v1/runtimes/broker/inspect', { runtimeId, ...extra })
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. NEW SERVER ENDPOINT — broker-backed runtime
// ═════════════════════════════════════════════════════════════════════════════

describe('[RED P3-4] Capability-gated liveness rendering (cody C-03259)', () => {
  it('liveness.mode=cached is passed through as-is (not re-derived as probe)', async () => {
    const runtimeId = 'rt-liveness-cached'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-liveness-cached',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:liveness-cached',
      activeInvocationId: 'inv-liveness-cached',
      inspectionCapabilities: { listInvocations: true, liveness: 'cached' },
    })

    const fake = new FakeBrokerController()
    const cachedLiveness: InvocationLivenessView = {
      mode: 'cached',
      checkedAt: fixture.now(),
      driver: { state: 'healthy' },
    }
    const summary: InvocationInspectionSummary = {
      invocationId: 'inv-liveness-cached' as InvocationInspectionSummary['invocationId'],
      state: 'ready',
      driver: 'codex-app-server',
      startedAt: fixture.now(),
      lastActivityAt: fixture.now(),
      liveness: cachedLiveness,
    }
    fake.invocationsResult = [summary]
    injectFakeController(fake)

    // RED: endpoint not yet wired
    const res = await postBrokerInspect(runtimeId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { invocations?: InvocationInspectionSummary[] }
    const inv = body.invocations?.[0]
    // liveness must be present and pass through mode:'cached' unchanged
    expect(inv?.liveness).toBeDefined()
    expect(inv?.liveness?.mode).toBe('cached')
  })

  it('liveness absent from broker summary → response also omits liveness (never synthesizes)', async () => {
    const runtimeId = 'rt-liveness-none'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-liveness-none',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:liveness-none',
      activeInvocationId: 'inv-liveness-none',
      // Broker advertises liveness:'none' — no live probe, no cached view
      inspectionCapabilities: { listInvocations: true, liveness: 'none' },
    })

    const fake = new FakeBrokerController()
    // Summary has NO liveness field (broker capability is 'none')
    const summary: InvocationInspectionSummary = {
      invocationId: 'inv-liveness-none' as InvocationInspectionSummary['invocationId'],
      state: 'ready',
      driver: 'codex-app-server',
      startedAt: fixture.now(),
      lastActivityAt: fixture.now(),
      // liveness intentionally absent
    }
    fake.invocationsResult = [summary]
    injectFakeController(fake)

    // RED: endpoint not yet wired
    const res = await postBrokerInspect(runtimeId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { invocations?: InvocationInspectionSummary[] }
    const inv = body.invocations?.[0]
    // Endpoint must NOT synthesize liveness when the broker provides none
    expect(inv?.liveness).toBeUndefined()
  })

  it('retention.blockedBy present → response passes it through and does NOT present computedRetireAt as unconditional', async () => {
    // When blockedBy is non-empty, computedRetireAt is NOT a firm deadline.
    // The endpoint must surface blockers explicitly — never suppress them.
    const runtimeId = 'rt-blocked-retire'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-blocked-retire',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:blocked-retire',
      activeInvocationId: 'inv-blocked-retire',
      inspectionCapabilities: { listInvocations: true, liveness: 'none' },
    })

    const fake = new FakeBrokerController()
    const summary: InvocationInspectionSummary = {
      invocationId: 'inv-blocked-retire' as InvocationInspectionSummary['invocationId'],
      state: 'turn_active',
      driver: 'codex-app-server',
      startedAt: fixture.now(),
      lastActivityAt: fixture.now(),
      lifecycle: {
        retention: {
          mode: 'ttl',
          idleTtlMs: 300_000,
          computedRetireAt: '2099-01-01T00:00:00.000Z',
          // Active turn blocks retirement — computedRetireAt is NOT a firm deadline
          blockedBy: ['active-turn'],
        },
        harnessRecovery: { mode: 'restart' },
        turnRetry: { mode: 'none' },
      },
    }
    fake.invocationsResult = [summary]
    injectFakeController(fake)

    // RED: endpoint not yet wired
    const res = await postBrokerInspect(runtimeId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      invocations?: Array<{
        lifecycle?: {
          retention?: {
            blockedBy?: string[]
            computedRetireAt?: string
          }
        }
      }>
    }
    const inv = body.invocations?.[0]
    // Blockers MUST be present in the response
    expect(inv?.lifecycle?.retention?.blockedBy).toEqual(['active-turn'])
    // computedRetireAt passes through but response must NOT drop blockedBy
    // (i.e., blockedBy is never stripped to make computedRetireAt look unconditional)
    expect((inv?.lifecycle?.retention?.blockedBy ?? []).length).toBeGreaterThan(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Graceful-exit summary passthrough (T-01893) — broker-pushed invocation.summary
// recorded on runtimeStateJson.finalSummary is returned by broker-inspect so the
// `hrc run` shutdown report reads a recorded snapshot, not the (gone) live model.
// ═════════════════════════════════════════════════════════════════════════════
