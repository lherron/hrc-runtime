/**
 * RED tests (T-04831 / parent T-04827 GROUP 3) — removal and GC reaper
 * must archive sessions, not orphan continuity.
 *
 * Architecture: daedalus-cleared (T-04827).
 *
 * [RED 3a] app-session removal: archived host session returns 'dormant' target
 *   After `POST /v1/app-sessions/remove` the host session is archived but
 *   its continuation is intact.  GET /v1/targets/by-session-ref must return
 *   state:'dormant' (not 'broken').  Currently returns 'broken' because
 *   toTargetState maps every non-active session to 'broken'.
 *
 * [RED 3b] app-session removal: continuation MUST NOT be dropped by the removal
 *   path.  Regression fence — currently passes (removal does not touch
 *   continuation_json).  Kept here as a GREEN guard so a future refactor cannot
 *   accidentally add continuation-clearing to the removal path.
 *
 * [RED 3c] app-session selector stays 'removed' after a successor is minted
 *   After removal the app-session record shows status:'removed'.  Minting a
 *   successor (resume) must NOT flip the app-session back to 'active' — the app
 *   session stays 'removed' until explicitly re-created.
 *   Currently RED because POST /v1/sessions/create-successor (the successor
 *   endpoint) does not exist.
 *
 * [RED 3d] GC reaper: archives abandoned-active sessions (no live runtime, idle)
 *   POST /v1/sessions/archive-abandoned must archive host sessions whose
 *   runtime is terminal and idle >= threshold, skipping primary-scope sessions.
 *   Currently fails with HTTP 404 (endpoint does not exist).
 *
 * [RED 3e] GC reaper MUST NOT drop continuation
 *   A reaped session's continuation_json must be preserved unchanged.  Archiving
 *   only delists; it must never delete JSONL/continuation.
 *   Currently RED because the endpoint does not exist.
 *
 * [RED 3f] Reaped session returns 'dormant' from target view
 *   After reaping, GET /v1/targets/by-session-ref must return state:'dormant'
 *   (continuation intact + artifact present/unknown).
 *   Currently RED because the endpoint does not exist AND toTargetState bug.
 *
 * RED at HEAD:
 *   3a — GET returns state:'broken' instead of 'dormant' after removal
 *   3c — POST /v1/sessions/create-successor → 404
 *   3d — POST /v1/sessions/archive-abandoned → 404
 *   3e — endpoint missing, would fail if it existed (no reaper yet)
 *   3f — endpoint missing + toTargetState bug
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { type AppManagedSessionRecord, openHrcDatabase } from 'hrc-store-sqlite'

import type { HrcTargetView } from 'hrc-core'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
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

function seedAppManagedSession(
  appId: string,
  appSessionKey: string,
  hostSessionId: string,
  generation: number
): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = new Date().toISOString()
  try {
    db.appManagedSessions.create({
      appId,
      appSessionKey,
      kind: 'harness',
      activeHostSessionId: hostSessionId,
      generation,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } as AppManagedSessionRecord)
  } finally {
    db.close()
  }
}

async function removeAppSession(
  appId: string,
  appSessionKey: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fixture.postJson('/v1/app-sessions/remove', {
    selector: { appId, appSessionKey },
    terminateRuntime: false,
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function getTargetByRef(sessionRef: string): Promise<{ status: number; body: unknown }> {
  const url = `/v1/targets/by-session-ref?sessionRef=${encodeURIComponent(sessionRef)}`
  const res = await fixture.fetchSocket(url)
  return { status: res.status, body: await res.json() }
}

async function safePostJson(
  path: string,
  body: Record<string, unknown>
): Promise<{
  status: number
  body: Record<string, unknown>
}> {
  const res = await fixture.postJson(path, body)
  const text = await res.text()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = { _raw: text, _parseError: true }
  }
  return { status: res.status, body: parsed }
}

async function postCreateSuccessor(
  sessionRef: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  return safePostJson('/v1/sessions/create-successor', { sessionRef })
}

async function postArchiveAbandoned(body: Record<string, unknown> = {}): Promise<{
  status: number
  body: Record<string, unknown>
}> {
  return safePostJson('/v1/sessions/archive-abandoned', body)
}

// ── RED 3a: after removal, target view returns 'dormant' ─────────────────────

describe('[RED 3a] app-session removal: archived host session returns dormant target', () => {
  const appId = 'test-app-t04831-3a'
  const appSessionKey = 'sess-3a'
  const scopeRef = `${SCOPE_PREFIX}:task:removal-dormant`
  let resolved: ResolveSessionResult

  beforeEach(async () => {
    resolved = await seedSessionWithContinuation(scopeRef)
    seedAppManagedSession(appId, appSessionKey, resolved.hostSessionId, resolved.generation)
  })

  it('removal succeeds (HTTP 200)', async () => {
    const { status } = await removeAppSession(appId, appSessionKey)
    expect(status).toBe(200)
  })

  it('host session is archived after removal', async () => {
    await removeAppSession(appId, appSessionKey)
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
      expect(session?.status).toBe('archived')
    } finally {
      db.close()
    }
  })

  it('archived host session returns dormant from target view (not broken)', async () => {
    await removeAppSession(appId, appSessionKey)
    const { status, body } = await getTargetByRef(`${scopeRef}/lane:default`)
    expect(status).toBe(200)
    const view = body as HrcTargetView
    // RED: currently 'broken' because toTargetState maps status !== 'active' → 'broken'
    expect(view.state).toBe('dormant')
  })
})

// ── GREEN guard 3b: removal must NOT drop continuation ───────────────────────

describe('[GREEN guard 3b] app-session removal: continuation is NOT dropped (regression fence)', () => {
  const appId = 'test-app-t04831-3b'
  const appSessionKey = 'sess-3b'
  const scopeRef = `${SCOPE_PREFIX}:task:removal-no-drop`
  let resolved: ResolveSessionResult

  beforeEach(async () => {
    resolved = await seedSessionWithContinuation(scopeRef)
    seedAppManagedSession(appId, appSessionKey, resolved.hostSessionId, resolved.generation)
  })

  it('host session continuation_json is intact after removal', async () => {
    await removeAppSession(appId, appSessionKey)
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
      // GREEN: removal does not touch continuation_json
      expect(session?.continuation).toBeDefined()
      expect(session?.continuation?.key).toBe(CONTINUATION_KEY)
      expect(session?.continuation?.provider).toBe('anthropic')
    } finally {
      db.close()
    }
  })

  it('continuation key is preserved after removal so resume is possible', async () => {
    await removeAppSession(appId, appSessionKey)
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
      // GREEN: key survives archiving
      expect(session?.continuation?.key).toBe(CONTINUATION_KEY)
    } finally {
      db.close()
    }
  })
})

// ── RED 3c: app-session selector stays 'removed' after successor mint ─────────

describe('[RED 3c] app-session stays removed after resume via successor', () => {
  const appId = 'test-app-t04831-3c'
  const appSessionKey = 'sess-3c'
  const scopeRef = `${SCOPE_PREFIX}:task:selector-removed`
  const sessionRef = `${scopeRef}/lane:default`
  let resolved: ResolveSessionResult

  beforeEach(async () => {
    resolved = await seedSessionWithContinuation(scopeRef)
    seedAppManagedSession(appId, appSessionKey, resolved.hostSessionId, resolved.generation)
    await removeAppSession(appId, appSessionKey)
  })

  it('app-session record shows removed after removal', async () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const managed = db.appManagedSessions.findByKey(appId, appSessionKey)
      expect(managed?.status).toBe('removed')
    } finally {
      db.close()
    }
  })

  it('create-successor endpoint returns 200 (not 404)', async () => {
    const { status } = await postCreateSuccessor(sessionRef)
    // RED: currently 404 (endpoint doesn't exist)
    expect(status).toBe(200)
  })

  it('app-session stays removed after successor is minted (no reactivation-in-place)', async () => {
    await postCreateSuccessor(sessionRef)
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const managed = db.appManagedSessions.findByKey(appId, appSessionKey)
      // RED: app session must stay removed — resuming via sessionRef/host is allowed
      // but the app-session selector must NOT be flipped back to active
      expect(managed?.status).toBe('removed')
    } finally {
      db.close()
    }
  })

  it('a new active host session is created but the app managed session is NOT updated', async () => {
    const { body } = await postCreateSuccessor(sessionRef)
    const result = body as Record<string, unknown>

    // RED: endpoint doesn't exist, so these assertions fail
    const newHostSessionId = result['hostSessionId'] as string | undefined
    expect(newHostSessionId).toBeDefined()
    expect(newHostSessionId).not.toBe(resolved.hostSessionId)

    // The app managed session must NOT have been updated to the new hostSessionId
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const managed = db.appManagedSessions.findByKey(appId, appSessionKey)
      expect(managed?.activeHostSessionId).toBe(resolved.hostSessionId) // unchanged
    } finally {
      db.close()
    }
  })
})

// ── RED 3d: GC reaper archives abandoned sessions ─────────────────────────────

describe('[RED 3d] POST /v1/sessions/archive-abandoned archives idle non-primary sessions', () => {
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
        adopted: false,
        lastActivityAt: pastDate,
        createdAt: pastDate,
        updatedAt: pastDate,
      })
    } finally {
      db.close()
    }
  })

  it('archive-abandoned endpoint returns HTTP 200 (not 404)', async () => {
    const { status } = await postArchiveAbandoned({ idleThresholdDays: 7 })
    // RED: currently 404 (endpoint does not exist)
    expect(status).toBe(200)
  })

  it('archives sessions with terminal runtime idle >= threshold', async () => {
    await postArchiveAbandoned({ idleThresholdDays: 7 })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
      // RED: endpoint doesn't exist, session stays 'active'
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
    const primaryResolved = await fixture.resolveSession(primaryScope)

    // NON-PRIMARY companion: a regular task session that MUST be reaped
    const nonPrimaryScope = 'agent:test:project:t04831-group3:task:T-04833-reapme'
    const nonPrimaryResolved = await fixture.resolveSession(nonPrimaryScope)

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
        adopted: false,
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
        adopted: false,
        lastActivityAt: pastDate,
        createdAt: pastDate,
        updatedAt: pastDate,
      })
    } finally {
      setupDb.close()
    }

    await postArchiveAbandoned({ idleThresholdDays: 7 })

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
      // RED: current isPrimaryScopeRef = !scopeRef.includes(':task:') returns FALSE
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
        adopted: false,
        lastActivityAt: pastDate,
        createdAt: pastDate,
        updatedAt: pastDate,
      })
    } finally {
      db.close()
    }
  })

  it('continuation is preserved after reaping (archiving is a view filter not deletion)', async () => {
    await postArchiveAbandoned({ idleThresholdDays: 7 })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
      // RED: endpoint doesn't exist + must not drop continuation
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
        adopted: false,
        lastActivityAt: pastDate,
        createdAt: pastDate,
        updatedAt: pastDate,
      })
    } finally {
      db.close()
    }
  })

  it('reaped session has state dormant in target view (continuation intact, resumable)', async () => {
    await postArchiveAbandoned({ idleThresholdDays: 7 })

    const { status, body } = await getTargetByRef(sessionRef)
    expect(status).toBe(200)
    const view = body as HrcTargetView
    // RED: endpoint doesn't exist + toTargetState bug (returns 'broken' for archived)
    expect(view.state).toBe('dormant')
    expect(view.continuation?.key).toBe(CONTINUATION_KEY)
  })
})
