import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHrcDatabase, openHrcDatabase } from '../database.js'
import { phase1Migrations } from '../migrations.js'

let tmpDir: string
let dbPath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-session-index-'))
  dbPath = join(tmpDir, 'state.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function seedCurrent(
  db: ReturnType<typeof openHrcDatabase>,
  input: {
    hostSessionId: string
    scopeRef?: string | undefined
    laneRef?: string | undefined
    updatedAt?: string | undefined
  }
) {
  const scopeRef = input.scopeRef ?? `agent:cody:project:hrc-runtime:task:${input.hostSessionId}`
  const laneRef = input.laneRef ?? 'main'
  const updatedAt = input.updatedAt ?? '2026-08-11T10:00:00.000Z'
  db.sessions.insert({
    hostSessionId: input.hostSessionId,
    scopeRef,
    laneRef,
    generation: 1,
    status: 'active',
    createdAt: updatedAt,
    updatedAt,
    ancestorScopeRefs: [],
  })
  db.continuities.upsert({
    scopeRef,
    laneRef,
    activeHostSessionId: input.hostSessionId,
    updatedAt,
  })
  return { scopeRef, laneRef, updatedAt }
}

function insertRuntime(
  db: ReturnType<typeof openHrcDatabase>,
  input: {
    hostSessionId: string
    scopeRef: string
    laneRef: string
    runtimeId: string
    status?: string | undefined
    transport?: 'headless' | 'tmux' | undefined
    supportsInflightInput?: boolean | undefined
    lastActivityAt?: string | undefined
    updatedAt?: string | undefined
  }
) {
  const updatedAt = input.updatedAt ?? '2026-08-11T10:01:00.000Z'
  return db.runtimes.insert({
    runtimeId: input.runtimeId,
    hostSessionId: input.hostSessionId,
    scopeRef: input.scopeRef,
    laneRef: input.laneRef,
    generation: 1,
    transport: input.transport ?? 'tmux',
    harness: 'codex-cli',
    provider: 'openai',
    status: input.status ?? 'ready',
    supportsInflightInput: input.supportsInflightInput ?? true,
    adopted: false,
    ...(input.lastActivityAt === undefined ? {} : { lastActivityAt: input.lastActivityAt }),
    createdAt: updatedAt,
    updatedAt,
  })
}

function appendEvent(
  db: ReturnType<typeof openHrcDatabase>,
  hostSessionId: string,
  scopeRef: string,
  laneRef: string,
  ts: string
) {
  db.hrcEvents.append({
    ts,
    hostSessionId,
    scopeRef,
    laneRef,
    generation: 1,
    category: 'turn',
    eventKind: 'turn.progress',
    payload: {},
  })
}

describe('session_index maintained projection', () => {
  test('tracks current lineages and derives Mobile status/mode at write time', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const seeded = seedCurrent(db, { hostSessionId: 'hsid-a' })
      expect(db.sessionIndex.listPage({ limit: 10 }).items[0]).toMatchObject({
        hostSessionId: 'hsid-a',
        agentId: 'cody',
        projectId: 'hrc-runtime',
        effectiveStatus: 'inactive',
        executionMode: 'nonInteractive',
        lastActivityAt: seeded.updatedAt,
      })

      insertRuntime(db, {
        hostSessionId: 'hsid-a',
        scopeRef: seeded.scopeRef,
        laneRef: seeded.laneRef,
        runtimeId: 'rt-a',
        status: 'ready',
        supportsInflightInput: true,
        lastActivityAt: '2026-08-11T10:02:00.000Z',
      })
      expect(db.sessionIndex.listPage({ limit: 10 }).items[0]).toMatchObject({
        effectiveStatus: 'active',
        executionMode: 'interactive',
        lastActivityAt: '2026-08-11T10:02:00.000Z',
      })

      db.sessions.updateIntent(
        'hsid-a',
        {
          execution: { preferredMode: 'headless' },
          harness: { id: 'codex-cli', provider: 'openai' },
        },
        '2026-08-11T10:05:00.000Z'
      )
      expect(db.sessionIndex.listPage({ limit: 10 }).items[0]).toMatchObject({
        executionMode: 'headless',
        lastActivityAt: '2026-08-11T10:02:00.000Z',
      })

      db.runtimes.updateStatus('rt-a', 'detached', '2026-08-11T10:06:00.000Z')
      expect(db.sessionIndex.listPage({ limit: 10 }).items[0]).toMatchObject({
        effectiveStatus: 'detached',
        lastActivityAt: '2026-08-11T10:02:00.000Z',
      })
    } finally {
      db.close()
    }
  })

  test('only contributing timestamps advance recency and MAX absorbs regressions', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const seeded = seedCurrent(db, { hostSessionId: 'hsid-a' })
      insertRuntime(db, {
        hostSessionId: 'hsid-a',
        scopeRef: seeded.scopeRef,
        laneRef: seeded.laneRef,
        runtimeId: 'rt-a',
        lastActivityAt: '2026-08-11T11:00:00.000Z',
      })
      appendEvent(db, 'hsid-a', seeded.scopeRef, seeded.laneRef, '2026-08-11T12:00:00.000Z')
      appendEvent(db, 'hsid-a', seeded.scopeRef, seeded.laneRef, '2026-08-11T09:00:00.000Z')
      db.runtimes.updateActivity('rt-a', '2026-08-11T10:30:00.000Z', '2026-08-11T13:00:00.000Z')
      db.sessions.updateParsedScope('hsid-a', { agentId: 'cody' }, '2026-08-11T14:00:00.000Z')
      db.sessions.updateContinuation(
        'hsid-a',
        { provider: 'openai', key: 'thread' },
        '2026-08-11T15:00:00.000Z'
      )
      db.sessions.updateStatus('hsid-a', 'active', '2026-08-11T16:00:00.000Z')

      expect(db.sessionIndex.listPage({ limit: 10 }).items[0]?.lastActivityAt).toBe(
        '2026-08-11T12:00:00.000Z'
      )
    } finally {
      db.close()
    }
  })

  test('rotating continuity replaces the lineage row with the current generation', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const first = seedCurrent(db, {
        hostSessionId: 'hsid-g1',
        updatedAt: '2026-08-11T12:00:00.000Z',
      })
      db.sessions.insert({
        hostSessionId: 'hsid-g2',
        scopeRef: first.scopeRef,
        laneRef: first.laneRef,
        generation: 2,
        status: 'active',
        priorHostSessionId: 'hsid-g1',
        createdAt: '2026-08-11T09:00:00.000Z',
        updatedAt: '2026-08-11T09:00:00.000Z',
        ancestorScopeRefs: [],
      })
      db.continuities.upsert({
        scopeRef: first.scopeRef,
        laneRef: first.laneRef,
        activeHostSessionId: 'hsid-g2',
        updatedAt: '2026-08-11T12:01:00.000Z',
      })
      expect(db.sessionIndex.listPage({ limit: 10 }).items).toEqual([
        expect.objectContaining({
          hostSessionId: 'hsid-g2',
          generation: 2,
          lastActivityAt: '2026-08-11T09:00:00.000Z',
        }),
      ])
    } finally {
      db.close()
    }
  })

  test('page keyset re-serves cut rows and facets self-exclude each dimension', () => {
    const db = openHrcDatabase(dbPath)
    try {
      for (const [id, time, agent] of [
        ['a', '2026-08-11T12:00:00.000Z', 'cody'],
        ['b', '2026-08-11T12:00:00.000Z', 'mable'],
        ['c', '2026-08-11T11:00:00.000Z', 'cody'],
      ] as const) {
        seedCurrent(db, {
          hostSessionId: `hsid-${id}`,
          scopeRef: `agent:${agent}:project:hrc-runtime:task:${id}`,
          updatedAt: time,
        })
      }
      const first = db.sessionIndex.listPage({ limit: 1 })
      expect(first.hasMore).toBe(true)
      const second = db.sessionIndex.listPage({
        limit: 2,
        cursor: {
          lastActivityAt: first.items[0]!.lastActivityAt,
          hostSessionId: first.items[0]!.hostSessionId,
        },
      })
      expect([...first.items, ...second.items].map((row) => row.hostSessionId)).toEqual([
        'hsid-b',
        'hsid-a',
        'hsid-c',
      ])

      const facets = db.sessionIndex.facets({
        agentId: 'cody',
        effectiveStatus: 'inactive',
        executionMode: 'nonInteractive',
      })
      expect(facets.total).toBe(2)
      expect(facets.byAgentId).toEqual({ cody: 2, mable: 1 })
      expect(facets.byEffectiveStatus).toEqual({ inactive: 2 })
      expect(facets.byExecutionMode).toEqual({ nonInteractive: 2 })
    } finally {
      db.close()
    }
  })
})

test('0041 backfill records the latest-seq to greatest-event recency reorder count', () => {
  const sqlite = createHrcDatabase(dbPath)
  sqlite.exec('CREATE TABLE hrc_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  const migrationIndex = phase1Migrations.findIndex(
    (migration) => migration.id === '0041_session_index'
  )
  expect(migrationIndex).toBeGreaterThan(0)
  for (const migration of phase1Migrations.slice(0, migrationIndex)) {
    migration.apply(sqlite)
    sqlite
      .query('INSERT INTO hrc_migrations (id, applied_at) VALUES (?, ?)')
      .run(migration.id, '2026-08-11T00:00:00.000Z')
  }
  sqlite.exec(`
    INSERT INTO sessions (
      host_session_id, scope_ref, lane_ref, generation, status, created_at, updated_at,
      ancestor_scope_refs_json
    ) VALUES
      ('hsid-a', 'agent:cody:project:hrc-runtime:task:a', 'main', 1, 'active',
       '2026-08-11T08:00:00.000Z', '2026-08-11T08:00:00.000Z', '[]'),
      ('hsid-b', 'agent:cody:project:hrc-runtime:task:b', 'main', 1, 'active',
       '2026-08-11T08:00:00.000Z', '2026-08-11T08:00:00.000Z', '[]');
    INSERT INTO continuities(scope_ref, lane_ref, active_host_session_id, updated_at) VALUES
      ('agent:cody:project:hrc-runtime:task:a', 'main', 'hsid-a', '2026-08-11T08:00:00.000Z'),
      ('agent:cody:project:hrc-runtime:task:b', 'main', 'hsid-b', '2026-08-11T08:00:00.000Z');
    INSERT INTO hrc_events(
      stream_seq, ts, host_session_id, scope_ref, lane_ref, generation, category,
      event_kind, replayed, payload_json
    ) VALUES
      (1, '2026-08-11T12:00:00.000Z', 'hsid-a',
       'agent:cody:project:hrc-runtime:task:a', 'main', 1, 'turn', 'turn.progress', 0, '{}'),
      (2, '2026-08-11T11:00:00.000Z', 'hsid-a',
       'agent:cody:project:hrc-runtime:task:a', 'main', 1, 'turn', 'turn.progress', 0, '{}'),
      (3, '2026-08-11T09:00:00.000Z', 'hsid-b',
       'agent:cody:project:hrc-runtime:task:b', 'main', 1, 'turn', 'turn.progress', 0, '{}');
  `)
  sqlite.close()

  const db = openHrcDatabase(dbPath)
  try {
    expect(db.sessionIndex.getBackfillEvidence()).toMatchObject({
      migrationId: '0041_session_index',
      rowCount: 2,
      changedRecencyCount: 1,
    })
    expect(db.sessionIndex.listPage({ limit: 2 }).items[0]?.lastActivityAt).toBe(
      '2026-08-11T12:00:00.000Z'
    )
  } finally {
    db.close()
  }
})
