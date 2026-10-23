/**
 * Retention regression coverage (T-04831, T-07575, T-11569).
 * The internal sweep archives idle non-primary sessions without deleting rows
 * or continuations. Reaped sessions remain dormant and resumable in target views.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import type { HrcTargetView } from 'hrc-core'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { archiveIdleSessions } from '../target-message-handlers.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture, ResolveSessionResult } from './fixtures/hrc-test-fixture'

const SCOPE_PREFIX = 'agent:test:project:t04831-group3'
const CONTINUATION_KEY = 'sess-key-t04831-g3'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-arch-rpr-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

// ── Seeding helpers ───────────────────────────────────────────────────────────

async function seedSessionWithContinuation(
  scopeRef: string,
  laneRef = 'main'
): Promise<ResolveSessionResult & { sessionRef: string }> {
  const resolved = await fixture.resolveSession(scopeRef)
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.updateContinuation(
      resolved.hostSessionId,
      { provider: 'anthropic', key: CONTINUATION_KEY },
      new Date().toISOString()
    )
  } finally {
    db.close()
  }
  return { ...resolved, sessionRef: `${scopeRef}/lane:${laneRef}` }
}

/**
 * Age the session row itself, not just its runtime.
 *
 * T-07575 made session recency authoritative: the sweep reads
 * `MAX(session_index.last_activity_at, runtimes.last_activity_at,
 * sessions.created_at)`, so a fixture that seeds an 8-day-old runtime under a
 * session minted three milliseconds ago describes a session that is *not*
 * abandoned, and the sweep is right to spare it. These fixtures always meant
 * "this whole session was abandoned N days ago"; this makes them say it.
 */
function ageSession(hostSessionId: string, isoTimestamp: string): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sqlite.run('UPDATE sessions SET created_at = ?, updated_at = ? WHERE host_session_id = ?', [
      isoTimestamp,
      isoTimestamp,
      hostSessionId,
    ])
    db.sqlite.run('UPDATE session_index SET last_activity_at = ? WHERE host_session_id = ?', [
      isoTimestamp,
      hostSessionId,
    ])
  } finally {
    db.close()
  }
}

async function getTargetByRef(sessionRef: string): Promise<{ status: number; body: unknown }> {
  const url = `/v1/targets/by-session-ref?sessionRef=${encodeURIComponent(sessionRef)}`
  const res = await fixture.fetchSocket(url)
  return { status: res.status, body: await res.json() }
}

function archiveAbandoned(idleThresholdDays = 7) {
  return archiveIdleSessions(server as unknown as HrcServerInstanceForHandlers, idleThresholdDays)
}

describe('[RED 3d] Internal retention sweep archives idle non-primary sessions', () => {
  const scopeRef = `${SCOPE_PREFIX}:task:reap-target`
  let resolved: ResolveSessionResult

  beforeEach(async () => {
    resolved = await seedSessionWithContinuation(scopeRef)

    // Seed a terminal runtime so the session appears "abandoned"
    const runtimeId = 'rt-reap-test-3d'
    const db = openHrcDatabase(fixture.dbPath)
    const pastDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() // 8 days ago
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId: resolved.hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation: resolved.generation,
        transport: 'headless',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'terminated',
        supportsInflightInput: false,
        lastActivityAt: pastDate,
        createdAt: pastDate,
        updatedAt: pastDate,
      })
    } finally {
      db.close()
    }
    ageSession(resolved.hostSessionId, pastDate)
  })

  it('the retention sweep reports the archived row', () => {
    expect(archiveAbandoned(7).archived).toBe(1)
  })

  it('archives sessions with terminal runtime idle >= threshold', async () => {
    archiveAbandoned(7)
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
      expect(session?.status).toBe('archived')
    } finally {
      db.close()
    }
  })

  it('skips primary-scope sessions (must not archive :task:primary)', async () => {
    // T-04833: PRIMARY shape is `…:task:primary` — NOT a no-task scope.
    // The old fixture used 'agent:test:project:t04831-group3' (no :task: segment)
    // which masked the bug: isPrimaryScopeRef = !scopeRef.includes(':task:') returns
    // false for the real primary shape, so the reaper wrongly archives it.
    const primaryScope = 'agent:test:project:t04831-group3:task:primary'
    const primaryResolved = await seedSessionWithContinuation(primaryScope)

    // NON-PRIMARY companion: a regular task session that MUST be reaped.
    // It carries a continuation because T-07575 only archives resumable
    // sessions — archiving a keyless one would report it `broken` and drop it
    // from dormant target listings, which is a capability change.
    const nonPrimaryScope = 'agent:test:project:t04831-group3:task:T-04833-reapme'
    const nonPrimaryResolved = await seedSessionWithContinuation(nonPrimaryScope)

    // Seed terminal runtimes for BOTH so the reaper would archive them if unprotected
    const pastDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const setupDb = openHrcDatabase(fixture.dbPath)
    try {
      setupDb.runtimes.insert({
        runtimeId: 'rt-primary-skip-3d',
        hostSessionId: primaryResolved.hostSessionId,
        scopeRef: primaryScope,
        laneRef: 'default',
        generation: primaryResolved.generation,
        transport: 'headless',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'terminated',
        supportsInflightInput: false,
        lastActivityAt: pastDate,
        createdAt: pastDate,
        updatedAt: pastDate,
      })
      setupDb.runtimes.insert({
        runtimeId: 'rt-nonprimary-reap-3d',
        hostSessionId: nonPrimaryResolved.hostSessionId,
        scopeRef: nonPrimaryScope,
        laneRef: 'default',
        generation: nonPrimaryResolved.generation,
        transport: 'headless',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'terminated',
        supportsInflightInput: false,
        lastActivityAt: pastDate,
        createdAt: pastDate,
        updatedAt: pastDate,
      })
    } finally {
      setupDb.close()
    }
    ageSession(primaryResolved.hostSessionId, pastDate)
    ageSession(nonPrimaryResolved.hostSessionId, pastDate)

    archiveAbandoned(7)

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      const nonPrimarySession = verifyDb.sessions.getByHostSessionId(
        nonPrimaryResolved.hostSessionId
      )
      // Companion: non-primary :task:T-04833-reapme WITH terminal+idle runtime MUST be
      // archived. Proves the reaper still fires correctly for task sessions.
      // This assertion passes both before and after the fix.
      expect(nonPrimarySession?.status).toBe('archived')

      const primarySession = verifyDb.sessions.getByHostSessionId(primaryResolved.hostSessionId)
      // for ':task:primary' — so the reaper archives it wrongly. This assertion FAILS.
      expect(primarySession?.status).toBe('active')
    } finally {
      verifyDb.close()
    }
  })
})

// ── RED 3e: GC reaper MUST NOT drop continuation ─────────────────────────────

describe('[RED 3e] archive-abandoned must not delete/null continuation', () => {
  const scopeRef = `${SCOPE_PREFIX}:task:reap-no-drop`
  let resolved: ResolveSessionResult

  beforeEach(async () => {
    resolved = await seedSessionWithContinuation(scopeRef)

    // Seed a terminal runtime older than the threshold
    const db = openHrcDatabase(fixture.dbPath)
    const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    try {
      db.runtimes.insert({
        runtimeId: 'rt-reap-drop-3e',
        hostSessionId: resolved.hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation: resolved.generation,
        transport: 'headless',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'terminated',
        supportsInflightInput: false,
        lastActivityAt: pastDate,
        createdAt: pastDate,
        updatedAt: pastDate,
      })
    } finally {
      db.close()
    }
  })

  it('continuation is preserved after reaping (archiving is a view filter not deletion)', async () => {
    archiveAbandoned(7)
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
      expect(session?.continuation).toBeDefined()
      expect(session?.continuation?.key).toBe(CONTINUATION_KEY)
    } finally {
      db.close()
    }
  })
})

// ── RED 3f: reaped session is dormant/resumable ───────────────────────────────

describe('[RED 3f] reaped session returns dormant from target view', () => {
  const scopeRef = `${SCOPE_PREFIX}:task:reap-dormant`
  const sessionRef = `${scopeRef}/lane:default`
  let resolved: ResolveSessionResult

  beforeEach(async () => {
    resolved = await seedSessionWithContinuation(scopeRef)

    // Seed a terminal runtime older than the threshold
    const db = openHrcDatabase(fixture.dbPath)
    const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    try {
      db.runtimes.insert({
        runtimeId: 'rt-reap-dormant-3f',
        hostSessionId: resolved.hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation: resolved.generation,
        transport: 'headless',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'terminated',
        supportsInflightInput: false,
        lastActivityAt: pastDate,
        createdAt: pastDate,
        updatedAt: pastDate,
      })
    } finally {
      db.close()
    }
    ageSession(resolved.hostSessionId, pastDate)
  })

  it('reaped session has state dormant in target view (continuation intact, resumable)', async () => {
    archiveAbandoned(7)

    const { status, body } = await getTargetByRef(sessionRef)
    expect(status).toBe(200)
    const view = body as HrcTargetView
    expect(view.state).toBe('dormant')
    expect(view.continuation?.key).toBe(CONTINUATION_KEY)
  })
})
