import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { HrcBoundedEventStreamRecord, HrcEventTail } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture.js'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

type InternalServer = HrcServer & {
  db: HrcDatabase
  notifyEvent(event: ReturnType<HrcDatabase['hrcEvents']['append']>): void
}

function seed(eventKind: string, payload: unknown = { eventKind }): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.hrcEvents.append({
      ts: fixture.now(),
      hostSessionId: 'hsid-t07493',
      scopeRef: 'agent:test:project:hrc-runtime:task:T-07493',
      laneRef: 'default',
      generation: 1,
      category: 'turn',
      eventKind,
      payload,
    })
  } finally {
    db.close()
  }
}

function recordReader(reader: ReadableStreamDefaultReader<Uint8Array>): {
  next(): Promise<HrcBoundedEventStreamRecord>
} {
  const decoder = new TextDecoder()
  let buffer = ''
  const parsed: HrcBoundedEventStreamRecord[] = []
  return {
    async next() {
      while (parsed.length === 0) {
        const result = await reader.read()
        expect(result.done).toBe(false)
        buffer += decoder.decode(result.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) parsed.push(JSON.parse(line) as HrcBoundedEventStreamRecord)
        }
      }
      return parsed.shift()!
    },
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07493-routes-')
})

afterEach(async () => {
  if (server) await server.stop()
  server = undefined
  await fixture.cleanup()
})

describe('T-07493 bounded lifecycle-event routes', () => {
  test('tail returns ascending newest rows, global head and durable incarnation', async () => {
    seed('turn.one')
    seed('turn.two')
    seed('turn.three', { nested: { deep: ['equivalent'] } })
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    const response = await fixture.fetchSocket('/v1/events/tail?limit=2')
    expect(response.status).toBe(200)
    const body = (await response.json()) as HrcEventTail
    expect(body.events.map((event) => event.eventKind)).toEqual(['turn.two', 'turn.three'])
    expect(body.events[1]!.payload).toEqual({ nested: { deep: ['equivalent'] } })
    expect(body.headHrcSeq).toBe(3)
    expect(body.truncated).toBe(true)
    expect(body.ledgerIncarnationId).toMatch(/^[a-f0-9]{32}$/)
  })

  test('stream orders advisory ready before ascending replay and ready has no cursor', async () => {
    seed('turn.one')
    seed('turn.two')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    const tail = (await (
      await fixture.fetchSocket('/v1/events/tail?limit=1')
    ).json()) as HrcEventTail
    const params = new URLSearchParams({
      ledgerIncarnationId: tail.ledgerIncarnationId,
      afterSeq: '0',
      follow: 'true',
    })
    const response = await fixture.fetchSocket(`/v1/events/bounded-stream?${params}`)
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const records = recordReader(reader)
    try {
      const ready = await records.next()
      expect(ready).toEqual({
        type: 'ready',
        ledgerIncarnationId: tail.ledgerIncarnationId,
        acceptedAfterHrcSeq: 0,
        replayHeadHrcSeq: 2,
      })
      expect('cursor' in ready).toBe(false)
      const first = await records.next()
      const second = await records.next()
      expect(first.type === 'event' ? first.event.eventKind : '').toBe('turn.one')
      expect(second.type === 'event' ? second.event.eventKind : '').toBe('turn.two')
    } finally {
      await reader.cancel()
    }
  })

  test('an event injected during replay crosses the seam once and after the replay suffix', async () => {
    seed('turn.one')
    seed('turn.two')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    const internal = server as InternalServer
    const tail = (await (
      await fixture.fetchSocket('/v1/events/tail?limit=1')
    ).json()) as HrcEventTail
    const original = internal.db.hrcEvents.scanReplayNewestFirst.bind(internal.db.hrcEvents)
    let injected = false
    internal.db.hrcEvents.scanReplayNewestFirst = (input, visit) =>
      original(input, (event) => {
        if (!injected) {
          injected = true
          const live = internal.db.hrcEvents.append({
            ts: fixture.now(),
            hostSessionId: 'hsid-t07493',
            scopeRef: 'agent:test:project:hrc-runtime:task:T-07493',
            laneRef: 'default',
            generation: 1,
            category: 'turn',
            eventKind: 'turn.live-seam',
            payload: { seam: true },
          })
          internal.notifyEvent(live)
        }
        return visit(event)
      })
    const params = new URLSearchParams({
      ledgerIncarnationId: tail.ledgerIncarnationId,
      afterSeq: '0',
      follow: 'true',
    })
    const response = await fixture.fetchSocket(`/v1/events/bounded-stream?${params}`)
    const reader = response.body!.getReader()
    const records = recordReader(reader)
    try {
      expect((await records.next()).type).toBe('ready')
      const delivered = [await records.next(), await records.next(), await records.next()]
      expect(
        delivered.map((record) => (record.type === 'event' ? record.event.eventKind : record.type))
      ).toEqual(['turn.one', 'turn.two', 'turn.live-seam'])
    } finally {
      await reader.cancel()
    }
  })

  test('disconnect after ready can reconnect from the same exclusive start without omission', async () => {
    seed('turn.one')
    seed('turn.two')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    const tail = (await (
      await fixture.fetchSocket('/v1/events/tail?limit=1')
    ).json()) as HrcEventTail
    const params = new URLSearchParams({
      ledgerIncarnationId: tail.ledgerIncarnationId,
      afterSeq: '0',
      follow: 'true',
    })
    const first = await fixture.fetchSocket(`/v1/events/bounded-stream?${params}`)
    const firstReader = first.body!.getReader()
    expect((await recordReader(firstReader).next()).type).toBe('ready')
    await firstReader.cancel()

    const resumed = await fixture.fetchSocket(`/v1/events/bounded-stream?${params}`)
    const resumedReader = resumed.body!.getReader()
    const records = recordReader(resumedReader)
    try {
      expect((await records.next()).type).toBe('ready')
      const replay = [await records.next(), await records.next()]
      expect(
        replay.map((record) => (record.type === 'event' ? record.event.eventKind : ''))
      ).toEqual(['turn.one', 'turn.two'])
    } finally {
      await resumedReader.cancel()
    }
  })

  test('old incarnation fails typed before streaming and never admits by numeric head', async () => {
    seed('turn.one')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    const tail = (await (
      await fixture.fetchSocket('/v1/events/tail?limit=1')
    ).json()) as HrcEventTail
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.sqlite.exec(
        `UPDATE hrc_event_ledger_metadata
            SET ledger_incarnation_id = lower(hex(randomblob(16)))
          WHERE id = 1`
      )
    } finally {
      db.close()
    }
    const params = new URLSearchParams({
      ledgerIncarnationId: tail.ledgerIncarnationId,
      afterSeq: String(tail.headHrcSeq),
      follow: 'true',
    })
    const response = await fixture.fetchSocket(`/v1/events/bounded-stream?${params}`)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: HrcErrorCode.CURSOR_INVALID } })
  })

  test('live replacement terminates the pinned stream before a new-incarnation event', async () => {
    seed('turn.one')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    const tail = (await (
      await fixture.fetchSocket('/v1/events/tail?limit=1')
    ).json()) as HrcEventTail
    const params = new URLSearchParams({
      ledgerIncarnationId: tail.ledgerIncarnationId,
      afterSeq: String(tail.headHrcSeq),
      follow: 'true',
    })
    const response = await fixture.fetchSocket(`/v1/events/bounded-stream?${params}`)
    const reader = response.body!.getReader()
    const records = recordReader(reader)
    expect((await records.next()).type).toBe('ready')

    const db = openHrcDatabase(fixture.dbPath)
    let replacementIncarnation = ''
    try {
      db.sqlite.exec(
        `UPDATE hrc_event_ledger_metadata
            SET ledger_incarnation_id = lower(hex(randomblob(16)))
          WHERE id = 1`
      )
      replacementIncarnation = db.hrcEvents.ledgerIncarnationId()
    } finally {
      db.close()
    }
    await fixture.resolveSession('agent:test:project:hrc-runtime:task:T-07493-live-replacement')
    expect(await records.next()).toEqual({
      type: 'ledger_replaced',
      expectedLedgerIncarnationId: tail.ledgerIncarnationId,
      currentLedgerIncarnationId: replacementIncarnation,
    })
    expect((await reader.read()).done).toBe(true)
  })
})
