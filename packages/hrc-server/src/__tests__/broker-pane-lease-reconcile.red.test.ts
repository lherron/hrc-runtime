/**
 * RED test (T-01732 / T-01730) — broker-tmux pane-lease RESTART RECONCILE.
 *
 * Governing plan: C-02889 on T-01730. "Restart = re-scan + re-associate, NOT
 * tmux attach-session." On daemon startup HRC must load each persisted
 * broker-tmux lease (session name deterministic from runtimeId; full lease ids
 * in `tmuxJson` / `runtimeStateJson.tmux`), inspect the LEASE socket for the
 * pane, and:
 *   - RE-ASSOCIATE the runtime when the pane is still alive AND its ids match
 *     the persisted lease (the tmux server outlives the daemon), leaving the
 *     runtime usable and its broker invocation intact; or
 *   - GC the runtime (mark unavailable) AND dispose its orphaned invocation
 *     when the pane is gone or its ids no longer match the persisted lease.
 *
 * At HEAD `reconcileStartupState` does NOT do any of this for broker-tmux
 * runtimes. It (a) runs them through the generic tmux block, which inspects the
 * DEFAULT server socket (never the lease socket) and marks them dead because
 * the leased session lives on a different server; and (b) unconditionally marks
 * EVERY harness-broker runtime stale via `broker_orphaned_on_restart`. There is
 * no comparison of the persisted sessionId/windowId/paneId to an observed pane
 * and no re-association path. So a runtime whose leased pane is still alive is
 * wrongly torn down, and a runtime whose pane is gone/mismatched is NOT cleaned
 * up via the lease socket (its invocation is left behind unless the blanket
 * orphan sweep happens to fire first).
 *
 * These tests FAIL at HEAD and turn green only once startup reconcile does
 * id-match re-association against the LEASE socket. They drive the real server
 * startup (`createHrcServer` runs reconcile) with a real tmux binary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer, createTmuxManager } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
const servers: HrcServer[] = []
const leaseSockets: string[] = []

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-pane-lease-reconcile-')
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop()
  }
  for (const socketPath of leaseSockets.splice(0)) {
    try {
      const { exited } = Bun.spawn(['tmux', '-S', socketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine when no server exists
    }
  }
  await fixture.cleanup()
})

/** Create a real, detached tmux session (window `main`) on the given socket. */
async function createSession(socketPath: string, sessionName: string): Promise<void> {
  const { exited } = Bun.spawn(
    ['tmux', '-S', socketPath, 'new-session', '-d', '-s', sessionName, '-n', 'main'],
    { stdout: 'ignore', stderr: 'ignore' }
  )
  expect(await exited).toBe(0)
}

type SeedOptions = {
  driver: 'claude-code-tmux' | 'codex-cli-tmux'
  /** Override the persisted paneId to simulate an id mismatch (stale pane). */
  paneIdOverride?: string | undefined
}

type Seeded = {
  runtimeId: string
  invocationId: string
}

/**
 * Allocate a REAL leased tmux pane on a dedicated lease socket and persist a
 * broker-tmux runtime + ready invocation whose lease points at it. With
 * `paneIdOverride`, the persisted lease intentionally disagrees with the live
 * pane (stale lease).
 */
async function seedBrokerLease(options: SeedOptions): Promise<Seeded> {
  const { driver } = options
  const suffix = driver.replace(/-/g, '_')
  const runtimeId = `runtime_${suffix}`
  const hostSessionId = `hsid_${suffix}`
  const operationId = `op_${suffix}`
  const invocationId = `invocation_${suffix}`
  const scopeRef = `agent:smokey:project:hrc-runtime:task:T-01732:${suffix}`
  const sessionName = `hrc-${driver}-${runtimeId}`
  const leaseSocket = join(fixture.runtimeRoot, `lease-${suffix}.sock`)
  leaseSockets.push(leaseSocket)

  await createSession(leaseSocket, sessionName)
  const leaseMgr = createTmuxManager({ socketPath: leaseSocket })
  const pane = await leaseMgr.inspectSession(sessionName)
  if (!pane) throw new Error('failed to allocate leased tmux pane fixture')

  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: driver === 'claude-code-tmux' ? 'claude-code' : 'codex-cli',
      provider: driver === 'claude-code-tmux' ? 'anthropic' : 'openai',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: operationId,
      activeInvocationId: invocationId,
      tmuxJson: {
        socketPath: leaseSocket,
        sessionName,
        windowName: 'main',
        sessionId: pane.sessionId,
        windowId: pane.windowId,
        paneId: options.paneIdOverride ?? pane.paneId,
        brokerDriver: driver,
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    db.brokerInvocations.insert({
      invocationId,
      operationId,
      runtimeId,
      brokerProtocol: 'harness-broker/0.1',
      brokerDriver: driver,
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({}),
      specHash: `sha256:spec-${suffix}`,
      startRequestHash: `sha256:req-${suffix}`,
      selectedProfileHash: `sha256:prof-${suffix}`,
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }

  return { runtimeId, invocationId }
}

function readRuntimeStatus(runtimeId: string): string | undefined {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runtimes.getByRuntimeId(runtimeId)?.status
  } finally {
    db.close()
  }
}

function readInvocationState(invocationId: string): string | undefined {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.brokerInvocations.getByInvocationId(invocationId)?.invocationState
  } finally {
    db.close()
  }
}

const UNAVAILABLE = ['dead', 'stale', 'terminated']

describe('RED #4: broker-tmux restart reconcile (id-match re-associate vs GC)', () => {
  for (const driver of ['claude-code-tmux', 'codex-cli-tmux'] as const) {
    it(`re-associates a live, id-matched lease for ${driver} (no teardown)`, async () => {
      const { runtimeId, invocationId } = await seedBrokerLease({ driver })

      // Daemon "restart": startup reconcile runs inside createHrcServer.
      const server = await createHrcServer(fixture.serverOpts())
      servers.push(server)

      // The leased pane is still alive with matching ids → re-associate, leave
      // the runtime usable and the invocation intact.
      expect(UNAVAILABLE).not.toContain(readRuntimeStatus(runtimeId))
      expect(readInvocationState(invocationId)).not.toBe('disposed')
    })

    it(`GCs a stale (id-mismatch) lease for ${driver} and disposes its invocation`, async () => {
      // Persisted paneId disagrees with the live pane → the lease is stale.
      const { runtimeId, invocationId } = await seedBrokerLease({
        driver,
        paneIdOverride: '%99999',
      })

      const server = await createHrcServer(fixture.serverOpts())
      servers.push(server)

      // Stale lease → runtime is marked unavailable AND its orphaned broker
      // invocation is disposed (so the next turn starts fresh).
      expect(UNAVAILABLE).toContain(readRuntimeStatus(runtimeId))
      expect(readInvocationState(invocationId)).toBe('disposed')
    })
  }
})
