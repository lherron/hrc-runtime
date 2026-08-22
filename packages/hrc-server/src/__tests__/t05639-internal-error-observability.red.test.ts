import { describe, expect, test } from 'bun:test'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'

type ExactRouteHandler = (request: Request, url: URL) => Response | Promise<Response>

type InspectableServer = HrcServer & {
  exactRouteHandlers: Record<string, ExactRouteHandler>
}

describe('T-05639 internal request error observability', () => {
  test('logs a forced handler throw with request context and preserves its cause for SDK callers', async () => {
    const fixture = await createHrcTestFixture('hrc-t05639-')
    const server = (await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false })
    )) as InspectableServer
    const stderrWrites: string[] = []
    const originalStderrWrite = process.stderr.write
    process.stderr.write = ((chunk, encodingOrCallback, callback) => {
      stderrWrites.push(String(chunk))
      if (typeof encodingOrCallback === 'function') {
        encodingOrCallback()
      } else {
        callback?.()
      }
      return true
    }) as typeof process.stderr.write

    const scopeRef = 'agent:smokey:project:taskboard:task:T-05625:role:red'
    const cause = 'forced T-05639 semantic turn bookkeeping failure'
    server.exactRouteHandlers['GET /v1/sessions'] = () => {
      throw new Error(cause)
    }

    let caught: unknown
    try {
      await new HrcClient(fixture.socketPath).listSessions({ scopeRef })
    } catch (error) {
      caught = error
    } finally {
      process.stderr.write = originalStderrWrite
      await server.stop()
      await fixture.cleanup()
    }

    expect(caught).toBeInstanceOf(HrcDomainError)
    const domainError = caught as HrcDomainError
    const requestId = domainError.detail['requestId']
    expect(domainError.code).toBe(HrcErrorCode.INTERNAL_ERROR)
    expect(requestId).toMatch(/^req-[0-9a-f-]+$/)
    expect((caught as Error).message).toContain(HrcErrorCode.INTERNAL_ERROR)
    expect((caught as Error).message).toContain(cause)
    expect((caught as Error).message).toContain(String(requestId))

    const log = stderrWrites.join('')
    expect(log).toContain('ERROR request.unhandled_error')
    expect(log).toContain('"method":"GET"')
    expect(log).toContain('"path":"/v1/sessions"')
    expect(log).toContain(`"scopeRef":"${scopeRef}"`)
    expect(log).toContain(`"requestId":"${String(requestId)}"`)
    expect(log).toContain(`"errorCode":"${HrcErrorCode.INTERNAL_ERROR}"`)
    expect(log).toContain(cause)
    expect(log).toContain('Error:')
  })
})
