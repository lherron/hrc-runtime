/**
 * Tests for Interactive Claude Runtime Idle/Busy Synchronization
 *
 * Covers spec sections 12.3–12.9:
 *   - Startup without priming prompt (runtime.ready -> ready)
 *   - Startup with priming prompt (stays busy until turn.stopped)
 *   - Manual turn lifecycle (turn.started -> busy, turn.stopped -> ready)
 *   - HRC-managed run isolation (activeRunId blocks hook mutations)
 *   - Stale hook handling (stale launch -> rejection event, 2xx response)
 *   - Replay parity (spooled hooks produce same transitions)
 *   - Idempotent runtime start (live interactive launch not double-started)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

function hookEnvelope(
  launchId: string,
  hostSessionId: string,
  generation: number,
  runtimeId: string,
  kind: string,
  hookEvent: unknown = {}
) {
  return {
    launchId,
    hostSessionId,
    generation,
    runtimeId,
    hookData: { kind, hookEvent },
  }
}

function seedLaunch(
  hostSessionId: string,
  runtimeId: string,
  launchId: string,
  status: string,
  opts: { wrapperPid?: number; childPid?: number } = {}
) {
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.launches.insert({
      launchId,
      hostSessionId,
      generation: 1,
      runtimeId,
      harness: 'claude-code',
      provider: 'anthropic',
      launchArtifactPath: '/tmp/fake-artifact.json',
      status,
      ...(opts.wrapperPid !== undefined ? { wrapperPid: opts.wrapperPid } : {}),
      ...(opts.childPid !== undefined ? { childPid: opts.childPid } : {}),
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

function getRuntimeStatus(runtimeId: string): string | undefined {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runtimes.getByRuntimeId(runtimeId)?.status
  } finally {
    db.close()
  }
}

async function getAllEvents(): Promise<any[]> {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.events.listFromSeq(1)
  } finally {
    db.close()
  }
}

async function getAllHrcEvents(): Promise<any[]> {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.listFromHrcSeq(1)
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-hook-lifecycle-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

// ---------------------------------------------------------------------------
// 12.3 Startup without priming prompt
// ---------------------------------------------------------------------------
describe('HRC-managed run isolation', () => {
  it('hooks do not mutate runtime status when activeRunId is set', async () => {
    const hsid = `hsid-${randomUUID()}`
    const rtId = `rt-${randomUUID()}`
    const launchId = `launch-${randomUUID()}`
    const runId = `run-${randomUUID()}`
    const scope = `test-isolation-${randomUUID()}`

    fixture.seedSession(hsid, scope)
    fixture.seedTmuxRuntime(hsid, scope, rtId, {
      status: 'busy',
      launchId,
      activeRunId: runId,
    })
    seedLaunch(hsid, rtId, launchId, 'child_started')

    // All three hook kinds should be no-ops
    for (const kind of ['turn.started', 'turn.stopped', 'runtime.ready']) {
      const res = await fixture.postJson(
        '/v1/internal/hooks/ingest',
        hookEnvelope(launchId, hsid, 1, rtId, kind)
      )
      expect(res.status).toBe(200)
      expect(getRuntimeStatus(rtId)).toBe('busy')
    }

    // Verify no semantic hook events were emitted (only hook.ingested)
    const events = await getAllEvents()
    const semanticHooks = events.filter(
      (e) =>
        e.eventKind === 'hook.turn_started' ||
        e.eventKind === 'hook.turn_stopped' ||
        e.eventKind === 'hook.runtime_ready'
    )
    expect(semanticHooks.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 12.7 Stale hook handling
// ---------------------------------------------------------------------------
describe('stale hook handling', () => {
  it('stale launch hook returns 2xx and appends rejection event', async () => {
    const hsid = `hsid-${randomUUID()}`
    const rtId = `rt-${randomUUID()}`
    const staleLaunchId = `launch-stale-${randomUUID()}`
    const activeLaunchId = `launch-active-${randomUUID()}`
    const scope = `test-stale-${randomUUID()}`

    fixture.seedSession(hsid, scope)
    fixture.seedTmuxRuntime(hsid, scope, rtId, { status: 'ready', launchId: activeLaunchId })
    seedLaunch(hsid, rtId, staleLaunchId, 'child_started')
    seedLaunch(hsid, rtId, activeLaunchId, 'child_started')

    // Send hook for stale launch
    const res = await fixture.postJson(
      '/v1/internal/hooks/ingest',
      hookEnvelope(staleLaunchId, hsid, 1, rtId, 'turn.started')
    )

    // Must return 2xx (spec 8.3)
    expect(res.status).toBe(200)

    // Runtime status must not change
    expect(getRuntimeStatus(rtId)).toBe('ready')

    // Rejection event must be appended
    const events = await getAllHrcEvents()
    const rejections = events.filter((e) => e.eventKind === 'launch.callback_rejected')
    expect(rejections.length).toBeGreaterThanOrEqual(1)
    const rejection = rejections.find(
      (e) => e.launchId === staleLaunchId && e.payload?.callback === 'hook_ingest'
    )
    expect(rejection).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 12.8 Replay parity
// ---------------------------------------------------------------------------
describe('replay parity', () => {
  it('spooled hook ingest produces same events as live path', async () => {
    // Test replay parity by comparing live vs replayed event output.
    // We can't test runtime status directly because startup reconciliation
    // marks tmux runtimes as dead when the tmux session doesn't exist.
    // Instead, verify that the replay path produces the same event kinds
    // (hook.ingested with replayed:true and hook.runtime_ready with replayed:true).

    const hsid = `hsid-${randomUUID()}`
    const rtId = `rt-${randomUUID()}`
    const launchId = `launch-${randomUUID()}`
    const scope = `test-replay-${randomUUID()}`

    // First, test live path for baseline
    fixture.seedSession(hsid, scope)
    fixture.seedTmuxRuntime(hsid, scope, rtId, { status: 'busy', launchId })
    seedLaunch(hsid, rtId, launchId, 'child_started')

    const liveRes = await fixture.postJson(
      '/v1/internal/hooks/ingest',
      hookEnvelope(launchId, hsid, 1, rtId, 'runtime.ready')
    )
    expect(liveRes.status).toBe(200)
    expect(getRuntimeStatus(rtId)).toBe('ready')

    const liveEvents = await getAllEvents()
    const liveIngested = liveEvents.filter((e) => e.eventKind === 'hook.ingested')
    const liveReady = liveEvents.filter((e) => e.eventKind === 'hook.runtime_ready')
    expect(liveIngested.length).toBe(1)
    expect(liveReady.length).toBe(1)

    // Now test replay path: stop server, seed fresh data, write spool, restart
    await server!.stop()
    server = undefined

    const hsid2 = `hsid-${randomUUID()}`
    const rtId2 = `rt-${randomUUID()}`
    const launchId2 = `launch-${randomUUID()}`
    const scope2 = `test-replay2-${randomUUID()}`

    fixture.seedSession(hsid2, scope2)
    fixture.seedTmuxRuntime(hsid2, scope2, rtId2, { status: 'busy', launchId: launchId2 })
    seedLaunch(hsid2, rtId2, launchId2, 'child_started')

    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const spoolLaunchDir = join(fixture.spoolDir, launchId2)
    await mkdir(spoolLaunchDir, { recursive: true })
    await writeFile(
      join(spoolLaunchDir, '001.json'),
      JSON.stringify({
        endpoint: '/v1/internal/hooks/ingest',
        payload: hookEnvelope(launchId2, hsid2, 1, rtId2, 'runtime.ready'),
      })
    )

    server = await createHrcServer(fixture.serverOpts())

    // Verify replayed events include both hook.ingested and hook.runtime_ready
    const replayEvents = await getAllEvents()
    const replayIngested = replayEvents.filter(
      (e) => e.eventKind === 'hook.ingested' && e.eventJson?.replayed === true
    )
    const replayReady = replayEvents.filter(
      (e) => e.eventKind === 'hook.runtime_ready' && e.eventJson?.replayed === true
    )

    // Replay must produce the same event kinds as live, plus replayed:true annotation
    expect(replayIngested.length).toBeGreaterThanOrEqual(1)
    expect(replayReady.length).toBeGreaterThanOrEqual(1)
    expect(replayReady[0].eventJson?.replayed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 12.9 Idempotent runtime start
// ---------------------------------------------------------------------------
describe('idempotent runtime start', () => {
  it('ready legacy tmux runtime with live launch is staled, not reused', async () => {
    const scope = `test-idempotent-${randomUUID()}`
    const resolved = await fixture.resolveSession(scope)
    const hsid = resolved.hostSessionId
    const rtId = `rt-${randomUUID()}`
    const launchId = `launch-${randomUUID()}`

    // Seed a tmux runtime in ready state with a live launch
    // Use PID 1 (init/launchd — always exists) as a live process
    fixture.seedTmuxRuntime(hsid, `agent:${scope}`, rtId, { status: 'ready', launchId })
    seedLaunch(hsid, rtId, launchId, 'child_started', { wrapperPid: 1, childPid: 1 })

    const res = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: {
          provider: 'anthropic',
          interactive: true,
        },
        execution: {
          preferredMode: 'interactive',
        },
      },
    })

    expect(res.status).toBe(503)
    const data = (await res.json()) as any
    expect(data.error?.code).toBe('runtime_unavailable')

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.getByRuntimeId(rtId)?.status).toBe('dead')
      const launches = db.launches.listByRuntimeId(rtId)
      expect(launches.length).toBe(1)
      expect(launches[0].launchId).toBe(launchId)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Claude Stop hook finalizes the active run
// ---------------------------------------------------------------------------
describe('claude Stop hook finalizes active run', () => {
  it('marks run completed, clears activeRunId, returns runtime to ready, and emits turn.completed', async () => {
    const hsid = `hsid-${randomUUID()}`
    const rtId = `rt-${randomUUID()}`
    const launchId = `launch-${randomUUID()}`
    const runId = `run-${randomUUID()}`
    const scope = `test-stop-finalize-${randomUUID()}`

    fixture.seedSession(hsid, scope)
    fixture.seedTmuxRuntime(hsid, scope, rtId, {
      status: 'busy',
      launchId,
      activeRunId: runId,
    })
    seedLaunch(hsid, rtId, launchId, 'child_started')

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runs.insert({
        runId,
        hostSessionId: hsid,
        runtimeId: rtId,
        scopeRef: scope.startsWith('agent:') ? scope : `agent:${scope}`,
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        status: 'started',
        acceptedAt: fixture.now(),
        startedAt: fixture.now(),
        updatedAt: fixture.now(),
      })
    } finally {
      db.close()
    }

    const res = await fixture.postJson('/v1/internal/hooks/ingest', {
      launchId,
      hostSessionId: hsid,
      generation: 1,
      runtimeId: rtId,
      hookData: {
        hook_event_name: 'Stop',
        last_assistant_message: 'done',
      },
    })
    expect(res.status).toBe(200)

    const db2 = openHrcDatabase(fixture.dbPath)
    try {
      const completed = db2.hrcEvents.listByRun(runId, { eventKind: 'turn.completed' })
      expect(completed.length).toBe(1)
      expect(completed[0]?.runtimeId).toBe(rtId)
      expect((completed[0]?.payload as any)?.source).toBe('hook_stop')

      const finalRun = db2.runs.getByRunId(runId)
      expect(finalRun?.status).toBe('completed')
      expect(finalRun?.completedAt).toBeDefined()

      const finalRuntime = db2.runtimes.getByRuntimeId(rtId)
      expect(finalRuntime?.status).toBe('ready')
      expect(finalRuntime?.activeRunId).toBeUndefined()
    } finally {
      db2.close()
    }
  })

  it('is idempotent — a second Stop hook does not double-emit turn.completed', async () => {
    const hsid = `hsid-${randomUUID()}`
    const rtId = `rt-${randomUUID()}`
    const launchId = `launch-${randomUUID()}`
    const runId = `run-${randomUUID()}`
    const scope = `test-stop-idempotent-${randomUUID()}`

    fixture.seedSession(hsid, scope)
    fixture.seedTmuxRuntime(hsid, scope, rtId, {
      status: 'busy',
      launchId,
      activeRunId: runId,
    })
    seedLaunch(hsid, rtId, launchId, 'child_started')

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runs.insert({
        runId,
        hostSessionId: hsid,
        runtimeId: rtId,
        scopeRef: scope.startsWith('agent:') ? scope : `agent:${scope}`,
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        status: 'started',
        acceptedAt: fixture.now(),
        startedAt: fixture.now(),
        updatedAt: fixture.now(),
      })
    } finally {
      db.close()
    }

    const payload = {
      launchId,
      hostSessionId: hsid,
      generation: 1,
      runtimeId: rtId,
      hookData: { hook_event_name: 'Stop', last_assistant_message: 'done' },
    }

    expect((await fixture.postJson('/v1/internal/hooks/ingest', payload)).status).toBe(200)
    expect((await fixture.postJson('/v1/internal/hooks/ingest', payload)).status).toBe(200)

    const db2 = openHrcDatabase(fixture.dbPath)
    try {
      const completed = db2.hrcEvents.listByRun(runId, { eventKind: 'turn.completed' })
      expect(completed.length).toBe(1)
    } finally {
      db2.close()
    }
  })
})
