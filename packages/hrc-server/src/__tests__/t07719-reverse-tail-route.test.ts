import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { HrcEventTail } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture.js'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

const SCOPE_REF = 'agent:test:project:hrc-runtime:task:T-07719'

function seed(
  eventKind: string,
  overrides: { hostSessionId?: string; generation?: number } = {}
): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.hrcEvents.append({
      ts: fixture.now(),
      hostSessionId: overrides.hostSessionId ?? 'hsid-t07719',
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: overrides.generation ?? 1,
      category: 'turn',
      eventKind,
      payload: { eventKind },
    })
  } finally {
    db.close()
  }
}

async function tail(query: string): Promise<Response> {
  return fixture.fetchSocket(`/v1/events/tail?${query}`)
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07719-routes-')
})

afterEach(async () => {
  if (server) await server.stop()
  server = undefined
  await fixture.cleanup()
})

describe('T-07719 exclusive-before reverse tail route', () => {
  test('serves the page before an already-loaded cursor, chronologically', async () => {
    for (const kind of ['e1', 'e2', 'e3', 'e4', 'e5']) seed(kind)
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    const head = (await (await tail('limit=2')).json()) as HrcEventTail
    expect(head.events.map((event) => event.eventKind)).toEqual(['e4', 'e5'])

    const response = await tail(
      `limit=2&beforeHrcSeq=${head.events[0]!.hrcSeq}&ledgerIncarnationId=${head.ledgerIncarnationId}`
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as HrcEventTail
    expect(body.events.map((event) => event.eventKind)).toEqual(['e2', 'e3'])
    expect(body.headHrcSeq).toBe(head.headHrcSeq)
    expect(body.ledgerIncarnationId).toBe(head.ledgerIncarnationId)
    expect(body.truncated).toBe(true)
  })

  test('exact host-session and generation filters are applied before the page limit', async () => {
    seed('match-1', { hostSessionId: 'hsid-a', generation: 2 })
    seed('noise-session', { hostSessionId: 'hsid-b', generation: 2 })
    seed('noise-generation', { hostSessionId: 'hsid-a', generation: 1 })
    seed('match-2', { hostSessionId: 'hsid-a', generation: 2 })
    seed('match-3', { hostSessionId: 'hsid-a', generation: 2 })
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    const head = (await (
      await tail('limit=1&hostSessionId=hsid-a&generation=2')
    ).json()) as HrcEventTail
    expect(head.events.map((event) => event.eventKind)).toEqual(['match-3'])

    const body = (await (
      await tail(
        `limit=1&hostSessionId=hsid-a&generation=2&beforeHrcSeq=${head.events[0]!.hrcSeq}&ledgerIncarnationId=${head.ledgerIncarnationId}`
      )
    ).json()) as HrcEventTail
    expect(body.events.map((event) => event.eventKind)).toEqual(['match-2'])
    expect(body.truncated).toBe(true)
  })

  test('a stale ledger incarnation returns cursor_invalid with no event payload', async () => {
    seed('e1')
    seed('e2')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    const response = await tail(
      'limit=2&beforeHrcSeq=2&ledgerIncarnationId=00000000000000000000000000000000'
    )
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error?: { code?: string } } & Record<string, unknown>
    expect(JSON.stringify(body)).toContain(HrcErrorCode.CURSOR_INVALID)
    expect('events' in body).toBe(false)
  })

  test('a reverse cursor without its expected incarnation is refused', async () => {
    seed('e1')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    const response = await tail('limit=2&beforeHrcSeq=1')
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain(HrcErrorCode.MALFORMED_REQUEST)
  })

  test('non-integer and overflow cursor values are refused', async () => {
    seed('e1')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    const incarnation = (await (await tail('limit=1')).json()) as HrcEventTail

    for (const raw of ['abc', '0', '-4', '1.5', '9007199254740993', '1e400']) {
      const response = await tail(
        `limit=2&beforeHrcSeq=${encodeURIComponent(raw)}&ledgerIncarnationId=${incarnation.ledgerIncarnationId}`
      )
      expect({ raw, status: response.status }).toEqual({ raw, status: 400 })
      expect(JSON.stringify(await response.json())).toContain(HrcErrorCode.MALFORMED_REQUEST)
    }
  })

  test('the reverse cursor does not weaken the existing maximum-limit validation', async () => {
    seed('e1')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    const head = (await (await tail('limit=1')).json()) as HrcEventTail

    const response = await tail(
      `limit=501&beforeHrcSeq=1&ledgerIncarnationId=${head.ledgerIncarnationId}`
    )
    expect(response.status).toBe(400)
  })

  test('a head caller that omits the reverse cursor is byte-identical to before', async () => {
    seed('e1')
    seed('e2')
    seed('e3')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    const response = await tail('limit=2')
    expect(response.status).toBe(200)
    const body = (await response.json()) as HrcEventTail
    expect(Object.keys(body).sort()).toEqual([
      'events',
      'headHrcSeq',
      'ledgerIncarnationId',
      'truncated',
    ])
    expect(body.events.map((event) => event.eventKind)).toEqual(['e2', 'e3'])
    expect(body.headHrcSeq).toBe(3)
    expect(body.truncated).toBe(true)
  })

  test('a start-of-history cursor returns an empty untruncated page at the live head', async () => {
    seed('e1')
    seed('e2')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    const head = (await (await tail('limit=1')).json()) as HrcEventTail

    const body = (await (
      await tail(`limit=5&beforeHrcSeq=1&ledgerIncarnationId=${head.ledgerIncarnationId}`)
    ).json()) as HrcEventTail
    expect(body.events).toEqual([])
    expect(body.truncated).toBe(false)
    expect(body.headHrcSeq).toBe(2)
  })
})
