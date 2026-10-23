import { expect, test } from 'bun:test'

import { createHrcServer } from '../index.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

test('retired title routes refuse without mutation; metadata set and clear update the roster', async () => {
  const fixture = await createHrcTestFixture('hrc-retired-title-')
  const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  try {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-11711'
    const { hostSessionId } = await fixture.resolveSession(scopeRef)
    const path = `/v1/sessions/${encodeURIComponent(hostSessionId)}/title`
    const patch = (body: Record<string, unknown>) =>
      fixture.fetchSocket('/v1/sessions/metadata', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopeRef, laneRef: 'default', ...body }),
      })
    const page = async () =>
      (await (await fixture.fetchSocket('/v1/sessions/page?nodes=local')).json()) as {
        items: Array<{ hostSessionId: string; title?: string }>
      }
    expect((await patch({ set: { title: 'Metadata title' } })).status).toBe(200)
    const baseline = server.db.hrcEvents.maxHrcSeq()
    for (const retired of [path, '/v1/sessions/hsid-missing/title']) {
      expect((await fixture.postJson(retired, { title: 'Must not land' })).status).toBe(404)
      expect((await fixture.fetchSocket(retired, { method: 'DELETE' })).status).toBe(404)
    }
    expect(server.db.hrcEvents.maxHrcSeq()).toBe(baseline)
    expect((await page()).items).toEqual([
      expect.objectContaining({ hostSessionId, title: 'Metadata title' }),
    ])
    expect((await patch({ clear: ['title'] })).status).toBe(200)
    expect((await page()).items[0]?.title).toBeUndefined()
    expect(server.db.hrcEvents.maxHrcSeq()).toBe(baseline + 1)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})
