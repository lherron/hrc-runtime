/**
 * M-15: Direct coverage for derivePriorHostSessionIds() (T-00985)
 *
 * Tests the continuity chain derivation logic via the public
 * ContinuityRepository.getByKey() API, which calls derivePriorHostSessionIds()
 * internally. Validates:
 *   - Ordering: returned array is oldest-to-newest
 *   - Cycle detection: circular prior_host_session_id chains don't loop
 *   - Edge cases: single session, broken chain, no sessions
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcSessionRecord } from 'hrc-core'

import type { HrcDatabase } from '../database'
import { openHrcDatabase } from '../index'

let tmpDir: string
let dbPath: string
let db: HrcDatabase

function ts(): string {
  return new Date().toISOString()
}

function makeSession(
  hostSessionId: string,
  generation: number,
  priorHostSessionId?: string
): HrcSessionRecord {
  return {
    hostSessionId,
    scopeRef: 'scope:chain-test',
    laneRef: 'default',
    generation,
    status: 'active',
    priorHostSessionId,
    createdAt: ts(),
    updatedAt: ts(),
    ancestorScopeRefs: [],
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-chain-test-'))
  dbPath = join(tmpDir, 'test.sqlite')
  db = openHrcDatabase(dbPath)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// M-15: derivePriorHostSessionIds ordering and cycle detection
// ---------------------------------------------------------------------------
describe('M-15: continuity chain derivation (T-00985)', () => {
  it('returns empty array for single session with no prior', () => {
    db.sessions.create(makeSession('hsid-solo', 1))
    db.continuities.upsert({
      scopeRef: 'scope:chain-test',
      laneRef: 'default',
      activeHostSessionId: 'hsid-solo',
      updatedAt: ts(),
    })

    const continuity = db.continuities.getByKey('scope:chain-test', 'default')
    expect(continuity).not.toBeNull()
    expect(continuity!.priorHostSessionIds).toEqual([])
  })

  it('returns chain in oldest-to-newest order for linear A→B→C', () => {
    // Create sessions: A (gen 1), B (gen 2, prior=A), C (gen 3, prior=B)
    db.sessions.create(makeSession('hsid-A', 1))
    db.sessions.create(makeSession('hsid-B', 2, 'hsid-A'))
    db.sessions.create(makeSession('hsid-C', 3, 'hsid-B'))

    db.continuities.upsert({
      scopeRef: 'scope:chain-test',
      laneRef: 'default',
      activeHostSessionId: 'hsid-C',
      updatedAt: ts(),
    })

    const continuity = db.continuities.getByKey('scope:chain-test', 'default')
    expect(continuity).not.toBeNull()
    // Walk from C→B→A, then reverse → [A, B]
    expect(continuity!.priorHostSessionIds).toEqual(['hsid-A', 'hsid-B'])
  })

  it('returns chain in oldest-to-newest for longer chain A→B→C→D→E', () => {
    db.sessions.create(makeSession('hsid-1', 1))
    db.sessions.create(makeSession('hsid-2', 2, 'hsid-1'))
    db.sessions.create(makeSession('hsid-3', 3, 'hsid-2'))
    db.sessions.create(makeSession('hsid-4', 4, 'hsid-3'))
    db.sessions.create(makeSession('hsid-5', 5, 'hsid-4'))

    db.continuities.upsert({
      scopeRef: 'scope:chain-test',
      laneRef: 'default',
      activeHostSessionId: 'hsid-5',
      updatedAt: ts(),
    })

    const continuity = db.continuities.getByKey('scope:chain-test', 'default')
    expect(continuity!.priorHostSessionIds).toEqual(['hsid-1', 'hsid-2', 'hsid-3', 'hsid-4'])
  })

  it('detects cycle and terminates without infinite loop', () => {
    // Create sessions that form a cycle: A→B→A
    // We need to insert with raw SQL to create the cycle since the FK
    // on prior_host_session_id would normally prevent B from pointing to A
    // before A exists, but we insert A first without a prior, then B pointing
    // to A, then update A to point to B.
    db.sessions.create(makeSession('hsid-cycle-A', 1))
    db.sessions.create(makeSession('hsid-cycle-B', 2, 'hsid-cycle-A'))

    // Force a cycle by updating A's prior to point to B
    db.sqlite.run(
      'UPDATE sessions SET prior_host_session_id = ? WHERE host_session_id = ?',
      'hsid-cycle-B',
      'hsid-cycle-A'
    )

    db.continuities.upsert({
      scopeRef: 'scope:chain-test',
      laneRef: 'default',
      activeHostSessionId: 'hsid-cycle-B',
      updatedAt: ts(),
    })

    // Should return a result (not hang) — cycle detection breaks the loop
    const continuity = db.continuities.getByKey('scope:chain-test', 'default')
    expect(continuity).not.toBeNull()
    // The chain walks B→A, sees A→B but B is already "seen" from start, so stops
    // Result should contain at most [A] (the prior of B)
    expect(continuity!.priorHostSessionIds.length).toBeLessThanOrEqual(2)
    expect(continuity!.priorHostSessionIds).toContain('hsid-cycle-A')
  })

  it('handles broken chain with prior in different scope', () => {
    // Create a session in a different scope — FK is satisfied but chain walk won't find it
    db.sessions.create({
      hostSessionId: 'hsid-other-scope',
      scopeRef: 'scope:other',
      laneRef: 'default',
      generation: 1,
      status: 'active',
      createdAt: ts(),
      updatedAt: ts(),
      ancestorScopeRefs: [],
    })

    // Session B points to other-scope session
    db.sessions.create(makeSession('hsid-cross-B', 1, 'hsid-other-scope'))

    db.continuities.upsert({
      scopeRef: 'scope:chain-test',
      laneRef: 'default',
      activeHostSessionId: 'hsid-cross-B',
      updatedAt: ts(),
    })

    const continuity = db.continuities.getByKey('scope:chain-test', 'default')
    expect(continuity).not.toBeNull()
    // hsid-other-scope is in the sessions table but NOT in scope:chain-test/default query
    // So byHostSessionId map won't contain it. But the chain walk pushes it, then can't find it.
    // Actually let me re-trace: currentHostSessionId = 'hsid-cross-B'
    // current = byHostSessionId.get('hsid-cross-B') → row for cross-B
    // priorHostSessionId = 'hsid-other-scope'
    // Not in seen → push, seen.add, currentHostSessionId = 'hsid-other-scope'
    // current = byHostSessionId.get('hsid-other-scope') → undefined (not in this scope)
    // priorHostSessionId = undefined → break
    // Result: ['hsid-other-scope'] reversed = ['hsid-other-scope']
    expect(continuity!.priorHostSessionIds).toEqual(['hsid-other-scope'])
  })

  it('only includes sessions from the same scope and lane', () => {
    // Different lane should not interfere
    db.sessions.create({
      hostSessionId: 'hsid-lane-other',
      scopeRef: 'scope:chain-test',
      laneRef: 'other-lane',
      generation: 1,
      status: 'active',
      createdAt: ts(),
      updatedAt: ts(),
      ancestorScopeRefs: [],
    })

    db.sessions.create(makeSession('hsid-lane-A', 1))
    db.sessions.create(makeSession('hsid-lane-B', 2, 'hsid-lane-A'))

    db.continuities.upsert({
      scopeRef: 'scope:chain-test',
      laneRef: 'default',
      activeHostSessionId: 'hsid-lane-B',
      updatedAt: ts(),
    })

    const continuity = db.continuities.getByKey('scope:chain-test', 'default')
    expect(continuity!.priorHostSessionIds).toEqual(['hsid-lane-A'])
  })
})
