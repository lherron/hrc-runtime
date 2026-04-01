/**
 * RED/GREEN tests for T-00976 (C-2): JSON parse crash guard
 *
 * Validates that corrupted JSON in SQLite columns does not crash repository
 * reads. Instead, the corrupted field should resolve to `undefined` and a
 * console.error should log enough context to identify the broken record.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../index'
import type { HrcDatabase } from '../index'

let tmpDir: string
let dbPath: string
let db: HrcDatabase

function ts(): string {
  return new Date().toISOString()
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-json-corruption-'))
  dbPath = join(tmpDir, 'test.sqlite')
  db = openHrcDatabase(dbPath)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

// Helper: insert a valid session row then corrupt a JSON column via raw SQL
function insertSession(hostSessionId: string): void {
  const now = ts()
  db.sessions.create({
    hostSessionId,
    scopeRef: 'scope-corrupt',
    laneRef: 'default',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

function corruptColumn(table: string, column: string, pk: string, pkColumn: string): void {
  db.sqlite.run(`UPDATE ${table} SET ${column} = ? WHERE ${pkColumn} = ?`, '{not-valid-json!!!', pk)
}

// ---------------------------------------------------------------------------
// Session: corrupted parsed_scope_json
// ---------------------------------------------------------------------------
describe('C-2: corrupted JSON does not crash reads', () => {
  it('session with corrupted parsed_scope_json returns undefined for that field', () => {
    insertSession('hsid-corrupt-1')
    corruptColumn('sessions', 'parsed_scope_json', 'hsid-corrupt-1', 'host_session_id')

    const logged: string[] = []
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    try {
      const session = db.sessions.getByHostSessionId('hsid-corrupt-1')
      expect(session).not.toBeNull()
      expect(session!.parsedScopeJson).toBeUndefined()
      // Should have logged the corruption
      expect(logged.length).toBeGreaterThan(0)
      expect(logged[0]).toContain('parsed_scope_json')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('session with corrupted last_applied_intent_json returns undefined', () => {
    insertSession('hsid-corrupt-2')
    corruptColumn('sessions', 'last_applied_intent_json', 'hsid-corrupt-2', 'host_session_id')

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const session = db.sessions.getByHostSessionId('hsid-corrupt-2')
      expect(session).not.toBeNull()
      expect(session!.lastAppliedIntentJson).toBeUndefined()
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('session with corrupted continuation_json returns undefined', () => {
    insertSession('hsid-corrupt-3')
    corruptColumn('sessions', 'continuation_json', 'hsid-corrupt-3', 'host_session_id')

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const session = db.sessions.getByHostSessionId('hsid-corrupt-3')
      expect(session).not.toBeNull()
      expect(session!.continuation).toBeUndefined()
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ---------------------------------------------------------------------------
  // Runtime: corrupted tmux_json
  // ---------------------------------------------------------------------------
  it('runtime with corrupted tmux_json returns undefined for that field', () => {
    // Insert session first (FK constraint)
    insertSession('hsid-rt-corrupt')
    const now = ts()
    db.runtimes.insert({
      runtimeId: 'rt-corrupt-1',
      hostSessionId: 'hsid-rt-corrupt',
      scopeRef: 'scope-corrupt',
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code' as any,
      provider: 'anthropic' as any,
      status: 'running',
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    corruptColumn('runtimes', 'tmux_json', 'rt-corrupt-1', 'runtime_id')

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const runtime = db.runtimes.getByRuntimeId('rt-corrupt-1')
      expect(runtime).not.toBeNull()
      expect(runtime!.tmuxJson).toBeUndefined()
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ---------------------------------------------------------------------------
  // Event: corrupted event_json
  // ---------------------------------------------------------------------------
  it('event with corrupted event_json returns undefined for eventJson', () => {
    insertSession('hsid-ev-corrupt')
    db.events.append({
      ts: ts(),
      hostSessionId: 'hsid-ev-corrupt',
      scopeRef: 'scope-corrupt',
      laneRef: 'default',
      generation: 1,
      source: 'test' as any,
      eventKind: 'test-event',
      eventJson: { hello: 'world' },
    })

    // Corrupt the event_json column
    db.sqlite.run(
      'UPDATE events SET event_json = ? WHERE host_session_id = ?',
      '{broken json',
      'hsid-ev-corrupt'
    )

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const events = db.events.query({ hostSessionId: 'hsid-ev-corrupt' })
      expect(events.length).toBeGreaterThan(0)
      expect(events[0].eventJson).toBeUndefined()
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ---------------------------------------------------------------------------
  // Log context: verify meaningful error message
  // ---------------------------------------------------------------------------
  it('logs table hint, column name, and raw value snippet on corruption', () => {
    insertSession('hsid-log-ctx')
    corruptColumn('sessions', 'parsed_scope_json', 'hsid-log-ctx', 'host_session_id')

    const logged: string[] = []
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    try {
      db.sessions.getByHostSessionId('hsid-log-ctx')
      expect(logged.length).toBeGreaterThan(0)
      // Must contain column name
      expect(logged[0]).toContain('parsed_scope_json')
      // Must contain a snippet of the corrupted value
      expect(logged[0]).toContain('not-valid-json')
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ---------------------------------------------------------------------------
  // Listing: corrupted row doesn't prevent other rows from loading
  // ---------------------------------------------------------------------------
  it('listing sessions returns all rows even when one has corrupted JSON', () => {
    insertSession('hsid-ok-1')

    // Insert a second session
    const now = ts()
    db.sessions.create({
      hostSessionId: 'hsid-ok-2',
      scopeRef: 'scope-corrupt',
      laneRef: 'default',
      generation: 2,
      status: 'active',
      priorHostSessionId: 'hsid-ok-1',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })

    // Corrupt JSON on the first session only
    corruptColumn('sessions', 'parsed_scope_json', 'hsid-ok-1', 'host_session_id')

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const sessions = db.sessions.listByScopeRef('scope-corrupt', 'default')
      expect(sessions.length).toBe(2)
      // One has undefined parsedScopeJson, the other doesn't
      const corrupted = sessions.find((s) => s.hostSessionId === 'hsid-ok-1')
      expect(corrupted!.parsedScopeJson).toBeUndefined()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
