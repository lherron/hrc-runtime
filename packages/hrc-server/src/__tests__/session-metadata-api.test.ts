import { expect, test } from 'bun:test'
import { createHrcServer } from '../index.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

test('metadata API is atomic, store-only, and title shims share its continuity projection', async () => {
  const f = await createHrcTestFixture('hrc-meta-api-')
  const server = await createHrcServer(f.serverOpts({ otelListenerEnabled: false }))
  try {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:metadata-e2e'
    const { hostSessionId } = (await (
      await f.postJson('/v1/sessions/resolve', {
        sessionRef: `${scopeRef}/lane:main`,
        create: true,
      })
    ).json()) as { hostSessionId: string }
    const patch = (set: unknown, clear?: string[]) =>
      f.fetchSocket('/v1/sessions/metadata', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopeRef, set, clear }),
      })
    const get = () => f.fetchSocket(`/v1/sessions/get?scopeRef=${encodeURIComponent(scopeRef)}`)
    const baseline = server.db.hrcEvents.maxHrcSeq()
    expect((await get()).status).toBe(200)
    expect(server.db.hrcEvents.maxHrcSeq()).toBe(baseline)
    expect(
      (await patch({ title: 'One', appearance: { color: '#123456' }, constructor: 'open' })).status
    ).toBe(200)
    const first = (await (await get()).json()) as Record<string, any>
    expect(first.identity.agentId).toBe('cody')
    expect(first.generation.generation).toBe(1)
    expect(first.metadata.title).toBe('One')
    expect(first.metadata.constructor).toBe('open')
    const changed = server.db.hrcEvents.maxHrcSeq()
    expect(changed - baseline).toBe(3)
    expect((await patch({ title: 'One' })).status).toBe(200)
    expect(server.db.hrcEvents.maxHrcSeq()).toBe(changed)
    const bad = await patch({
      title: 'Should not land',
      appearance: 'prefix',
      [`${'a'.repeat(65)}.${'b'.repeat(63)}`]: 1,
    })
    expect(bad.status).toBe(400)
    expect(((await (await get()).json()) as Record<string, any>).metadata.title).toBe('One')
    expect(server.db.hrcEvents.maxHrcSeq()).toBe(changed)
    const titlePath = `/v1/sessions/${hostSessionId}/title`
    expect(
      (await f.postJson(titlePath, { title: 'Slugger', source: 'generated', model: 'smoke' }))
        .status
    ).toBe(200)
    expect(((await (await get()).json()) as Record<string, any>).metadataSources.title.source).toBe(
      'api'
    )
    expect((await f.fetchSocket(titlePath, { method: 'DELETE' })).status).toBe(200)
    expect(((await (await get()).json()) as Record<string, any>).metadata.title).toBeUndefined()
    expect((await f.fetchSocket('/v1/sessions/get?scopeRef=agent:nonexistent')).status).toBe(404)
    const missing = await f.fetchSocket('/v1/sessions/metadata', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopeRef: 'agent:nonexistent', set: { title: 'No' } }),
    })
    expect(missing.status).toBe(404)
    expect((await patch(null)).status).toBe(400)
    expect((await patch({}, ['appearance.color'])).status).toBe(200)
  } finally {
    await server.stop()
    await f.cleanup()
  }
})
