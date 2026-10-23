import { expect, test } from 'bun:test'
import { createHrcServer } from '../index.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

test('retired session operations are unmatched while live neighbours still dispatch', async () => {
  const fixture = await createHrcTestFixture('hrc-t11569-')
  const server = await createHrcServer(fixture.serverOpts())
  try {
    const missing = await fixture.postJson('/v1/does-not-exist-t11569', {})
    expect(missing.status).toBe(404)
    const unmatched = await missing.text()
    for (const route of ['archive-abandoned', 'clear-context', 'create-successor']) {
      const response = await fixture.postJson(`/v1/sessions/${route}`, {})
      expect(response.status).toBe(404)
      expect(await response.text()).toEqual(unmatched)
    }
    for (const route of [
      '/v1/clear-context',
      '/v1/sessions/restart',
      '/v1/sessions/resume-continuation',
      '/v1/sessions/drop-continuation',
    ]) {
      const response = await fixture.postJson(route, {})
      expect(response.status).toBe(400)
    }
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})
