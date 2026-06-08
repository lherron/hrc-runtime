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
 *  2. Non-broker ghostty fallback labeling (item #5, must-not-mislead gate)
 *     - for transport:'ghostty' + harness:'claude-code' with no broker:
 *       response must include source:'hrc-derived' (or derivedBy field)
 *       and a synthesized lifecycle.retention.computedRetireAt =
 *       lastActivityAt + 15 min (DEFAULT_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES)
 *     - HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES env override is honored
 *     - label MUST be present; plain broker-less inspect must never omit it
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

// ── constants matching production policy ─────────────────────────────────────
const DEFAULT_GHOSTTY_IDLE_TTL_MINUTES = 15
const DEFAULT_GHOSTTY_IDLE_TTL_MS = DEFAULT_GHOSTTY_IDLE_TTL_MINUTES * 60 * 1000

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

class FakeBrokerController {
  listInvocationsCalls: FakeListInvocationsCall[] = []
  snapshotCalls: FakeSnapshotCall[] = []

  invocationsResult: InvocationInspectionSummary[] = []
  snapshotResult: BrokerControllerRpcResult<InvocationSnapshot> | null = null

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

type SeedGhosttyRuntimeOpts = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  lastActivityAt?: string | undefined
  adopted?: boolean | undefined
}

function seedGhosttyRuntime(opts: SeedGhosttyRuntimeOpts): void {
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
      transport: 'ghostty',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: opts.adopted ?? false,
      // No controllerKind — not broker-managed
      lastActivityAt: opts.lastActivityAt ?? now,
      createdAt: now,
      updatedAt: now,
    })
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
// 2. NON-BROKER GHOSTTY FALLBACK LABELING (item #5 — must-not-mislead gate)
// ═════════════════════════════════════════════════════════════════════════════

describe('[RED P3-2] Non-broker ghostty fallback: source labeled hrc-derived', () => {
  it('ghostty runtime returns source:hrc-derived (not broker-reported)', async () => {
    seedGhosttyRuntime({
      runtimeId: 'rt-ghostty-src',
      hostSessionId: 'hsid-ghostty-src',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:ghostty-src',
    })

    // RED: endpoint not yet wired; when wired, must return hrc-derived label
    const res = await postBrokerInspect('rt-ghostty-src')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { source?: string }
    // Must be labeled as HRC-derived — never 'broker' or absent
    expect(body.source).toBe('hrc-derived')
  })

  it('ghostty runtime synthesizes computedRetireAt = lastActivityAt + 15min (default policy)', async () => {
    // Use a fixed lastActivityAt so we can assert the exact computedRetireAt
    const lastActivityAt = '2026-06-03T10:00:00.000Z'
    const expectedRetireAt = new Date(
      new Date(lastActivityAt).getTime() + DEFAULT_GHOSTTY_IDLE_TTL_MS
    ).toISOString() // = '2026-06-03T10:15:00.000Z'

    seedGhosttyRuntime({
      runtimeId: 'rt-ghostty-retire',
      hostSessionId: 'hsid-ghostty-retire',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:ghostty-retire',
      lastActivityAt,
    })

    // RED: endpoint not yet wired
    const res = await postBrokerInspect('rt-ghostty-retire')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      lifecycle?: { retention?: { computedRetireAt?: string; idleTtlMs?: number } }
    }
    expect(body.lifecycle?.retention?.computedRetireAt).toBe(expectedRetireAt)
    expect(body.lifecycle?.retention?.idleTtlMs).toBe(DEFAULT_GHOSTTY_IDLE_TTL_MS)
  })

  it('ghostty runtime synthesizes idleTtlMs from HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES env override', async () => {
    const customMinutes = 30
    const expectedIdleTtlMs = customMinutes * 60 * 1000

    const lastActivityAt = '2026-06-03T10:00:00.000Z'
    const expectedRetireAt = new Date(
      new Date(lastActivityAt).getTime() + expectedIdleTtlMs
    ).toISOString()

    seedGhosttyRuntime({
      runtimeId: 'rt-ghostty-override',
      hostSessionId: 'hsid-ghostty-override',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:ghostty-override',
      lastActivityAt,
    })

    // Set env override to 30 min for this test
    const origEnv = process.env['HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES']
    process.env['HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES'] = String(customMinutes)
    try {
      // RED: endpoint not yet wired
      const res = await postBrokerInspect('rt-ghostty-override')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        lifecycle?: { retention?: { computedRetireAt?: string; idleTtlMs?: number } }
      }
      expect(body.lifecycle?.retention?.computedRetireAt).toBe(expectedRetireAt)
      expect(body.lifecycle?.retention?.idleTtlMs).toBe(expectedIdleTtlMs)
    } finally {
      if (origEnv === undefined) {
        process.env['HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES'] = undefined
      } else {
        process.env['HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES'] = origEnv
      }
    }
  })

  it('ghostty fallback source label is present on every response — never absent', async () => {
    // A response missing source:'hrc-derived' would mislead operators into thinking
    // the lifecycle data is broker-reported when it is HRC-synthesized.
    seedGhosttyRuntime({
      runtimeId: 'rt-ghostty-label-always',
      hostSessionId: 'hsid-ghostty-label-always',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01856:ghostty-label-always',
    })

    // RED: endpoint not yet wired
    const res = await postBrokerInspect('rt-ghostty-label-always')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // The source MUST be present and MUST NOT be 'broker'
    expect(body['source']).toBeDefined()
    expect(body['source']).not.toBe('broker')
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
    // runtime-DB facts. There is no idle-cleanup policy to apply (that only
    // applies to ghostty/claude-code). The lifecycle.retention.mode must
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

describe('broker-inspect finalSummary passthrough (T-01893)', () => {
  it('returns runtimeStateJson.finalSummary on the inspect response', async () => {
    const runtimeId = 'rt-final-summary'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-final-summary',
      scopeRef: 'agent:larry:project:agent-spaces:task:final-summary',
    })

    const finalSummary = {
      reason: 'prompt_input_exit',
      summary: {
        invocationId: 'inv-final-summary',
        state: 'ready',
        driver: 'codex-cli-tmux',
        startedAt: fixture.now(),
        lastActivityAt: fixture.now(),
        turnsCompleted: 3,
      },
    }
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const runtime = db.runtimes.getByRuntimeId(runtimeId)
      db.runtimes.update(runtimeId, {
        runtimeStateJson: { ...(runtime?.runtimeStateJson ?? {}), finalSummary },
        updatedAt: fixture.now(),
      })
    } finally {
      db.close()
    }

    // No live broker controller injected — mirrors the post-reap state where the
    // live read model is gone but the recorded summary persists.
    const res = await postBrokerInspect(runtimeId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { finalSummary?: typeof finalSummary }
    expect(body.finalSummary).toMatchObject({
      reason: 'prompt_input_exit',
      summary: { driver: 'codex-cli-tmux', turnsCompleted: 3 },
    })
  })
})
