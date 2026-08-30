import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import { HrcClient } from '../index.js'
import type { HrcEventTail, HrcEventTailOptions } from '../index.js'

let dir: string
let socketPath: string
let server: ReturnType<typeof Bun.serve> | undefined

const EMPTY_TAIL: HrcEventTail = {
  events: [],
  ledgerIncarnationId: 'ledger-a',
  headHrcSeq: 900,
  truncated: false,
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-sdk-t07719-'))
  socketPath = join(dir, 'hrc.sock')
})

afterEach(async () => {
  server?.stop(true)
  server = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('T-07719 reverse lifecycle-event tail SDK', () => {
  test('tailEvents sends the exclusive-before cursor and its incarnation fence', async () => {
    let captured = ''
    server = Bun.serve({
      unix: socketPath,
      fetch(request) {
        const url = new URL(request.url)
        captured = url.pathname + url.search
        return Response.json(EMPTY_TAIL)
      },
    })
    const options: HrcEventTailOptions = {
      limit: 25,
      beforeHrcSeq: 880,
      ledgerIncarnationId: 'ledger-a',
      scopeRef: 'agent:test',
      generation: 3,
      eventKind: 'turn.completed',
    }
    await new HrcClient(socketPath).tailEvents(options)
    expect(captured).toBe(
      '/v1/events/tail?limit=25&beforeHrcSeq=880&ledgerIncarnationId=ledger-a&generation=3&scopeRef=agent%3Atest&eventKind=turn.completed'
    )
  })

  test('a head-page caller emits no reverse cursor parameters', async () => {
    let captured = ''
    server = Bun.serve({
      unix: socketPath,
      fetch(request) {
        const url = new URL(request.url)
        captured = url.pathname + url.search
        return Response.json(EMPTY_TAIL)
      },
    })
    await new HrcClient(socketPath).tailEvents({ limit: 25, scopeRef: 'agent:test' })
    expect(captured).toBe('/v1/events/tail?limit=25&scopeRef=agent%3Atest')
  })

  test('tailEvents preserves the typed cursor_invalid failure', async () => {
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
    try {
      await new HrcClient(socketPath).tailEvents({
        limit: 25,
        beforeHrcSeq: 880,
        ledgerIncarnationId: 'ledger-a',
      })
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
