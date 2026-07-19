import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'

import { openHrcDatabase } from '../index'

let tmpDir: string
let dbPath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-status-changed-at-'))
  dbPath = join(tmpDir, 'state.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function seedRuntime(
  db: ReturnType<typeof openHrcDatabase>,
  overrides: Partial<HrcRuntimeSnapshot> = {}
): HrcRuntimeSnapshot {
  const hostSessionId = overrides.hostSessionId ?? 'hsid-status-changed-at'
  const scopeRef = overrides.scopeRef ?? 'agent:test:project:hrc-runtime:task:T-06578'
  db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
    ancestorScopeRefs: [],
  })
  return db.runtimes.insert({
    runtimeId: 'rt-status-changed-at',
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:02:00.000Z',
    lastActivityAt: '2026-07-18T10:01:00.000Z',
    ...overrides,
  })
}

describe('T-06578 runtime repository statusChangedAt', () => {
  it('guards statusChangedAt in the repository when a same-status write is replayed', () => {
    const bootstrap = new Database(dbPath)
    bootstrap.exec('CREATE TABLE bootstrap (id INTEGER PRIMARY KEY)')
    bootstrap.close()

    const db = openHrcDatabase(dbPath)
    try {
      seedRuntime(db)
      const changedAt = '2026-07-18T10:03:00.000Z'
      const replayedAt = '2026-07-18T10:04:00.000Z'
      db.runtimes.update('rt-status-changed-at', {
        status: 'busy',
        statusChangedAt: changedAt,
        updatedAt: '2026-07-18T11:00:00.000Z',
      })
      db.runtimes.update('rt-status-changed-at', {
        status: 'busy',
        statusChangedAt: replayedAt,
        updatedAt: '2026-07-18T12:00:00.000Z',
      })

      expect(db.runtimes.getByRuntimeId('rt-status-changed-at')).toMatchObject({
        status: 'busy',
        statusChangedAt: changedAt,
        updatedAt: '2026-07-18T12:00:00.000Z',
      })
    } finally {
      db.close()
    }
  })

  it('migrates a nullable column and maps null to unknown without timestamp derivation', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const columns = db.sqlite.query<{ name: string }, []>('PRAGMA table_info(runtimes)').all()
      expect(columns.map((column) => column.name)).toContain('status_changed_at')

      const runtime = seedRuntime(db)
      expect(runtime.statusChangedAt).toBe('unknown')
      expect(runtime.statusChangedAt).not.toBe(runtime.lastActivityAt)
      expect(runtime.statusChangedAt).not.toBe(runtime.updatedAt)
      expect(
        db.sqlite
          .query<{ status_changed_at: string | null }, []>(
            'SELECT status_changed_at FROM runtimes WHERE runtime_id = "rt-status-changed-at"'
          )
          .get()?.status_changed_at
      ).toBeNull()
    } finally {
      db.close()
    }
  })
})
