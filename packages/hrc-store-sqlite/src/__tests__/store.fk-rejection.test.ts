/**
 * M-14: Foreign key rejection tests for hrc-store-sqlite (T-00985)
 *
 * Validates that PRAGMA foreign_keys = ON is enforced across all tables
 * with real FK relations. Each test attempts to insert a row referencing
 * a non-existent parent and asserts that SQLite rejects it.
 *
 * Coverage: runtimes→sessions, runs→sessions, runs→runtimes,
 *           launches→sessions, events→sessions, events→runs,
 *           events→runtimes, surface_bindings→sessions,
 *           surface_bindings→runtimes, app_sessions→sessions,
 *           local_bridges→sessions, local_bridges→runtimes
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLaunchRecord, HrcRunRecord, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'

import type { HrcDatabase } from '../database'
import { openHrcDatabase } from '../index'

let tmpDir: string
let dbPath: string
let db: HrcDatabase

function ts(): string {
  return new Date().toISOString()
}

function testScopeRef(scopeKey: string): string {
  return `agent:test:project:hrc-store-fk:task:${scopeKey}`
}

function makeSession(id: string): HrcSessionRecord {
  return {
    hostSessionId: id,
    scopeRef: testScopeRef('fk-test'),
    laneRef: 'default',
    generation: 1,
    status: 'active',
    createdAt: ts(),
    updatedAt: ts(),
    ancestorScopeRefs: [],
  }
}

function makeRuntime(id: string, hostSessionId: string): HrcRuntimeSnapshot {
  return {
    runtimeId: id,
    hostSessionId,
    scopeRef: testScopeRef('fk-test'),
    laneRef: 'default',
    generation: 1,
    transport: 'stdio',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'idle',
    supportsInflightInput: false,
    adopted: false,
    createdAt: ts(),
    updatedAt: ts(),
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-fk-test-'))
  dbPath = join(tmpDir, 'test.sqlite')
  db = openHrcDatabase(dbPath)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// M-14: FK rejection — every FK reference to a non-existent parent must throw
// ---------------------------------------------------------------------------
describe('M-14: FK rejection on real relations (T-00985)', () => {
  it('rejects runtime with non-existent host_session_id', () => {
    expect(() => {
      db.runtimes.insert(makeRuntime('rt-orphan', 'hsid-does-not-exist'))
    }).toThrow()
  })

  it('rejects run with non-existent host_session_id', () => {
    expect(() => {
      db.runs.insert({
        runId: 'run-orphan',
        hostSessionId: 'hsid-does-not-exist',
        scopeRef: testScopeRef('fk-test'),
        laneRef: 'default',
        generation: 1,
        transport: 'stdio',
        status: 'accepted',
        updatedAt: ts(),
      } as HrcRunRecord)
    }).toThrow()
  })

  it('rejects run with non-existent runtime_id', () => {
    const session = db.sessions.insert(makeSession('hsid-run-fk'))
    expect(() => {
      db.runs.insert({
        runId: 'run-bad-rt',
        hostSessionId: session.hostSessionId,
        runtimeId: 'rt-does-not-exist',
        scopeRef: testScopeRef('fk-test'),
        laneRef: 'default',
        generation: 1,
        transport: 'stdio',
        status: 'accepted',
        updatedAt: ts(),
      })
    }).toThrow()
  })

  it('rejects launch with non-existent host_session_id', () => {
    expect(() => {
      db.launches.insert({
        launchId: 'launch-orphan',
        hostSessionId: 'hsid-does-not-exist',
        generation: 1,
        harness: 'claude-code',
        provider: 'anthropic',
        launchArtifactPath: '/tmp/artifact.json',
        status: 'pending',
        createdAt: ts(),
        updatedAt: ts(),
      } as HrcLaunchRecord)
    }).toThrow()
  })

  it('rejects event with non-existent host_session_id', () => {
    expect(() => {
      db.events.append({
        seq: 0,
        ts: ts(),
        hostSessionId: 'hsid-does-not-exist',
        scopeRef: testScopeRef('fk-test'),
        laneRef: 'default',
        generation: 1,
        source: 'hrc',
        eventKind: 'test',
        eventJson: {},
      })
    }).toThrow()
  })

  it('rejects event with non-existent run_id', () => {
    const session = db.sessions.insert(makeSession('hsid-evt-run'))
    const runtime = db.runtimes.insert(makeRuntime('rt-evt-run', session.hostSessionId))
    expect(() => {
      db.events.append({
        seq: 0,
        ts: ts(),
        hostSessionId: session.hostSessionId,
        scopeRef: testScopeRef('fk-test'),
        laneRef: 'default',
        generation: 1,
        runId: 'run-does-not-exist',
        runtimeId: runtime.runtimeId,
        source: 'hrc',
        eventKind: 'test',
        eventJson: {},
      })
    }).toThrow()
  })

  it('rejects event with non-existent runtime_id', () => {
    const session = db.sessions.insert(makeSession('hsid-evt-rt'))
    expect(() => {
      db.events.append({
        seq: 0,
        ts: ts(),
        hostSessionId: session.hostSessionId,
        scopeRef: testScopeRef('fk-test'),
        laneRef: 'default',
        generation: 1,
        runtimeId: 'rt-does-not-exist',
        source: 'hrc',
        eventKind: 'test',
        eventJson: {},
      })
    }).toThrow()
  })

  it('rejects surface_binding with non-existent host_session_id', () => {
    expect(() => {
      db.surfaceBindings.bind({
        surfaceKind: 'terminal',
        surfaceId: 'term-1',
        hostSessionId: 'hsid-does-not-exist',
        runtimeId: 'rt-does-not-exist',
        generation: 1,
        boundAt: ts(),
      })
    }).toThrow()
  })

  it('rejects surface_binding with non-existent runtime_id', () => {
    const session = db.sessions.insert(makeSession('hsid-sb-rt'))
    expect(() => {
      db.surfaceBindings.bind({
        surfaceKind: 'terminal',
        surfaceId: 'term-2',
        hostSessionId: session.hostSessionId,
        runtimeId: 'rt-does-not-exist',
        generation: 1,
        boundAt: ts(),
      })
    }).toThrow()
  })

  it('rejects app_session with non-existent host_session_id', () => {
    expect(() => {
      db.appSessions.create({
        appId: 'app-test',
        appSessionKey: 'key-1',
        hostSessionId: 'hsid-does-not-exist',
        createdAt: ts(),
        updatedAt: ts(),
      })
    }).toThrow()
  })

  it('rejects local_bridge with non-existent host_session_id', () => {
    expect(() => {
      db.localBridges.create({
        bridgeId: 'bridge-orphan',
        hostSessionId: 'hsid-does-not-exist',
        runtimeId: 'rt-does-not-exist',
        transport: 'unix',
        target: '/tmp/bridge.sock',
        status: 'active',
        createdAt: ts(),
      })
    }).toThrow()
  })

  it('rejects local_bridge with non-existent runtime_id', () => {
    const session = db.sessions.insert(makeSession('hsid-lb-rt'))
    expect(() => {
      db.localBridges.create({
        bridgeId: 'bridge-bad-rt',
        hostSessionId: session.hostSessionId,
        runtimeId: 'rt-does-not-exist',
        transport: 'unix',
        target: '/tmp/bridge.sock',
        status: 'active',
        createdAt: ts(),
      })
    }).toThrow()
  })

  // Positive control: valid FK chain succeeds
  it('accepts valid FK chain session→runtime→run→event', () => {
    const session = db.sessions.insert(makeSession('hsid-valid'))
    const runtime = db.runtimes.insert(makeRuntime('rt-valid', session.hostSessionId))
    const run = db.runs.insert({
      runId: 'run-valid',
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: testScopeRef('fk-test'),
      laneRef: 'default',
      generation: 1,
      transport: 'stdio',
      status: 'accepted',
      updatedAt: ts(),
    })
    const event = db.events.append({
      seq: 0,
      ts: ts(),
      hostSessionId: session.hostSessionId,
      scopeRef: testScopeRef('fk-test'),
      laneRef: 'default',
      generation: 1,
      runId: run.runId,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind: 'test',
      eventJson: { ok: true },
    })
    expect(event.seq).toBeGreaterThan(0)
  })
})
