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

  it('ordinary inspect stays read-only and does not run final-summary recovery', async () => {
    const runtimeId = 'rt-final-summary-readonly'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-final-summary-readonly',
      scopeRef: 'agent:larry:project:agent-spaces:task:readonly-final-summary',
      activeInvocationId: 'inv-final-summary-readonly',
    })
    const fake = new FakeBrokerController()
    injectFakeController(fake)

    const res = await postBrokerInspect(runtimeId)
    expect(res.status).toBe(200)
    expect(fake.recoverFinalSummaryCalls).toEqual([])
  })

  it('explicit final-summary recovery calls the bounded recovery path and returns recovered summary', async () => {
    const runtimeId = 'rt-final-summary-recover'
    const tokenPath = `${fixture.tmpDir}/recover-token`
    await Bun.write(tokenPath, 'recover-token-secret')
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-final-summary-recover',
      scopeRef: 'agent:larry:project:agent-spaces:task:recover-final-summary',
      activeInvocationId: 'inv-final-summary-recover',
    })
    const finalSummary = {
      reason: 'prompt_input_exit',
      summary: {
        invocationId: 'inv-final-summary-recover',
        state: 'ready',
        driver: 'codex-cli-tmux',
        startedAt: fixture.now(),
        lastActivityAt: fixture.now(),
        turnsCompleted: 2,
      },
    }
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const runtime = db.runtimes.getByRuntimeId(runtimeId)
      db.runtimes.update(runtimeId, {
        status: 'terminated',
        runtimeStateJson: {
          ...(runtime?.runtimeStateJson ?? {}),
          broker: {
            ...((runtime?.runtimeStateJson?.['broker'] as Record<string, unknown>) ?? {}),
            endpoint: {
              kind: 'unix-jsonrpc-ndjson',
              socketPath: '/tmp/final-summary-recover.sock',
              attachTokenRef: { kind: 'file', path: tokenPath, redacted: true },
            },
          },
        },
        updatedAt: fixture.now(),
      })
    } finally {
      db.close()
    }

    const fake = new FakeBrokerController()
    fake.recoverFinalSummaryResult = { state: 'recovered' }
    fake.recoverFinalSummaryHook = () => {
      const hookDb = openHrcDatabase(fixture.dbPath)
      try {
        const runtime = hookDb.runtimes.getByRuntimeId(runtimeId)
        hookDb.runtimes.update(runtimeId, {
          runtimeStateJson: { ...(runtime?.runtimeStateJson ?? {}), finalSummary },
          updatedAt: fixture.now(),
        })
      } finally {
        hookDb.close()
      }
    }
    injectFakeController(fake)

    const res = await postBrokerInspect(runtimeId, {
      recoverFinalSummary: { timeoutMs: 123 },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      finalSummary?: typeof finalSummary
      finalSummaryRecovery?: FinalSummaryRecoveryResult
    }
    expect(fake.recoverFinalSummaryCalls).toEqual([
      {
        runtimeId,
        socketPath: '/tmp/final-summary-recover.sock',
        attachToken: 'recover-token-secret',
        timeoutMs: 123,
      },
    ])
    expect(body.finalSummaryRecovery).toEqual({ state: 'recovered' })
    expect(body.finalSummary).toMatchObject({
      reason: 'prompt_input_exit',
      summary: { driver: 'codex-cli-tmux', turnsCompleted: 2 },
    })
  })

  it('explicit final-summary recovery on non-broker runtime returns a factual fallback state', async () => {
    seedAdoptedHeadlessRuntime({
      runtimeId: 'rt-final-summary-nonbroker',
      hostSessionId: 'hsid-final-summary-nonbroker',
      scopeRef: 'agent:larry:project:agent-spaces:task:nonbroker-final-summary',
    })

    const res = await postBrokerInspect('rt-final-summary-nonbroker', {
      recoverFinalSummary: { timeoutMs: 10 },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { finalSummaryRecovery?: FinalSummaryRecoveryResult }
    expect(body.finalSummaryRecovery).toEqual({ state: 'not_broker' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// T-07077 — `includeInvocations:false` keeps the summary path off the broker
// ═════════════════════════════════════════════════════════════════════════════

describe('[T-07077] includeInvocations gate', () => {
  it('skips the broker read model entirely and still labels the runtime source:broker', async () => {
    const runtimeId = 'rt-t07077-gate'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-t07077-gate',
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-07077:gate',
      inspectionCapabilities: { listInvocations: true, liveness: 'none' },
    })
    const fake = new FakeBrokerController()
    injectFakeController(fake)

    const res = await postBrokerInspect(runtimeId, { includeInvocations: false })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { source?: string; invocations?: unknown[] }

    // The broker is never asked — that is the whole point of the gate.
    expect(fake.listInvocationsCalls).toHaveLength(0)
    // Still broker-backed: mislabeling these as 'hrc-derived' would present
    // broker facts as synthesized.
    expect(body.source).toBe('broker')
    // Omitted, not [] — "not asked for" must stay distinguishable from "none present".
    expect(body.invocations).toBeUndefined()
  })

  it('returns promptly even when the broker read model would hang forever', async () => {
    // The live failure mode: a reaped broker whose socket never EOFs. With the
    // gate the response cannot depend on that RPC at all.
    const runtimeId = 'rt-t07077-hang'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-t07077-hang',
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-07077:hang',
      inspectionCapabilities: { listInvocations: true, liveness: 'none' },
    })
    const fake = new FakeBrokerController()
    fake.listInvocations = (): Promise<InvocationInspectionSummary[]> =>
      new Promise<InvocationInspectionSummary[]>(() => {})
    injectFakeController(fake)

    const startedAt = Date.now()
    const res = await postBrokerInspect(runtimeId, { includeInvocations: false })
    expect(res.status).toBe(200)
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })

  it('still queries the broker read model by default (no gate)', async () => {
    const runtimeId = 'rt-t07077-default'
    seedBrokerTmuxRuntime({
      runtimeId,
      hostSessionId: 'hsid-t07077-default',
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-07077:default',
      inspectionCapabilities: { listInvocations: true, liveness: 'none' },
    })
    const fake = new FakeBrokerController()
    injectFakeController(fake)

    const res = await postBrokerInspect(runtimeId)
    expect(res.status).toBe(200)
    expect(fake.listInvocationsCalls).toHaveLength(1)
  })
})
