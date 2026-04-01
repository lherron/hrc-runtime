/**
 * RED/GREEN tests for C-2: JSON parse crash in hrc-store-sqlite (T-00976)
 *
 * Bug: parseJson() in repositories.ts calls JSON.parse() with no try-catch.
 * If a SQLite row contains corrupted/malformed JSON in any JSON column,
 * the entire process crashes with an unhandled SyntaxError.
 *
 * These tests inject corrupted JSON directly into SQLite rows via raw SQL,
 * then call repository read methods. Currently they CRASH (RED) because
 * parseJson() has no error handling.
 *
 * Pass conditions for Curly (T-00976):
 *   1. parseJson() must catch JSON.parse errors and not throw
 *   2. Corrupted JSON fields should return a safe fallback (undefined/null/default)
 *   3. The error should be logged with enough context to identify the broken record
 *   4. Other valid fields in the same row must still be returned correctly
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../index'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-store-json-crash-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// Helper: insert a valid session with all required fields
function insertSession(db: ReturnType<typeof openHrcDatabase>, hostSessionId: string) {
  const now = ts()
  db.sessions.create({
    hostSessionId,
    scopeRef: `scope://${hostSessionId}`,
    laneRef: 'default',
    generation: 1,
    status: 'active',
    ancestorScopeRefs: [],
    createdAt: now,
    updatedAt: now,
  })
}

// ---------------------------------------------------------------------------
// C-2: Corrupted JSON in repository rows must not crash
// ---------------------------------------------------------------------------
describe('C-2: parseJson crash guard', () => {
  it('survives corrupted parsed_scope_json in a session row', () => {
    const db = openHrcDatabase(dbPath)
    try {
      insertSession(db, 'hsid-corrupt-1')

      // Corrupt the JSON column directly via raw SQL
      db.sqlite.run(
        `UPDATE sessions SET parsed_scope_json = '{not valid json!!!' WHERE host_session_id = ?`,
        ['hsid-corrupt-1']
      )

      // This should NOT throw — currently it does (RED)
      const session = db.sessions.findByHostSessionId('hsid-corrupt-1')
      expect(session).not.toBeNull()
      expect(session!.hostSessionId).toBe('hsid-corrupt-1')
      // Corrupted JSON field should fall back to undefined, not crash
      expect(session!.parsedScopeJson).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('survives corrupted continuation_json in a session row', () => {
    const db = openHrcDatabase(dbPath)
    try {
      insertSession(db, 'hsid-corrupt-2')

      db.sqlite.run(
        `UPDATE sessions SET continuation_json = 'GARBAGE{{{{' WHERE host_session_id = ?`,
        ['hsid-corrupt-2']
      )

      const session = db.sessions.findByHostSessionId('hsid-corrupt-2')
      expect(session).not.toBeNull()
      expect(session!.continuation).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('survives corrupted tmux_json in a runtime row', () => {
    const db = openHrcDatabase(dbPath)
    try {
      insertSession(db, 'hsid-rt-corrupt')

      db.runtimes.create({
        runtimeId: 'rt-corrupt-1',
        hostSessionId: 'hsid-rt-corrupt',
        scopeRef: 'scope://hsid-rt-corrupt',
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'pending',
        supportsInflightInput: false,
        adopted: false,
        createdAt: ts(),
        updatedAt: ts(),
      })

      // Corrupt tmux_json
      db.sqlite.run(`UPDATE runtimes SET tmux_json = '<<<broken>>>' WHERE runtime_id = ?`, [
        'rt-corrupt-1',
      ])

      // Should not throw
      const runtime = db.runtimes.findById('rt-corrupt-1')
      expect(runtime).not.toBeNull()
      expect(runtime!.runtimeId).toBe('rt-corrupt-1')
      expect(runtime!.tmuxJson).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('survives corrupted event_json in an event row', () => {
    const db = openHrcDatabase(dbPath)
    try {
      insertSession(db, 'hsid-evt-corrupt')

      db.events.append({
        ts: ts(),
        hostSessionId: 'hsid-evt-corrupt',
        scopeRef: 'scope://hsid-evt-corrupt',
        laneRef: 'default',
        generation: 1,
        source: 'hrc',
        eventKind: 'test.event',
        eventJson: { valid: true },
      })

      // Corrupt the event_json
      db.sqlite.run(
        `UPDATE events SET event_json = 'totally broken json' WHERE host_session_id = ?`,
        ['hsid-evt-corrupt']
      )

      // Should not throw
      const events = db.events.query({ hostSessionId: 'hsid-evt-corrupt' })
      expect(events.length).toBe(1)
      expect(events[0].eventKind).toBe('test.event')
      expect(events[0].eventJson).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('survives corrupted metadata_json in an app_session row', () => {
    const db = openHrcDatabase(dbPath)
    try {
      insertSession(db, 'hsid-app-corrupt')

      // Insert an app session with valid metadata via raw SQL since apply()
      // may not expose the crash path the same way
      db.sqlite.run(
        `INSERT INTO app_sessions (app_id, app_session_key, host_session_id, label, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['test-app', 'key-1', 'hsid-app-corrupt', 'Test', '{"foo":"bar"}', ts(), ts()]
      )

      // Corrupt the metadata_json
      db.sqlite.run(
        `UPDATE app_sessions SET metadata_json = '\\x00\\xff invalid' WHERE app_session_key = ?`,
        ['key-1']
      )

      // Should not throw
      const found = db.appSessions.findByKey('test-app', 'key-1')
      expect(found).not.toBeNull()
      expect(found!.appSessionKey).toBe('key-1')
      expect(found!.metadata).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
