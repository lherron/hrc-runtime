/**
 * T-08576 R-C1..R-C6: app identity creation is validated and committed atomically.
 * Real SQLite is used throughout; the only seam is command launch after the identity commit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EnsureAppSessionRequest, HrcCommandSpec, HrcSessionRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  ensureAppSessionFromBody,
  handleApplyManagedAppSessions,
  removeAppSessionFromBody,
} from '../app-session-handlers'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

const NOW = '2026-09-17T06:50:00.000Z'

let dir: string
let db: HrcDatabase

beforeEach(async () => {
  Reflect.deleteProperty(process.env, 'HRC_ALLOW_HARNESS_SHIM')
  dir = await mkdtemp(join(tmpdir(), 't08576-atomic-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

function commandRequest(appSessionKey: string): EnsureAppSessionRequest {
  return {
    selector: { appId: 't08576', appSessionKey },
    spec: {
      kind: 'command',
      command: { launchMode: 'exec', argv: ['/bin/true'] },
    },
  }
}

function makeServer(launch: 'succeed' | 'reject' = 'succeed') {
  const launchHosts: string[] = []
  let runtimeSequence = 0
  const instance = {
    db,
    options: {},
    notifyEvent: () => {},
    ensureCommandRuntimeForSession: async (session: HrcSessionRecord, command: HrcCommandSpec) => {
      launchHosts.push(session.hostSessionId)
      if (launch === 'reject') throw new Error('t08576 injected launch failure')
      runtimeSequence += 1
      const runtimeId = `rt-t08576-atomic-${runtimeSequence}`
      db.runtimes.insert({
        runtimeId,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        transport: 'tmux',
        harness: 'command',
        provider: 'command',
        status: 'ready',
        runtimeKind: 'command',
        commandSpec: command,
        supportsInflightInput: false,
        adopted: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const runtime = db.runtimes.getByRuntimeId(runtimeId)
      if (!runtime) throw new Error('failed to seed command runtime')
      return runtime
    },
    ensureAppSessionFromBody,
    removeAppSessionFromBody,
  } as unknown as HrcServerInstanceForHandlers
  return { instance, launchHosts }
}

function captureFailure(
  error: unknown,
  includeMessage = false
): { name: string; code?: string; message?: string } {
  const value = error as { name?: string; code?: string; message?: string }
  return {
    name: value.name ?? String(error),
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(!includeMessage || value.message === undefined ? {} : { message: value.message }),
  }
}

async function callEnsure(
  instance: HrcServerInstanceForHandlers,
  request: EnsureAppSessionRequest,
  includeFailureMessage = false
): Promise<{
  response?: Record<string, unknown>
  error?: { name: string; code?: string; message?: string }
}> {
  try {
    const response = await ensureAppSessionFromBody.call(instance, request)
    return { response: (await response.json()) as Record<string, unknown> }
  } catch (error) {
    return { error: captureFailure(error, includeFailureMessage) }
  }
}

function counts(): Record<string, number> {
  const tables = db.sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'hrc_migrations' ORDER BY name"
    )
    .all()
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      db.sqlite.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM "${name}"`).get()
        ?.count ?? 0,
    ])
  )
}

function changedCounts(before: Record<string, number>): Record<string, number> {
  const after = counts()
  return Object.fromEntries(
    Object.keys(after)
      .filter((table) => after[table] !== before[table])
      .map((table) => [table, after[table]! - (before[table] ?? 0)])
  )
}

function rawContinuity(scopeRef: string, laneRef: string): string | undefined {
  return db.sqlite
    .query<{ active_host_session_id: string }, [string, string]>(
      'SELECT active_host_session_id FROM continuities WHERE scope_ref = ? AND lane_ref = ?'
    )
    .get(scopeRef, laneRef)?.active_host_session_id
}

describe('T-08576 atomic app identity creation', () => {
  it('R-C1 rejects a non-token selector before every write', async () => {
    const { instance, launchHosts } = makeServer()
    const before = counts()

    const result = await callEnsure(instance, commandRequest('bad/key'))

    expect({ result, changes: changedCounts(before), launchHosts }).toEqual({
      result: { error: { name: 'HrcBadRequestError', code: 'malformed_request' } },
      changes: {},
      launchHosts: [],
    })
  })

  it('R-C2 rolls session, continuity, index and event writes back on managed-row failure', async () => {
    const { instance, launchHosts } = makeServer()
    db.sqlite.exec(`
      INSERT INTO sessions (
        host_session_id, scope_ref, lane_ref, generation, status, created_at, updated_at,
        ancestor_scope_refs_json
      ) VALUES ('hsid-prior', 'app:t08576', 'rollback', 0, 'archived', '${NOW}', '${NOW}', '[]');
      INSERT INTO continuities (scope_ref, lane_ref, active_host_session_id, updated_at)
      VALUES ('app:t08576', 'rollback', 'hsid-prior', '${NOW}');
      CREATE TRIGGER t08576_abort_managed BEFORE INSERT ON app_managed_sessions
      BEGIN SELECT RAISE(ABORT, 't08576 injected'); END;
    `)
    const before = counts()

    const result = await callEnsure(instance, commandRequest('rollback'), true)

    expect({
      errorName: result.error?.name,
      injectedFailure: result.error?.message?.includes('t08576 injected') ?? false,
      changes: changedCounts(before),
      continuity: rawContinuity('app:t08576', 'rollback'),
      launchHosts,
    }).toEqual({
      errorName: 'SQLiteError',
      injectedFailure: true,
      changes: {},
      continuity: 'hsid-prior',
      launchHosts: [],
    })
  })

  it('R-C3 commits session, continuity, managed row and created event as one identity', async () => {
    const { instance, launchHosts } = makeServer()

    const result = await callEnsure(instance, commandRequest('commit'))
    const managed = db.appManagedSessions.findByKey('t08576', 'commit')
    const hostSessionId = managed?.activeHostSessionId
    const createdEvents = db.sqlite
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM hrc_events WHERE event_kind = 'app-session.created'"
      )
      .get()?.count

    expect({
      result,
      hostSessionId,
      continuity: rawContinuity('app:t08576', 'commit'),
      session: hostSessionId ? db.sessions.getByHostSessionId(hostSessionId)?.hostSessionId : null,
      createdEvents,
      launchHosts,
    }).toEqual({
      result: { response: expect.objectContaining({ created: true }) },
      hostSessionId: expect.any(String),
      continuity: hostSessionId,
      session: hostSessionId,
      createdEvents: 1,
      launchHosts: [hostSessionId],
    })
  })

  it('R-C4 preserves the committed identity across launch failure and converges on retry', async () => {
    const rejecting = makeServer('reject')
    const first = await callEnsure(rejecting.instance, commandRequest('stable'))
    const committed = db.appManagedSessions.findByKey('t08576', 'stable')
    const hostSessionId = committed?.activeHostSessionId

    const succeeding = makeServer('succeed')
    const retry = await callEnsure(succeeding.instance, commandRequest('stable'))

    expect({
      first,
      committed: committed !== null,
      continuity: rawContinuity('app:t08576', 'stable'),
      retry,
      hostAfterRetry: db.appManagedSessions.findByKey('t08576', 'stable')?.activeHostSessionId,
      sessionCount: db.sqlite
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sessions WHERE scope_ref = 'app:t08576' AND lane_ref = 'stable'"
        )
        .get()?.count,
      retryLaunchHosts: succeeding.launchHosts,
    }).toEqual({
      first: { error: { name: 'Error' } },
      committed: true,
      continuity: hostSessionId,
      retry: { response: expect.objectContaining({ created: false }) },
      hostAfterRetry: hostSessionId,
      sessionCount: 1,
      retryLaunchHosts: [hostSessionId],
    })
  })

  it('R-C5 repoints a defect orphan in the create transaction and never launches it', async () => {
    db.sqlite.exec(`
      INSERT INTO sessions (
        host_session_id, scope_ref, lane_ref, generation, status, created_at, updated_at,
        ancestor_scope_refs_json
      ) VALUES ('hsid-defect-orphan', 'app:t08576', 'orphan', 1, 'active', '${NOW}', '${NOW}', '[]');
      INSERT INTO continuities (scope_ref, lane_ref, active_host_session_id, updated_at)
      VALUES ('app:t08576', 'orphan', 'hsid-defect-orphan', '${NOW}');
    `)
    const { instance, launchHosts } = makeServer()

    const result = await callEnsure(instance, commandRequest('orphan'))
    const current = db.appManagedSessions.findByKey('t08576', 'orphan')?.activeHostSessionId

    expect({
      result,
      current,
      continuity: rawContinuity('app:t08576', 'orphan'),
      launchHosts,
    }).toEqual({
      result: { response: expect.objectContaining({ created: true }) },
      current: expect.any(String),
      continuity: current,
      launchHosts: [current],
    })
    expect(current).not.toBe('hsid-defect-orphan')
  })

  it('R-C6 validates every apply entry before touching the valid prefix', async () => {
    const { instance, launchHosts } = makeServer()
    const before = counts()
    const request = new Request('http://hrc/v1/app-sessions/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId: 't08576',
        sessions: [
          { appSessionKey: 'valid', spec: commandRequest('valid').spec },
          { appSessionKey: 'bad/key', spec: commandRequest('bad/key').spec },
        ],
      }),
    })

    let failure: { name: string; code?: string } | undefined
    try {
      await handleApplyManagedAppSessions.call(instance, request)
    } catch (error) {
      failure = captureFailure(error)
    }

    expect({ failure, changes: changedCounts(before), launchHosts }).toEqual({
      failure: { name: 'HrcBadRequestError', code: 'malformed_request' },
      changes: {},
      launchHosts: [],
    })
  })
})
