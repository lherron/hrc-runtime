/**
 * RED/GREEN tests for hrc-cli Phase 6 diagnostics commands (T-00973 / T-00974)
 *
 * Tests the CLI commands for Phase 6 diagnostics surfaces:
 *   - hrc health — print { ok: true } JSON to stdout
 *   - hrc status — print daemon status JSON to stdout
 *   - hrc runtime list [--host-session-id X] — list runtimes JSON
 *   - hrc launch list [--host-session-id X] [--runtime-id X] — list launches JSON
 *   - hrc adopt <runtimeId> — adopt orphaned runtime, print result JSON
 *
 * Pass conditions for Curly (T-00973):
 *   1. `hrc health` exits 0 and prints { ok: true } JSON to stdout
 *   2. `hrc status` exits 0 and prints status JSON with uptime, socketPath, counts
 *   3. `hrc runtime list` exits 0 and prints JSON array of runtimes
 *   4. `hrc runtime list --host-session-id X` filters runtimes
 *   5. `hrc launch list` exits 0 and prints JSON array of launches
 *   6. `hrc launch list --host-session-id X` filters by hostSessionId
 *   7. `hrc launch list --runtime-id X` filters by runtimeId
 *   8. `hrc adopt <runtimeId>` exits 0 and prints adopted runtime JSON
 *   9. `hrc adopt` with no args exits 1 with error on stderr
 *  10. All output is valid JSON on stdout
 *
 * Reference: T-00946 (parent plan), T-00973 (Curly diagnostics), T-00974 (Smokey validation)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string
let server: HrcServer

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

async function runCli(args: string[], env?: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn(['bun', 'run', CLI_PATH, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // Override socket discovery to use our test socket
      HRC_RUNTIME_DIR: runtimeRoot,
      HRC_STATE_DIR: stateRoot,
      ...env,
    },
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited

  return { stdout, stderr, exitCode }
}

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
  const scopeRef = opts?.scopeRef ?? 'project:cli-diag'

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
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-cli-phase6-'))
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
})

afterEach(async () => {
  if (server) await server.stop()
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. hrc health
// ---------------------------------------------------------------------------
describe('hrc health', () => {
  it('exits 0 and prints { ok: true } JSON', async () => {
    const result = await runCli(['health'])
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout.trim())
    expect(body).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// 2. hrc status
// ---------------------------------------------------------------------------
describe('hrc status', () => {
  it('exits 0 and prints status JSON with uptime and counts', async () => {
    const result = await runCli(['status'])
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout.trim())
    expect(typeof body.uptime).toBe('number')
    expect(typeof body.socketPath).toBe('string')
    expect(typeof body.sessionCount).toBe('number')
    expect(typeof body.runtimeCount).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// 3. hrc runtime list
// ---------------------------------------------------------------------------
describe('hrc runtime list', () => {
  it('exits 0 and prints JSON array of runtimes', async () => {
    seedRuntime()

    const result = await runCli(['runtime', 'list'])
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout.trim())
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
    expect(body[0].runtimeId).toBeString()
  })

  it('filters by --host-session-id', async () => {
    const seed1 = seedRuntime({ scopeRef: 'project:cli-rt-a' })
    seedRuntime({ scopeRef: 'project:cli-rt-b' })

    const result = await runCli([
      'runtime', 'list',
      '--host-session-id', seed1.hostSessionId,
    ])
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout.trim())
    expect(body.length).toBe(1)
    expect(body[0].hostSessionId).toBe(seed1.hostSessionId)
  })

  it('prints empty array when no runtimes exist', async () => {
    const result = await runCli(['runtime', 'list'])
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout.trim())
    expect(body).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. hrc launch list
// ---------------------------------------------------------------------------
describe('hrc launch list', () => {
  it('exits 0 and prints JSON array of launches', async () => {
    const seed = seedRuntime()
    seedLaunch(seed.hostSessionId, seed.runtimeId)

    const result = await runCli(['launch', 'list'])
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout.trim())
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
    expect(body[0].launchId).toBeString()
  })

  it('filters by --host-session-id', async () => {
    const seed1 = seedRuntime({ scopeRef: 'project:cli-launch-a' })
    const seed2 = seedRuntime({ scopeRef: 'project:cli-launch-b' })
    seedLaunch(seed1.hostSessionId, seed1.runtimeId)
    seedLaunch(seed2.hostSessionId, seed2.runtimeId)

    const result = await runCli([
      'launch', 'list',
      '--host-session-id', seed1.hostSessionId,
    ])
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout.trim())
    expect(body.length).toBe(1)
    expect(body[0].hostSessionId).toBe(seed1.hostSessionId)
  })

  it('filters by --runtime-id', async () => {
    const seed1 = seedRuntime({ scopeRef: 'project:cli-launch-rt-a' })
    const seed2 = seedRuntime({ scopeRef: 'project:cli-launch-rt-b' })
    seedLaunch(seed1.hostSessionId, seed1.runtimeId)
    seedLaunch(seed2.hostSessionId, seed2.runtimeId)

    const result = await runCli([
      'launch', 'list',
      '--runtime-id', seed1.runtimeId,
    ])
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout.trim())
    expect(body.length).toBe(1)
    expect(body[0].runtimeId).toBe(seed1.runtimeId)
  })

  it('prints empty array when no launches exist', async () => {
    const result = await runCli(['launch', 'list'])
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout.trim())
    expect(body).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. hrc adopt
// ---------------------------------------------------------------------------
describe('hrc adopt', () => {
  it('exits 0 and prints adopted runtime JSON for dead runtime', async () => {
    const { runtimeId } = seedRuntime({ status: 'dead' })

    const result = await runCli(['adopt', runtimeId])
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout.trim())
    expect(body.runtimeId).toBe(runtimeId)
    expect(body.adopted).toBe(true)
    expect(body.status).toBe('adopted')
  })

  it('exits 1 with error on stderr when no runtimeId argument', async () => {
    const result = await runCli(['adopt'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('exits 1 when adopting an active runtime', async () => {
    const { runtimeId } = seedRuntime({ status: 'ready' })

    const result = await runCli(['adopt', runtimeId])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
