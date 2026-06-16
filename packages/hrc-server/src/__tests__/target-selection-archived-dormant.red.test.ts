/**
 * RED tests (T-04831 / parent T-04827 GROUP 2) — selection and resolution of
 * archived sessions.
 *
 * Architecture: daedalus-cleared (T-04827).  Three behaviors to pin:
 *
 * [RED 2a] default target LIST hides archived rows
 *   GET /v1/targets must not return sessions with status 'archived', even when
 *   the continuity still points to the archived hostSessionId.  Currently the
 *   list INCLUDES them because listAllSessions returns all rows and
 *   isActiveTargetSession returns true when continuity.activeHostSessionId
 *   matches the archived session (continuity is not updated on removal).
 *
 * [RED 2b] explicit target GET surfaces archived row as state:'dormant'
 *   GET /v1/targets/by-session-ref?sessionRef=… for an archived session with
 *   a continuation must return { state: 'dormant' }.  Currently returns
 *   { state: 'broken' } because toTargetState maps every non-active session
 *   to 'broken'.
 *
 * [RED 2c] resuming an archived row mints a new active successor
 *   POST /v1/sessions/create-successor { sessionRef, priorHostSessionId }
 *   must:
 *     - mint a new status:'active' host session
 *     - set priorHostSessionId = archived session's hostSessionId
 *     - copy continuation + last intent/parsed scope from the archived row
 *     - repoint continuity.activeHostSessionId → the new session
 *     - leave the archived row with status:'archived' (no reactivation-in-place)
 *   Currently fails with HTTP 404 (endpoint does not exist).
 *
 * RED at HEAD:
 *   2a — archived rows appear in GET /v1/targets (list bug)
 *   2b — GET /v1/targets/by-session-ref returns state:'broken' not 'dormant'
 *   2c — POST /v1/sessions/create-successor returns HTTP 404
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import type { HrcTargetView } from 'hrc-core'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE_PREFIX = 'agent:test:project:t04831-group2'
const NOW = '2026-06-16T00:00:00.000Z'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-arch-sel-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

// ── DB helpers ────────────────────────────────────────────────────────────────

type SeedArchivedOpts = {
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  withContinuation?: boolean
  continuityPointsHere?: boolean // if true, continuity.activeHostSessionId === hostSessionId
}

function seedArchivedSession(opts: SeedArchivedOpts): void {
  const db = openHrcDatabase(fixture.dbPath)
  const ts = new Date().toISOString()
  try {
    db.sessions.insert({
      hostSessionId: opts.hostSessionId,
      scopeRef: opts.scopeRef,
      laneRef: opts.laneRef,
      generation: opts.generation,
      status: 'archived',
      createdAt: NOW,
      updatedAt: ts,
      ancestorScopeRefs: [],
      ...(opts.withContinuation
        ? { continuation: { provider: 'anthropic', key: 'sess-key-t04831-g2' } }
        : {}),
    })

    if (opts.continuityPointsHere) {
      db.continuities.upsert({
        scopeRef: opts.scopeRef,
        laneRef: opts.laneRef,
        activeHostSessionId: opts.hostSessionId,
        updatedAt: ts,
      })
    }
  } finally {
    db.close()
  }
}

async function getTargetList(): Promise<HrcTargetView[]> {
  const res = await fixture.fetchSocket('/v1/targets')
  expect(res.status).toBe(200)
  return (await res.json()) as HrcTargetView[]
}

async function getTargetByRef(sessionRef: string): Promise<{ status: number; body: unknown }> {
  const url = `/v1/targets/by-session-ref?sessionRef=${encodeURIComponent(sessionRef)}`
  const res = await fixture.fetchSocket(url)
  return { status: res.status, body: await res.json() }
}

async function postCreateSuccessor(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fixture.postJson('/v1/sessions/create-successor', body)
  const text = await res.text()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = { _raw: text, _parseError: true }
  }
  return { status: res.status, body: parsed }
}

// ── RED 2a: default list hides archived rows ──────────────────────────────────

describe('[RED 2a] GET /v1/targets list must NOT include archived sessions', () => {
  const scopeRef = `${SCOPE_PREFIX}:task:list-hide`
  const hostSessionId = 'hsid-archived-list-2a'
  const sessionRef = `${scopeRef}/lane:main`

  beforeEach(() => {
    // Seed an archived session where continuity still points to it (the post-removal
    // scenario: removal archives the session but doesn't repoint continuity).
    seedArchivedSession({
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 2,
      withContinuation: true,
      continuityPointsHere: true, // simulate removal: continuity not updated
    })
  })

  it('archived session does not appear in GET /v1/targets list', async () => {
    const targets = await getTargetList()
    const refs = targets.map((t) => t.sessionRef)
    // RED: currently included because isActiveTargetSession returns true when
    // continuity still points to the archived row
    expect(refs).not.toContain(sessionRef)
  })

  it('archived session is absent from list even when continuity points to it', async () => {
    const targets = await getTargetList()
    const found = targets.find((t) => t.scopeRef === scopeRef)
    // RED: currently found because continuity.activeHostSessionId === hostSessionId
    expect(found).toBeUndefined()
  })
})

// ── RED 2b: explicit GET surfaces archived as 'dormant' ──────────────────────

describe('[RED 2b] GET /v1/targets/by-session-ref must return state dormant for archived+continuation', () => {
  const scopeRef = `${SCOPE_PREFIX}:task:get-dormant`
  const hostSessionId = 'hsid-archived-get-2b'
  const sessionRef = `${scopeRef}/lane:main`

  beforeEach(() => {
    seedArchivedSession({
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 2,
      withContinuation: true,
      continuityPointsHere: true,
    })
  })

  it('returns HTTP 200 for an archived session by sessionRef', async () => {
    const { status } = await getTargetByRef(sessionRef)
    // Should still be findable (findTargetSession uses continuity pointer)
    expect(status).toBe(200)
  })

  it('returns state dormant for archived session with continuation (not broken)', async () => {
    const { status, body } = await getTargetByRef(sessionRef)
    expect(status).toBe(200)
    const view = body as HrcTargetView
    // RED: currently returns 'broken' (toTargetState maps status !== 'active' → 'broken')
    expect(view.state).toBe('dormant')
  })

  it('continuation field is preserved in the target view', async () => {
    const { body } = await getTargetByRef(sessionRef)
    const view = body as HrcTargetView
    // Continuation must survive archiving so resume is possible
    expect(view.continuation).toBeDefined()
    expect(view.continuation?.key).toBe('sess-key-t04831-g2')
  })

  it('archived session with missing artifact returns broken (non-resumable)', async () => {
    const missingScope = `${SCOPE_PREFIX}:task:get-broken-missing`
    const missingHsid = 'hsid-archived-missing-2b'
    // Seed archived session with no continuation key — no artifact to probe
    seedArchivedSession({
      hostSessionId: missingHsid,
      scopeRef: missingScope,
      laneRef: 'main',
      generation: 1,
      withContinuation: false, // no continuation ref
      continuityPointsHere: true,
    })
    const { status, body } = await getTargetByRef(`${missingScope}/lane:main`)
    expect(status).toBe(200)
    const view = body as HrcTargetView
    // No continuation → broken (non-resumable); this should pass before and after the fix
    expect(view.state).toBe('broken')
  })
})

// ── RED 2c: resume mints a new active successor ───────────────────────────────

describe('[RED 2c] POST /v1/sessions/create-successor mints active successor from archived row', () => {
  const scopeRef = `${SCOPE_PREFIX}:task:successor`
  const archivedHsid = 'hsid-archived-successor-2c'
  const sessionRef = `${scopeRef}/lane:main`

  beforeEach(() => {
    seedArchivedSession({
      hostSessionId: archivedHsid,
      scopeRef,
      laneRef: 'main',
      generation: 2,
      withContinuation: true,
      continuityPointsHere: true,
    })
  })

  it('returns HTTP 200 (not 404) for create-successor endpoint', async () => {
    const { status } = await postCreateSuccessor({ sessionRef })
    // RED: currently 404 (endpoint does not exist)
    expect(status).toBe(200)
  })

  it('mints a new active session with incremented generation', async () => {
    const { body } = await postCreateSuccessor({ sessionRef })
    const result = body as Record<string, unknown>
    // RED: endpoint doesn't exist, so result is error body
    expect(result['status']).toBe('active')
    expect(result['generation']).toBe(3) // archived was gen 2 → successor gen 3
  })

  it('successor preserves priorHostSessionId → archived session', async () => {
    const { body } = await postCreateSuccessor({ sessionRef })
    const result = body as Record<string, unknown>
    // RED: endpoint doesn't exist
    expect(result['priorHostSessionId']).toBe(archivedHsid)
  })

  it('successor inherits continuation from archived row', async () => {
    const { body } = await postCreateSuccessor({ sessionRef })
    const result = body as Record<string, unknown>
    // RED: endpoint doesn't exist
    const continuation = result['continuation'] as Record<string, unknown> | undefined
    expect(continuation?.key).toBe('sess-key-t04831-g2')
  })

  it('continuity is repointed to the new successor', async () => {
    const { body } = await postCreateSuccessor({ sessionRef })
    const result = body as Record<string, unknown>
    const newHostSessionId = result['hostSessionId'] as string
    expect(newHostSessionId).toBeDefined()

    // Verify continuity points to new successor, not the archived row
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const continuity = db.continuities.getByKey(scopeRef, 'main')
      // RED: continuity still points to archived (no endpoint)
      expect(continuity?.activeHostSessionId).toBe(newHostSessionId)
      expect(continuity?.activeHostSessionId).not.toBe(archivedHsid)
    } finally {
      db.close()
    }
  })

  it('archived row STAYS archived after successor is minted (no reactivation-in-place)', async () => {
    await postCreateSuccessor({ sessionRef })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      const archivedRow = db.sessions.getByHostSessionId(archivedHsid)
      // RED: archived row unchanged (or endpoint doesn't exist)
      expect(archivedRow?.status).toBe('archived')
    } finally {
      db.close()
    }
  })
})
