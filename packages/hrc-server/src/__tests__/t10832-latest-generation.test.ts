import { afterEach, describe, expect, test } from 'bun:test'
import type { HrcSessionRecord } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const scope = (seat: string) => `agent:cody:project:hrc-runtime:task:${seat}`
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString()

function seed(
  db: HrcDatabase,
  seat: string,
  generation: number,
  ts = daysAgo(1),
  laneRef = 'main',
  status: 'active' | 'archived' = 'active'
): string {
  const hostSessionId = `hsid-${seat}-${laneRef}-${generation}`
  db.sessions.insert({
    hostSessionId,
    scopeRef: scope(seat),
    laneRef,
    generation,
    status,
    createdAt: ts,
    updatedAt: ts,
  })
  db.sqlite.run('UPDATE session_index SET last_activity_at = ? WHERE host_session_id = ?', [
    ts,
    hostSessionId,
  ])
  return hostSessionId
}

describe('T-10832 latest generation projection', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  async function boot(seedRows: (db: HrcDatabase) => void) {
    const fixture = await createHrcTestFixture('hrc-t10832-')
    fixtures.push(fixture)
    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    // Seed after reconciliation so the timestamps and live runtime remain as declared.
    const db = openHrcDatabase(fixture.dbPath)
    try {
      seedRows(db)
    } finally {
      db.close()
    }
    return { fixture, server }
  }

  async function list(fixture: HrcServerTestFixture, query = '') {
    const response = await fixture.fetchSocket(`/v1/sessions${query}`)
    expect(response.status).toBe(200)
    const rows = (await response.json()) as HrcSessionRecord[]
    return { rows, ids: rows.map((row) => row.hostSessionId).sort(), response }
  }

  test('unscoped and scoped reads collapse only when explicitly requested and report withheld rows', async () => {
    const { fixture, server } = await boot((db) => {
      for (const generation of [1, 2, 3]) seed(db, 'multi', generation)
      seed(db, 'single', 1)
    })
    try {
      expect((await list(fixture)).rows).toHaveLength(4)
      const latest = await list(fixture, '?latestGeneration=true')
      expect(latest.ids).toEqual(['hsid-multi-main-3', 'hsid-single-main-1'])
      expect(latest.response.headers.get('X-Hrc-Session-Total')).toBe('4')
      expect(latest.response.headers.get('X-Hrc-Session-Returned')).toBe('2')
      expect(latest.response.headers.get('X-Hrc-Session-Withheld')).toBe('2')
      const scoped = `?scopeRef=${encodeURIComponent(scope('multi'))}`
      expect((await list(fixture, scoped)).rows).toHaveLength(3)
      expect((await list(fixture, `${scoped}&latestGeneration=true`)).ids).toEqual([
        'hsid-multi-main-3',
      ])
      expect((await list(fixture, '?latestGeneration=false')).ids).toEqual(
        (await list(fixture)).ids
      )
      for (const value of ['maybe', '', 'false']) {
        expect((await list(fixture, `?latestGeneration=${value}`)).ids).toEqual(
          (await list(fixture)).ids
        )
      }
      for (const value of ['1', 'yes', 'TRUE', 'YeS']) {
        expect((await list(fixture, `?latestGeneration=${value}`)).ids).toEqual(latest.ids)
      }
    } finally {
      await server.stop()
    }
  })

  test('window membership survives collapse, including an old seat with a ready runtime', async () => {
    const { fixture, server } = await boot((db) => {
      seed(db, 'multi', 2, daysAgo(90))
      seed(db, 'multi', 3)
      const liveId = seed(db, 'live', 1, daysAgo(90))
      db.sqlite.run(
        `INSERT INTO runtimes (
        runtime_id, host_session_id, scope_ref, lane_ref, generation, transport, harness,
        provider, status, supports_inflight_input, last_activity_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'main', 1, 'tmux', 'claude-code', 'anthropic', 'ready', 0, ?, ?, ?)`,
        ['rt-live', liveId, scope('live'), daysAgo(90), daysAgo(90), daysAgo(90)]
      )
      // The highest stored generation is outside the window: never widen to it.
      seed(db, 'narrow', 1)
      seed(db, 'narrow', 2, daysAgo(90))
    })
    try {
      const query = `?updatedSince=${encodeURIComponent(daysAgo(2))}&latestGeneration=true`
      expect((await list(fixture, query)).ids).toEqual([
        'hsid-live-main-1',
        'hsid-multi-main-3',
        'hsid-narrow-main-1',
      ])
    } finally {
      await server.stop()
    }
  })

  test('groups by lane and collapses before status and limit, also with all=true', async () => {
    const { fixture, server } = await boot((db) => {
      seed(db, 'multi', 1, daysAgo(90), 'main', 'archived')
      seed(db, 'multi', 2, daysAgo(90))
      seed(db, 'multi', 1, daysAgo(90), 'other')
    })
    try {
      expect((await list(fixture, '?all=true&latestGeneration=true')).ids).toEqual([
        'hsid-multi-main-2',
        'hsid-multi-other-1',
      ])
      expect((await list(fixture, '?all=true&latestGeneration=true&laneRef=main')).ids).toEqual([
        'hsid-multi-main-2',
      ])
      expect((await list(fixture, '?all=true&latestGeneration=true&status=archived')).ids).toEqual(
        []
      )
      expect((await list(fixture, '?all=true&latestGeneration=true&limit=1')).rows).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  test('SDK sends true and updatedSince on both list methods, and omits false', async () => {
    const fixture = await createHrcTestFixture('hrc-t10832-sdk-')
    fixtures.push(fixture)
    const urls: URL[] = []
    const server = Bun.serve({
      unix: fixture.socketPath,
      fetch(request) {
        urls.push(new URL(request.url))
        return Response.json([], {
          headers: { 'X-Hrc-Session-Total': '0', 'X-Hrc-Session-Withheld': '0' },
        })
      },
    })
    try {
      const client = new HrcClient(fixture.socketPath)
      const updatedSince = daysAgo(1)
      await client.listSessions({ updatedSince, latestGeneration: true })
      await client.listSessionsWithProjection({ updatedSince, latestGeneration: true })
      await client.listSessions({ latestGeneration: false })
      await client.listSessionsWithProjection({ latestGeneration: false })
      expect(urls).toHaveLength(4)
      for (const url of urls.slice(0, 2)) {
        expect(url.pathname).toBe('/v1/sessions')
        expect(url.searchParams.get('latestGeneration')).toBe('true')
        expect(url.searchParams.get('updatedSince')).toBe(updatedSince)
      }
      for (const url of urls.slice(2)) expect(url.searchParams.has('latestGeneration')).toBe(false)
    } finally {
      server.stop(true)
    }
  })
})
