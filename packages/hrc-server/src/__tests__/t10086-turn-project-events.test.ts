import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HrcLifecycleEvent } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { appendHrcEvent } from '../hrc-event-helper.js'
import type { WrkqProjectEventPostParams } from '../wrkq/ledger-client.js'
import {
  SESSION_PROJECT_EVENTS_STREAM,
  SessionProjectEventPublisher,
} from '../wrkq/session-project-events.js'

// Failure cases 1–6 and 8 from the spec. Case 7 belongs to wrkq.
describe('T-10086 — turn facts from the durable ledger', () => {
  let db: HrcDatabase
  let publisher: SessionProjectEventPublisher
  let posts: WrkqProjectEventPostParams[]
  const seat = 'agent:cody:project:hrc-runtime:task:T-10086'

  function startPublisher() {
    return new SessionProjectEventPublisher({
      db,
      node: 'max3',
      pollIntervalMs: 0,
      post: async (fact) => {
        posts.push(fact)
      },
    })
  }

  function append(kind: string, seconds: number, overrides: Partial<HrcLifecycleEvent> = {}) {
    return appendHrcEvent(db, kind, {
      hostSessionId: 'hs-turns',
      scopeRef: seat,
      laneRef: 'default',
      generation: 1,
      runtimeId: 'rt-turns',
      ts: new Date(Date.UTC(2026, 9, 2, 20, 0, seconds)).toISOString(),
      ...overrides,
    })
  }

  beforeEach(() => {
    db = openHrcDatabase(':memory:')
    const now = '2026-10-02T20:00:00.000Z'
    db.sessions.insert({
      hostSessionId: 'hs-turns',
      scopeRef: seat,
      laneRef: 'default',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    db.continuities.upsert({
      scopeRef: seat,
      laneRef: 'default',
      activeHostSessionId: 'hs-turns',
      updatedAt: now,
    })
    posts = []
    publisher = startPublisher()
  })

  afterEach(() => {
    publisher.stop()
    db.close()
  })

  it('pairs without run ids and preserves attribute order, affiliation and timestamps', async () => {
    const start = append('turn.started', 0)
    append('turn.completed', 192)
    await publisher.drain()
    expect(posts.map((p) => p.type)).toEqual(['turn.started', 'turn.ended'])
    const key = `rt-turns:${start.hrcSeq}`
    expect(posts[0]?.idempotencyKey).toBe(`turn:${key}:started`)
    expect(posts[1]?.idempotencyKey).toBe(`turn:${key}:ended`)
    expect(posts[1]?.attributes).toEqual({
      source: 'hrc-server',
      node: 'max3',
      seat,
      agent: 'cody',
      task: 'T-10086',
      session: 'hs-turns',
      generation: '1',
      runtime_id: 'rt-turns',
      turn: key,
      end: 'completed',
      duration_ms: '192000',
    })
    expect(Object.keys(posts[1]?.attributes ?? {})).toEqual([
      'source',
      'node',
      'seat',
      'agent',
      'task',
      'session',
      'generation',
      'runtime_id',
      'turn',
      'end',
      'duration_ms',
    ])
    expect(posts[1]?.summary).toContain('completed, 3m12s')
    expect(posts[0]?.occurredAt).toBe(start.ts)
    expect(posts[1]?.occurredAt).toBe('2026-10-02T20:03:12.000Z')
    expect(posts[0]?.scopeRef).toBe(`${seat}/lane:default`)
    expect(posts[0]?.task).toBe('T-10086')
  })

  it('closes a superseded turn before publishing the next start', async () => {
    const first = append('turn.started', 0)
    const second = append('turn.started', 2)
    append('turn.completed', 3)
    await publisher.drain()
    expect(posts.map((p) => [p.type, p.attributes['end'], p.attributes['turn']])).toEqual([
      ['turn.started', undefined, `rt-turns:${first.hrcSeq}`],
      ['turn.ended', 'superseded', `rt-turns:${first.hrcSeq}`],
      ['turn.started', undefined, `rt-turns:${second.hrcSeq}`],
      ['turn.ended', 'completed', `rt-turns:${second.hrcSeq}`],
    ])
  })

  it('ignores orphan reaper bursts and duplicate terminals', async () => {
    append('turn.reaped', 0)
    append('turn.reaped', 2)
    await publisher.drain()
    expect(posts).toHaveLength(0)
    append('turn.started', 3)
    append('turn.completed', 4)
    append('turn.reaped', 6)
    append('turn.reaped', 8)
    await publisher.drain()
    expect(posts.map((p) => p.type)).toEqual(['turn.started', 'turn.ended'])
  })

  it('publishes both session.ended and runtime_ended on a crash mid-turn', async () => {
    append('turn.started', 0)
    append('runtime.crashed', 4)
    await publisher.drain()
    expect(posts.map((p) => p.type)).toEqual(['turn.started', 'session.ended', 'turn.ended'])
    expect(posts[2]?.attributes['end']).toBe('runtime_ended')
    expect(posts[2]?.attributes['duration_ms']).toBe('4000')
  })

  it('rebuilds before the replayed event, not at the ledger head', async () => {
    const start = append('turn.started', 0)
    await publisher.drain()
    const cursor = db.wrkqLedgerCursors.get(SESSION_PROJECT_EVENTS_STREAM)
    expect(cursor).toBe(start.hrcSeq)
    // Terminal is already in the ledger when the publisher restarts, beyond its cursor.
    append('turn.completed', 5, { runId: 'run-terminal' })
    publisher.stop()
    publisher = startPublisher()
    await publisher.drain()
    expect(posts.map((p) => p.type)).toEqual(['turn.started', 'turn.ended'])
    expect(posts[1]?.idempotencyKey).toBe(`turn:rt-turns:${start.hrcSeq}:ended`)
    expect(posts[1]?.attributes['run_id']).toBe('run-terminal')
    // Replay the same end after another restart: same key, no replayed start.
    db.sqlite
      .query('UPDATE wrkq_ledger_cursors SET high_water = ? WHERE stream = ?')
      .run(start.hrcSeq, SESSION_PROJECT_EVENTS_STREAM)
    publisher.stop()
    publisher = startPublisher()
    await publisher.drain()
    expect(posts[2]?.idempotencyKey).toBe(posts[1]?.idempotencyKey)
    expect(posts.filter((p) => p.type === 'turn.started')).toHaveLength(1)
  })

  it('carries optional start run ids but no prompt, message or tool text', async () => {
    const secret = 'private-prompt-message-tool-text'
    append('turn.started', 0, { runId: 'run-start', payload: { prompt: secret, tool: secret } })
    append('turn.failed', 2, { payload: { message: secret } })
    await publisher.drain()
    expect(posts).toHaveLength(2)
    expect(posts[1]?.attributes['end']).toBe('failed')
    expect(posts[1]?.attributes['run_id']).toBe('run-start')
    expect(JSON.stringify(posts)).not.toContain(secret)
  })

  it('posts nothing for a seat with no project', async () => {
    append('turn.started', 0, { scopeRef: 'agent:cody' })
    append('turn.completed', 1, { scopeRef: 'agent:cody' })
    await publisher.drain()
    expect(posts).toHaveLength(0)
  })
})
