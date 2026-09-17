/**
 * T-08566 stage 2 — regressions for two visibility defects found by the isolated
 * workstream (Astra EN-14226):
 *  DEF-1 broker forensics (`hrc monitor events`) must carry the STORED evidence
 *        origin, never reconstruct it;
 *  DEF-2 prune dry-run must report a held runtime as `offline_evidence_held`
 *        regardless of its active run or otherwise non-prunable status, without
 *        weakening any unheld safety refusal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { type HrcServer, createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer
beforeEach(async () => {
  fixture = await createHrcTestFixture('t08566-visibility-')
  server = await createHrcServer(fixture.serverOpts())
  await Bun.sleep(50)
})
afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

const BINDING = {
  source: 'aspd',
  releaseId: 'asp-visibility-test',
  sourceCommit: 'c0ffee',
  builtAt: '2026-09-17T00:00:00.000Z',
  releaseRoot: '/nonexistent/asp-visibility-test',
  worker: {
    protocol: 'harness-broker/0.2',
    executable: '/nonexistent/asp-visibility-test/harness-broker',
    argvPrefix: ['run', '--transport', 'unix'],
  },
}

function seedBrokerRuntime(
  suffix: string,
  opts: {
    status: string
    bound: boolean
    activeRunId?: string | undefined
    external?: boolean | undefined
  }
) {
  const runtimeId = `rt-vis-${suffix}`
  const hostSessionId = `hsid-vis-${suffix}`
  const invocationId = `inv-vis-${suffix}`
  const scopeRef = `agent:clod:project:hrc-runtime:task:t08566vis${suffix}`
  fixture.seedSession(hostSessionId, scopeRef)
  fixture.seedTmuxRuntime(hostSessionId, scopeRef, runtimeId, { status: opts.status })
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    const ledger = `${fixture.runtimeRoot}/bipc/${suffix}/events.ndjson`
    db.runtimes.update(runtimeId, {
      transport: 'headless',
      controllerKind: 'harness-broker',
      ...(opts.activeRunId !== undefined ? { activeRunId: opts.activeRunId } : {}),
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId,
        hostSessionId,
        generation: 1,
        ...(opts.bound ? { executionRelease: BINDING } : {}),
        ...(opts.external ? { lifecycleOwner: 'external' } : {}),
        broker: {
          endpoint: {
            kind: 'unix-jsonrpc-ndjson',
            socketPath: `${fixture.runtimeRoot}/bipc/${suffix}/b.sock`,
            attachTokenRef: {
              kind: 'file',
              path: `${fixture.runtimeRoot}/bipc/${suffix}/attach.token`,
              redacted: true,
            },
            protocolVersion: 'harness-broker/0.2',
          },
          substrate: {
            kind: 'leased-tmux',
            tmuxSocketPath: fixture.tmuxSocketPath,
            sessionName: `hrc-${runtimeId}`,
            brokerWindow: { sessionId: '$dead', windowId: '@dead', paneId: '%dead' },
            generation: 1,
            eventLedgerPath: ledger,
          },
          presentation: { kind: 'none' },
        },
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    db.brokerInvocations.insert({
      invocationId: invocationId as never,
      operationId: `op-vis-${suffix}`,
      runtimeId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'exited',
      capabilitiesJson: '{}',
      specHash: 'sha256:vis',
      startRequestHash: 'sha256:vis',
      selectedProfileHash: 'sha256:vis',
      lastProjectedSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
  return { runtimeId, hostSessionId, invocationId }
}

describe('DEF-1: broker forensics carries the stored evidence origin', () => {
  test('retained rows expose evidenceOrigin; unmarked rows do not', async () => {
    const seeded = seedBrokerRuntime('forensics', { status: 'terminated', bound: true })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      for (const [seq, origin] of [
        [1, undefined],
        [2, 'retained'],
      ] as const) {
        db.brokerInvocationEvents.appendEvent({
          invocationId: seeded.invocationId,
          seq,
          time: `2026-09-17T06:00:0${seq}.000Z`,
          type: 'diagnostic',
          runtimeId: seeded.runtimeId,
          payload: { seq },
          envelopeJson: JSON.stringify({ invocationId: seeded.invocationId, seq }),
          projectionStatus: 'applied',
          ...(origin ? { evidenceOrigin: origin } : {}),
        })
      }
    } finally {
      db.close()
    }
    const response = await fixture.fetchSocket(
      `/v1/broker-forensics?targetId=${encodeURIComponent(seeded.runtimeId)}`
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { events: Array<Record<string, unknown>> }
    const bySeq = new Map(body.events.map((event) => [event['seq'], event]))
    expect(bySeq.get(2)?.['evidenceOrigin']).toBe('retained')
    expect(bySeq.get(1)).toBeDefined()
    expect(Object.hasOwn(bySeq.get(1) ?? {}, 'evidenceOrigin')).toBe(false)
  })
})

describe('DEF-2: prune dry-run reports held evidence ahead of other refusals', () => {
  async function dryRun(statuses: string[]) {
    const response = await fixture.postJson('/v1/runtimes/prune', {
      status: statuses,
      olderThan: '0s',
      dryRun: true,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      results: Array<{ runtimeId: string; status: string; reason?: string }>
    }
    return new Map(body.results.map((result) => [result.runtimeId, result]))
  }

  test('held + active run and held + non-prunable status report offline_evidence_held; unheld refusals unchanged', async () => {
    const heldActive = seedBrokerRuntime('held-active', {
      status: 'terminated',
      bound: true,
      activeRunId: 'run-vis-held-active',
    })
    const heldFailed = seedBrokerRuntime('held-failed', { status: 'failed', bound: true })
    const heldStale = seedBrokerRuntime('held-stale', { status: 'stale', bound: true })
    const unheldActive = seedBrokerRuntime('unheld-active', {
      status: 'terminated',
      bound: false,
      activeRunId: 'run-vis-unheld-active',
    })
    const unheldFailed = seedBrokerRuntime('unheld-failed', { status: 'failed', bound: false })
    const externalHeld = seedBrokerRuntime('external-held', {
      status: 'terminated',
      bound: true,
      external: true,
    })

    const results = await dryRun(['terminated', 'failed', 'stale', 'dead', 'crashed', 'detached'])
    expect(results.get(heldActive.runtimeId)).toMatchObject({
      status: 'skipped',
      reason: 'offline_evidence_held',
    })
    expect(results.get(heldFailed.runtimeId)).toMatchObject({
      status: 'skipped',
      reason: 'offline_evidence_held',
    })
    expect(results.get(heldStale.runtimeId)).toMatchObject({
      status: 'skipped',
      reason: 'offline_evidence_held',
    })
    // Unheld safety controls keep their own refusals.
    expect(results.get(unheldActive.runtimeId)).toMatchObject({
      status: 'skipped',
      reason: 'active_run',
    })
    expect(results.get(unheldFailed.runtimeId)).toMatchObject({
      status: 'skipped',
      reason: 'status_not_prunable:failed',
    })
    // External-owned rows are excluded before any hold evaluation.
    expect(results.get(externalHeld.runtimeId)).toMatchObject({
      status: 'skipped',
      reason: 'external_lifecycle_owner',
    })

    // No destructive action from a dry run.
    const db = openHrcDatabase(fixture.dbPath)
    try {
      for (const id of [
        heldActive,
        heldFailed,
        heldStale,
        unheldActive,
        unheldFailed,
        externalHeld,
      ]) {
        expect(db.runtimes.getByRuntimeId(id.runtimeId)).not.toBeNull()
      }
    } finally {
      db.close()
    }
  })
})
