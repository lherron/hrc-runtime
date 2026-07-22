import { afterEach, describe, expect, test } from 'bun:test'

import type { HrcTargetView } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06805-mint-race'
const SESSION_REF = `${SCOPE}/lane:main`
const INTENT = {
  harness: { provider: 'openai' as const, interactive: false, id: 'codex-cli' as const },
}

describe('T-06805 session mint single-flight', () => {
  let fixture: HrcServerTestFixture | undefined
  let server: HrcServer | undefined

  afterEach(async () => {
    await server?.stop()
    await fixture?.cleanup()
  })

  test('concurrent ensure-target requests converge on one scope/lane continuity and session', async () => {
    fixture = await createHrcTestFixture('hrc-t06805-mint-race-')
    server = await createHrcServer(fixture.serverOpts())

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        fixture!.postJson('/v1/targets/ensure', {
          sessionRef: SESSION_REF,
          runtimeIntent: INTENT,
        })
      )
    )
    const failures = await Promise.all(
      responses
        .filter((response) => response.status !== 200)
        .map(async (response) => ({ status: response.status, body: await response.clone().text() }))
    )
    expect(failures).toEqual([])
    const targets = (await Promise.all(
      responses.map((response) => response.json())
    )) as HrcTargetView[]
    expect(new Set(targets.map((target) => target.hostSessionId)).size).toBe(1)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      const sessions = db.sessions.listByScopeRef(SCOPE)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({ laneRef: 'main', status: 'active', generation: 1 })
      expect(db.continuities.getByKey(SCOPE, 'main')).toMatchObject({
        activeHostSessionId: sessions[0]!.hostSessionId,
      })
      expect(
        db.hrcEvents.listByScope(SCOPE).filter((event) => event.eventKind === 'session.created')
      ).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})
