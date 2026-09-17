/**
 * T-08566 stage 2 H1b/H3 — pruning must never infer that a private broker
 * lease is dead by looking only on the daemon tmux socket. These tests use real
 * private tmux servers and persist the production lease shape. The positive
 * controls keep the legacy daemon-socket guard and genuinely dead leases safe.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import {
  getBrokerRuntimeTmuxLeasedPaneId,
  getBrokerRuntimeTmuxSocketPath,
} from '../broker-decisions'
import { hasLeasedBrokerSubstrate } from '../broker/runtime-hosting'
import { type HrcServer, createHrcServer } from '../index'
import { createTmuxManager } from '../tmux'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

const OLD = '2026-01-01T00:00:00.000Z'
const ALLOWLISTED_SCOPE = 'agent:mneme:project:signal-pipeline:task:signal-cluster'
const EXECUTION_RELEASE = {
  source: 'aspd',
  releaseId: 'asp-h1b-test',
  sourceCommit: 'f450dc9999240000000000000000000000000000',
  builtAt: '2026-09-12T05:40:56.000Z',
  releaseRoot: '/nonexistent/asp-h1b-test',
  worker: {
    protocol: 'harness-broker/0.2',
    executable: '/nonexistent/asp-h1b-test/harness-broker',
    argvPrefix: ['run', '--transport', 'unix'],
  },
}

type Lease = {
  socketPath: string
  sessionId: string
  sessionName: string
  windowId: string
  paneId: string
}

type PruneLivenessEvaluator = (
  runtime: HrcRuntimeSnapshot,
  tmux: ReturnType<typeof createTmuxManager>,
  db: ReturnType<typeof openHrcDatabase>,
  options: { tmuxManagerFactory: typeof createTmuxManager }
) => Promise<{ prunable: boolean; reason?: string }>

type Seeded = {
  runtimeId: string
  hostSessionId: string
  invocationId: string
  ledgerDir: string
  ledgerPath: string
  ledgerBytes: Buffer
}

let fixture: HrcServerTestFixture
let server: HrcServer
let tmuxSockets: string[]

beforeEach(async () => {
  fixture = await createHrcTestFixture('t08566-prune-safety-')
  server = await createHrcServer(fixture.serverOpts())
  tmuxSockets = []
})

afterEach(async () => {
  for (const socketPath of tmuxSockets) {
    spawnSync('tmux', ['-S', socketPath, 'kill-server'])
  }
  await server.stop()
  await fixture.cleanup()
})

function tmux(socketPath: string, args: string[]) {
  return spawnSync('tmux', ['-S', socketPath, ...args], { encoding: 'utf8' })
}

async function createLiveLease(suffix: string): Promise<Lease> {
  const socketPath = join(fixture.runtimeRoot, 'btmux', `${suffix}.sock`)
  const sessionName = `hrc-h1b-${suffix}`
  await mkdir(join(fixture.runtimeRoot, 'btmux'), { recursive: true })
  const created = tmux(socketPath, [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-n',
    'tui',
    'sleep 600',
  ])
  expect({ status: created.status, stderr: created.stderr }).toEqual({ status: 0, stderr: '' })
  tmuxSockets.push(socketPath)
  const identity = tmux(socketPath, [
    'display-message',
    '-p',
    '-t',
    `=${sessionName}:tui`,
    '#{session_id}\t#{window_id}\t#{pane_id}',
  ])
  expect(identity.status).toBe(0)
  const [sessionId, windowId, paneId] = identity.stdout.trim().split('\t')
  if (!sessionId || !windowId || !paneId) {
    throw new Error(`tmux did not return a complete lease identity: ${identity.stdout}`)
  }
  const liveness = await createTmuxManager({ socketPath }).inspectPaneLiveness(paneId)
  expect(liveness).toMatchObject({ alive: true, dead: false, currentCommand: 'sleep' })
  return { socketPath, sessionId, sessionName, windowId, paneId }
}

async function createShellLease(suffix: string): Promise<Lease> {
  const socketPath = join(fixture.runtimeRoot, 'btmux', `${suffix}.sock`)
  const sessionName = `hrc-h1b-${suffix}`
  await mkdir(join(fixture.runtimeRoot, 'btmux'), { recursive: true })
  const created = tmux(socketPath, ['new-session', '-d', '-s', sessionName, '-n', 'tui'])
  expect({ status: created.status, stderr: created.stderr }).toEqual({ status: 0, stderr: '' })
  tmuxSockets.push(socketPath)
  const identity = tmux(socketPath, [
    'display-message',
    '-p',
    '-t',
    `=${sessionName}:tui`,
    '#{session_id}\t#{window_id}\t#{pane_id}',
  ])
  expect(identity.status).toBe(0)
  const [sessionId, windowId, paneId] = identity.stdout.trim().split('\t')
  if (!sessionId || !windowId || !paneId) {
    throw new Error(`tmux did not return a complete shell lease identity: ${identity.stdout}`)
  }
  const liveness = await createTmuxManager({ socketPath }).inspectPaneLiveness(paneId)
  expect(liveness).toMatchObject({ alive: false, dead: false })
  return { socketPath, sessionId, sessionName, windowId, paneId }
}

function killLease(lease: Lease): void {
  const killed = tmux(lease.socketPath, ['kill-server'])
  expect(killed.status).toBe(0)
  tmuxSockets = tmuxSockets.filter((entry) => entry !== lease.socketPath)
  expect(tmux(lease.socketPath, ['has-session', '-t', `=${lease.sessionName}`]).status).not.toBe(0)
}

function leaseAlive(lease: Lease): boolean {
  return tmux(lease.socketPath, ['has-session', '-t', `=${lease.sessionName}`]).status === 0
}

async function seedBrokerRuntime(
  suffix: string,
  options: {
    status: string
    bound: boolean
    lease: Lease
    hosted?: boolean | undefined
    d8eShape?: boolean | undefined
    scopeRef?: string | undefined
    activeRunId?: string | undefined
    external?: boolean | undefined
  }
): Promise<Seeded> {
  const runtimeId = `rt-h1b-${suffix}`
  const hostSessionId = `hsid-h1b-${suffix}`
  const invocationId = `inv-h1b-${suffix}`
  const scopeRef = options.scopeRef ?? `agent:clod:project:hrc-runtime:task:h1b${suffix}`
  const ledgerDir = join(fixture.runtimeRoot, 'bipc', suffix)
  const ledgerPath = join(ledgerDir, 'events.ndjson')
  const ledgerBytes = Buffer.from(`{"invocationId":"${invocationId}","seq":1}\n`)
  await mkdir(ledgerDir, { recursive: true })
  await writeFile(ledgerPath, ledgerBytes)

  fixture.seedSession(hostSessionId, scopeRef)
  fixture.seedTmuxRuntime(hostSessionId, scopeRef, runtimeId, { status: options.status })
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.runtimes.update(runtimeId, {
      transport: 'headless',
      controllerKind: 'harness-broker',
      ...(options.activeRunId ? { activeRunId: options.activeRunId } : {}),
      tmuxJson: options.d8eShape
        ? {
            kind: 'broker-tmux-allocation',
            brokerDriver: 'codex-app-server',
            socketPath: options.lease.socketPath,
            allocatedAt: OLD,
            sessionId: options.lease.sessionId,
            windowId: options.lease.windowId,
            paneId: options.lease.paneId,
            sessionName: options.lease.sessionName,
            windowName: 'tui',
            generation: 1,
          }
        : {
            kind: 'broker-tmux-allocation',
            socketPath: options.lease.socketPath,
            sessionId: options.lease.sessionId,
            sessionName: options.lease.sessionName,
            windowId: options.lease.windowId,
            paneId: options.lease.paneId,
            windowName: 'tui',
          },
      runtimeStateJson: options.d8eShape
        ? {
            schemaVersion: 'runtime-state/v1',
            kind: 'harness-broker',
            runtimeId,
            hostSessionId,
            generation: 1,
            status: options.status,
            executionRelease: {
              ...EXECUTION_RELEASE,
              operationId: `op-h1b-${suffix}`,
              helloRelease: {
                releaseId: EXECUTION_RELEASE.releaseId,
                sourceCommit: EXECUTION_RELEASE.sourceCommit,
                builtAt: EXECUTION_RELEASE.builtAt,
              },
            },
            tmux: {
              brokerDriver: 'codex-app-server',
              socketPath: options.lease.socketPath,
              allocatedAt: OLD,
              sessionId: options.lease.sessionId,
              windowId: options.lease.windowId,
              paneId: options.lease.paneId,
              sessionName: options.lease.sessionName,
              windowName: 'tui',
              generation: 1,
            },
            updatedAt: OLD,
            startFailure: { code: 'broker_start_failed', message: 'fixture start failed' },
            staleReason: 'broker_tmux_lease_stale_on_restart',
            stalePayload: {
              runtimeId,
              reason: 'broker_tmux_lease_stale_on_restart',
              generation: 1,
              invocationId,
            },
            terminalInvocation: { invocationId, eventType: 'hrc.runtime.stale' },
          }
        : {
            schemaVersion: 'runtime-state/v1',
            kind: 'harness-broker',
            runtimeId,
            hostSessionId,
            generation: 1,
            ...(options.bound ? { executionRelease: EXECUTION_RELEASE } : {}),
            ...(options.external ? { lifecycleOwner: 'external' } : {}),
            broker:
              options.hosted === false
                ? { eventLedgerPath: ledgerPath }
                : {
                    endpoint: {
                      kind: 'unix-jsonrpc-ndjson',
                      socketPath: join(ledgerDir, 'broker.sock'),
                      attachTokenRef: {
                        kind: 'file',
                        path: join(ledgerDir, 'attach.token'),
                        redacted: true,
                      },
                      protocolVersion: 'harness-broker/0.2',
                    },
                    substrate: {
                      kind: 'leased-tmux',
                      tmuxSocketPath: options.lease.socketPath,
                      sessionName: options.lease.sessionName,
                      brokerWindow: {
                        sessionId: options.lease.sessionId,
                        windowId: options.lease.windowId,
                        paneId: options.lease.paneId,
                      },
                      generation: 1,
                      eventLedgerPath: ledgerPath,
                    },
                    presentation: { kind: 'none' },
                  },
          },
      lastActivityAt: OLD,
      updatedAt: OLD,
    } as never)
    db.brokerInvocations.insert({
      invocationId: invocationId as never,
      operationId: `op-h1b-${suffix}`,
      runtimeId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'exited',
      capabilitiesJson: '{}',
      specHash: `sha256:h1b-${suffix}`,
      startRequestHash: `sha256:h1b-${suffix}`,
      selectedProfileHash: `sha256:h1b-${suffix}`,
      lastProjectedSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }

  const persisted = runtime(runtimeId)
  expect(persisted).not.toBeNull()
  expect(hasLeasedBrokerSubstrate(persisted as HrcRuntimeSnapshot)).toBe(
    options.d8eShape ? false : options.hosted !== false
  )
  expect(getBrokerRuntimeTmuxSocketPath(persisted as HrcRuntimeSnapshot)).toBe(
    options.lease.socketPath
  )
  expect(getBrokerRuntimeTmuxLeasedPaneId(persisted as HrcRuntimeSnapshot)).toBe(
    options.lease.paneId
  )
  if (options.d8eShape) {
    expect(Object.keys(persisted?.tmuxJson ?? {}).sort()).toEqual(
      [
        'allocatedAt',
        'brokerDriver',
        'generation',
        'kind',
        'paneId',
        'sessionId',
        'sessionName',
        'socketPath',
        'windowId',
        'windowName',
      ].sort()
    )
    expect(Object.keys(persisted?.runtimeStateJson ?? {}).sort()).toEqual(
      [
        'executionRelease',
        'generation',
        'hostSessionId',
        'kind',
        'runtimeId',
        'stalePayload',
        'staleReason',
        'startFailure',
        'status',
        'terminalInvocation',
        'tmux',
        'updatedAt',
        'schemaVersion',
      ].sort()
    )
  }
  return { runtimeId, hostSessionId, invocationId, ledgerDir, ledgerPath, ledgerBytes }
}

async function sharedPruneLivenessEvaluator(): Promise<unknown> {
  const sweepHelpers = (await import('../sweep-helpers')) as unknown as Record<string, unknown>
  return sweepHelpers['evaluatePruneLivenessSafety']
}

async function evaluateSharedLiveness(runtimeId: string): Promise<{
  evaluator: unknown
  result?: { prunable: boolean; reason?: string } | undefined
}> {
  const evaluator = await sharedPruneLivenessEvaluator()
  if (typeof evaluator !== 'function') return { evaluator }
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const persisted = db.runtimes.getByRuntimeId(runtimeId)
    if (!persisted) throw new Error(`missing runtime ${runtimeId}`)
    const result = await (evaluator as PruneLivenessEvaluator)(
      persisted,
      createTmuxManager({ socketPath: fixture.tmuxSocketPath }),
      db,
      { tmuxManagerFactory: createTmuxManager }
    )
    return { evaluator, result }
  } finally {
    db.close()
  }
}

function runtime(runtimeId: string): HrcRuntimeSnapshot | null {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runtimes.getByRuntimeId(runtimeId)
  } finally {
    db.close()
  }
}

function rowCount(table: string, runtimeId: string): number {
  const db = new Database(fixture.dbPath, { readonly: true })
  try {
    return (
      db
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE runtime_id = ?`
        )
        .get(runtimeId)?.count ?? 0
    )
  } finally {
    db.close()
  }
}

async function ledgerSnapshot(seeded: Seeded) {
  return {
    entries: await readdir(seeded.ledgerDir),
    bytes: await readFile(seeded.ledgerPath),
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe('T-08566 H1b/H3 private broker lease prune safety', () => {
  test('exports the shared status-agnostic prune liveness evaluator', async () => {
    expect(typeof (await sharedPruneLivenessEvaluator())).toBe('function')
  })

  test('exact d8e stale shape is fenced by bulk dry-run without parsed leased hosting', async () => {
    const lease = await createLiveLease('d8e-bulk')
    const seeded = await seedBrokerRuntime('d8e-bulk', {
      status: 'stale',
      bound: true,
      lease,
      d8eShape: true,
    })
    const persisted = runtime(seeded.runtimeId) as HrcRuntimeSnapshot
    expect(hasLeasedBrokerSubstrate(persisted)).toBe(false)

    const response = await fixture.postJson('/v1/runtimes/prune', {
      status: ['stale'],
      olderThan: '0s',
      dryRun: true,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      results: [{ runtimeId: seeded.runtimeId, status: 'skipped', reason: 'live_broker_lease' }],
    })
    expect(runtime(seeded.runtimeId)).not.toBeNull()
    expect(leaseAlive(lease)).toBe(true)
  })

  test('shared liveness evaluator fences the exact d8e stale shape', async () => {
    const lease = await createLiveLease('d8e-unit')
    const seeded = await seedBrokerRuntime('d8e-unit', {
      status: 'stale',
      bound: true,
      lease,
      d8eShape: true,
    })
    expect(await evaluateSharedLiveness(seeded.runtimeId)).toMatchObject({
      evaluator: expect.any(Function),
      result: { prunable: false, reason: 'live_broker_lease' },
    })
  })

  test('busy parsed lease is live to the shared evaluator but status admission wins in bulk', async () => {
    const lease = await createLiveLease('busy-control')
    const seeded = await seedBrokerRuntime('busy-control', {
      status: 'busy',
      bound: false,
      lease,
    })
    const response = await fixture.postJson('/v1/runtimes/prune', {
      status: ['busy'],
      olderThan: '0s',
      dryRun: true,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      results: [
        {
          runtimeId: seeded.runtimeId,
          status: 'skipped',
          reason: 'status_not_prunable:busy',
        },
      ],
    })
    expect(await evaluateSharedLiveness(seeded.runtimeId)).toMatchObject({
      evaluator: expect.any(Function),
      result: { prunable: false, reason: 'live_broker_lease' },
    })
  })

  test('a present private shell pane is live evidence even when its foreground is not alive', async () => {
    const lease = await createShellLease('shell-pane')
    const seeded = await seedBrokerRuntime('shell-pane', {
      status: 'stale',
      bound: false,
      lease,
    })
    const response = await fixture.postJson('/v1/runtimes/prune', {
      status: ['stale'],
      olderThan: '0s',
      dryRun: true,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      results: [{ runtimeId: seeded.runtimeId, status: 'skipped', reason: 'live_broker_lease' }],
    })
    expect(runtime(seeded.runtimeId)).not.toBeNull()
    expect(leaseAlive(lease)).toBe(true)
  })

  test('bulk dry-run and apply both spare an unbound runtime with a live private lease', async () => {
    const lease = await createLiveLease('bulk-live')
    const seeded = await seedBrokerRuntime('bulk-live', {
      status: 'stale',
      bound: false,
      lease,
      hosted: false,
    })
    const before = await ledgerSnapshot(seeded)

    const dryResponse = await fixture.postJson('/v1/runtimes/prune', {
      status: ['stale'],
      olderThan: '0s',
      dryRun: true,
    })
    const dryBody = await json(dryResponse)
    const applyResponse = await fixture.postJson('/v1/runtimes/prune', {
      status: ['stale'],
      olderThan: '0s',
      yes: true,
    })
    const applyBody = await json(applyResponse)

    expect({
      dryStatus: dryResponse.status,
      dryBody,
      applyStatus: applyResponse.status,
      applyBody,
      runtimePresent: runtime(seeded.runtimeId) !== null,
      ledger: await ledgerSnapshot(seeded),
      leaseAlive: leaseAlive(lease),
    }).toMatchObject({
      dryStatus: 200,
      dryBody: {
        results: [{ runtimeId: seeded.runtimeId, status: 'skipped', reason: 'live_broker_lease' }],
      },
      applyStatus: 200,
      applyBody: {
        results: [{ runtimeId: seeded.runtimeId, status: 'skipped', reason: 'live_broker_lease' }],
      },
      runtimePresent: true,
      ledger: before,
      leaseAlive: true,
    })
  })

  test('ledger-inclusive preflight refuses a live private lease without mutation', async () => {
    const lease = await createLiveLease('manifest-live')
    const seeded = await seedBrokerRuntime('manifest-live', {
      status: 'stale',
      bound: false,
      lease,
      scopeRef: ALLOWLISTED_SCOPE,
    })
    const before = {
      ledger: await ledgerSnapshot(seeded),
      invocations: rowCount('broker_invocations', seeded.runtimeId),
    }

    const response = await fixture.postJson('/v1/runtimes/prune', {
      runtimeIds: [seeded.runtimeId],
      includeLedgers: true,
      yes: true,
    })
    const body = await json(response)

    expect({
      status: response.status,
      body,
      runtimePresent: runtime(seeded.runtimeId) !== null,
      ledger: await ledgerSnapshot(seeded),
      invocations: rowCount('broker_invocations', seeded.runtimeId),
      leaseAlive: leaseAlive(lease),
    }).toMatchObject({
      status: 409,
      body: {
        error: {
          detail: {
            failureCount: 1,
            failures: [
              {
                runtimeId: seeded.runtimeId,
                reasons: expect.arrayContaining(['live_broker_lease']),
              },
            ],
          },
        },
      },
      runtimePresent: true,
      ledger: before.ledger,
      invocations: before.invocations,
      leaseAlive: true,
    })
  })

  test('retained-evidence disposal refuses a held runtime with a live private lease', async () => {
    const lease = await createLiveLease('dispose-live')
    const seeded = await seedBrokerRuntime('dispose-live', {
      status: 'stale',
      bound: true,
      lease,
    })
    const before = {
      ledger: await ledgerSnapshot(seeded),
      outcomes: rowCount('retained_evidence_outcomes', seeded.runtimeId),
    }

    const dryResponse = await fixture.postJson('/v1/runtimes/prune', {
      runtimeIds: [seeded.runtimeId],
      disposeRetainedEvidence: true,
      reason: 'operator reviewed evidence',
      dryRun: true,
    })
    const dryBody = await json(dryResponse)
    const applyResponse = await fixture.postJson('/v1/runtimes/prune', {
      runtimeIds: [seeded.runtimeId],
      disposeRetainedEvidence: true,
      reason: 'operator reviewed evidence',
      yes: true,
    })
    const applyBody = await json(applyResponse)

    expect({
      dryStatus: dryResponse.status,
      dryBody,
      applyStatus: applyResponse.status,
      applyBody,
      outcomes: rowCount('retained_evidence_outcomes', seeded.runtimeId),
      runtimePresent: runtime(seeded.runtimeId) !== null,
      ledger: await ledgerSnapshot(seeded),
      leaseAlive: leaseAlive(lease),
    }).toMatchObject({
      dryStatus: 200,
      dryBody: {
        results: [{ runtimeId: seeded.runtimeId, status: 'skipped', reason: 'live_broker_lease' }],
      },
      applyStatus: 200,
      applyBody: {
        results: [{ runtimeId: seeded.runtimeId, status: 'skipped', reason: 'live_broker_lease' }],
      },
      outcomes: before.outcomes,
      runtimePresent: true,
      ledger: before.ledger,
      leaseAlive: true,
    })
  })

  test('probe errors fail closed in bulk and ledger-inclusive preflight', async () => {
    const lease = await createLiveLease('probe-error')
    const seeded = await seedBrokerRuntime('probe-error', {
      status: 'stale',
      bound: false,
      lease,
      scopeRef: ALLOWLISTED_SCOPE,
    })
    ;(server as unknown as { brokerTmuxManagerFactory: unknown }).brokerTmuxManagerFactory =
      () => ({
        inspectPaneLiveness: async () => {
          throw new Error('probe exploded')
        },
      })

    const bulkResponse = await fixture.postJson('/v1/runtimes/prune', {
      status: ['stale'],
      olderThan: '0s',
      dryRun: true,
    })
    const bulkBody = await json(bulkResponse)
    const ledgerResponse = await fixture.postJson('/v1/runtimes/prune', {
      runtimeIds: [seeded.runtimeId],
      includeLedgers: true,
      dryRun: true,
      yes: true,
    })
    const ledgerBody = await json(ledgerResponse)

    expect({
      bulkStatus: bulkResponse.status,
      bulkBody,
      ledgerStatus: ledgerResponse.status,
      ledgerBody,
      runtimePresent: runtime(seeded.runtimeId) !== null,
      leaseAlive: leaseAlive(lease),
    }).toMatchObject({
      bulkStatus: 200,
      bulkBody: {
        results: [
          {
            runtimeId: seeded.runtimeId,
            status: 'error',
            errorMessage: 'probe exploded',
          },
        ],
      },
      ledgerStatus: 409,
      ledgerBody: {
        error: {
          detail: {
            failures: [
              {
                runtimeId: seeded.runtimeId,
                reasons: expect.arrayContaining(['safety_gate_error:probe exploded']),
              },
            ],
          },
        },
      },
      runtimePresent: true,
      leaseAlive: true,
    })
  })
})

describe('T-08566 prune safety positive controls', () => {
  test('legacy daemon-socket tmux sessions still report live_tmux', async () => {
    const sessionName = 'hrc-h1b-legacy-live'
    const created = tmux(fixture.tmuxSocketPath, [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-n',
      'main',
      'sleep 600',
    ])
    expect(created.status).toBe(0)
    const runtimeId = 'rt-h1b-legacy-live'
    const hostSessionId = 'hsid-h1b-legacy-live'
    const scopeRef = 'agent:clod:project:hrc-runtime:task:h1blegacylive'
    fixture.seedSession(hostSessionId, scopeRef)
    fixture.seedTmuxRuntime(hostSessionId, scopeRef, runtimeId, { status: 'stale' })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.update(runtimeId, {
        tmuxJson: { socketPath: fixture.tmuxSocketPath, sessionName, windowName: 'main' },
        lastActivityAt: OLD,
        updatedAt: OLD,
      } as never)
    } finally {
      db.close()
    }

    const response = await fixture.postJson('/v1/runtimes/prune', {
      status: ['stale'],
      olderThan: '0s',
      dryRun: true,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      results: [{ runtimeId, status: 'skipped', reason: 'live_tmux' }],
    })
    expect(runtime(runtimeId)).not.toBeNull()
  })

  test('a dead private lease is prunable and safe held termination disposes atomically', async () => {
    const lease = await createLiveLease('dead-safe')
    const stale = await seedBrokerRuntime('dead-stale', {
      status: 'stale',
      bound: false,
      lease,
    })
    const terminated = await seedBrokerRuntime('dead-terminated', {
      status: 'terminated',
      bound: true,
      lease,
    })
    killLease(lease)

    const bulk = await fixture.postJson('/v1/runtimes/prune', {
      status: ['stale'],
      olderThan: '0s',
      dryRun: true,
    })
    expect(bulk.status).toBe(200)
    expect(await bulk.json()).toMatchObject({
      results: [{ runtimeId: stale.runtimeId, status: 'pruned', reason: 'dry_run' }],
    })

    const dispose = await fixture.postJson('/v1/runtimes/prune', {
      runtimeIds: [terminated.runtimeId],
      disposeRetainedEvidence: true,
      reason: 'confirmed dead lease',
      yes: true,
    })
    expect(dispose.status).toBe(200)
    expect(await dispose.json()).toMatchObject({
      results: [{ runtimeId: terminated.runtimeId, status: 'pruned', reason: 'operator_disposed' }],
    })
    expect(runtime(terminated.runtimeId)).toBeNull()
    const audit = new Database(fixture.dbPath, { readonly: true })
    try {
      expect(
        audit
          .query<{ outcome: string }, [string]>(
            'SELECT outcome FROM retained_evidence_outcomes WHERE runtime_id = ?'
          )
          .all(terminated.runtimeId)
      ).toEqual([{ outcome: 'operator_disposed' }])
    } finally {
      audit.close()
    }
  })

  test('unheld disposition returns 409 and leaves the runtime and ledger untouched', async () => {
    const lease = await createLiveLease('unheld')
    const seeded = await seedBrokerRuntime('unheld', {
      status: 'stale',
      bound: false,
      lease,
    })
    const before = await ledgerSnapshot(seeded)
    const response = await fixture.postJson('/v1/runtimes/prune', {
      runtimeIds: [seeded.runtimeId],
      disposeRetainedEvidence: true,
      reason: 'must not apply',
      yes: true,
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'retained_evidence_not_held' },
    })
    expect(runtime(seeded.runtimeId)).not.toBeNull()
    expect(await ledgerSnapshot(seeded)).toEqual(before)
    expect(rowCount('retained_evidence_outcomes', seeded.runtimeId)).toBe(0)
    expect(leaseAlive(lease)).toBe(true)
  })

  test('active-run, status, and external-owner guards remain unchanged', async () => {
    const lease = await createLiveLease('guard-controls')
    const active = await seedBrokerRuntime('guard-active', {
      status: 'stale',
      bound: false,
      lease,
      activeRunId: 'run-h1b-active',
    })
    const ready = await seedBrokerRuntime('guard-ready', {
      status: 'ready',
      bound: false,
      lease,
    })
    const external = await seedBrokerRuntime('guard-external', {
      status: 'stale',
      bound: false,
      lease,
      external: true,
    })
    const response = await fixture.postJson('/v1/runtimes/prune', {
      status: ['stale', 'ready'],
      olderThan: '0s',
      dryRun: true,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      results: Array<{ runtimeId: string; status: string; reason?: string }>
    }
    const byRuntime = new Map(body.results.map((result) => [result.runtimeId, result]))
    expect(byRuntime.get(active.runtimeId)).toMatchObject({
      status: 'skipped',
      reason: 'active_run',
    })
    expect(byRuntime.get(ready.runtimeId)).toMatchObject({
      status: 'skipped',
      reason: 'status_not_prunable:ready',
    })
    expect(byRuntime.get(external.runtimeId)).toMatchObject({
      status: 'skipped',
      reason: 'external_lifecycle_owner',
    })
  })
})
