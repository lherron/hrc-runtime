import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

describe('GET /v1/status lightweight summary', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeAll(async () => {
    fixture = await createHrcTestFixture('hrc-status-summary-')
    server = await createHrcServer(fixture.serverOpts())
    await fixture.ensureRuntime('status-summary')
  })

  afterAll(async () => {
    await server.stop()
    await fixture.cleanup()
  })

  it('preserves the default status session projection and durable totals', async () => {
    const response = await fixture.fetchSocket('/v1/status')
    expect(response.status).toBe(200)

    const body = (await response.json()) as Record<string, unknown>
    expect(body['sessions']).toBeArrayOfSize(1)
    expect(body['sessionCount']).toBe(1)
    expect(body['runtimeCount']).toBe(1)
  })

  it('omits sessions and returns scalar durable totals when includeSessions=false', async () => {
    const response = await fixture.fetchSocket('/v1/status?includeSessions=false')
    expect(response.status).toBe(200)

    const body = (await response.json()) as Record<string, unknown>
    expect(Object.hasOwn(body, 'sessions')).toBe(false)
    expect(body['sessionCount']).toBe(1)
    expect(body['runtimeCount']).toBe(1)
  })
})
