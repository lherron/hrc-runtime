/**
 * T-01738 operator-surface remainder (F-V1 + F-V5) for broker-tmux pane leases.
 *
 * F-V1: `hrc runtime inspect <rt> --json` must surface the per-runtime lease
 *   allocation (socketPath / sessionName / paneId) for a broker-tmux runtime,
 *   instead of dropping it (the response previously omitted tmux entirely).
 * F-V5: `hrc runtime adopt <rt>` on a broker-tmux runtime whose lease server is
 *   DEAD must be rejected (CONFLICT) rather than returning ok/adopted and later
 *   dispatching a turn at a pane that no longer exists. A live lease still adopts.
 *
 * Uses real tmux lease servers on per-runtime sockets under `<runtimeRoot>/btmux/`,
 * mirroring broker-pane-lease-orphan-sweep.red.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir } from 'node:fs/promises'
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
  fixture = await createHrcTestFixture('hbos-')
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

/**
 * Seed a broker-tmux (harness-broker / tmux) runtime claiming the given lease.
 * `status` lets callers seed an adoptable ('dead'/'stale') or live runtime.
 */
function seedBrokerTmuxRuntime(args: {
  driver: string
  runtimeId: string
  socketPath: string
  status: string
  paneId?: string
}): { hostSessionId: string } {
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  const hostSessionId = `hs_${args.runtimeId}`
  const scopeRef = `agent:smokey:project:hrc-runtime:task:T-01738:${args.runtimeId}`
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
      runtimeId: args.runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: args.status,
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      tmuxJson: {
        socketPath: args.socketPath,
        sessionName: `hrc-${args.driver}-${args.runtimeId}`,
        windowName: 'main',
        brokerDriver: args.driver,
        ...(args.paneId ? { paneId: args.paneId } : {}),
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
  } finally {
    db.close()
  }
  return { hostSessionId }
}

describe('T-01738 F-V1: runtime inspect surfaces broker-tmux lease allocation', () => {
  it('returns tmux socketPath/sessionName for a live broker-tmux runtime', async () => {
    const driver = 'cc'
    const runtimeId = 'inspA'
    const { socketPath, sessionName } = await createLeaseSession(driver, runtimeId)
    seedBrokerTmuxRuntime({ driver, runtimeId, socketPath, status: 'ready' })

    const server = await createHrcServer(fixture.serverOpts())
    servers.push(server)

    const response = await fixture.postJson('/v1/runtimes/inspect', { runtimeId })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      transport: string
      tmux?: { socketPath?: string; sessionName?: string }
    }
    expect(body.transport).toBe('tmux')
    expect(body.tmux).toBeDefined()
    expect(body.tmux?.socketPath).toBe(socketPath)
    expect(body.tmux?.sessionName).toBe(sessionName)
  })

  it('omits tmux for a non-tmux (headless) runtime', async () => {
    const server = await createHrcServer(fixture.serverOpts())
    servers.push(server)

    const { runtimeId } = await fixture.ensureRuntime(
      'agent:smokey:project:hrc-runtime:task:T-01738'
    )
    // ensureRuntime seeds a non-tmux (sdk) runtime.
    const response = await fixture.postJson('/v1/runtimes/inspect', { runtimeId })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { transport: string; tmux?: unknown }
    expect(body.transport).not.toBe('tmux')
    expect(body.tmux).toBeUndefined()
  })
})

describe('T-01738 F-V5: adopt verifies broker-tmux lease liveness', () => {
  it('rejects adopting a broker-tmux runtime whose lease server is dead', async () => {
    const driver = 'cc'
    const runtimeId = 'adoptDead'
    // Point at a btmux socket with no live server.
    await mkdir(btmuxDir(), { recursive: true })
    const socketPath = join(btmuxDir(), `${driver}-${runtimeId}.sock`)
    seedBrokerTmuxRuntime({ driver, runtimeId, socketPath, status: 'dead' })

    const server = await createHrcServer(fixture.serverOpts())
    servers.push(server)

    const response = await fixture.postJson('/v1/runtimes/adopt', { runtimeId })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('stale_context')
  })

  it('adopts a broker-tmux runtime whose lease server is live', async () => {
    const driver = 'cx'
    const runtimeId = 'adoptLive'
    const { socketPath, sessionName } = await createLeaseSession(driver, runtimeId)
    expect((await createTmuxManager({ socketPath }).inspectSession(sessionName)) !== null).toBe(true)
    seedBrokerTmuxRuntime({ driver, runtimeId, socketPath, status: 'dead' })

    const server = await createHrcServer(fixture.serverOpts())
    servers.push(server)

    const response = await fixture.postJson('/v1/runtimes/adopt', { runtimeId })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string; adopted: boolean }
    expect(body.adopted).toBe(true)
    expect(body.status).toBe('adopted')
  })
})
