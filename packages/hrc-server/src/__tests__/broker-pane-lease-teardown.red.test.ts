/**
 * RED test (T-01732 / T-01730) — broker-tmux pane-lease TEARDOWN contract.
 *
 * Governing plan: C-02889 on T-01730. A broker-tmux runtime owns a tmux
 * server/session/window/pane that HRC allocated on a PER-RUNTIME LEASE SOCKET
 * (`runtime.tmuxJson.socketPath`), NOT the shared default HRC tmux server
 * (`this.tmux`, the server-wide `tmuxSocketPath`). When the runtime is torn
 * down, HRC must clean up the lease the same way the pre-HRC reference harness
 * does: drive a TmuxManager bound to the LEASE socket, kill the leased session
 * AND its server (removing the socket), and leave the default `this.tmux`
 * server completely untouched.
 *
 * At HEAD `terminateTmuxRuntime` uses `this.tmux` (the DEFAULT socket) to
 * inspect/terminate the broker runtime's session. That:
 *   (a) never touches the lease socket, so the leased session/server/socket
 *       survive forever (leak), and
 *   (b) DOES touch the default server — if a same-named session exists there it
 *       gets killed.
 *
 * Both are wrong for a lease-owned pane, so this test FAILS at HEAD and turns
 * green only once teardown routes through a lease-socket TmuxManager and leaves
 * the default server alone.
 *
 * This exercises the real server over the unix socket with a real tmux binary;
 * it creates two independent tmux servers (lease socket + default socket) so it
 * can prove WHICH socket teardown acted on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer, createTmuxManager } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer
const leaseSockets: string[] = []

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-pane-lease-teardown-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  // Reap any lease-socket tmux servers this test spun up.
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

type SeededLease = {
  runtimeId: string
  sessionName: string
  leaseSocket: string
}

/**
 * Allocate a REAL leased tmux pane on a dedicated lease socket, plant a
 * same-named decoy session on the DEFAULT server, and persist a broker-tmux
 * runtime that points its lease at the lease socket.
 */
async function seedBrokerTmuxLease(driver: 'claude-code-tmux' | 'codex-cli-tmux'): Promise<SeededLease> {
  const suffix = driver.replace(/-/g, '_')
  const runtimeId = `runtime_${suffix}`
  const hostSessionId = `hsid_${suffix}`
  const scopeRef = `agent:smokey:project:hrc-runtime:task:T-01732:${suffix}`
  const sessionName = `hrc-${driver}-${runtimeId}`
  const leaseSocket = join(fixture.runtimeRoot, `lease-${suffix}.sock`)
  leaseSockets.push(leaseSocket)

  // The leased pane lives on its OWN tmux server (lease socket).
  await createSession(leaseSocket, sessionName)
  const leaseMgr = createTmuxManager({ socketPath: leaseSocket })
  const pane = await leaseMgr.inspectSession(sessionName)
  if (!pane) throw new Error('failed to allocate leased tmux pane fixture')

  // Decoy: a same-named session on the DEFAULT server. Correct teardown must
  // NEVER touch this; HEAD (which uses this.tmux) will kill it.
  await createSession(fixture.tmuxSocketPath, sessionName)

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
      tmuxJson: {
        socketPath: leaseSocket,
        sessionName,
        windowName: 'main',
        sessionId: pane.sessionId,
        windowId: pane.windowId,
        paneId: pane.paneId,
        brokerDriver: driver,
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
  } finally {
    db.close()
  }

  return { runtimeId, sessionName, leaseSocket }
}

describe('RED #5: broker-tmux teardown uses the lease-socket TmuxManager', () => {
  for (const driver of ['claude-code-tmux', 'codex-cli-tmux'] as const) {
    it(`kills the leased session/server/socket and leaves the default server untouched for ${driver}`, async () => {
      const { runtimeId, sessionName, leaseSocket } = await seedBrokerTmuxLease(driver)

      const leaseMgr = createTmuxManager({ socketPath: leaseSocket })
      const defaultMgr = createTmuxManager({ socketPath: fixture.tmuxSocketPath })

      // Pre-conditions: both the leased session and the default decoy are live.
      expect(await leaseMgr.inspectSession(sessionName)).not.toBeNull()
      expect(await defaultMgr.inspectSession(sessionName)).not.toBeNull()

      const res = await fixture.postJson('/v1/terminate', { runtimeId })
      expect(res.status).toBe(200)

      // Full teardown contract:
      //  (1) the leased session is killed on the LEASE socket,
      expect(await leaseMgr.inspectSession(sessionName)).toBeNull()
      //  (2) the leased tmux server is gone (socket removed),
      expect(existsSync(leaseSocket)).toBe(false)
      //  (3) the DEFAULT this.tmux server is untouched (decoy survives).
      expect(await defaultMgr.inspectSession(sessionName)).not.toBeNull()
    })
  }
})
