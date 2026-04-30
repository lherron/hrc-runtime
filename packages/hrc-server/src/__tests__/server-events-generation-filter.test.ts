/**
 * RED tests: GET /v1/events does not filter by hostSessionId or generation.
 *
 * These tests prove that the server's /v1/events route currently ignores
 * hostSessionId and generation query parameters. Phase 1b will add the
 * filter logic and turn these green.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-events-gen-filter-')
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString()
}

function scopeRef(key: string): string {
  return `agent:test:project:gen-filter:task:${key}`
}

/**
 * Seed a session and insert lifecycle events directly into the database,
 * bypassing server route logic.
 */
function seedEventsForSession(
  hostSessionId: string,
  key: string,
  generation: number,
  events: Array<{ eventKind: string; tag: string }>
): void {
  const db = openHrcDatabase(fixture.dbPath)
  const timestamp = now()
  const scope = scopeRef(key)

  try {
    // Ensure session exists
    try {
      db.sessions.insert({
        hostSessionId,
        scopeRef: scope,
        laneRef: 'default',
        generation,
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
        ancestorScopeRefs: [],
      })
    } catch {
      // Session may already exist from a prior call with same hostSessionId
    }

    for (const evt of events) {
      db.hrcEvents.append({
        ts: timestamp,
        hostSessionId,
        scopeRef: scope,
        laneRef: 'default',
        generation,
        category: 'turn',
        eventKind: evt.eventKind,
        payload: { tag: evt.tag },
      })
    }
  } finally {
    db.close()
  }
}

type ParsedEvent = {
  hrcSeq: number
  hostSessionId: string
  generation: number
  eventKind: string
  payload: Record<string, unknown>
}

async function fetchEvents(queryString = ''): Promise<ParsedEvent[]> {
  const path = queryString ? `/v1/events?${queryString}` : '/v1/events'
  const res = await fixture.fetchSocket(path)
  expect(res.status).toBe(200)
  const text = await res.text()
  if (!text.trim()) return []
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

// ===========================================================================
// DELIVERABLE 4: Route filter tests
// ===========================================================================

describe('GET /v1/events hostSessionId + generation filtering', () => {
  it('filters events by hostSessionId query param — excludes other sessions', async () => {
    // Seed events for two different hostSessionIds sharing the same scopeRef
    seedEventsForSession('hsid-server-A', 'shared', 1, [
      { eventKind: 'turn.started', tag: 'A-1' },
      { eventKind: 'turn.completed', tag: 'A-2' },
    ])
    seedEventsForSession('hsid-server-B', 'shared', 1, [{ eventKind: 'turn.started', tag: 'B-1' }])

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // Unfiltered should return all 3
    const allEvents = await fetchEvents('fromSeq=1')
    expect(allEvents.length).toBe(3)

    // Filtered by hostSessionId should return only matching events
    const eventsA = await fetchEvents('fromSeq=1&hostSessionId=hsid-server-A')
    expect(eventsA).toHaveLength(2)
    expect(eventsA.every((e) => e.hostSessionId === 'hsid-server-A')).toBe(true)

    const eventsB = await fetchEvents('fromSeq=1&hostSessionId=hsid-server-B')
    expect(eventsB).toHaveLength(1)
    expect(eventsB[0]!.hostSessionId).toBe('hsid-server-B')
  })

  it('filters events by generation query param — excludes other generations', async () => {
    // Same hostSessionId, two different generations
    seedEventsForSession('hsid-server-gen', 'gen-test', 1, [
      { eventKind: 'turn.started', tag: 'gen1-a' },
      { eventKind: 'turn.completed', tag: 'gen1-b' },
    ])
    seedEventsForSession('hsid-server-gen', 'gen-test', 2, [
      { eventKind: 'turn.started', tag: 'gen2-a' },
    ])

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // Unfiltered should return all 3
    const allEvents = await fetchEvents('fromSeq=1')
    expect(allEvents.length).toBe(3)

    // Filter by generation=1 should return 2 events
    const gen1 = await fetchEvents('fromSeq=1&hostSessionId=hsid-server-gen&generation=1')
    expect(gen1).toHaveLength(2)
    expect(gen1.every((e) => e.generation === 1)).toBe(true)

    // Filter by generation=2 should return 1 event
    const gen2 = await fetchEvents('fromSeq=1&hostSessionId=hsid-server-gen&generation=2')
    expect(gen2).toHaveLength(1)
    expect(gen2[0]!.generation).toBe(2)
  })

  it('combines hostSessionId + generation for precise isolation', async () => {
    // Session A gen 1
    seedEventsForSession('hsid-combo-A', 'combo', 1, [{ eventKind: 'turn.started', tag: 'A-g1' }])
    // Session A gen 2
    seedEventsForSession('hsid-combo-A', 'combo', 2, [{ eventKind: 'turn.started', tag: 'A-g2' }])
    // Session B gen 1
    seedEventsForSession('hsid-combo-B', 'combo', 1, [{ eventKind: 'turn.started', tag: 'B-g1' }])

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    // All 3 unfiltered
    const all = await fetchEvents('fromSeq=1')
    expect(all.length).toBe(3)

    // Only session A, generation 1
    const filtered = await fetchEvents('fromSeq=1&hostSessionId=hsid-combo-A&generation=1')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.hostSessionId).toBe('hsid-combo-A')
    expect(filtered[0]!.generation).toBe(1)
    expect((filtered[0]!.payload as any).tag).toBe('A-g1')
  })
})
