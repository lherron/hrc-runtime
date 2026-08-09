import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { access, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'
import type { ExternalRegistrationGrant, HrcDatabase } from 'hrc-store-sqlite'

import { HarnessBrokerController } from '../broker/controller.js'
import { performExternalRegistrationHello } from '../external-registration-rendezvous.js'
import type { ExternalParticipantRpcClient } from '../external-registration-rendezvous.js'
import { hashRegistrationCredential } from '../registration-handlers.js'
import {
  terminateGhosttyRuntime,
  terminateHeadlessRuntime,
  terminateRuntime,
  terminateTmuxRuntime,
} from '../runtime-control-handlers/interrupt-terminate.js'
import type { ServerContext } from '../server-context.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import type { HrcServerOptions } from '../server-types.js'
import { reconcileStartupState } from '../startup-reconcile.js'
import {
  appendSweepCompletedEvent,
  handleSweepRuntimes,
  resolveSweepSummarySession,
  runTmuxAgingOnce,
  transitionRuntimeForAging,
} from '../sweep-handlers.js'
import { evaluatePruneDisposition } from '../sweep-helpers.js'
import {
  cleanupIdleClaudeGhosttyRuntimes,
  reconcileActiveRunsOnce,
  sweepZombieRunsOnce,
} from '../sweep-reconcile.js'

const REGISTRATION_ID = 'registration-t07137'
const CREDENTIAL = 'credential-t07137'
const SCOPE = 'agent:arris:project:arris:task:reg-t07137'
const OLD = '2020-01-01T00:00:00.000Z'

class HelloClient implements ExternalParticipantRpcClient {
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'epr.hello') {
      return {
        protocolVersion: 'epr/1',
        registrationId: params['registrationId'],
        credential: CREDENTIAL,
        capabilities: { events: true, turns: false, continuations: true },
        participantInfo: { name: 'arris' },
      }
    }
    if (method === 'epr.established') return { ready: true, currentSeq: -1 }
    throw new Error(`unexpected ${method}`)
  }

  async notify(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('T-07137 lifecycleOwner fencing', () => {
  let root: string
  let db: HrcDatabase
  let server: HrcServerInstanceForHandlers
  let controller: HarnessBrokerController
  let runtimeId: string

  beforeEach(async () => {
    root = join(tmpdir(), `hrc-epr-t07137-${crypto.randomUUID()}`)
    await mkdir(root, { recursive: true })
    db = openHrcDatabase(join(root, 'state.sqlite'))
    controller = new HarnessBrokerController({ db })
    server = {
      db,
      options: { runtimeRoot: join(root, 'run') } as HrcServerOptions,
      harnessBrokerController: controller,
      generateBrokerAttachToken: () => 'attach-token-t07137',
      externalParticipantClients: new Map(),
      externalRegistrationOperations: new Map(),
      stopping: false,
      ctx: { notifyEvent: () => undefined },
    } as unknown as HrcServerInstanceForHandlers
    const grant: ExternalRegistrationGrant = {
      registrationId: REGISTRATION_ID,
      classId: 'arris-agent',
      derivedScope: SCOPE,
      socketPath: join(root, 'participant.sock'),
      credentialHash: hashRegistrationCredential(CREDENTIAL),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumed: false,
      turnsAllowed: false,
      provisioner: {},
      createdAt: new Date().toISOString(),
    }
    expect(
      db.externalRegistrationGrants.issueWithinCapacity(grant, 1, grant.createdAt).outcome
    ).toBe('issued')
    runtimeId = (await performExternalRegistrationHello(server, REGISTRATION_ID, new HelloClient()))
      .delivery.runtimeId
  })

  afterEach(async () => {
    controller.shutdown()
    db.close()
    await rm(root, { recursive: true, force: true })
  })

  async function proveOperatorEviction(
    invoke: (runtime: HrcRuntimeSnapshot) => Promise<Response>,
    transport: HrcRuntimeSnapshot['transport']
  ): Promise<void> {
    const runtime = db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime) throw new Error('external runtime missing')
    const grant = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)
    if (!grant?.attachTokenRef) throw new Error('external attach token missing')
    expect(await Bun.file(grant.attachTokenRef).exists()).toBe(true)

    const ledger = createPlacementLedgerRepository(db.sqlite)
    const binding = ledger.installActive({
      scopeRef: SCOPE,
      homeNodeId: 'svc',
      placementEpoch: 1,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'explicit_local' },
      establishmentProvenance: 'explicit_local',
      updatedAt: OLD,
    })
    db.sessions.updateContinuation(
      runtime.hostSessionId,
      { provider: 'anthropic', key: 'opaque-external-continuation' },
      OLD
    )

    let closes = 0
    server.externalParticipantClients.set(REGISTRATION_ID, {
      request: async () => {
        throw new Error('operator eviction must not issue a participant lifecycle RPC')
      },
      notify: async () => {
        throw new Error('operator eviction must not issue a participant lifecycle notification')
      },
      close: async () => {
        closes += 1
      },
    })

    const response = await invoke({
      ...runtime,
      // Deliberately lie in every display/transport projection. The immutable
      // lifecycleOwner field must win before a transport-specific requirement,
      // broker disposal, or substrate teardown is reached.
      transport,
      harness: 'claude-code',
      provider: 'anthropic',
      runtimeStateJson: {
        ...(runtime.runtimeStateJson ?? {}),
        broker: {
          protocolVersion: 'harness-broker/0.2',
          endpoint: { kind: 'stdio-jsonrpc-ndjson' },
          substrate: { kind: 'leased-tmux' },
          presentation: { kind: 'tmux-tui' },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(db.runtimes.getByRuntimeId(runtimeId)).toMatchObject({
      status: 'terminated',
      lifecycleTerminalReason: 'operator_evict',
      runtimeStateJson: {
        lifecycleOwner: 'external',
        terminalReason: 'operator_evict',
        control: { mode: 'epr', brokerAttached: false },
        externalRegistration: {
          finalReason: 'operator_evict',
          attachTokenRevokedAt: expect.any(String),
        },
      },
    })
    expect(db.brokerInvocations.getByInvocationId(grant.invocationId!)).toMatchObject({
      invocationState: 'disposed',
      lifecycleTerminalReason: 'operator_evict',
    })
    expect(closes).toBe(1)
    expect(server.externalParticipantClients.has(REGISTRATION_ID)).toBe(false)
    await expect(access(grant.attachTokenRef)).rejects.toThrow()
    expect(ledger.get(SCOPE)).toEqual(binding)
    expect(db.sessions.getByHostSessionId(runtime.hostSessionId)?.continuation).toEqual({
      provider: 'anthropic',
      key: 'opaque-external-continuation',
    })
    expect(
      db.hrcEvents
        .listFromHrcSeq(1, { runtimeId })
        .filter((event) => event.eventKind === 'runtime.terminated')
    ).toHaveLength(1)
  }

  test('generic terminate evicts externally-owned rows before transport dispatch', async () => {
    await proveOperatorEviction(
      (runtime) => terminateRuntime.call(server, runtime, { dropContinuation: true }),
      'tmux'
    )
  })

  test('direct tmux terminate cannot require or tear down tmux for an external owner', async () => {
    await proveOperatorEviction((runtime) => terminateTmuxRuntime.call(server, runtime), 'tmux')
  })

  test('direct Ghostty terminate cannot require or tear down a surface for an external owner', async () => {
    await proveOperatorEviction(
      (runtime) => terminateGhosttyRuntime.call(server, runtime),
      'ghostty'
    )
  })

  test('direct headless terminate cannot dispose a broker or drop continuation for an external owner', async () => {
    await proveOperatorEviction(
      (runtime) =>
        terminateHeadlessRuntime.call(server, runtime, {
          dropContinuation: true,
          reason: 'generic-terminate-reason-must-not-win',
        }),
      'headless'
    )
  })

  test('manual runtime sweep and recurring tmux aging report an external-owner skip', async () => {
    db.sqlite
      .query(
        `UPDATE runtimes
            SET transport = 'tmux', status = 'ready', last_activity_at = ?, updated_at = ?
          WHERE runtime_id = ?`
      )
      .run(OLD, OLD, runtimeId)
    const sweepServer = {
      ...server,
      staleGenerationThresholdSec: 1,
      brokerTmuxManagerFactory: () => {
        throw new Error('external runtime aging must not probe tmux')
      },
      transitionRuntimeForAging,
      appendSweepCompletedEvent,
      resolveSweepSummarySession,
      notifyEvent: () => undefined,
    } as unknown as HrcServerInstanceForHandlers

    const response = await handleSweepRuntimes.call(
      sweepServer,
      new Request('http://localhost/v1/runtimes/sweep', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ olderThan: '1s' }),
      })
    )
    const manual = (await response.json()) as {
      results: Array<{ status: string; reason?: string }>
      summary: { stale: number; skipped: number }
    }
    expect(manual.results).toEqual([
      expect.objectContaining({ status: 'skipped', reason: 'external_lifecycle_owner' }),
    ])
    expect(manual.summary).toMatchObject({ stale: 0, skipped: 1 })

    const recurring = await runTmuxAgingOnce.call(sweepServer)
    expect(recurring.results).toEqual([
      expect.objectContaining({ status: 'skipped', reason: 'external_lifecycle_owner' }),
    ])
    expect(db.runtimes.getByRuntimeId(runtimeId)?.status).toBe('ready')
  })

  test('zombie and active-run reapers cannot claim a run owned by an external runtime', async () => {
    const runtime = db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime) throw new Error('external runtime missing')
    const runId = 'run-t07137-forged'
    db.runs.insert({
      runId,
      hostSessionId: runtime.hostSessionId,
      runtimeId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
      transport: 'headless',
      status: 'running',
      acceptedAt: OLD,
      startedAt: OLD,
      updatedAt: OLD,
    })
    db.runtimes.update(runtimeId, {
      activeRunId: runId,
      status: 'busy',
      lastActivityAt: OLD,
      updatedAt: OLD,
    })
    const ctx = {
      db,
      notifyEvent: () => undefined,
      tmux: {},
      ghostmux: {},
    } as unknown as ServerContext

    const zombie = await sweepZombieRunsOnce(ctx, {
      olderThanMs: 1,
      dryRun: false,
      thresholdSeconds: 1,
    })
    const active = await reconcileActiveRunsOnce(ctx, {
      olderThanMs: 1,
      dryRun: false,
      thresholdSeconds: 1,
    })

    expect(zombie.summary).toMatchObject({ matched: 0, zombied: 0 })
    expect(active.summary).toMatchObject({ matched: 0, reaped: 0, repaired: 0 })
    expect(db.runs.getByRunId(runId)?.status).toBe('running')
    expect(db.runtimes.getByRuntimeId(runtimeId)).toMatchObject({
      status: 'busy',
      activeRunId: runId,
    })
  })

  test('Ghostty idle cleanup keys on lifecycleOwner before legacy display fields', async () => {
    db.sqlite
      .query(
        `UPDATE runtimes
            SET transport = 'ghostty', harness = 'claude-code', status = 'ready',
                last_activity_at = ?, updated_at = ?
          WHERE runtime_id = ?`
      )
      .run(OLD, OLD, runtimeId)
    let substrateCalls = 0
    const ctx = {
      db,
      notifyEvent: () => undefined,
      tmux: {},
      ghostmux: {
        sendKeys: async () => {
          substrateCalls += 1
        },
        terminate: async () => {
          substrateCalls += 1
        },
      },
    } as unknown as ServerContext

    await cleanupIdleClaudeGhosttyRuntimes(ctx)

    expect(substrateCalls).toBe(0)
    expect(db.runtimes.getByRuntimeId(runtimeId)?.status).toBe('ready')
  })

  test('startup classification leaves external rows for EPR replay even with misleading projections', async () => {
    db.sqlite
      .query(
        `UPDATE runtimes
            SET transport = 'ghostty', harness = 'claude-code', provider = 'anthropic'
          WHERE runtime_id = ?`
      )
      .run(runtimeId)
    let substrateCalls = 0

    await reconcileStartupState(
      db,
      {
        inspectSession: async () => {
          substrateCalls += 1
          return null
        },
      } as never,
      {
        inspectSurface: async () => {
          substrateCalls += 1
          return null
        },
      } as never,
      { reconcileGhostty: true, runtimeRoot: join(root, 'run') }
    )

    expect(substrateCalls).toBe(0)
    expect(db.runtimes.getByRuntimeId(runtimeId)?.status).toBe('ready')
  })

  test('broker dispose refuses an external owner before touching an active client', async () => {
    let lifecycleRpcCalls = 0
    const active = (
      controller as unknown as {
        active: Map<string, unknown>
      }
    ).active
    active.set(runtimeId, {
      invocationId: db.runtimes.getByRuntimeId(runtimeId)?.activeInvocationId,
      client: {
        stop: async () => {
          lifecycleRpcCalls += 1
        },
        dispose: async () => {
          lifecycleRpcCalls += 1
        },
        close: async () => {
          lifecycleRpcCalls += 1
        },
      },
    })

    const result = await controller.dispose(runtimeId, { reason: 'operator_evict' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('external broker dispose unexpectedly succeeded')
    expect(result.error.code).toBe('broker_runtime_not_active')
    expect(result.error.message).toContain('external lifecycle ownership')
    expect(lifecycleRpcCalls).toBe(0)
    expect(db.runtimes.getByRuntimeId(runtimeId)?.status).toBe('ready')
  })

  test('runtime prune preserves external lifecycle records for explicit registration GC', async () => {
    db.runtimes.update(runtimeId, { status: 'terminated', updatedAt: OLD })
    const runtime = db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime) throw new Error('external runtime missing')

    const disposition = await evaluatePruneDisposition(runtime, {} as never)

    expect(disposition).toEqual({ prunable: false, reason: 'external_lifecycle_owner' })
    expect(db.runtimes.getByRuntimeId(runtimeId)).not.toBeNull()
  })
})
