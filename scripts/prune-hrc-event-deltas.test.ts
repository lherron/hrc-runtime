import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { countDeltaEvents, pruneDeltaEvents } from './prune-hrc-event-deltas'

const tempDirs: string[] = []

function makeStore(): { path: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'hrc-prune-deltas-'))
  tempDirs.push(dir)
  const path = join(dir, 'state.sqlite')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
  `)
  return { path, db }
}

function eventJson(eventKind: string): string {
  return JSON.stringify({
    otel: {
      logRecord: {
        attributes: {
          'event.kind': eventKind,
        },
      },
    },
  })
}

function seedRows(db: Database): void {
  const insert = db.prepare(
    'INSERT INTO events (seq, source, event_kind, event_json) VALUES (?, ?, ?, ?)'
  )
  insert.run(1, 'otel', 'codex.websocket_event', eventJson('response.output_text.delta'))
  insert.run(2, 'otel', 'codex.sse_event', eventJson('response.function_call_arguments.delta'))
  insert.run(3, 'otel', 'codex.websocket_event', eventJson('response.completed'))
  insert.run(4, 'hook', 'codex.websocket_event', eventJson('response.output_text.delta'))
  insert.run(5, 'otel', 'message_update', eventJson('response.output_text.delta'))
}

function eventSeqs(db: Database): number[] {
  return db
    .query<{ seq: number }, []>('SELECT seq FROM events ORDER BY seq ASC')
    .all()
    .map((row) => row.seq)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('prune-hrc-event-deltas', () => {
  test('dry-run counts matching OTEL transport delta rows without deleting', () => {
    const { path, db } = makeStore()
    seedRows(db)
    db.close()

    const result = pruneDeltaEvents({
      dbPath: path,
      apply: false,
      batchSize: 1,
      checkpoint: false,
      vacuum: false,
    })

    const verify = new Database(path)
    try {
      expect(result).toEqual({ initialCount: 2, deleted: 0, remainingCount: 2 })
      expect(eventSeqs(verify)).toEqual([1, 2, 3, 4, 5])
    } finally {
      verify.close()
    }
  })

  test('apply deletes only matching OTEL transport delta rows in batches', () => {
    const { path, db } = makeStore()
    seedRows(db)
    expect(countDeltaEvents(db)).toBe(2)
    db.close()

    const result = pruneDeltaEvents({
      dbPath: path,
      apply: true,
      batchSize: 1,
      checkpoint: false,
      vacuum: false,
    })

    const verify = new Database(path)
    try {
      expect(result).toEqual({ initialCount: 2, deleted: 2, remainingCount: 0 })
      expect(eventSeqs(verify)).toEqual([3, 4, 5])
    } finally {
      verify.close()
    }
  })
})
