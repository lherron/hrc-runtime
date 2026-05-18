import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../index'

/**
 * Tests for HrcLifecycleEventRepository.listLatestPerSession.
 *
 * This query backs ACP listMobileSessions freshness (lastHrcSeq / lastActivityAt).
 * It MUST return the latest event per (hostSessionId, generation) regardless of
 * how many other events sit ahead of them in the table — i.e. it must not depend
 * on any bounded in-memory window like `collectEvents(..., 2_000)` once the store
 * grows past that window.
 */

let tmpDir: string
let dbPath: string

function ts(offsetMs = 0): string {
  return new Date(Date.UTC(2026, 0, 1) + offsetMs).toISOString()
}

function scopeRef(key: string): string {
  return `agent:test:project:hrc-latest:task:${key}`
}

function seedSession(
  db: ReturnType<typeof openHrcDatabase>,
  hostSessionId: string,
  key: string,
  generation = 1
): void {
  const now = ts()
  db.sessions.insert({
    hostSessionId,
    scopeRef: scopeRef(key),
    laneRef: 'default',
    generation,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-latest-per-session-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('HrcLifecycleEventRepository.listLatestPerSession', () => {
  it('returns the latest event per host session across multiple sessions', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-a', 'a')
      seedSession(db, 'hsid-b', 'b')
      seedSession(db, 'hsid-c', 'c')

      // Two events for A, three for B, one for C, interleaved.
      const a1 = db.hrcEvents.append({
        ts: ts(0),
        hostSessionId: 'hsid-a',
        scopeRef: scopeRef('a'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.accepted',
        payload: {},
      })
      const b1 = db.hrcEvents.append({
        ts: ts(1),
        hostSessionId: 'hsid-b',
        scopeRef: scopeRef('b'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.started',
        payload: {},
      })
      const a2 = db.hrcEvents.append({
        ts: ts(2),
        hostSessionId: 'hsid-a',
        scopeRef: scopeRef('a'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: { latest: 'a' },
      })
      const b2 = db.hrcEvents.append({
        ts: ts(3),
        hostSessionId: 'hsid-b',
        scopeRef: scopeRef('b'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: {},
      })
      const c1 = db.hrcEvents.append({
        ts: ts(4),
        hostSessionId: 'hsid-c',
        scopeRef: scopeRef('c'),
        laneRef: 'default',
        generation: 1,
        category: 'runtime',
        eventKind: 'runtime.created',
        payload: {},
      })
      const b3 = db.hrcEvents.append({
        ts: ts(5),
        hostSessionId: 'hsid-b',
        scopeRef: scopeRef('b'),
        laneRef: 'default',
        generation: 1,
        category: 'launch',
        eventKind: 'launch.exited',
        payload: { latest: 'b' },
      })

      const latest = db.hrcEvents.listLatestPerSession()

      // Newest-first by hrcSeq
      expect(latest.map((e) => e.hrcSeq)).toEqual([b3.hrcSeq, c1.hrcSeq, a2.hrcSeq])
      expect(latest.map((e) => e.hostSessionId)).toEqual(['hsid-b', 'hsid-c', 'hsid-a'])

      // Latest event for A is a2 (not a1)
      const aRow = latest.find((e) => e.hostSessionId === 'hsid-a')
      expect(aRow?.eventKind).toBe('turn.completed')
      expect(aRow?.hrcSeq).toBe(a2.hrcSeq)
      expect((aRow?.payload as { latest?: string }).latest).toBe('a')

      // Latest event for B is b3 (not b1 or b2)
      const bRow = latest.find((e) => e.hostSessionId === 'hsid-b')
      expect(bRow?.eventKind).toBe('launch.exited')
      expect(bRow?.hrcSeq).toBe(b3.hrcSeq)

      // Unused-but-real reference to silence linter and document setup intent.
      expect([a1.hrcSeq, b1.hrcSeq, b2.hrcSeq, c1.hrcSeq].every((seq) => seq > 0)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('returns one row per (hostSessionId, generation) when sessions rotate generations', () => {
    const db = openHrcDatabase(dbPath)
    try {
      // hsid-rot exists at generation 1 then is rotated to generation 2 (a fresh row).
      // Both generations should appear in latest-per-session output.
      seedSession(db, 'hsid-rot-g1', 'rot1', 1)
      seedSession(db, 'hsid-rot-g2', 'rot2', 2)

      const g1a = db.hrcEvents.append({
        ts: ts(0),
        hostSessionId: 'hsid-rot-g1',
        scopeRef: scopeRef('rot1'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.started',
        payload: {},
      })
      const g1b = db.hrcEvents.append({
        ts: ts(1),
        hostSessionId: 'hsid-rot-g1',
        scopeRef: scopeRef('rot1'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: { gen: 1 },
      })
      const g2a = db.hrcEvents.append({
        ts: ts(2),
        hostSessionId: 'hsid-rot-g2',
        scopeRef: scopeRef('rot2'),
        laneRef: 'default',
        generation: 2,
        category: 'turn',
        eventKind: 'turn.started',
        payload: { gen: 2 },
      })

      const latest = db.hrcEvents.listLatestPerSession()
      expect(latest).toHaveLength(2)

      const g1 = latest.find((e) => e.generation === 1)
      expect(g1?.hrcSeq).toBe(g1b.hrcSeq)
      expect((g1?.payload as { gen?: number }).gen).toBe(1)

      const g2 = latest.find((e) => e.generation === 2)
      expect(g2?.hrcSeq).toBe(g2a.hrcSeq)
      expect((g2?.payload as { gen?: number }).gen).toBe(2)

      expect(g1a.hrcSeq).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('returns multiple generations for a single host session row', () => {
    // Several stores allow events for the same host_session_id at different generations
    // (e.g. when the row is overwritten in place during rotation in some test paths).
    // The query must group by (host_session_id, generation), not host_session_id alone.
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-multi-gen', 'multi', 1)

      const g1Old = db.hrcEvents.append({
        ts: ts(0),
        hostSessionId: 'hsid-multi-gen',
        scopeRef: scopeRef('multi'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: { tag: 'g1' },
      })
      const g2Newer = db.hrcEvents.append({
        ts: ts(1),
        hostSessionId: 'hsid-multi-gen',
        scopeRef: scopeRef('multi'),
        laneRef: 'default',
        generation: 2,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: { tag: 'g2' },
      })

      const latest = db.hrcEvents.listLatestPerSession({ hostSessionId: 'hsid-multi-gen' })
      expect(latest).toHaveLength(2)

      const byGeneration = new Map(latest.map((e) => [e.generation, e]))
      expect(byGeneration.get(1)?.hrcSeq).toBe(g1Old.hrcSeq)
      expect(byGeneration.get(2)?.hrcSeq).toBe(g2Newer.hrcSeq)
    } finally {
      db.close()
    }
  })

  it('resolves old events outside any small bounded recent window', () => {
    // Simulate the original bug: with collectEvents(..., 2_000), the latest event
    // for an old session can be older than the most recent 2,000 events and
    // therefore disappear from freshness projection. listLatestPerSession must
    // still return it correctly.
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-old', 'old')
      seedSession(db, 'hsid-new', 'new')

      const oldEvt = db.hrcEvents.append({
        ts: ts(0),
        hostSessionId: 'hsid-old',
        scopeRef: scopeRef('old'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: { tag: 'oldest' },
      })

      // Insert a large burst of events for hsid-new so oldEvt is far out of
      // any small bounded window.
      const bulk = 2_500
      let newest: { hrcSeq: number } | null = null
      for (let i = 0; i < bulk; i += 1) {
        newest = db.hrcEvents.append({
          ts: ts(10 + i),
          hostSessionId: 'hsid-new',
          scopeRef: scopeRef('new'),
          laneRef: 'default',
          generation: 1,
          category: 'turn',
          eventKind: 'turn.tool_result',
          payload: { i },
        })
      }
      expect(newest?.hrcSeq).toBeGreaterThan(oldEvt.hrcSeq + 2_000)

      const latest = db.hrcEvents.listLatestPerSession()
      expect(latest).toHaveLength(2)
      const oldRow = latest.find((e) => e.hostSessionId === 'hsid-old')
      expect(oldRow?.hrcSeq).toBe(oldEvt.hrcSeq)
      expect((oldRow?.payload as { tag?: string }).tag).toBe('oldest')

      const newRow = latest.find((e) => e.hostSessionId === 'hsid-new')
      expect(newRow?.hrcSeq).toBe(newest?.hrcSeq ?? 0)
    } finally {
      db.close()
    }
  })

  it('breaks ties by hrcSeq (PK monotonic) when ts collides', () => {
    // Two events with the same ts for the same session should pick the row with
    // the highest hrc_seq deterministically.
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-tie', 'tie')
      const sameTs = ts(1)
      const e1 = db.hrcEvents.append({
        ts: sameTs,
        hostSessionId: 'hsid-tie',
        scopeRef: scopeRef('tie'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.started',
        payload: {},
      })
      const e2 = db.hrcEvents.append({
        ts: sameTs,
        hostSessionId: 'hsid-tie',
        scopeRef: scopeRef('tie'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: {},
      })
      expect(e2.hrcSeq).toBeGreaterThan(e1.hrcSeq)

      const latest = db.hrcEvents.listLatestPerSession({ hostSessionId: 'hsid-tie' })
      expect(latest).toHaveLength(1)
      expect(latest[0]?.hrcSeq).toBe(e2.hrcSeq)
      expect(latest[0]?.eventKind).toBe('turn.completed')
    } finally {
      db.close()
    }
  })

  it('narrows the search window with filters before grouping', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-f1', 'f1')
      seedSession(db, 'hsid-f2', 'f2')

      const f1Turn = db.hrcEvents.append({
        ts: ts(0),
        hostSessionId: 'hsid-f1',
        scopeRef: scopeRef('f1'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: {},
      })
      const f1Runtime = db.hrcEvents.append({
        ts: ts(1),
        hostSessionId: 'hsid-f1',
        scopeRef: scopeRef('f1'),
        laneRef: 'default',
        generation: 1,
        category: 'runtime',
        eventKind: 'runtime.ready',
        payload: {},
      })
      const f2Turn = db.hrcEvents.append({
        ts: ts(2),
        hostSessionId: 'hsid-f2',
        scopeRef: scopeRef('f2'),
        laneRef: 'default',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: {},
      })

      // category=turn narrows away the runtime event, so f1's "latest turn"
      // becomes f1Turn (not f1Runtime).
      const latestTurns = db.hrcEvents.listLatestPerSession({ category: 'turn' })
      expect(latestTurns.map((e) => e.hostSessionId).sort()).toEqual(['hsid-f1', 'hsid-f2'])
      const f1 = latestTurns.find((e) => e.hostSessionId === 'hsid-f1')
      expect(f1?.hrcSeq).toBe(f1Turn.hrcSeq)
      expect(f1Runtime.hrcSeq).toBeGreaterThan(f1Turn.hrcSeq)

      // scopeRef filter restricts to a single session bucket.
      const f2Only = db.hrcEvents.listLatestPerSession({ scopeRef: scopeRef('f2') })
      expect(f2Only).toHaveLength(1)
      expect(f2Only[0]?.hrcSeq).toBe(f2Turn.hrcSeq)
    } finally {
      db.close()
    }
  })

  it('returns an empty array when the table is empty', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const latest = db.hrcEvents.listLatestPerSession()
      expect(latest).toEqual([])
    } finally {
      db.close()
    }
  })
})
