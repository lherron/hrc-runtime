import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let originalServe: typeof Bun.serve

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-events-follow-timeout-')
  originalServe = Bun.serve
})

afterEach(async () => {
  Bun.serve = originalServe
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

describe('event follow server configuration', () => {
  it('disables Bun idle timeout for long-lived requests via server.timeout', async () => {
    let capturedOptions: Parameters<typeof Bun.serve>[0] | undefined

    Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
      capturedOptions = options
      return {
        stop() {},
      } as ReturnType<typeof Bun.serve>
    }) as typeof Bun.serve

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    expect(capturedOptions).toBeDefined()
    const timeoutCalls: Array<{ request: Request; seconds: number }> = []
    const request = new Request('http://localhost/v1/events?follow=true')
    const fakeServer = {
      timeout(req: Request, seconds: number) {
        timeoutCalls.push({ request: req, seconds })
      },
    }

    await capturedOptions?.fetch?.(
      request,
      fakeServer as Parameters<NonNullable<typeof capturedOptions.fetch>>[1]
    )

    expect(timeoutCalls).toEqual([{ request, seconds: 0 }])
  })
})
