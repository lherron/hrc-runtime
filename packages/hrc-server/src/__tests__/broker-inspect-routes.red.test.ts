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

describe('[RED P3-1] POST /v1/runtimes/broker/inspect — broker-backed runtime', () => {
  it('responds 200 (endpoint not yet wired)', async () => {
    seedBrokerTmuxRuntime({
      runtimeId: 'rt-binspect-200',
      hostSessionId: 'hsid-binspect-200',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:binspect-200',
    })
    const fake = new FakeBrokerController()
    injectFakeController(fake)

    // RED: POST /v1/runtimes/broker/inspect does not exist yet → 404
    const res = await postBrokerInspect('rt-binspect-200')
    expect(res.status).toBe(200)
  })

  it('returns InvocationInspectionSummary[] under an `invocations` key', async () => {
    const runtimeId = 'rt-binspect-shape'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-binspect-shape',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:binspect-shape',
      activeInvocationId: 'inv-binspect-shape',
    })

    const fake = new FakeBrokerController()
    const summary: InvocationInspectionSummary = {
      invocationId: 'inv-binspect-shape' as InvocationInspectionSummary['invocationId'],
      state: 'turn_active',
      driver: 'codex-app-server',
      startedAt: fixture.now(),
      lastActivityAt: fixture.now(),
    }
    fake.invocationsResult = [summary]
    injectFakeController(fake)

    // RED: endpoint not yet wired
    const res = await postBrokerInspect(runtimeId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { invocations?: unknown[] }
    expect(Array.isArray(body.invocations)).toBe(true)
    expect(body.invocations).toHaveLength(1)
    expect((body.invocations?.[0] as InvocationInspectionSummary)?.invocationId).toBe(
      'inv-binspect-shape'
    )
    expect((body.invocations?.[0] as InvocationInspectionSummary)?.state).toBe('turn_active')
  })

  it('calls controller.listInvocations with the requested runtimeId', async () => {
    const runtimeId = 'rt-binspect-calls'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-binspect-calls',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:binspect-calls',
    })

    const fake = new FakeBrokerController()
    injectFakeController(fake)

    // RED: endpoint not yet wired — controller never called
    await postBrokerInspect(runtimeId)
    expect(fake.listInvocationsCalls).toHaveLength(1)
    expect(fake.listInvocationsCalls[0]?.runtimeId).toBe(runtimeId)
  })

  it('passes probeLiveness:true to controller when requested', async () => {
    const runtimeId = 'rt-binspect-probe'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-binspect-probe',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:binspect-probe',
      inspectionCapabilities: { listInvocations: true, liveness: 'probe' },
    })

    const fake = new FakeBrokerController()
    injectFakeController(fake)

    // RED: endpoint not yet wired
    await postBrokerInspect(runtimeId, { probeLiveness: true })
    expect(fake.listInvocationsCalls[0]?.opts?.probeLiveness).toBe(true)
  })

  it('mutates ZERO DB state (no inserts, no events, no row updates)', async () => {
    const runtimeId = 'rt-binspect-nomut'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-binspect-nomut',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:binspect-nomut',
      activeInvocationId: 'inv-binspect-nomut',
    })

    const fake = new FakeBrokerController()
    injectFakeController(fake)

    const rowsBefore = totalWriteableRows()

    // RED: endpoint not yet wired → 404 before mutation check ever matters
    const res = await postBrokerInspect(runtimeId)
    expect(res.status).toBe(200)

    const rowsAfter = totalWriteableRows()
    // No new rows must have been inserted in ANY write-sensitive table
    expect(rowsAfter).toBe(rowsBefore)
  })

  it('runtime row is byte-for-byte identical after the call (no field updates)', async () => {
    const runtimeId = 'rt-binspect-rowident'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-binspect-rowident',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:binspect-rowident',
      activeInvocationId: 'inv-binspect-rowident',
    })

    const fake = new FakeBrokerController()
    injectFakeController(fake)

    const db = openHrcDatabase(fixture.dbPath)
    const runtimeBefore = db.runtimes.getByRuntimeId(runtimeId)
    const sessionBefore = db.sessions.getByHostSessionId('hsid-binspect-rowident')
    db.close()

    // RED: endpoint not yet wired → 404 before row comparison ever matters
    const res = await postBrokerInspect(runtimeId)
    expect(res.status).toBe(200)

    const db2 = openHrcDatabase(fixture.dbPath)
    expect(db2.runtimes.getByRuntimeId(runtimeId)).toEqual(runtimeBefore)
    expect(db2.sessions.getByHostSessionId('hsid-binspect-rowident')).toEqual(sessionBefore)
    db2.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. PRE-BROKER / ADOPTED RUNTIME FALLBACK
// ═════════════════════════════════════════════════════════════════════════════

describe('[RED P3-3] Non-broker adopted/pre-broker fallback: source labeled hrc-derived', () => {
  it('adopted tmux runtime (no controllerKind) returns source:hrc-derived', async () => {
    seedAdoptedHeadlessRuntime({
      runtimeId: 'rt-adopted-src',
      hostSessionId: 'hsid-adopted-src',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:adopted-src',
    })

    // RED: endpoint not yet wired; when wired, adopted runtime must be labeled
    const res = await postBrokerInspect('rt-adopted-src')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { source?: string }
    expect(body.source).toBe('hrc-derived')
  })

  it('adopted runtime does NOT synthesize broker retention fields', async () => {
    // For an adopted (pre-broker) runtime, lifecycle can only come from
    // runtime-DB facts. There is no idle-cleanup policy to apply. The
    // lifecycle.retention.mode must
    // reflect that this is DB-fact-only, not broker-reported.
    seedAdoptedHeadlessRuntime({
      runtimeId: 'rt-adopted-nosynth',
      hostSessionId: 'hsid-adopted-nosynth',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:adopted-nosynth',
    })

    // RED: endpoint not yet wired
    const res = await postBrokerInspect('rt-adopted-nosynth')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      source?: string
      lifecycle?: { retention?: { mode?: string } }
    }
    expect(body.source).toBe('hrc-derived')
    // Must NOT claim broker retention mode — only 'db-only' or similar HRC-derived mode
    expect(body.lifecycle?.retention?.mode).not.toBe('keep-alive')
    expect(body.lifecycle?.retention?.mode).not.toBe('ttl')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. CAPABILITY-GATED LIVENESS PASS-THROUGH (cody C-03259)
// ═════════════════════════════════════════════════════════════════════════════
