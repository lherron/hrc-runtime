/**
 * RED/GREEN tests for hrc-server Phase 6 hardening (T-00972 / T-00974)
 *
 * Tests the server-side hardening surface:
 *   - Orphaned launch reconciliation on startup
 *   - Stale launch callback rejection (does NOT mutate active runtime state)
 *   - Dead runtime detection (tmux liveness)
 *   - Startup failure transparency (no silent swallowing)
 *
 * Reconciliation semantics (from reconcileStartupState in index.ts):
 *   - Orphanable launch statuses: "wrapper_started" | "child_started"
 *   - Orphaned launch: status → "orphaned", event: launch.orphaned
 *   - Runtime whose active launch is orphaned: status → "stale", event: runtime.stale
 *   - Runtime whose tmux session is missing: status → "dead", event: runtime.dead (source: 'tmux')
 *
 * Pass conditions for Larry (T-00972):
 *   1. On startup, launches with status "wrapper_started" or "child_started"
 *      whose tracked PID is dead are reconciled to status "orphaned" and a
 *      launch.orphaned event is emitted with { launchId, pid, priorStatus }
 *   2. On startup, runtimes whose active launch (runtime.launchId) is orphaned
 *      are marked status "stale" and a runtime.stale event is emitted with
 *      { launchId, priorStatus, reason: 'launch_orphaned' }
 *   3. On startup, tmux-transport runtimes whose tmux session is missing
 *      are marked status "dead" and a runtime.dead event is emitted with
 *      { sessionName, reason: 'tmux_session_missing' } and source: 'tmux'
 *   4. Stale callback (wrapper-started for a launch whose generation <
 *      active generation) is rejected with STALE_CONTEXT and does NOT
 *      mutate the active runtime record
 *   5. Stale callback (exited for a prior-generation launch) is rejected
 *      with STALE_CONTEXT; active runtime status is unchanged
 *   6. POST /v1/runtimes/adopt on a dead/stale runtime sets adopted = true,
 *      status = "adopted", and emits runtime.adopted event
 *   7. POST /v1/runtimes/adopt on an active runtime returns CONFLICT
 *   8. Startup reconciliation emits events for every reconciled record
 *      (launch.orphaned + runtime.stale) — no silent swallowing
 *   9. Spool replay of a stale callback after restart does not corrupt
 *      current-generation runtime state
 *  10. Multiple orphaned launches for the same runtime are all reconciled
 *      and produce individual launch.orphaned events
 *
 * Reference: T-00946 (parent plan), T-00972 (Larry hardening), T-00974 (Smokey validation)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcHttpError } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServerOptions } from '../index'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string

function ts(): string {
  return new Date().toISOString()
}

async function fetchSocket(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    // @ts-expect-error -- Bun supports unix option on fetch
    unix: socketPath,
  })
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetchSocket(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-phase6-hardening-'))
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
})

afterEach(async () => {
  try {
    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited
  } catch {
    // fine when no tmux server exists
  }
  await rm(tmpDir, { recursive: true, force: true })
})

function serverOpts(overrides: Partial<HrcServerOptions> = {}): HrcServerOptions {
  return {
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    tmuxSocketPath,
    ...overrides,
  }
}

/**
 * Helper: seed a session, runtime, and launch record directly in the DB.
 * The launch has a dead PID and status "wrapper_started" (an orphanable status).
 * The runtime's launchId points to this launch so it will be marked stale.
 */
function seedOrphanedLaunch(
  db: HrcDatabase,
  opts?: {
    scopeRef?: string
    runtimeStatus?: string
    launchStatus?: string
    wrapperPid?: number
    generation?: number
    launchId?: string
  }
): {
  hostSessionId: string
  runtimeId: string
  launchId: string
} {
  const now = ts()
  const scopeRef = opts?.scopeRef ?? `project:orphan-${randomUUID().slice(0, 8)}`
  const hostSessionId = `hsid-${randomUUID()}`
  const runtimeId = `rt-${randomUUID()}`
  const launchId = opts?.launchId ?? `launch-${randomUUID()}`
  const generation = opts?.generation ?? 1

  db.continuities.upsert({
    scopeRef,
    laneRef: 'default',
    activeHostSessionId: hostSessionId,
    updatedAt: now,
  })

  db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation,
    status: 'active',
    ancestorScopeRefs: [],
    createdAt: now,
    updatedAt: now,
  })

  db.runtimes.insert({
    runtimeId,
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation,
    launchId,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: opts?.runtimeStatus ?? 'ready',
    supportsInflightInput: false,
    adopted: false,
    // Provide valid tmuxJson so requireTmuxPane doesn't throw,
    // but the tmux session won't actually exist (handled separately)
    tmuxJson: {
      sessionName: `hrc-test-${runtimeId}`,
      sessionId: '$99',
      windowId: '@0',
      paneId: '%0',
      socketPath: tmuxSocketPath,
    },
    createdAt: now,
    updatedAt: now,
  })

  // Launch with orphanable status and dead PID (2147483647 unlikely to be alive)
  db.launches.insert({
    launchId,
    hostSessionId,
    generation,
    runtimeId,
    harness: 'claude-code',
    provider: 'anthropic',
    launchArtifactPath: join(tmpDir, 'artifacts', launchId),
    status: opts?.launchStatus ?? 'wrapper_started',
    wrapperPid: opts?.wrapperPid ?? 2147483647,
    createdAt: now,
    updatedAt: now,
  })

  return { hostSessionId, runtimeId, launchId }
}

// ---------------------------------------------------------------------------
// 1. Orphaned launch reconciliation on startup
// ---------------------------------------------------------------------------
describe('orphaned launch reconciliation on startup', () => {
  it('marks wrapper_started launches with dead PIDs as "orphaned" and emits launch.orphaned', async () => {
    const db = openHrcDatabase(dbPath)
    const { launchId } = seedOrphanedLaunch(db, { launchStatus: 'wrapper_started' })
    db.close()

    const server = await createHrcServer(serverOpts())

    // Launch should be marked "orphaned" (not "dead")
    const dbAfter = openHrcDatabase(dbPath)
    const launch = dbAfter.launches.getByLaunchId(launchId)
    dbAfter.close()

    expect(launch).not.toBeNull()
    expect(launch!.status).toBe('orphaned')

    // Verify launch.orphaned event with correct payload
    const eventsRes = await fetchSocket('/v1/events')
    const events = parseNdjson(await eventsRes.text())
    const orphanedEvents = events.filter((e) => e.eventKind === 'launch.orphaned')
    expect(orphanedEvents.length).toBeGreaterThanOrEqual(1)
    const matchingEvent = orphanedEvents.find((e) => {
      const json = e.eventJson as Record<string, unknown>
      return json.launchId === launchId
    })
    expect(matchingEvent).toBeDefined()
    const eventJson = matchingEvent!.eventJson as Record<string, unknown>
    expect(eventJson.pid).toBe(2147483647)
    expect(eventJson.priorStatus).toBe('wrapper_started')

    await server.stop()
  })

  it('marks child_started launches with dead PIDs as "orphaned"', async () => {
    const db = openHrcDatabase(dbPath)
    const launchId = `launch-${randomUUID()}`
    const { launchId: seededId } = seedOrphanedLaunch(db, {
      launchStatus: 'child_started',
      launchId,
    })
    db.close()

    const server = await createHrcServer(serverOpts())

    const dbAfter = openHrcDatabase(dbPath)
    const launch = dbAfter.launches.getByLaunchId(seededId)
    dbAfter.close()

    expect(launch).not.toBeNull()
    expect(launch!.status).toBe('orphaned')

    await server.stop()
  })

  it('marks runtimes whose active launch is orphaned as "stale" with runtime.stale event', async () => {
    const db = openHrcDatabase(dbPath)
    const { runtimeId, launchId } = seedOrphanedLaunch(db)
    db.close()

    const server = await createHrcServer(serverOpts())

    // Runtime should be "stale" (not "dead") — orphaned-launch path
    const dbAfter = openHrcDatabase(dbPath)
    const runtime = dbAfter.runtimes.getByRuntimeId(runtimeId)
    dbAfter.close()

    expect(runtime).not.toBeNull()
    expect(runtime!.status).toBe('stale')

    // Verify runtime.stale event (not runtime.dead)
    const eventsRes = await fetchSocket('/v1/events')
    const events = parseNdjson(await eventsRes.text())
    const staleEvents = events.filter((e) => e.eventKind === 'runtime.stale')
    expect(staleEvents.length).toBeGreaterThanOrEqual(1)
    const matchingEvent = staleEvents.find((e) => {
      const json = e.eventJson as Record<string, unknown>
      return json.launchId === launchId
    })
    expect(matchingEvent).toBeDefined()
    const eventJson = matchingEvent!.eventJson as Record<string, unknown>
    expect(eventJson.reason).toBe('launch_orphaned')
    expect(eventJson.priorStatus).toBe('ready')

    await server.stop()
  })

  it('reconciles multiple orphaned launches for the same runtime individually', async () => {
    const db = openHrcDatabase(dbPath)
    const now = ts()
    const scopeRef = 'project:multi-orphan'
    const hostSessionId = `hsid-${randomUUID()}`
    const runtimeId = `rt-${randomUUID()}`
    const launchId1 = `launch-${randomUUID()}`
    const launchId2 = `launch-${randomUUID()}`

    db.continuities.upsert({
      scopeRef,
      laneRef: 'default',
      activeHostSessionId: hostSessionId,
      updatedAt: now,
    })
    db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      status: 'active',
      ancestorScopeRefs: [],
      createdAt: now,
      updatedAt: now,
    })
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      launchId: launchId2, // point to the second launch as "active"
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      tmuxJson: {
        sessionName: `hrc-test-${runtimeId}`,
        sessionId: '$99',
        windowId: '@0',
        paneId: '%0',
        socketPath: tmuxSocketPath,
      },
      createdAt: now,
      updatedAt: now,
    })

    for (const launchId of [launchId1, launchId2]) {
      db.launches.insert({
        launchId,
        hostSessionId,
        generation: 1,
        runtimeId,
        harness: 'claude-code',
        provider: 'anthropic',
        launchArtifactPath: join(tmpDir, 'artifacts', launchId),
        status: 'wrapper_started',
        wrapperPid: 2147483647,
        createdAt: now,
        updatedAt: now,
      })
    }
    db.close()

    const server = await createHrcServer(serverOpts())

    // Both launches should be marked orphaned
    const dbAfter = openHrcDatabase(dbPath)
    expect(dbAfter.launches.getByLaunchId(launchId1)!.status).toBe('orphaned')
    expect(dbAfter.launches.getByLaunchId(launchId2)!.status).toBe('orphaned')
    dbAfter.close()

    // Should have individual launch.orphaned events for each
    const eventsRes = await fetchSocket('/v1/events')
    const events = parseNdjson(await eventsRes.text())
    const orphanedEvents = events.filter((e) => e.eventKind === 'launch.orphaned')
    expect(orphanedEvents.length).toBeGreaterThanOrEqual(2)

    await server.stop()
  })
})

// ---------------------------------------------------------------------------
// 2. Stale launch callback rejection
// ---------------------------------------------------------------------------
describe('stale launch callback rejection', () => {
  it('rejects wrapper-started for a prior-generation launch with STALE_CONTEXT', async () => {
    const db = openHrcDatabase(dbPath)
    const now = ts()
    const hostSessionId1 = `hsid-${randomUUID()}`
    const hostSessionId2 = `hsid-${randomUUID()}`
    const runtimeId = `rt-${randomUUID()}`
    const staleLaunchId = `launch-stale-${randomUUID()}`

    db.continuities.upsert({
      scopeRef: 'project:stale-cb',
      laneRef: 'default',
      activeHostSessionId: hostSessionId2,
      updatedAt: now,
    })
    db.sessions.insert({
      hostSessionId: hostSessionId1,
      scopeRef: 'project:stale-cb',
      laneRef: 'default',
      generation: 1,
      status: 'superseded',
      ancestorScopeRefs: [],
      createdAt: now,
      updatedAt: now,
    })
    db.sessions.insert({
      hostSessionId: hostSessionId2,
      scopeRef: 'project:stale-cb',
      laneRef: 'default',
      generation: 2,
      status: 'active',
      ancestorScopeRefs: [],
      createdAt: now,
      updatedAt: now,
    })
    // Active runtime on gen 2 — SDK transport so tmux reconciliation won't touch it
    db.runtimes.insert({
      runtimeId,
      hostSessionId: hostSessionId2,
      scopeRef: 'project:stale-cb',
      laneRef: 'default',
      generation: 2,
      transport: 'sdk',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    db.launches.insert({
      launchId: staleLaunchId,
      hostSessionId: hostSessionId1,
      generation: 1,
      runtimeId,
      harness: 'claude-code',
      provider: 'anthropic',
      launchArtifactPath: join(tmpDir, 'artifacts', staleLaunchId),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    })
    db.close()

    const server = await createHrcServer(serverOpts())

    // Attempt wrapper-started for the stale launch
    const res = await postJson(`/v1/internal/launches/${staleLaunchId}/wrapper-started`, {
      hostSessionId: hostSessionId1,
      wrapperPid: process.pid,
      timestamp: ts(),
    })

    // Should be rejected with STALE_CONTEXT
    expect(res.status).toBe(409)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.STALE_CONTEXT)

    // Active runtime on generation 2 must NOT be mutated
    const dbAfter = openHrcDatabase(dbPath)
    const activeRuntime = dbAfter.runtimes.getByRuntimeId(runtimeId)
    dbAfter.close()

    expect(activeRuntime!.status).toBe('ready')
    expect(activeRuntime!.generation).toBe(2)
    expect(activeRuntime!.hostSessionId).toBe(hostSessionId2)

    await server.stop()
  })

  it('rejects exited callback for a prior-generation launch without mutating active runtime', async () => {
    const db = openHrcDatabase(dbPath)
    const now = ts()
    const hostSessionId1 = `hsid-${randomUUID()}`
    const hostSessionId2 = `hsid-${randomUUID()}`
    const activeRuntimeId = `rt-active-${randomUUID()}`
    const staleLaunchId = `launch-stale-exit-${randomUUID()}`

    db.continuities.upsert({
      scopeRef: 'project:stale-exit',
      laneRef: 'default',
      activeHostSessionId: hostSessionId2,
      updatedAt: now,
    })
    db.sessions.insert({
      hostSessionId: hostSessionId1,
      scopeRef: 'project:stale-exit',
      laneRef: 'default',
      generation: 1,
      status: 'superseded',
      ancestorScopeRefs: [],
      createdAt: now,
      updatedAt: now,
    })
    db.sessions.insert({
      hostSessionId: hostSessionId2,
      scopeRef: 'project:stale-exit',
      laneRef: 'default',
      generation: 2,
      status: 'active',
      ancestorScopeRefs: [],
      createdAt: now,
      updatedAt: now,
    })
    // Active gen-2 runtime — SDK transport so tmux reconciliation won't touch it
    const activeRunId = `run-${randomUUID()}`
    db.runtimes.insert({
      runtimeId: activeRuntimeId,
      hostSessionId: hostSessionId2,
      scopeRef: 'project:stale-exit',
      laneRef: 'default',
      generation: 2,
      transport: 'sdk',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'busy',
      supportsInflightInput: true,
      adopted: false,
      activeRunId,
      createdAt: now,
      updatedAt: now,
    })
    // Stale launch from gen-1 (points to old runtime, not the active one)
    const oldRuntimeId = `rt-old-exit-${randomUUID()}`
    db.runtimes.insert({
      runtimeId: oldRuntimeId,
      hostSessionId: hostSessionId1,
      scopeRef: 'project:stale-exit',
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'terminated',
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    db.launches.insert({
      launchId: staleLaunchId,
      hostSessionId: hostSessionId1,
      generation: 1,
      runtimeId: oldRuntimeId,
      harness: 'claude-code',
      provider: 'anthropic',
      launchArtifactPath: join(tmpDir, 'artifacts', staleLaunchId),
      status: 'wrapper_started',
      wrapperPid: 2147483647,
      createdAt: now,
      updatedAt: now,
    })
    db.close()

    const server = await createHrcServer(serverOpts())

    // Attempt exited callback for the stale launch
    const res = await postJson(`/v1/internal/launches/${staleLaunchId}/exited`, {
      hostSessionId: hostSessionId1,
      exitCode: 0,
      timestamp: ts(),
    })

    expect(res.status).toBe(409)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.STALE_CONTEXT)

    // Active runtime must remain "busy" and on generation 2
    const dbAfter = openHrcDatabase(dbPath)
    const runtime = dbAfter.runtimes.getByRuntimeId(activeRuntimeId)
    dbAfter.close()

    expect(runtime!.status).toBe('busy')
    expect(runtime!.generation).toBe(2)
    expect(runtime!.activeRunId).toBeDefined()

    await server.stop()
  })
})

// ---------------------------------------------------------------------------
// 3. Dead runtime detection (tmux liveness)
// ---------------------------------------------------------------------------
describe('dead runtime detection', () => {
  it('detects a runtime whose tmux session is missing and marks it dead', async () => {
    // Seed a runtime with valid tmuxJson but no actual tmux session behind it
    const db = openHrcDatabase(dbPath)
    const now = ts()
    const hostSessionId = `hsid-${randomUUID()}`
    const runtimeId = `rt-dead-tmux-${randomUUID()}`
    const deadSessionName = `hrc-dead-${randomUUID()}`

    db.continuities.upsert({
      scopeRef: 'project:dead-tmux',
      laneRef: 'default',
      activeHostSessionId: hostSessionId,
      updatedAt: now,
    })
    db.sessions.insert({
      hostSessionId,
      scopeRef: 'project:dead-tmux',
      laneRef: 'default',
      generation: 1,
      status: 'active',
      ancestorScopeRefs: [],
      createdAt: now,
      updatedAt: now,
    })
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef: 'project:dead-tmux',
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      // Valid tmuxJson shape so requireTmuxPane won't throw,
      // but the named session does not actually exist in tmux
      tmuxJson: {
        sessionName: deadSessionName,
        sessionId: '$999',
        windowId: '@0',
        paneId: '%0',
        socketPath: tmuxSocketPath,
      },
      createdAt: now,
      updatedAt: now,
    })
    db.close()

    // Start server — dead tmux detection should run during reconciliation
    const server = await createHrcServer(serverOpts())

    const dbAfter = openHrcDatabase(dbPath)
    const runtime = dbAfter.runtimes.getByRuntimeId(runtimeId)
    dbAfter.close()

    expect(runtime).not.toBeNull()
    expect(runtime!.status).toBe('dead')

    // Should emit runtime.dead event with source 'tmux'
    const eventsRes = await fetchSocket('/v1/events')
    const events = parseNdjson(await eventsRes.text())
    const deadEvents = events.filter((e) => e.eventKind === 'runtime.dead')
    const matchingEvent = deadEvents.find((e) => {
      const json = e.eventJson as Record<string, unknown>
      return json.sessionName === deadSessionName
    })
    expect(matchingEvent).toBeDefined()
    expect(matchingEvent!.source).toBe('tmux')
    const eventJson = matchingEvent!.eventJson as Record<string, unknown>
    expect(eventJson.reason).toBe('tmux_session_missing')

    await server.stop()
  })
})

// ---------------------------------------------------------------------------
// 4. Runtime adoption
// ---------------------------------------------------------------------------
describe('runtime adoption', () => {
  it('POST /v1/runtimes/adopt marks a dead runtime as adopted', async () => {
    const db = openHrcDatabase(dbPath)
    const now = ts()
    const hostSessionId = `hsid-${randomUUID()}`
    const runtimeId = `rt-adopt-${randomUUID()}`

    db.continuities.upsert({
      scopeRef: 'project:adopt',
      laneRef: 'default',
      activeHostSessionId: hostSessionId,
      updatedAt: now,
    })
    db.sessions.insert({
      hostSessionId,
      scopeRef: 'project:adopt',
      laneRef: 'default',
      generation: 1,
      status: 'active',
      ancestorScopeRefs: [],
      createdAt: now,
      updatedAt: now,
    })
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef: 'project:adopt',
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'dead',
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    db.close()

    const server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/runtimes/adopt', { runtimeId })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.runtimeId).toBe(runtimeId)
    expect(body.adopted).toBe(true)
    expect(body.status).toBe('adopted')

    // Verify event
    const eventsRes = await fetchSocket('/v1/events')
    const events = parseNdjson(await eventsRes.text())
    const adoptEvents = events.filter((e) => e.eventKind === 'runtime.adopted')
    expect(adoptEvents.length).toBeGreaterThanOrEqual(1)

    await server.stop()
  })

  it('POST /v1/runtimes/adopt also works on stale runtimes', async () => {
    // Seed a runtime that will become stale via orphaned launch reconciliation
    const db = openHrcDatabase(dbPath)
    const { runtimeId } = seedOrphanedLaunch(db, {
      scopeRef: 'project:adopt-stale',
    })
    db.close()

    const server = await createHrcServer(serverOpts())

    // After startup reconciliation, the runtime should be stale
    const dbCheck = openHrcDatabase(dbPath)
    const rtBefore = dbCheck.runtimes.getByRuntimeId(runtimeId)
    dbCheck.close()
    expect(rtBefore!.status).toBe('stale')

    // Now adopt it
    const res = await postJson('/v1/runtimes/adopt', { runtimeId })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.adopted).toBe(true)
    expect(body.status).toBe('adopted')

    await server.stop()
  })

  it('POST /v1/runtimes/adopt on an active runtime returns CONFLICT', async () => {
    // Use SDK transport so tmux reconciliation doesn't touch this runtime
    const db = openHrcDatabase(dbPath)
    const now = ts()
    const hostSessionId = `hsid-${randomUUID()}`
    const runtimeId = `rt-adopt-active-${randomUUID()}`

    db.continuities.upsert({
      scopeRef: 'project:adopt-conflict',
      laneRef: 'default',
      activeHostSessionId: hostSessionId,
      updatedAt: now,
    })
    db.sessions.insert({
      hostSessionId,
      scopeRef: 'project:adopt-conflict',
      laneRef: 'default',
      generation: 1,
      status: 'active',
      ancestorScopeRefs: [],
      createdAt: now,
      updatedAt: now,
    })
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef: 'project:adopt-conflict',
      laneRef: 'default',
      generation: 1,
      transport: 'sdk',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    db.close()

    const server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/runtimes/adopt', { runtimeId })
    expect(res.status).toBe(409)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.CONFLICT)

    await server.stop()
  })

  it('POST /v1/runtimes/adopt on unknown runtime returns 404', async () => {
    const server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/runtimes/adopt', {
      runtimeId: 'rt-nonexistent',
    })
    expect(res.status).toBe(404)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.UNKNOWN_RUNTIME)

    await server.stop()
  })
})

// ---------------------------------------------------------------------------
// 5. Startup failure transparency
// ---------------------------------------------------------------------------
describe('startup failure transparency', () => {
  it('emits reconciliation events (not silently swallowed) for all orphaned records', async () => {
    // Seed two separate orphaned runtimes
    const db = openHrcDatabase(dbPath)
    const seeds = [seedOrphanedLaunch(db), seedOrphanedLaunch(db)]
    db.close()

    const server = await createHrcServer(serverOpts())

    const eventsRes = await fetchSocket('/v1/events')
    const events = parseNdjson(await eventsRes.text())

    // Every seeded orphan should produce a launch.orphaned event
    for (const seed of seeds) {
      const hasOrphanEvent = events.some(
        (e) =>
          e.eventKind === 'launch.orphaned' &&
          (e.eventJson as Record<string, unknown>).launchId === seed.launchId
      )
      expect(hasOrphanEvent).toBe(true)
    }

    // Every seeded runtime should produce a runtime.stale event (not runtime.dead)
    for (const seed of seeds) {
      const hasStaleEvent = events.some(
        (e) =>
          e.eventKind === 'runtime.stale' &&
          (e.eventJson as Record<string, unknown>).launchId === seed.launchId
      )
      expect(hasStaleEvent).toBe(true)
    }

    await server.stop()
  })
})

// ---------------------------------------------------------------------------
// 6. Spool replay of stale callback after restart
// ---------------------------------------------------------------------------
describe('spool replay stale callback safety', () => {
  it('replaying a stale callback from spool does not corrupt current-gen runtime', async () => {
    // Gen-2 runtime uses SDK transport (no tmux reconciliation).
    // The stale launch from gen-1 has its own old runtimeId (not the active one).
    const db = openHrcDatabase(dbPath)
    const now = ts()
    const hostSessionId1 = `hsid-spool-stale-${randomUUID()}`
    const hostSessionId2 = `hsid-spool-current-${randomUUID()}`
    const activeRuntimeId = `rt-spool-current-${randomUUID()}`
    const oldRuntimeId = `rt-spool-old-${randomUUID()}`
    const staleLaunchId = `launch-spool-stale-${randomUUID()}`

    db.continuities.upsert({
      scopeRef: 'project:spool-stale',
      laneRef: 'default',
      activeHostSessionId: hostSessionId2,
      updatedAt: now,
    })
    db.sessions.insert({
      hostSessionId: hostSessionId1,
      scopeRef: 'project:spool-stale',
      laneRef: 'default',
      generation: 1,
      status: 'superseded',
      ancestorScopeRefs: [],
      createdAt: now,
      updatedAt: now,
    })
    db.sessions.insert({
      hostSessionId: hostSessionId2,
      scopeRef: 'project:spool-stale',
      laneRef: 'default',
      generation: 2,
      status: 'active',
      ancestorScopeRefs: [],
      createdAt: now,
      updatedAt: now,
    })
    // Active gen-2 runtime (SDK transport, no tmux reconciliation)
    db.runtimes.insert({
      runtimeId: activeRuntimeId,
      hostSessionId: hostSessionId2,
      scopeRef: 'project:spool-stale',
      laneRef: 'default',
      generation: 2,
      transport: 'sdk',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    // Old gen-1 runtime (already terminated)
    db.runtimes.insert({
      runtimeId: oldRuntimeId,
      hostSessionId: hostSessionId1,
      scopeRef: 'project:spool-stale',
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'terminated',
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    // Stale launch from gen-1, pointing to old runtime
    db.launches.insert({
      launchId: staleLaunchId,
      hostSessionId: hostSessionId1,
      generation: 1,
      runtimeId: oldRuntimeId,
      harness: 'claude-code',
      provider: 'anthropic',
      launchArtifactPath: join(tmpDir, 'artifacts', staleLaunchId),
      status: 'exited',
      wrapperPid: 2147483647,
      createdAt: now,
      updatedAt: now,
    })
    db.close()

    // Create spool entry for the stale launch's exited callback
    const launchSpoolDir = join(spoolDir, staleLaunchId)
    await mkdir(launchSpoolDir, { recursive: true })
    await writeFile(
      join(launchSpoolDir, '000001.json'),
      JSON.stringify({
        endpoint: `/v1/internal/launches/${staleLaunchId}/exited`,
        payload: {
          hostSessionId: hostSessionId1,
          exitCode: 0,
          timestamp: ts(),
        },
      }),
      'utf-8'
    )

    // Start server — spool replay should process the stale callback safely
    const server = await createHrcServer(serverOpts())

    // The active gen-2 runtime must NOT have been corrupted
    const dbAfter = openHrcDatabase(dbPath)
    const activeRuntime = dbAfter.runtimes.getByRuntimeId(activeRuntimeId)
    dbAfter.close()

    expect(activeRuntime!.status).toBe('ready')
    expect(activeRuntime!.generation).toBe(2)
    expect(activeRuntime!.hostSessionId).toBe(hostSessionId2)

    await server.stop()
  })
})
