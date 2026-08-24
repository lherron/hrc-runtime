import { afterEach, describe, expect, test } from 'bun:test'

import { createHrcServer } from '../index.js'
import type { SessionPageResponse } from '../session-index-handlers.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

describe('T-07501 session title routes', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  test('serializes writes, protects manual titles, and clears the roster projection', async () => {
    const fixture = await createHrcTestFixture('hrc-t07501-title-')
    fixtures.push(fixture)
    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    try {
      const { hostSessionId } = await fixture.resolveSession(
        'agent:cody:project:hrc-runtime:task:T-07501'
      )
      const path = `/v1/sessions/${encodeURIComponent(hostSessionId)}/title`

      const manual = await fixture.postJson(path, {
        title: 'Add session title routes',
        source: 'manual',
      })
      expect(manual.status).toBe(200)
      expect(await manual.json()).toMatchObject({
        hostSessionId,
        title: 'Add session title routes',
        source: 'manual',
      })

      const pageAfterInsert = await fixture.fetchSocket('/v1/sessions/page?nodes=local')
      const inserted = (await pageAfterInsert.json()) as SessionPageResponse
      expect(inserted.items).toEqual([
        expect.objectContaining({ hostSessionId, title: 'Add session title routes' }),
      ])

      const guarded = await fixture.postJson(path, {
        title: 'Generated replacement must lose',
        source: 'generated',
        model: 'test-model',
      })
      expect(guarded.status).toBe(409)
      expect(await guarded.json()).toMatchObject({
        error: { detail: { hostSessionId, existingSource: 'manual', requiresForce: true } },
      })

      const unchanged = (await (
        await fixture.fetchSocket('/v1/sessions/page?nodes=local')
      ).json()) as SessionPageResponse
      expect(unchanged.items[0]?.title).toBe('Add session title routes')

      const forced = await fixture.postJson(path, {
        title: 'Forced generated replacement',
        source: 'generated',
        model: 'test-model',
        force: true,
      })
      expect(forced.status).toBe(200)
      expect(await forced.json()).toMatchObject({
        title: 'Forced generated replacement',
        source: 'generated',
        model: 'test-model',
      })

      const deleted = await fixture.fetchSocket(path, { method: 'DELETE' })
      expect(deleted.status).toBe(200)
      expect(await deleted.json()).toEqual({ hostSessionId, deleted: true })
      const pageAfterDelete = (await (
        await fixture.fetchSocket('/v1/sessions/page?nodes=local')
      ).json()) as SessionPageResponse
      expect(pageAfterDelete.items[0]?.title).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  test('validates the request and refuses unknown host sessions', async () => {
    const fixture = await createHrcTestFixture('hrc-t07501-title-errors-')
    fixtures.push(fixture)
    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    try {
      const unknownPath = '/v1/sessions/hsid-missing/title'
      expect(
        (await fixture.postJson(unknownPath, { title: 'Missing', source: 'manual' })).status
      ).toBe(404)
      expect((await fixture.fetchSocket(unknownPath, { method: 'DELETE' })).status).toBe(404)

      const { hostSessionId } = await fixture.resolveSession(
        'agent:cody:project:hrc-runtime:task:T-07501-errors'
      )
      const path = `/v1/sessions/${encodeURIComponent(hostSessionId)}/title`
      expect((await fixture.postJson(path, { title: ' ', source: 'manual' })).status).toBe(400)
      expect(
        (await fixture.postJson(path, { title: 'Bad source', source: 'operator' })).status
      ).toBe(400)
    } finally {
      await server.stop()
    }
  })
})
