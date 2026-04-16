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
  const res = await fixture.fetchSocket('/v1/events?fromSeq=1')
  const text = await res.text()
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
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
describe('startup without priming prompt', () => {
  it('child-started sets busy, then runtime.ready sets ready', async () => {
    const hsid = `hsid-${randomUUID()}`
    const rtId = `rt-${randomUUID()}`
    const launchId = `launch-${randomUUID()}`
    const scope = `test-startup-noprime-${randomUUID()}`

    fixture.seedSession(hsid, scope)
    fixture.seedTmuxRuntime(hsid, scope, rtId, { status: 'busy', launchId })
    seedLaunch(hsid, rtId, launchId, 'child_started')

    // Verify starts as busy
    expect(getRuntimeStatus(rtId)).toBe('busy')

    // Send runtime.ready hook (simulating session_start without priming prompt)
    const res = await fixture.postJson(
      '/v1/internal/hooks/ingest',
      hookEnvelope(launchId, hsid, 1, rtId, 'runtime.ready')
    )
    expect(res.status).toBe(200)
    expect(getRuntimeStatus(rtId)).toBe('ready')
  })
})

// ---------------------------------------------------------------------------
// 12.4 Startup with priming prompt
// ---------------------------------------------------------------------------
describe('startup with priming prompt', () => {
  it('runtime stays busy until turn.stopped', async () => {
    const hsid = `hsid-${randomUUID()}`
    const rtId = `rt-${randomUUID()}`
    const launchId = `launch-${randomUUID()}`
    const scope = `test-startup-prime-${randomUUID()}`

    fixture.seedSession(hsid, scope)
    fixture.seedTmuxRuntime(hsid, scope, rtId, { status: 'busy', launchId })
    seedLaunch(hsid, rtId, launchId, 'child_started')

    // With priming prompt, session-ready.sh exits without sending runtime.ready.
    // The runtime stays busy. Only turn.stopped transitions to ready.
    expect(getRuntimeStatus(rtId)).toBe('busy')

    // turn.stopped sets it to ready
    const res = await fixture.postJson(
      '/v1/internal/hooks/ingest',
      hookEnvelope(launchId, hsid, 1, rtId, 'turn.stopped')
    )
    expect(res.status).toBe(200)
    expect(getRuntimeStatus(rtId)).toBe('ready')
  })
})

// ---------------------------------------------------------------------------
// 12.5 Manual turn lifecycle
// ---------------------------------------------------------------------------
describe('manual turn lifecycle', () => {
  it('turn.started sets busy, turn.stopped sets ready', async () => {
    const hsid = `hsid-${randomUUID()}`
    const rtId = `rt-${randomUUID()}`
    const launchId = `launch-${randomUUID()}`
    const scope = `test-turn-${randomUUID()}`

    fixture.seedSession(hsid, scope)
    fixture.seedTmuxRuntime(hsid, scope, rtId, { status: 'ready', launchId })
    seedLaunch(hsid, rtId, launchId, 'child_started')

    expect(getRuntimeStatus(rtId)).toBe('ready')

    // turn.started -> busy
    let res = await fixture.postJson(
      '/v1/internal/hooks/ingest',
      hookEnvelope(launchId, hsid, 1, rtId, 'turn.started')
    )
    expect(res.status).toBe(200)
    expect(getRuntimeStatus(rtId)).toBe('busy')

    // turn.stopped -> ready
    res = await fixture.postJson(
      '/v1/internal/hooks/ingest',
      hookEnvelope(launchId, hsid, 1, rtId, 'turn.stopped')
    )
    expect(res.status).toBe(200)
    expect(getRuntimeStatus(rtId)).toBe('ready')

    // Verify semantic events emitted
    const events = await getAllEvents()
    const hookEvents = events.filter(
      (e) => e.eventKind === 'hook.turn_started' || e.eventKind === 'hook.turn_stopped'
    )
    expect(hookEvents.length).toBe(2)
    expect(hookEvents[0].eventKind).toBe('hook.turn_started')
    expect(hookEvents[1].eventKind).toBe('hook.turn_stopped')
  })
})

// ---------------------------------------------------------------------------
// 12.6 HRC-managed run isolation
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
    const events = await getAllEvents()
    const rejections = events.filter((e) => e.eventKind === 'launch.callback_rejected')
    expect(rejections.length).toBeGreaterThanOrEqual(1)
    const rejection = rejections.find(
      (e) => e.eventJson?.launchId === staleLaunchId && e.eventJson?.callback === 'hook_ingest'
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
  it('ready runtime with live launch is not double-started', async () => {
    // This test seeds a tmux runtime with status=ready and a live child_started
    // launch, then calls /v1/runtimes/start. The server should reuse the
    // existing runtime rather than enqueuing a new launch.
    const scope = `test-idempotent-${randomUUID()}`
    const resolved = await fixture.resolveSession(scope)
    const hsid = resolved.hostSessionId
    const rtId = `rt-${randomUUID()}`
    const launchId = `launch-${randomUUID()}`

    // Seed a tmux runtime in ready state with a live launch
    // Use PID 1 (init/launchd — always exists) as a live process
    fixture.seedTmuxRuntime(hsid, `agent:${scope}`, rtId, { status: 'ready', launchId })
    seedLaunch(hsid, rtId, launchId, 'child_started', { wrapperPid: 1, childPid: 1 })

    // Request runtime start — should reuse existing
    const res = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
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

    // The response should be successful and return the existing runtime
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.runtimeId).toBe(rtId)

    // Verify no new launches were created
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const launches = db.launches.listByRuntimeId(rtId)
      expect(launches.length).toBe(1)
      expect(launches[0].launchId).toBe(launchId)
    } finally {
      db.close()
    }
  })
})
