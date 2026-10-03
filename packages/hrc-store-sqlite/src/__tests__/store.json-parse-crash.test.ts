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
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../index'

let tmpDir: string
let dbPath: string
let consoleErrorSpy: ReturnType<typeof spyOn<typeof console, 'error'>>

function ts(): string {
  return new Date().toISOString()
}

function testScopeRef(scopeKey: string): string {
  return `agent:test:project:hrc-store-json-parse:task:${scopeKey}`
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-store-json-crash-'))
  dbPath = join(tmpDir, 'test.sqlite')
  // Capture parseJson's corruption warnings so the harness output stays clean
  // and we can assert the log carries enough context to identify the broken row.
  consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  consoleErrorSpy.mockRestore()
  await rm(tmpDir, { recursive: true, force: true })
})

// Helper: insert a valid session with all required fields
function insertSession(db: ReturnType<typeof openHrcDatabase>, hostSessionId: string) {
  const now = ts()
  db.sessions.insert({
    hostSessionId,
    scopeRef: testScopeRef(hostSessionId),
    laneRef: 'default',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
}

// ---------------------------------------------------------------------------
// C-2: Corrupted JSON in repository rows must not crash
// ---------------------------------------------------------------------------
describe('C-2: parseJson crash guard', () => {
  it('survives corrupted continuation_json in a session row', () => {
    const db = openHrcDatabase(dbPath)
    try {
      insertSession(db, 'hsid-corrupt-2')

      db.sqlite.run(
        `UPDATE sessions SET continuation_json = 'GARBAGE{{{{' WHERE host_session_id = ?`,
        ['hsid-corrupt-2']
      )

      const session = db.sessions.getByHostSessionId('hsid-corrupt-2')
      expect(session).not.toBeNull()
      expect(session!.continuation).toBeUndefined()
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Corrupt JSON in column continuation_json')
      )
    } finally {
      db.close()
    }
  })

  it('survives corrupted tmux_json in a runtime row', () => {
    const db = openHrcDatabase(dbPath)
    try {
      insertSession(db, 'hsid-rt-corrupt')

      db.runtimes.insert({
        runtimeId: 'rt-corrupt-1',
        hostSessionId: 'hsid-rt-corrupt',
        scopeRef: testScopeRef('hsid-rt-corrupt'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'pending',
        supportsInflightInput: false,
        createdAt: ts(),
        updatedAt: ts(),
      })

      // Corrupt tmux_json
      db.sqlite.run(`UPDATE runtimes SET tmux_json = '<<<broken>>>' WHERE runtime_id = ?`, [
        'rt-corrupt-1',
      ])

      // Should not throw
      const runtime = db.runtimes.getByRuntimeId('rt-corrupt-1')
      expect(runtime).not.toBeNull()
      expect(runtime!.runtimeId).toBe('rt-corrupt-1')
      expect(runtime!.tmuxJson).toBeUndefined()
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Corrupt JSON in column tmux_json')
      )
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
        scopeRef: testScopeRef('hsid-evt-corrupt'),
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
      const events = db.events.listFromSeq(1, { hostSessionId: 'hsid-evt-corrupt' })
      expect(events.length).toBe(1)
      expect(events[0].eventKind).toBe('test.event')
      expect(events[0].eventJson).toBeUndefined()
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Corrupt JSON in column event_json')
      )
    } finally {
      db.close()
    }
  })
})
