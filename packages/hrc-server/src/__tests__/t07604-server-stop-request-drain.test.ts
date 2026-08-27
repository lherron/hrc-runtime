/**
 * T-07604 — `stop()` must DRAIN work that outlives its response before it
 * closes the store.
 *
 * `Bun.serve().stop(true)` closes the SOCKET, not the handler. A handler parked
 * on an await when the stop begins (broker precompile, tmux allocate) resumes
 * afterwards; at HEAD it resumed against a store `stop()` had already closed and
 * threw `RangeError: Cannot use a closed database` out of the sqlite statement
 * layer. Under full-suite load that landed as an unrelated red in whichever test
 * happened to be running (T-07604 run 1: cli-diagnostics).
 *
 * The parked handler here stands in for the real slow ones; what is under test is
 * the ordering contract, not any particular route.
 */
import { describe, expect, test } from 'bun:test'

import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'

type ExactRouteHandler = (request: Request, url: URL) => Response | Promise<Response>

type InspectableServer = HrcServer & {
  exactRouteHandlers: Record<string, ExactRouteHandler>
  db: HrcDatabase
}

describe('T-07604 server stop request drain', () => {
  test('a handler still parked when stop() begins never observes a closed database', async () => {
    const fixture = await createHrcTestFixture('hrc-t07604-')
    const server = (await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false })
    )) as InspectableServer

    let handlerSettled = false
    let handlerError: unknown
    server.exactRouteHandlers['GET /v1/sessions'] = async () => {
      await Bun.sleep(400)
      try {
        server.db.sessions.count()
      } catch (error) {
        handlerError = error
      }
      handlerSettled = true
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }

    const inFlight = fixture.fetchSocket('/v1/sessions').catch(() => undefined)
    // Let the handler reach its await so the stop lands mid-flight.
    await Bun.sleep(100)
    expect(handlerSettled).toBe(false)

    try {
      await server.stop()

      // stop() returned only after the parked handler finished...
      expect(handlerSettled).toBe(true)
      // ...and the store was still open when it did.
      expect(handlerError).toBeUndefined()
    } finally {
      await inFlight
      await fixture.cleanup()
    }
  })
})
