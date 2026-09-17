/** T-08566 F0/F0w: origin survives reads and federation never strips authority. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { appendHrcEvent } from '../hrc-event-helper'
import { type HrcServer, createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer
beforeEach(async () => {
  fixture = await createHrcTestFixture('t08566-origin-')
  server = await createHrcServer(fixture.serverOpts())
})
afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

function importedEvent(evidenceOrigin?: 'retained') {
  return {
    hrcSeq: 41,
    streamSeq: 41,
    ts: '2026-09-17T00:00:00.000Z',
    hostSessionId: 'hsid-remote',
    scopeRef: 'agent:smokey:project:hrc-runtime',
    laneRef: 'main',
    generation: 1,
    runtimeId: 'rt-remote',
    runId: 'run-remote',
    category: 'turn',
    eventKind: 'turn.completed',
    transport: 'headless',
    replayed: false,
    payload: { success: true },
    ...(evidenceOrigin ? { evidenceOrigin } : {}),
  }
}

async function ingest(batch: Record<string, unknown>) {
  const response = await fetch('http://hrc/v1/ingest', {
    method: 'POST',
    body: JSON.stringify(batch),
    unix: join(fixture.runtimeRoot, 'ingest', 'events.sock'),
  } as RequestInit & { unix: string })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('T-08566 retained evidence origin', () => {
  test('live events remain unmarked through the tail route (positive control)', async () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      fixture.seedSession('hsid-live-origin', 'agent:smokey:project:hrc-runtime')
      appendHrcEvent(db, 'runtime.created', {
        ts: fixture.now(),
        hostSessionId: 'hsid-live-origin',
        scopeRef: 'agent:smokey:project:hrc-runtime',
        laneRef: 'default',
        generation: 1,
        payload: {},
      })
    } finally {
      db.close()
    }
    const response = await fixture.fetchSocket('/v1/events?after=0')
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).not.toContain('retained')
  })

  test('both durable event tables constrain and expose retained origin', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      for (const table of ['hrc_events', 'broker_invocation_events']) {
        const sql = db.sqlite
          .query<{ sql: string }, [string]>(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
          )
          .get(table)?.sql
        expect(sql).toContain('evidence_origin')
        expect(sql).toContain("evidence_origin = 'retained'")
      }
    } finally {
      db.close()
    }
  })

  test('v1 live ingest remains accepted (positive federation control)', async () => {
    const observed = await ingest({
      version: 1,
      sourceRef: 'remote:T-08566:live',
      feed: 'hrc_events',
      events: [{ originSeq: 41, event: importedEvent() }],
    })
    expect(observed).toMatchObject({ status: 200, body: { ok: true, inserted: 1 } })
  })

  test('v2 federation preserves retained origin and enforces version marking', async () => {
    const retained = await ingest({
      version: 2,
      sourceRef: 'remote:T-08566:retained',
      feed: 'hrc_events',
      events: [{ originSeq: 41, event: importedEvent('retained') }],
    })
    expect(retained).toMatchObject({ status: 200, body: { ok: true, inserted: 1 } })

    const v2Missing = await ingest({
      version: 2,
      sourceRef: 'remote:T-08566:missing',
      feed: 'hrc_events',
      events: [{ originSeq: 42, event: importedEvent() }],
    })
    expect(v2Missing).toMatchObject({ status: 400, body: { code: 'invalid_batch' } })

    const v1Marked = await ingest({
      version: 1,
      sourceRef: 'remote:T-08566:old-marked',
      feed: 'hrc_events',
      events: [{ originSeq: 43, event: importedEvent('retained') }],
    })
    expect(v1Marked).toMatchObject({ status: 400, body: { code: 'invalid_batch' } })
  })
})
