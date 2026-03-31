/**
 * RED/GREEN tests for HRC server sessions/apply endpoint (T-00971 / Phase 5)
 *
 * Tests POST /v1/sessions/apply for app-owned session reconciliation:
 *   - Single session create via apply
 *   - Single session update via apply (label/metadata change)
 *   - Bulk upsert: inserts new + updates existing + marks removed
 *   - Idempotent re-apply produces same state
 *   - Apply is scoped to appId (other app sessions untouched)
 *   - Returns reconciliation summary { inserted, updated, removed }
 *
 * Pass conditions for Larry (T-00971):
 *   1. POST /v1/sessions/apply accepts { appId, hostSessionId, sessions: [...] }
 *   2. Returns 200 with { inserted, updated, removed } counts
 *   3. New sessions in the apply set are created (inserted > 0)
 *   4. Existing sessions with changed fields are updated (updated > 0)
 *   5. Sessions absent from the apply set are marked removed (removed > 0)
 *   6. GET /v1/sessions/app?appId=X&hostSessionId=Y returns reconciled records
 *   7. Removed records have removedAt set
 *   8. Re-apply same set is idempotent (inserted=0, removed=0)
 *   9. Apply for appId=A does not affect appId=B records
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

// RED GATE: server must handle POST /v1/sessions/apply and GET /v1/sessions/app
import { createHrcServer } from '../index'
import type { HrcServer, HrcServerOptions } from '../index'

// RED GATE: this type does not exist yet in hrc-core
import type { HrcAppSessionRecord } from 'hrc-core'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string

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
 * Helper: resolve a session so we have a valid hostSessionId for apply calls.
 */
async function resolveHostSession(scopeRef: string): Promise<{
  hostSessionId: string
  generation: number
}> {
  const res = await postJson('/v1/sessions/resolve', {
    sessionRef: `${scopeRef}/lane:default`,
  })
  return (await res.json()) as { hostSessionId: string; generation: number }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-server-apply-test-'))
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

// ---------------------------------------------------------------------------
// 1. POST /v1/sessions/apply — create new app sessions
// ---------------------------------------------------------------------------
describe('POST /v1/sessions/apply', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('creates new app sessions and returns insertion count', async () => {
    server = await createHrcServer(serverOpts())
    const { hostSessionId } = await resolveHostSession('apply-create-test')

    const res = await postJson('/v1/sessions/apply', {
      appId: 'workbench',
      hostSessionId,
      sessions: [
        { appSessionKey: 'ws-1', label: 'Workspace 1' },
        { appSessionKey: 'ws-2', label: 'Workspace 2' },
      ],
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { inserted: number; updated: number; removed: number }
    expect(body.inserted).toBe(2)
    expect(body.updated).toBe(0)
    expect(body.removed).toBe(0)
  })

  it('updates existing sessions when label/metadata change', async () => {
    server = await createHrcServer(serverOpts())
    const { hostSessionId } = await resolveHostSession('apply-update-test')

    // First apply — create
    await postJson('/v1/sessions/apply', {
      appId: 'workbench',
      hostSessionId,
      sessions: [{ appSessionKey: 'ws-upd', label: 'Original' }],
    })

    // Second apply — update label
    const res = await postJson('/v1/sessions/apply', {
      appId: 'workbench',
      hostSessionId,
      sessions: [{ appSessionKey: 'ws-upd', label: 'Renamed' }],
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { inserted: number; updated: number; removed: number }
    expect(body.inserted).toBe(0)
    expect(body.updated).toBe(1)
    expect(body.removed).toBe(0)
  })

  it('marks sessions as removed when absent from apply set', async () => {
    server = await createHrcServer(serverOpts())
    const { hostSessionId } = await resolveHostSession('apply-remove-test')

    // Create two sessions
    await postJson('/v1/sessions/apply', {
      appId: 'workbench',
      hostSessionId,
      sessions: [
        { appSessionKey: 'ws-keep', label: 'Keep' },
        { appSessionKey: 'ws-drop', label: 'Drop' },
      ],
    })

    // Re-apply with only ws-keep
    const res = await postJson('/v1/sessions/apply', {
      appId: 'workbench',
      hostSessionId,
      sessions: [{ appSessionKey: 'ws-keep', label: 'Keep' }],
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { inserted: number; updated: number; removed: number }
    expect(body.removed).toBe(1)
  })

  it('is idempotent on re-apply', async () => {
    server = await createHrcServer(serverOpts())
    const { hostSessionId } = await resolveHostSession('apply-idem-test')

    const sessions = [
      { appSessionKey: 'ws-a', label: 'A' },
      { appSessionKey: 'ws-b', label: 'B' },
    ]

    await postJson('/v1/sessions/apply', {
      appId: 'workbench',
      hostSessionId,
      sessions,
    })

    const res = await postJson('/v1/sessions/apply', {
      appId: 'workbench',
      hostSessionId,
      sessions,
    })

    const body = (await res.json()) as { inserted: number; updated: number; removed: number }
    expect(body.inserted).toBe(0)
    expect(body.removed).toBe(0)
  })

  it('is scoped to appId — other apps untouched', async () => {
    server = await createHrcServer(serverOpts())
    const { hostSessionId } = await resolveHostSession('apply-scope-test')

    // Create sessions for app-A
    await postJson('/v1/sessions/apply', {
      appId: 'app-A',
      hostSessionId,
      sessions: [{ appSessionKey: 'a-session' }],
    })

    // Apply for app-B (empty set) should NOT remove app-A sessions
    await postJson('/v1/sessions/apply', {
      appId: 'app-B',
      hostSessionId,
      sessions: [],
    })

    // Verify app-A session still exists via direct DB check
    const db = openHrcDatabase(dbPath)
    try {
      const record = db.appSessions.findByKey('app-A', 'a-session')
      expect(record).not.toBeNull()
      expect(record!.removedAt).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. GET /v1/sessions/app — query reconciled app sessions
// ---------------------------------------------------------------------------
describe('GET /v1/sessions/app', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns reconciled app sessions for appId + hostSessionId', async () => {
    server = await createHrcServer(serverOpts())
    const { hostSessionId } = await resolveHostSession('query-app-test')

    await postJson('/v1/sessions/apply', {
      appId: 'workbench',
      hostSessionId,
      sessions: [
        { appSessionKey: 'qs-1', label: 'Query 1' },
        { appSessionKey: 'qs-2', label: 'Query 2' },
      ],
    })

    const res = await fetchSocket(`/v1/sessions/app?appId=workbench&hostSessionId=${hostSessionId}`)
    expect(res.status).toBe(200)
    const records = (await res.json()) as HrcAppSessionRecord[]
    expect(records.length).toBe(2)
    expect(records.map((r) => r.appSessionKey).sort()).toEqual(['qs-1', 'qs-2'])
  })

  it('includes removedAt on removed records', async () => {
    server = await createHrcServer(serverOpts())
    const { hostSessionId } = await resolveHostSession('query-removed-test')

    // Create then remove
    await postJson('/v1/sessions/apply', {
      appId: 'workbench',
      hostSessionId,
      sessions: [{ appSessionKey: 'qs-gone', label: 'Gone' }],
    })
    await postJson('/v1/sessions/apply', {
      appId: 'workbench',
      hostSessionId,
      sessions: [],
    })

    const res = await fetchSocket(`/v1/sessions/app?appId=workbench&hostSessionId=${hostSessionId}`)
    const records = (await res.json()) as HrcAppSessionRecord[]
    const removed = records.find((r) => r.appSessionKey === 'qs-gone')
    expect(removed).toBeDefined()
    expect(removed!.removedAt).toBeDefined()
  })

  it('returns 400 when appId is missing', async () => {
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/sessions/app?hostSessionId=whatever')
    expect(res.status).toBe(400)
  })

  it('returns 400 when hostSessionId is missing', async () => {
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/sessions/app?appId=workbench')
    expect(res.status).toBe(400)
  })
})
