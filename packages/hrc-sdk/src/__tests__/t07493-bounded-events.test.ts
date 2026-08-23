import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import { HrcClient } from '../index.js'
import type {
  HrcBoundedEventStreamRecord,
  HrcEventTail,
  HrcEventTailOptions,
  WatchBoundedEventsOptions,
} from '../index.js'

let dir: string
let socketPath: string
let server: ReturnType<typeof Bun.serve> | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-sdk-t07493-'))
  socketPath = join(dir, 'hrc.sock')
})

afterEach(async () => {
  server?.stop(true)
  server = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('T-07493 bounded lifecycle-event SDK', () => {
  test('tailEvents sends the bounded limit and exact filters', async () => {
    let captured = ''
    server = Bun.serve({
      unix: socketPath,
      fetch(request) {
        captured = new URL(request.url).pathname + new URL(request.url).search
        return Response.json({
          events: [],
          ledgerIncarnationId: 'ledger-a',
          headHrcSeq: 42,
          truncated: false,
        } satisfies HrcEventTail)
      },
    })
    const options: HrcEventTailOptions = {
      limit: 25,
      scopeRef: 'agent:test',
      generation: 3,
      eventKind: 'turn.completed',
    }
    const result = await new HrcClient(socketPath).tailEvents(options)
    expect(result).toMatchObject({ ledgerIncarnationId: 'ledger-a', headHrcSeq: 42 })
    expect(captured).toBe(
      '/v1/events/tail?limit=25&generation=3&scopeRef=agent%3Atest&eventKind=turn.completed'
    )
  })

  test('watchBoundedEvents supplies the incarnation fence and yields the complete union', async () => {
    let captured = ''
    const records: HrcBoundedEventStreamRecord[] = [
      {
        type: 'ready',
        ledgerIncarnationId: 'ledger-a',
        acceptedAfterHrcSeq: 7,
        replayHeadHrcSeq: 9,
      },
      {
        type: 'gap',
        ledgerIncarnationId: 'ledger-a',
        reason: 'replay_window',
        afterHrcSeq: 7,
        beforeHrcSeq: 9,
        dropped: null,
      },
    ]
    server = Bun.serve({
      unix: socketPath,
      fetch(request) {
        captured = new URL(request.url).pathname + new URL(request.url).search
        return new Response(records.map((record) => `${JSON.stringify(record)}\n`).join(''), {
          headers: { 'content-type': 'application/x-ndjson' },
        })
      },
    })
    const options: WatchBoundedEventsOptions = {
      ledgerIncarnationId: 'ledger-a',
      afterSeq: 7,
      sourceRef: 'lab',
    }
    const received: HrcBoundedEventStreamRecord[] = []
    for await (const record of new HrcClient(socketPath).watchBoundedEvents(options)) {
      received.push(record)
    }
    expect(received).toEqual(records)
    expect(captured).toBe(
      '/v1/events/bounded-stream?ledgerIncarnationId=ledger-a&afterSeq=7&follow=true&sourceRef=lab'
    )
  })

  test('watchBoundedEvents preserves typed cursor_invalid failures', async () => {
    server = Bun.serve({
      unix: socketPath,
      fetch() {
        return Response.json(
          {
            error: {
              code: HrcErrorCode.CURSOR_INVALID,
              message: 'event ledger incarnation is no longer current',
              detail: {
                expectedLedgerIncarnationId: 'ledger-a',
                currentLedgerIncarnationId: 'ledger-b',
              },
            },
          },
          { status: 409 }
        )
      },
    })
    const iterator = new HrcClient(socketPath)
      .watchBoundedEvents({ ledgerIncarnationId: 'ledger-a', afterSeq: 7 })
      [Symbol.asyncIterator]()
    try {
      await iterator.next()
      throw new Error('expected cursor_invalid')
    } catch (error) {
      expect(error).toBeInstanceOf(HrcDomainError)
      expect((error as HrcDomainError).code).toBe(HrcErrorCode.CURSOR_INVALID)
      expect((error as HrcDomainError).status).toBe(409)
      expect((error as HrcDomainError).detail).toEqual({
        expectedLedgerIncarnationId: 'ledger-a',
        currentLedgerIncarnationId: 'ledger-b',
      })
    }
  })
})
