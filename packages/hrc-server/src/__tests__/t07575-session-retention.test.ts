import { afterEach, describe, expect, test } from 'bun:test'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import type { HrcSessionRecord } from 'hrc-core'
import { createHrcServer } from '../index.js'
import {
  HRC_SESSION_RETENTION_SWEEP_ENABLED_ENV,
  HRC_SESSION_RETENTION_SWEEP_INTERVAL_MS,
} from '../server-constants.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { startSessionRetentionSweep } from '../sweep-handlers.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const DAY_MS = 24 * 60 * 60 * 1000

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

type SeedInput = {
  id: string
  /** Written to both `created_at` and `updated_at`. */
  ts: string
  status?: 'active' | 'archived'
  continuationKey?: string | undefined
  /** When set, the `session_index` row carries this instead of `ts`. */
  indexActivityAt?: string | undefined
  runtimeStatus?: string | undefined
  runtimeActivityAt?: string | undefined
  scopeRef?: string | undefined
}

/**
 * Seed one session, its continuity, its `session_index` projection row and
 * (optionally) a runtime. `session_index` is written directly rather than
 * through an event insert so a test can state the divergence it is pinning —
 * a stale `sessions.updated_at` beside a fresh authoritative clock — without
 * depending on which event tables happen to carry traffic.
 */
function seed(db: HrcDatabase, input: SeedInput): { hostSessionId: string; scopeRef: string } {
  const scopeRef = input.scopeRef ?? `agent:cody:project:hrc-runtime:task:${input.id}`
  const hostSessionId = `hsid-${input.id}`
  db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    status: input.status ?? 'active',
    createdAt: input.ts,
    updatedAt: input.ts,
    ancestorScopeRefs: [],
    ...(input.continuationKey !== undefined
      ? { continuation: { provider: 'claude', key: input.continuationKey } }
      : {}),
  })
  db.continuities.upsert({
    scopeRef,
    laneRef: 'main',
    activeHostSessionId: hostSessionId,
    updatedAt: input.ts,
  })
  db.sqlite.run('UPDATE session_index SET last_activity_at = ? WHERE host_session_id = ?', [
    input.indexActivityAt ?? input.ts,
    hostSessionId,
  ])
  if (input.runtimeStatus !== undefined) {
    db.sqlite.run(
      `INSERT INTO runtimes (
         runtime_id, host_session_id, scope_ref, lane_ref, generation, transport, harness,
         provider, status, supports_inflight_input, adopted, last_activity_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'main', 1, 'tmux', 'claude-code', 'anthropic', ?, 0, 0, ?, ?, ?)`,
      [
        `rt-${input.id}`,
        hostSessionId,
        scopeRef,
        input.runtimeStatus,
        input.runtimeActivityAt ?? input.ts,
        input.ts,
        input.ts,
      ]
    )
  }
  return { hostSessionId, scopeRef }
}

function withDb(fixture: HrcServerTestFixture, run: (db: HrcDatabase) => void): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    run(db)
  } finally {
    db.close()
  }
}

async function listSessions(
  fixture: HrcServerTestFixture,
  query = ''
): Promise<{ ids: string[]; withheld: number | undefined; total: number | undefined }> {
  const response = await fixture.fetchSocket(`/v1/sessions${query}`)
  expect(response.status).toBe(200)
  const rows = (await response.json()) as HrcSessionRecord[]
  const header = (name: string): number | undefined => {
    const raw = response.headers.get(name)
    return raw === null ? undefined : Number(raw)
  }
  return {
    ids: rows.map((row) => row.hostSessionId),
    withheld: header('X-Hrc-Session-Withheld'),
    total: header('X-Hrc-Session-Total'),
  }
}

describe('T-07575 session retention', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  /**
   * Start a server, THEN seed.
   *
   * Order matters and cost a round of vacuous tests to learn. Startup
   * reconciliation marks seeded runtimes `stale` and — because that transition
   * appends an `hrc_events` row — advances `session_index.last_activity_at` to
   * now. A fixture seeded before boot therefore arrives at the assertions with
   * a fresh authoritative clock and a rewritten runtime status, so every test
   * about old-and-parked passes for reasons that have nothing to do with the
   * predicate under test. Seeding after boot leaves the state exactly as
   * written.
   */
  async function boot(prefix: string, seedRows: (db: HrcDatabase) => void) {
    const fixture = await createHrcTestFixture(prefix)
    fixtures.push(fixture)
    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    withDb(fixture, seedRows)
    return { fixture, server }
  }

  test('runs once at boot and then schedules the 24-hour cadence', () => {
    const originalSetInterval = globalThis.setInterval
    const originalEnabled = process.env[HRC_SESSION_RETENTION_SWEEP_ENABLED_ENV]
    let scheduledDelay: number | undefined
    let scheduledCallback: (() => void) | undefined
    let ticks = 0

    globalThis.setInterval = ((callback: () => void, delay?: number) => {
      scheduledCallback = callback
      scheduledDelay = delay
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    delete process.env[HRC_SESSION_RETENTION_SWEEP_ENABLED_ENV]

    const context = {
      sessionRetentionTimer: undefined,
      runRecurringSessionRetention: async () => {
        ticks += 1
      },
    } as unknown as HrcServerInstanceForHandlers

    try {
      startSessionRetentionSweep.call(context)
      expect(ticks).toBe(1)
      expect(scheduledDelay).toBe(HRC_SESSION_RETENTION_SWEEP_INTERVAL_MS)

      scheduledCallback?.()
      expect(ticks).toBe(2)
    } finally {
      globalThis.setInterval = originalSetInterval
      if (originalEnabled === undefined) {
        delete process.env[HRC_SESSION_RETENTION_SWEEP_ENABLED_ENV]
      } else {
        process.env[HRC_SESSION_RETENTION_SWEEP_ENABLED_ENV] = originalEnabled
      }
    }
  })

  test('an unscoped read is bounded to the projection window, and says what it withheld', async () => {
    const { fixture, server } = await boot('hrc-t07575-bound-', (db) => {
      seed(db, { id: 'fresh', ts: daysAgo(1) })
      seed(db, { id: 'stale', ts: daysAgo(90) })
    })
    try {
      const bounded = await listSessions(fixture)
      expect(bounded.ids).toEqual(['hsid-fresh'])
      expect(bounded.total).toBe(2)
      expect(bounded.withheld).toBe(1)

      // Every door reaches the row the default withheld.
      expect((await listSessions(fixture, '?all=true')).ids.sort()).toEqual([
        'hsid-fresh',
        'hsid-stale',
      ])
      expect(
        (await listSessions(fixture, '?updatedSince=2020-01-01T00:00:00.000Z')).ids.sort()
      ).toEqual(['hsid-fresh', 'hsid-stale'])
      expect(
        (await listSessions(fixture, '?scopeRef=agent:cody:project:hrc-runtime:task:stale')).ids
      ).toEqual(['hsid-stale'])
    } finally {
      await server.stop()
    }
  })

  test('a bare ?all with no value does not widen the read', async () => {
    const { fixture, server } = await boot('hrc-t07575-allbare-', (db) => {
      seed(db, { id: 'fresh', ts: daysAgo(1) })
      seed(db, { id: 'stale', ts: daysAgo(90) })
    })
    try {
      expect((await listSessions(fixture, '?all')).ids).toEqual(['hsid-fresh'])
      expect((await listSessions(fixture, '?all=maybe')).ids).toEqual(['hsid-fresh'])
    } finally {
      await server.stop()
    }
  })

  test('a live runtime keeps a session in the projection however old its row is', async () => {
    const { fixture, server } = await boot('hrc-t07575-live-', (db) => {
      seed(db, {
        id: 'ancient-but-busy',
        ts: daysAgo(120),
        runtimeStatus: 'busy',
        runtimeActivityAt: daysAgo(120),
      })
    })
    try {
      expect((await listSessions(fixture)).ids).toEqual(['hsid-ancient-but-busy'])
    } finally {
      await server.stop()
    }
  })

  // Daedalus REJECT flaw 1. `session_index.last_activity_at` is the recency
  // authority (invariant `hrc-runtime.mobile-session-index`) and is advanced by
  // event inserts that never touch `sessions.updated_at`. A projection sensing
  // on `updated_at` hides sessions that were genuinely active yesterday.
  test('recency comes from session_index, not from sessions.updated_at', async () => {
    const { fixture, server } = await boot('hrc-t07575-authority-', (db) => {
      seed(db, {
        id: 'events-only',
        ts: daysAgo(30),
        indexActivityAt: daysAgo(1),
      })
    })
    try {
      expect((await listSessions(fixture)).ids).toEqual(['hsid-events-only'])
    } finally {
      await server.stop()
    }
  })

  test('the archive sweep also senses on session_index, so it spares an events-only session', async () => {
    const { fixture, server } = await boot('hrc-t07575-sweep-authority-', (db) => {
      seed(db, {
        id: 'events-only',
        ts: daysAgo(30),
        indexActivityAt: daysAgo(1),
        continuationKey: 'ck-events-only',
      })
    })
    try {
      const response = await fixture.postJson('/v1/sessions/archive-abandoned', {})
      expect(response.status).toBe(200)
      expect((await response.json()).archived).toBe(0)
    } finally {
      await server.stop()
    }
  })

  // Daedalus REJECT flaw 2. `SessionRepository.updateStatus` rewrites
  // `updated_at`, so a projection keyed on that column would treat every row
  // the sweep archived as active-this-second — the migration would defeat its
  // own bounded-view outcome and leave the store hotter than it found it.
  test('archiving a cold session does not make it hot again', async () => {
    const { fixture, server } = await boot('hrc-t07575-selfdefeat-', (db) => {
      seed(db, { id: 'fresh', ts: daysAgo(1) })
      for (let index = 0; index < 5; index += 1) {
        seed(db, {
          id: `cold-${index}`,
          ts: daysAgo(90),
          continuationKey: `ck-${index}`,
        })
      }
    })
    try {
      expect((await listSessions(fixture)).ids).toEqual(['hsid-fresh'])

      const response = await fixture.postJson('/v1/sessions/archive-abandoned', {})
      expect(response.status).toBe(200)
      expect((await response.json()).archived).toBe(5)

      const after = await listSessions(fixture)
      expect(after.ids).toEqual(['hsid-fresh'])
      expect(after.withheld).toBe(5)
    } finally {
      await server.stop()
    }
  })

  test('the sweep never deletes a row, and never drops a continuation', async () => {
    const { fixture, server } = await boot('hrc-t07575-nodelete-', (db) => {
      seed(db, { id: 'cold', ts: daysAgo(90), continuationKey: 'ck-cold' })
    })
    try {
      await fixture.postJson('/v1/sessions/archive-abandoned', {})
      const rows = (await listSessions(fixture, '?all=true')).ids
      expect(rows).toEqual(['hsid-cold'])

      withDb(fixture, (db) => {
        const record = db.sessions.getByHostSessionId('hsid-cold')
        expect(record?.status).toBe('archived')
        expect(record?.continuation?.key).toBe('ck-cold')
      })
    } finally {
      await server.stop()
    }
  })

  test('the sweep spares keyless, primary-scoped and live sessions', async () => {
    const { fixture, server } = await boot('hrc-t07575-spare-', (db) => {
      // No continuation key: archiving would report it `broken` and drop it
      // from dormant target listings — a capability change, not a view change.
      seed(db, { id: 'keyless', ts: daysAgo(90) })
      seed(db, {
        id: 'primary',
        ts: daysAgo(90),
        continuationKey: 'ck-primary',
        scopeRef: 'agent:cody:project:hrc-runtime:task:primary',
      })
      seed(db, {
        id: 'live',
        ts: daysAgo(90),
        continuationKey: 'ck-live',
        runtimeStatus: 'ready',
        runtimeActivityAt: daysAgo(90),
      })
      seed(db, { id: 'cold', ts: daysAgo(90), continuationKey: 'ck-cold' })
    })
    try {
      const response = await fixture.postJson('/v1/sessions/archive-abandoned', {})
      const body = await response.json()
      expect(body.archived).toBe(1)
      expect(body.skippedPrimary).toBe(1)
      expect(body.skippedNoContinuation).toBe(1)
      expect(body.skippedNotIdle).toBe(1)

      withDb(fixture, (db) => {
        expect(db.sessions.getByHostSessionId('hsid-cold')?.status).toBe('archived')
        for (const spared of ['hsid-keyless', 'hsid-primary', 'hsid-live']) {
          expect(db.sessions.getByHostSessionId(spared)?.status).toBe('active')
        }
      })
    } finally {
      await server.stop()
    }
  })

  // Daedalus REJECT (round 2). The archive sweep must not sense liveness with
  // the display projection's `ready|busy` allow-list: HRC also produces
  // `starting`, `stopping` and `awaiting_input`, and the running-turn authority
  // counts all four as running. A continuation-bearing turn parked on an
  // operator prompt for a week has no activity but is not idle, and archiving
  // it files a live turn as dormant.
  test.each(['awaiting_input', 'starting', 'stopping', 'stopped', 'failed'])(
    'a week-old session whose runtime is %s is neither archived nor hidden',
    async (runtimeStatus) => {
      const { fixture, server } = await boot(`hrc-t07575-parked-${runtimeStatus}-`, (db) => {
        seed(db, {
          id: 'parked',
          ts: daysAgo(9),
          continuationKey: 'ck-parked',
          runtimeStatus,
          runtimeActivityAt: daysAgo(9),
        })
      })
      try {
        expect((await listSessions(fixture)).ids).toEqual(['hsid-parked'])

        const response = await fixture.postJson('/v1/sessions/archive-abandoned', {})
        expect((await response.json()).archived).toBe(0)
        withDb(fixture, (db) => {
          expect(db.sessions.getByHostSessionId('hsid-parked')?.status).toBe('active')
        })
      } finally {
        await server.stop()
      }
    }
  )

  test('an active run keeps a session live whatever its runtime status column says', async () => {
    const { fixture, server } = await boot('hrc-t07575-activerun-', (db) => {
      seed(db, {
        id: 'midturn',
        ts: daysAgo(30),
        continuationKey: 'ck-midturn',
        runtimeStatus: 'terminated',
        runtimeActivityAt: daysAgo(30),
      })
      db.sqlite.run("UPDATE runtimes SET active_run_id = 'run-midturn' WHERE runtime_id = ?", [
        'rt-midturn',
      ])
    })
    try {
      expect((await listSessions(fixture)).ids).toEqual(['hsid-midturn'])
      const response = await fixture.postJson('/v1/sessions/archive-abandoned', {})
      expect((await response.json()).archived).toBe(0)
    } finally {
      await server.stop()
    }
  })

  test('?status and ?limit narrow, and a malformed ?updatedSince is rejected', async () => {
    const { fixture, server } = await boot('hrc-t07575-narrow-', (db) => {
      seed(db, { id: 'a', ts: daysAgo(1) })
      seed(db, { id: 'b', ts: daysAgo(1) })
      seed(db, { id: 'c', ts: daysAgo(1), status: 'archived' })
    })
    try {
      expect((await listSessions(fixture, '?status=archived')).ids).toEqual(['hsid-c'])
      expect((await listSessions(fixture, '?limit=1')).ids).toHaveLength(1)
      expect((await fixture.fetchSocket('/v1/sessions?updatedSince=not-a-date')).status).toBe(400)
      expect((await fixture.fetchSocket('/v1/sessions?limit=0')).status).toBe(400)
      expect((await fixture.fetchSocket('/v1/sessions?status=bogus')).status).toBe(400)
    } finally {
      await server.stop()
    }
  })
})
