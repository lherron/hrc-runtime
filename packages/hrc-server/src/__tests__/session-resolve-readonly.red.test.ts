/**
 * RED tests (T-01854) — hrc session resolve must be read-only by default.
 *
 * Problem: POST /v1/sessions/resolve currently has two write-on-read bugs:
 *
 *   Bug A (no-session path): when no continuity session exists and no --create
 *   flag is passed, the handler unconditionally inserts a session row + continuity
 *   row and emits session.created. An inspection-shaped resolve must be a pure
 *   read; it must NOT create anything.
 *
 *   Bug B (existing-session path): when a continuity session IS found the handler
 *   still calls appendEvent('session.resolved') + notifyEvent — a write-on-read.
 *   A plain resolve must emit NO lifecycle events in this path either.
 *
 *   Bug C (default lane): the CLI defaults the lane to 'default' instead of
 *   'main', minting phantom lane:default sessions when a plain resolve is run.
 *   A plain resolve (old CLI default: lane:default) must create no rows.
 *
 * Required behaviours (architecture approved: C-03257):
 *   [RED 1] plain-resolve-creates-nothing — no create flag, no session/continuity
 *           exists → created:false, 0 session rows, 0 continuity rows, 0
 *           session.created events.
 *   [RED 2] plain-resolve-existing-no-event — no create flag, continuity found
 *           → created:false, ZERO new lifecycle events (no session.resolved write).
 *   [RED 3] default-lane-no-phantom — plain resolve with lane:default (the current
 *           wrong CLI default) must not mint a phantom lane:default session row.
 *   [GREEN 4] create-flag-still-creates — resolve with create:true still inserts
 *             session + continuity and emits session.created (contract guardrail).
 *
 * Tests 1-3 FAIL against current code (current code always creates / always emits).
 * Test 4 passes now and must stay green after the fix.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Database } from 'bun:sqlite'
import type { HrcLifecycleEvent, ResolveSessionResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-session-resolve-readonly-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

// ── DB helpers ────────────────────────────────────────────────────────────────

function countSessionsByScopeRef(scopeRef: string): number {
  const db = new Database(fixture.dbPath)
  try {
    const row = db
      .query<{ n: number }, [string]>('SELECT COUNT(*) as n FROM sessions WHERE scope_ref = ?')
      .get(scopeRef)
    return row?.n ?? 0
  } finally {
    db.close()
  }
}

function countContinuitiesByScopeRef(scopeRef: string): number {
  const db = new Database(fixture.dbPath)
  try {
    const row = db
      .query<{ n: number }, [string]>('SELECT COUNT(*) as n FROM continuities WHERE scope_ref = ?')
      .get(scopeRef)
    return row?.n ?? 0
  } finally {
    db.close()
  }
}

function countSessionsByLane(scopeRef: string, laneRef: string): number {
  const db = new Database(fixture.dbPath)
  try {
    const row = db
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) as n FROM sessions WHERE scope_ref = ? AND lane_ref = ?'
      )
      .get(scopeRef, laneRef)
    return row?.n ?? 0
  } finally {
    db.close()
  }
}

function listEventsByScopeRef(scopeRef: string): HrcLifecycleEvent[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.listFromHrcSeq(1).filter((e) => e.scopeRef === scopeRef)
  } finally {
    db.close()
  }
}

async function postResolve(
  sessionRef: string,
  extra: Record<string, unknown> = {}
): Promise<{ status: number; body: ResolveSessionResponse }> {
  const res = await fixture.postJson('/v1/sessions/resolve', { sessionRef, ...extra })
  expect(res.status).toBe(200)
  const body = (await res.json()) as ResolveSessionResponse
  return { status: res.status, body }
}

// ── RED 1: plain resolve — no session — creates nothing ───────────────────────

describe('[RED 1] plain resolve — no continuity exists — must create nothing', () => {
  it('returns created:false when no session exists and no create flag', async () => {
    const scopeRef = 'agent:test-resolve-ro-new:project:t01854'
    const { body } = await postResolve(`${scopeRef}/lane:main`)
    // RED: current code returns created:true (inserts unconditionally)
    expect(body.created).toBe(false)
  })

  it('inserts no session row when no create flag', async () => {
    const scopeRef = 'agent:test-resolve-ro-nosession:project:t01854'
    await postResolve(`${scopeRef}/lane:main`)
    // RED: current code inserts a session row
    expect(countSessionsByScopeRef(scopeRef)).toBe(0)
  })

  it('inserts no continuity row when no create flag', async () => {
    const scopeRef = 'agent:test-resolve-ro-nocontinuity:project:t01854'
    await postResolve(`${scopeRef}/lane:main`)
    // RED: current code inserts a continuity row
    expect(countContinuitiesByScopeRef(scopeRef)).toBe(0)
  })

  it('emits no session.created event when no create flag', async () => {
    const scopeRef = 'agent:test-resolve-ro-noevent:project:t01854'
    await postResolve(`${scopeRef}/lane:main`)
    const events = listEventsByScopeRef(scopeRef).filter((e) => e.eventKind === 'session.created')
    // RED: current code appends session.created
    expect(events).toHaveLength(0)
  })
})

// ── RED 2: plain resolve — existing session — emits no event ─────────────────

describe('[RED 2] plain resolve — existing continuity found — must not emit any event', () => {
  it('emits no session.resolved event when resolving an existing session without create flag', async () => {
    const scopeRef = 'agent:test-resolve-ro-existing:project:t01854'
    const sessionRef = `${scopeRef}/lane:main`

    // Setup: create a real session via explicit create flag
    await postResolve(sessionRef, { create: true })
    const eventsAfterCreate = listEventsByScopeRef(scopeRef)

    // Plain resolve — finds existing continuity — must NOT emit session.resolved
    const { body } = await postResolve(sessionRef)
    expect(body.created).toBe(false)

    const eventsAfterResolve = listEventsByScopeRef(scopeRef)
    // RED: current code appends session.resolved (one more event than after create)
    expect(eventsAfterResolve).toHaveLength(eventsAfterCreate.length)
  })

  it('emits no new events of any kind on a plain resolve of an existing session', async () => {
    const scopeRef = 'agent:test-resolve-ro-nowrite:project:t01854'
    const sessionRef = `${scopeRef}/lane:main`

    await postResolve(sessionRef, { create: true })
    const countBefore = listEventsByScopeRef(scopeRef).length

    await postResolve(sessionRef)
    await postResolve(sessionRef)

    const countAfter = listEventsByScopeRef(scopeRef).length
    // RED: current code appends two session.resolved events (one per plain resolve)
    expect(countAfter).toBe(countBefore)
  })
})

// ── RED 3: plain resolve — default lane — no phantom lane:default session ─────

describe('[RED 3] default lane must be main — plain resolve must not mint phantom lane:default session', () => {
  it('inserts no session at lane:default when plain resolve uses lane:default (old CLI default)', async () => {
    // The CLI currently defaults to lane:default (the bug).
    // A plain resolve must NOT create a phantom session at lane:default.
    const scopeRef = 'agent:test-resolve-ro-deflt:project:t01854'
    await postResolve(`${scopeRef}/lane:default`)
    // RED: current code inserts a session at lane:default
    expect(countSessionsByLane(scopeRef, 'default')).toBe(0)
  })

  it('inserts no rows at all when plain resolve uses the old default lane:default', async () => {
    const scopeRef = 'agent:test-resolve-ro-deflt2:project:t01854'
    await postResolve(`${scopeRef}/lane:default`)
    // RED: current code inserts a session + continuity row
    expect(countSessionsByScopeRef(scopeRef)).toBe(0)
    expect(countContinuitiesByScopeRef(scopeRef)).toBe(0)
  })

  it('plain resolve of lane:main also creates nothing (correct new default lane)', async () => {
    const scopeRef = 'agent:test-resolve-ro-main:project:t01854'
    const { body } = await postResolve(`${scopeRef}/lane:main`)
    // RED: current code creates and returns created:true
    expect(body.created).toBe(false)
    expect(countSessionsByScopeRef(scopeRef)).toBe(0)
  })
})

// ── GREEN 4: create:true still creates (contract guardrail) ──────────────────

describe('[GREEN 4] resolve with create:true still creates as before', () => {
  it('inserts a session row when create:true is passed', async () => {
    const scopeRef = 'agent:test-resolve-create-session:project:t01854'
    const { body } = await postResolve(`${scopeRef}/lane:main`, { create: true })
    expect(body.created).toBe(true)
    expect(body.hostSessionId).toBeString()
    expect(body.generation).toBe(1)
    expect(countSessionsByScopeRef(scopeRef)).toBe(1)
  })

  it('inserts a continuity row when create:true is passed', async () => {
    const scopeRef = 'agent:test-resolve-create-cont:project:t01854'
    await postResolve(`${scopeRef}/lane:main`, { create: true })
    expect(countContinuitiesByScopeRef(scopeRef)).toBe(1)
  })

  it('emits a session.created event when create:true is passed', async () => {
    const scopeRef = 'agent:test-resolve-create-event:project:t01854'
    await postResolve(`${scopeRef}/lane:main`, { create: true })
    const events = listEventsByScopeRef(scopeRef).filter((e) => e.eventKind === 'session.created')
    expect(events).toHaveLength(1)
  })

  it('subsequent plain resolve of an existing session returns created:false', async () => {
    const scopeRef = 'agent:test-resolve-create-idem:project:t01854'
    const sessionRef = `${scopeRef}/lane:main`
    const first = await postResolve(sessionRef, { create: true })
    expect(first.body.created).toBe(true)

    // After the fix: plain resolve finds existing → created:false
    const second = await postResolve(sessionRef)
    expect(second.body.created).toBe(false)
    expect(second.body.hostSessionId).toBe(first.body.hostSessionId)
  })
})
