import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLifecycleEvent } from 'hrc-core'

import { createHrcDatabase } from '../database.js'
import { openHrcDatabase } from '../index'
import { phase1Migrations } from '../migrations.js'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

function scopeRef(key: string): string {
  return `agent:test:project:hrc-events:task:${key}`
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-events-test-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function seedSession(db: ReturnType<typeof openHrcDatabase>, hostSessionId: string, key: string) {
  const now = ts()
  db.sessions.insert({
    hostSessionId,
    scopeRef: scopeRef(key),
    laneRef: 'default',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

function createLegacyDatabase(appliedCount: number): ReturnType<typeof createHrcDatabase> {
  const sqlite = createHrcDatabase(dbPath)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS hrc_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)

  for (const migration of phase1Migrations.slice(0, appliedCount)) {
    migration.apply(sqlite)
    sqlite
      .prepare('INSERT INTO hrc_migrations (id, applied_at) VALUES (?, ?)')
      .run(migration.id, ts())
  }

  return sqlite
}

function seedLegacySession(
  sqlite: ReturnType<typeof createHrcDatabase>,
  hostSessionId: string,
  key: string
) {
  const now = ts()
  sqlite
    .prepare(
      `
        INSERT INTO sessions (
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          status,
          created_at,
          updated_at,
          ancestor_scope_refs_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(hostSessionId, scopeRef(key), 'default', 1, 'active', now, now, '[]')
}

function seedLegacyRuntimeAndRun(
  sqlite: ReturnType<typeof createHrcDatabase>,
  hostSessionId: string,
  key: string,
  runtimeId: string,
  runId: string
) {
  const now = ts()
  sqlite
    .prepare(
      `
        INSERT INTO runtimes (
          runtime_id,
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          transport,
          harness,
          provider,
          status,
          supports_inflight_input,
          adopted,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      runtimeId,
      hostSessionId,
      scopeRef(key),
      'default',
      1,
      'sdk',
      'agent-sdk',
      'anthropic',
      'ready',
      1,
      0,
      now,
      now
    )

  sqlite
    .prepare(
      `
        INSERT INTO runs (
          run_id,
          host_session_id,
          runtime_id,
          scope_ref,
          lane_ref,
          generation,
          transport,
          status,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(runId, hostSessionId, runtimeId, scopeRef(key), 'default', 1, 'sdk', 'started', now)
}

describe('HrcLifecycleEventRepository', () => {
  it('appends and reloads with hrcSeq and streamSeq populated', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-a', 'a')
      const evt = db.hrcEvents.append({
        ts: ts(),
        hostSessionId: 'hsid-a',
        scopeRef: scopeRef('a'),
        laneRef: 'default',
        generation: 1,
        runtimeId: 'rt-a',
        runId: 'run-a',
        launchId: 'lch-a',
        category: 'turn',
        eventKind: 'turn.started',
        transport: 'sdk',
        payload: { prompt: 'hi' },
      })
      expect(evt.hrcSeq).toBeGreaterThan(0)
      expect(evt.streamSeq).toBeGreaterThan(0)
      expect(evt.category).toBe('turn')
      expect(evt.replayed).toBe(false)
      expect(evt.transport).toBe('sdk')
      expect((evt.payload as { prompt: string }).prompt).toBe('hi')
    } finally {
      db.close()
    }
  })

  it('produces monotonically increasing hrcSeq', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-mono', 'mono')
      const base = {
        ts: ts(),
        hostSessionId: 'hsid-mono',
        scopeRef: scopeRef('mono'),
        laneRef: 'default',
        generation: 1,
        category: 'runtime' as const,
        eventKind: 'runtime.created',
        payload: {},
      }
      const e1 = db.hrcEvents.append(base)
      const e2 = db.hrcEvents.append({ ...base, eventKind: 'runtime.interrupted' })
      const e3 = db.hrcEvents.append({ ...base, eventKind: 'runtime.terminated' })
      expect(e2.hrcSeq).toBeGreaterThan(e1.hrcSeq)
      expect(e3.hrcSeq).toBeGreaterThan(e2.hrcSeq)
    } finally {
      db.close()
    }
  })

  it('interleaves stream_seq with EventRepository writes across sources', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-mix', 'mix')
      const baseHook = {
        ts: ts(),
        hostSessionId: 'hsid-mix',
        scopeRef: scopeRef('mix'),
        laneRef: 'default',
        generation: 1,
      }
      const h1 = db.events.append({
        ...baseHook,
        source: 'hook',
        eventKind: 'hook.ingested',
        eventJson: {},
      })
      const l1 = db.hrcEvents.append({
        ...baseHook,
        category: 'turn',
        eventKind: 'turn.started',
        payload: {},
      })
      const h2 = db.events.append({
        ...baseHook,
        source: 'otel',
        eventKind: 'codex.api_request',
        eventJson: {},
      })
      const l2 = db.hrcEvents.append({
        ...baseHook,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: {},
      })

      expect(l1.streamSeq).toBeGreaterThan(h1.streamSeq)
      expect(h2.streamSeq).toBeGreaterThan(l1.streamSeq)
      expect(l2.streamSeq).toBeGreaterThan(h2.streamSeq)

      // stream_seq is unique across both tables
      const seqs = new Set<number>([h1.streamSeq, l1.streamSeq, h2.streamSeq, l2.streamSeq])
      expect(seqs.size).toBe(4)
    } finally {
      db.close()
    }
  })

  it('filters by runId, launchId, eventKind, category, and scopeRef', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-f', 'f')
      const base = {
        ts: ts(),
        hostSessionId: 'hsid-f',
        scopeRef: scopeRef('f'),
        laneRef: 'default',
        generation: 1,
        payload: {},
      }
      db.hrcEvents.append({
        ...base,
        runId: 'run-1',
        launchId: 'lch-1',
        category: 'turn',
        eventKind: 'turn.accepted',
      })
      db.hrcEvents.append({
        ...base,
        runId: 'run-1',
        launchId: 'lch-1',
        category: 'turn',
        eventKind: 'turn.completed',
      })
      db.hrcEvents.append({
        ...base,
        runId: 'run-2',
        launchId: 'lch-2',
        category: 'runtime',
        eventKind: 'runtime.created',
      })

      expect(db.hrcEvents.listByRun('run-1').length).toBe(2)
      expect(db.hrcEvents.listByLaunch('lch-2').length).toBe(1)
      expect(db.hrcEvents.listByKind('turn.accepted').length).toBe(1)
      expect(db.hrcEvents.listFromHrcSeq(1, { category: 'runtime' }).length).toBe(1)
      expect(db.hrcEvents.listByScope(scopeRef('f')).length).toBe(3)
    } finally {
      db.close()
    }
  })

  it('roundtrips replayed flag and optional columns', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-r', 'r')
      const now = ts()
      const withFlag = db.hrcEvents.append({
        ts: now,
        hostSessionId: 'hsid-r',
        scopeRef: scopeRef('r'),
        laneRef: 'default',
        generation: 1,
        category: 'launch',
        eventKind: 'launch.callback_rejected',
        errorCode: 'stale_callback',
        replayed: true,
        payload: { reason: 'test' },
      })
      const withoutFlag = db.hrcEvents.append({
        ts: now,
        hostSessionId: 'hsid-r',
        scopeRef: scopeRef('r'),
        laneRef: 'default',
        generation: 1,
        category: 'launch',
        eventKind: 'launch.exited',
        payload: {},
      })
      expect(withFlag.replayed).toBe(true)
      expect(withFlag.errorCode).toBe('stale_callback')
      expect(withoutFlag.replayed).toBe(false)
      expect(withoutFlag.errorCode).toBeUndefined()
      expect(withoutFlag.launchId).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('listFromStreamSeq orders by shared stream cursor', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-s', 's')
      const base = {
        ts: ts(),
        hostSessionId: 'hsid-s',
        scopeRef: scopeRef('s'),
        laneRef: 'default',
        generation: 1,
      }
      db.events.append({ ...base, source: 'hook', eventKind: 'hook.ingested', eventJson: {} })
      const l1 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.accepted',
        payload: {},
      })
      db.events.append({ ...base, source: 'hook', eventKind: 'hook.ingested', eventJson: {} })
      const l2 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: {},
      })

      const fromL1 = db.hrcEvents.listFromStreamSeq(l1.streamSeq)
      expect(fromL1.map((e: HrcLifecycleEvent) => e.eventKind)).toEqual([
        'turn.accepted',
        'turn.completed',
      ])
      expect(fromL1[0]!.streamSeq).toBe(l1.streamSeq)
      expect(fromL1[1]!.streamSeq).toBe(l2.streamSeq)
    } finally {
      db.close()
    }
  })
})

describe('0009_backfill_legacy_hrc_events', () => {
  it('migrates legacy source=hrc rows into hrc_events during upgrade from pre-0008 databases', () => {
    const sqlite = createLegacyDatabase(7)
    try {
      seedLegacySession(sqlite, 'legacy-hsid', 'legacy')
      seedLegacyRuntimeAndRun(sqlite, 'legacy-hsid', 'legacy', 'rt-legacy', 'run-legacy')

      sqlite
        .prepare(
          `
            INSERT INTO events (
              seq,
              ts,
              host_session_id,
              scope_ref,
              lane_ref,
              generation,
              source,
              event_kind,
              event_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          1,
          ts(),
          'legacy-hsid',
          scopeRef('legacy'),
          'default',
          1,
          'hook',
          'hook.ingested',
          JSON.stringify({ provider: 'test' })
        )

      sqlite
        .prepare(
          `
            INSERT INTO events (
              seq,
              ts,
              host_session_id,
              scope_ref,
              lane_ref,
              generation,
              runtime_id,
              run_id,
              source,
              event_kind,
              event_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          2,
          ts(),
          'legacy-hsid',
          scopeRef('legacy'),
          'default',
          1,
          'rt-legacy',
          'run-legacy',
          'hrc',
          'turn.completed',
          JSON.stringify({
            hostSessionId: 'legacy-hsid',
            scopeRef: scopeRef('legacy'),
            laneRef: 'default',
            generation: 1,
            runtimeId: 'rt-legacy',
            runId: 'run-legacy',
            launchId: 'launch-legacy',
            transport: 'sdk',
            replayed: true,
            promptLength: 2,
            outputText: 'ok',
          })
        )

      sqlite
        .prepare(
          `
            INSERT INTO events (
              seq,
              ts,
              host_session_id,
              scope_ref,
              lane_ref,
              generation,
              source,
              event_kind,
              event_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          3,
          ts(),
          'legacy-hsid',
          scopeRef('legacy'),
          'default',
          1,
          'hrc',
          'app-session.literal-input',
          JSON.stringify({
            appId: 'app-1',
            appSessionKey: 'session-1',
            transport: 'headless',
            payloadLength: 11,
            enter: true,
          })
        )
    } finally {
      sqlite.close()
    }

    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0009_backfill_legacy_hrc_events')

      const rawEvents = db.events.listFromSeq(1)
      expect(rawEvents).toHaveLength(1)
      expect(rawEvents[0]?.source).toBe('hook')

      const typedEvents = db.hrcEvents.listFromHrcSeq(1)
      expect(typedEvents.map((event) => event.eventKind)).toEqual([
        'turn.completed',
        'app-session.literal-input',
      ])
      expect(typedEvents.map((event) => event.streamSeq)).toEqual([2, 3])

      expect(typedEvents[0]).toMatchObject({
        hrcSeq: 1,
        streamSeq: 2,
        runtimeId: 'rt-legacy',
        runId: 'run-legacy',
        launchId: 'launch-legacy',
        transport: 'sdk',
        replayed: true,
      })
      expect(typedEvents[0]?.payload).toEqual({
        promptLength: 2,
        outputText: 'ok',
      })

      expect(typedEvents[1]).toMatchObject({
        hrcSeq: 2,
        streamSeq: 3,
        appId: 'app-1',
        appSessionKey: 'session-1',
        replayed: false,
      })
      expect(typedEvents[1]?.transport).toBeUndefined()
      expect(typedEvents[1]?.payload).toEqual({
        transport: 'headless',
        payloadLength: 11,
        enter: true,
      })

      const cursor = db.sqlite
        .query<{ next_seq: number }, []>('SELECT next_seq FROM event_stream_cursor WHERE id = 1')
        .get()
      expect(cursor?.next_seq).toBe(4)
    } finally {
      db.close()
    }
  })

  it('repairs already-upgraded databases that still have legacy hrc rows in events', () => {
    const sqlite = createLegacyDatabase(8)
    try {
      seedLegacySession(sqlite, 'partial-hsid', 'partial')
      sqlite
        .prepare(
          `
            INSERT INTO events (
              seq,
              ts,
              host_session_id,
              scope_ref,
              lane_ref,
              generation,
              source,
              event_kind,
              event_json,
              stream_seq
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          9,
          ts(),
          'partial-hsid',
          scopeRef('partial'),
          'default',
          1,
          'hrc',
          'session.created',
          JSON.stringify({ created: true }),
          9
        )
    } finally {
      sqlite.close()
    }

    const db = openHrcDatabase(dbPath)
    try {
      expect(db.events.listFromSeq(1)).toHaveLength(0)

      const typedEvents = db.hrcEvents.listFromHrcSeq(1)
      expect(typedEvents).toHaveLength(1)
      expect(typedEvents[0]).toMatchObject({
        hrcSeq: 1,
        streamSeq: 9,
        category: 'session',
        eventKind: 'session.created',
      })
      expect(typedEvents[0]?.payload).toEqual({ created: true })

      const cursor = db.sqlite
        .query<{ next_seq: number }, []>('SELECT next_seq FROM event_stream_cursor WHERE id = 1')
        .get()
      expect(cursor?.next_seq).toBe(10)
    } finally {
      db.close()
    }
  })
})

describe('appendHrcEvent helper', () => {
  it('derives category from known event kind', async () => {
    const { appendHrcEvent, categoryForEventKind } = await import(
      '../../../hrc-server/src/hrc-event-helper'
    )
    expect(categoryForEventKind('turn.accepted')).toBe('turn')
    expect(categoryForEventKind('runtime.restarted')).toBe('runtime')
    expect(categoryForEventKind('launch.orphaned')).toBe('launch')
    expect(categoryForEventKind('app-session.literal-input')).toBe('app_session')
    expect(() => categoryForEventKind('no.such.kind')).toThrow(/unknown hrc event kind/)

    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-h', 'h')
      const e = appendHrcEvent(db, 'turn.accepted', {
        ts: ts(),
        hostSessionId: 'hsid-h',
        scopeRef: scopeRef('h'),
        laneRef: 'default',
        generation: 1,
        runId: 'run-h',
        payload: { x: 1 },
      })
      expect(e.category).toBe('turn')
      expect(e.eventKind).toBe('turn.accepted')
      expect(e.runId).toBe('run-h')
    } finally {
      db.close()
    }
  })
})
