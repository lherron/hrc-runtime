/**
 * RED test (T-01733 / T-01730 GAP 1) — broker-tmux ORPHAN-SESSION SWEEP.
 *
 * Governing plan: C-02889 on T-01730. A crash BETWEEN tmux allocate and the
 * runtime-persist write leaks a tmux server on a per-runtime lease socket under
 * `<runtimeRoot>/btmux/` whose `hrc-<driver>-<runtimeId>` session no DB runtime
 * references. The re-associate pass only walks persisted runtimes, so it can
 * never reclaim such a leak. After the re-associate pass, startup reconcile must
 * sweep lease-socket sessions matching the `hrc-` naming convention that are NOT
 * claimed by a non-terminal runtime and kill their server — but only once they
 * are older than a grace threshold, so a session that is still being allocated /
 * draining by a live (other) daemon is not torn down.
 *
 * At HEAD `reconcileStartupState` performs NO such sweep, so the orphaned lease
 * server survives a restart (this fails). It turns green once the sweep runs.
 *
 * The grace threshold is overridable via HRC_BROKER_ORPHAN_SWEEP_GRACE_MS so the
 * "swept" case can force a fresh session past grace, and the "protected" case can
 * hold a fresh session inside grace — both deterministic with a real tmux binary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer, createTmuxManager } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const GRACE_ENV = 'HRC_BROKER_ORPHAN_SWEEP_GRACE_MS'

let fixture: HrcServerTestFixture
const servers: HrcServer[] = []
const leaseSockets: string[] = []
let priorGrace: string | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-pane-lease-orphan-sweep-')
  priorGrace = process.env[GRACE_ENV]
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
  if (priorGrace === undefined) {
    delete process.env[GRACE_ENV]
  } else {
    process.env[GRACE_ENV] = priorGrace
  }
  await fixture.cleanup()
})

/** The directory startup reconcile scans for orphaned broker-tmux lease sockets. */
function btmuxDir(): string {
  return join(fixture.runtimeRoot, 'btmux')
}

/** Create a real detached lease session on a btmux socket matching the convention. */
async function createLeaseSession(
  driver: string,
  runtimeId: string
): Promise<{ socketPath: string; sessionName: string }> {
  await mkdir(btmuxDir(), { recursive: true })
  const socketPath = join(btmuxDir(), `${driver}-${runtimeId}.sock`)
  const sessionName = `hrc-${driver}-${runtimeId}`
  leaseSockets.push(socketPath)
  const { exited } = Bun.spawn(
    ['tmux', '-S', socketPath, 'new-session', '-d', '-s', sessionName, '-n', 'main'],
    { stdout: 'ignore', stderr: 'ignore' }
  )
  expect(await exited).toBe(0)
  return { socketPath, sessionName }
}

async function sessionAlive(socketPath: string, sessionName: string): Promise<boolean> {
  const mgr = createTmuxManager({ socketPath })
  return (await mgr.inspectSession(sessionName)) !== null
}

/** Seed a non-terminal harness-broker tmux runtime that claims the given lease. */
function seedClaimingRuntime(driver: string, runtimeId: string, socketPath: string): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  const hostSessionId = `hs_${runtimeId}`
  const scopeRef = `agent:smokey:project:hrc-runtime:task:T-01733:${runtimeId}`
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
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      tmuxJson: {
        socketPath,
        sessionName: `hrc-${driver}-${runtimeId}`,
        windowName: 'main',
        brokerDriver: driver,
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
  } finally {
    db.close()
  }
}

describe('RED (GAP 1): broker-tmux orphan-session sweep on restart', () => {
  it('kills an unclaimed lease session/server older than the grace threshold', async () => {
    const driver = 'cc'
    const runtimeId = 'orphA'
    const { socketPath, sessionName } = await createLeaseSession(driver, runtimeId)
    expect(await sessionAlive(socketPath, sessionName)).toBe(true)

    // Force the freshly-created session past grace so it is swept.
    process.env[GRACE_ENV] = '0'

    const server = await createHrcServer(fixture.serverOpts())
    servers.push(server)

    expect(await sessionAlive(socketPath, sessionName)).toBe(false)
  })

  it('does NOT sweep a fresh, within-grace lease session', async () => {
    const driver = 'cx'
    const runtimeId = 'orphB'
    const { socketPath, sessionName } = await createLeaseSession(driver, runtimeId)
    expect(await sessionAlive(socketPath, sessionName)).toBe(true)

    // Large grace window protects a just-created (still-draining) session.
    process.env[GRACE_ENV] = '600000'

    const server = await createHrcServer(fixture.serverOpts())
    servers.push(server)

    expect(await sessionAlive(socketPath, sessionName)).toBe(true)
  })

  it('does NOT sweep a session claimed by a non-terminal runtime even past grace', async () => {
    const driver = 'cc'
    const runtimeId = 'claimC'
    const { socketPath, sessionName } = await createLeaseSession(driver, runtimeId)
    seedClaimingRuntime(driver, runtimeId, socketPath)

    process.env[GRACE_ENV] = '0'

    const server = await createHrcServer(fixture.serverOpts())
    servers.push(server)

    expect(await sessionAlive(socketPath, sessionName)).toBe(true)
  })
})
