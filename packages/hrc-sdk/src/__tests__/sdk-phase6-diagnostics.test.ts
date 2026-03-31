/**
 * RED/GREEN tests for hrc-sdk Phase 6 diagnostics methods (T-00973 / T-00974)
 *
 * Tests that the HrcClient SDK exposes typed methods for Phase 6 surfaces:
 *   - getHealth() → { ok: true }
 *   - getStatus() → { uptime, socketPath, sessionCount, runtimeCount }
 *   - listRuntimes(filter?) → HrcRuntimeSnapshot[]
 *   - listLaunches(filter?) → HrcLaunchRecord[]
 *   - adoptRuntime(runtimeId) → HrcRuntimeSnapshot
 *
 * These tests run against a real hrc-server instance over a Unix socket.
 *
 * Pass conditions for Curly (T-00973):
 *   1. client.getHealth() returns { ok: true }
 *   2. client.getStatus() returns status with uptime, socketPath, counts
 *   3. client.listRuntimes() returns all runtimes
 *   4. client.listRuntimes({ hostSessionId }) filters correctly
 *   5. client.listLaunches() returns all launches
 *   6. client.listLaunches({ hostSessionId }) filters by host session
 *   7. client.listLaunches({ runtimeId }) filters by runtime
 *   8. client.adoptRuntime(runtimeId) on dead runtime returns adopted snapshot
 *   9. client.adoptRuntime(runtimeId) on active runtime throws CONFLICT
 *  10. client.adoptRuntime(unknownId) throws UNKNOWN_RUNTIME
 *
 * Reference: T-00946 (parent plan), T-00973 (Curly diagnostics), T-00974 (Smokey validation)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcLaunchRecord, HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'

// RED GATE: These imports will fail until Curly adds the new SDK methods
import { HrcClient } from '../client'
import type {
  HealthResponse,
  LaunchListFilter,
  RuntimeListFilter,
  StatusResponse,
} from '../types'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string
let server: HrcServer
let client: HrcClient

function ts(): string {
  return new Date().toISOString()
}

function serverOpts(): HrcServerOptions {
  return {
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    tmuxSocketPath,
  }
}

function seedRuntime(opts?: { scopeRef?: string; status?: string }): {
  hostSessionId: string
  runtimeId: string
} {
  const now = ts()
  const hostSessionId = `hsid-${randomUUID()}`
  const runtimeId = `rt-${randomUUID()}`
  const scopeRef = opts?.scopeRef ?? 'project:sdk-diag'

  const db = openHrcDatabase(dbPath)
  db.continuities.upsert({
    scopeRef,
    laneRef: 'default',
    activeHostSessionId: hostSessionId,
    updatedAt: now,
  })
  db.sessions.create({
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    status: 'active',
    ancestorScopeRefs: [],
    createdAt: now,
    updatedAt: now,
  })
  db.runtimes.create({
    runtimeId,
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: opts?.status ?? 'ready',
    supportsInflightInput: false,
    adopted: false,
    createdAt: now,
    updatedAt: now,
  })
  db.close()
  return { hostSessionId, runtimeId }
}

function seedLaunch(hostSessionId: string, runtimeId: string): string {
  const now = ts()
  const launchId = `launch-${randomUUID()}`

  const db = openHrcDatabase(dbPath)
  db.launches.create({
    launchId,
    hostSessionId,
    generation: 1,
    runtimeId,
    harness: 'claude-code',
    provider: 'anthropic',
    launchArtifactPath: join(tmpDir, 'artifacts', launchId),
    status: 'exited',
    createdAt: now,
    updatedAt: now,
  })
  db.close()
  return launchId
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-phase6-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })

  server = await createHrcServer(serverOpts())
  client = new HrcClient(socketPath)
})

afterEach(async () => {
  if (server) await server.stop()
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. getHealth()
// ---------------------------------------------------------------------------
describe('HrcClient.getHealth()', () => {
  it('returns { ok: true }', async () => {
    const health: HealthResponse = await client.getHealth()
    expect(health).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// 2. getStatus()
// ---------------------------------------------------------------------------
describe('HrcClient.getStatus()', () => {
  it('returns daemon status with uptime, socketPath, and counts', async () => {
    const status: StatusResponse = await client.getStatus()

    expect(typeof status.uptime).toBe('number')
    expect(status.uptime).toBeGreaterThanOrEqual(0)
    expect(status.socketPath).toBe(socketPath)
    expect(typeof status.sessionCount).toBe('number')
    expect(typeof status.runtimeCount).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// 3. listRuntimes()
// ---------------------------------------------------------------------------
describe('HrcClient.listRuntimes()', () => {
  it('returns all runtimes', async () => {
    const s1 = seedRuntime({ scopeRef: 'project:sdk-rt-a' })
    const s2 = seedRuntime({ scopeRef: 'project:sdk-rt-b' })

    const runtimes: HrcRuntimeSnapshot[] = await client.listRuntimes()
    expect(runtimes.length).toBe(2)
    const ids = runtimes.map((r) => r.runtimeId)
    expect(ids).toContain(s1.runtimeId)
    expect(ids).toContain(s2.runtimeId)
  })

  it('filters by hostSessionId', async () => {
    const s1 = seedRuntime({ scopeRef: 'project:sdk-rt-filter-a' })
    seedRuntime({ scopeRef: 'project:sdk-rt-filter-b' })

    const runtimes: HrcRuntimeSnapshot[] = await client.listRuntimes({
      hostSessionId: s1.hostSessionId,
    })
    expect(runtimes.length).toBe(1)
    expect(runtimes[0]!.runtimeId).toBe(s1.runtimeId)
  })

  it('returns empty array when no runtimes exist', async () => {
    const runtimes: HrcRuntimeSnapshot[] = await client.listRuntimes()
    expect(runtimes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. listLaunches()
// ---------------------------------------------------------------------------
describe('HrcClient.listLaunches()', () => {
  it('returns all launches', async () => {
    const s1 = seedRuntime({ scopeRef: 'project:sdk-launch-a' })
    const s2 = seedRuntime({ scopeRef: 'project:sdk-launch-b' })
    const l1 = seedLaunch(s1.hostSessionId, s1.runtimeId)
    const l2 = seedLaunch(s2.hostSessionId, s2.runtimeId)

    const launches: HrcLaunchRecord[] = await client.listLaunches()
    expect(launches.length).toBe(2)
    const ids = launches.map((l) => l.launchId)
    expect(ids).toContain(l1)
    expect(ids).toContain(l2)
  })

  it('filters by hostSessionId', async () => {
    const s1 = seedRuntime({ scopeRef: 'project:sdk-launch-filter-host-a' })
    const s2 = seedRuntime({ scopeRef: 'project:sdk-launch-filter-host-b' })
    const l1 = seedLaunch(s1.hostSessionId, s1.runtimeId)
    seedLaunch(s2.hostSessionId, s2.runtimeId)

    const launches: HrcLaunchRecord[] = await client.listLaunches({
      hostSessionId: s1.hostSessionId,
    })
    expect(launches.length).toBe(1)
    expect(launches[0]!.launchId).toBe(l1)
  })

  it('filters by runtimeId', async () => {
    const s1 = seedRuntime({ scopeRef: 'project:sdk-launch-filter-rt-a' })
    const s2 = seedRuntime({ scopeRef: 'project:sdk-launch-filter-rt-b' })
    const l1 = seedLaunch(s1.hostSessionId, s1.runtimeId)
    seedLaunch(s2.hostSessionId, s2.runtimeId)

    const launches: HrcLaunchRecord[] = await client.listLaunches({
      runtimeId: s1.runtimeId,
    })
    expect(launches.length).toBe(1)
    expect(launches[0]!.launchId).toBe(l1)
  })

  it('returns empty array when no launches exist', async () => {
    const launches: HrcLaunchRecord[] = await client.listLaunches()
    expect(launches).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. adoptRuntime()
// ---------------------------------------------------------------------------
describe('HrcClient.adoptRuntime()', () => {
  it('adopts a dead runtime and returns updated snapshot', async () => {
    const { runtimeId } = seedRuntime({ status: 'dead' })

    const result: HrcRuntimeSnapshot = await client.adoptRuntime(runtimeId)
    expect(result.runtimeId).toBe(runtimeId)
    expect(result.adopted).toBe(true)
    expect(result.status).toBe('adopted')
  })

  it('throws CONFLICT when adopting an active runtime', async () => {
    const { runtimeId } = seedRuntime({ status: 'ready' })

    try {
      await client.adoptRuntime(runtimeId)
      expect(true).toBe(false) // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      expect((err as HrcDomainError).code).toBe(HrcErrorCode.CONFLICT)
    }
  })

  it('throws UNKNOWN_RUNTIME for nonexistent runtimeId', async () => {
    try {
      await client.adoptRuntime(`rt-nonexistent-${randomUUID()}`)
      expect(true).toBe(false) // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      expect((err as HrcDomainError).code).toBe(HrcErrorCode.UNKNOWN_RUNTIME)
    }
  })
})
