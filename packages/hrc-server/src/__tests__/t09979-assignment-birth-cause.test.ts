import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

/**
 * T-09979 — the ACP reconciler starts delegated work with `ensureTarget`
 * (summon) then a queued turn. A session born by that start reports
 * `session.born cause=assignment`; a start into a seat that already has a
 * session births nothing; a plain summon keeps `cause=summon`.
 *
 * Failure modes this guards:
 *  - the cause is dropped between the route and the `session.created` payload
 *    (assignment births read as `summon`);
 *  - the cause leaks onto a session that already existed (a second start
 *    invents a birth);
 *  - an unknown cause is silently accepted, or silently treated as `summon`;
 *  - a subtask seat's birth is affiliated to the project instead of its task.
 */

const INTENT = {
  harness: { provider: 'openai' as const, interactive: false, id: 'codex-cli' as const },
}

describe('T-09979 — ensure-target birthCause', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined
  let ledger: FakeWrkqLedger

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t09979-')
    ledger = new FakeWrkqLedger()
    server = await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false, wrkqLedger: ledger })
    )
  })

  afterEach(async () => {
    if (server !== undefined) {
      await server.stop()
      server = undefined
    }
    await fixture.cleanup()
  })

  function births(scope: string) {
    return ledger.projectEventPosts.filter(
      (post) => post.type === 'session.born' && post.attributes['seat'] === scope
    )
  }

  it('a cold assignment start posts one birth with cause=assignment under the subtask', async () => {
    const scope = 'agent:arris:project:hrc-runtime:task:T-09979.diagram'
    const sessionRef = `${scope}/lane:main`

    const first = await fixture.postJson('/v1/targets/ensure', {
      sessionRef,
      runtimeIntent: INTENT,
      birthCause: 'assignment',
    })
    expect(first.status).toBe(200)
    await server!.sessionProjectEvents.drain()

    const born = births(scope)
    expect(born).toHaveLength(1)
    expect(born[0]?.attributes['cause']).toBe('assignment')
    expect(born[0]?.task).toBe('T-09979.diagram')
    expect(born[0]?.summary).toContain('via assignment')

    // A second start into the now-existing session invents no birth.
    const second = await fixture.postJson('/v1/targets/ensure', {
      sessionRef,
      runtimeIntent: INTENT,
      birthCause: 'assignment',
    })
    expect(second.status).toBe(200)
    await server!.sessionProjectEvents.drain()
    expect(births(scope)).toHaveLength(1)
    expect(
      server!.db.hrcEvents
        .listByScope(scope)
        .filter((event) => event.eventKind === 'session.created')
    ).toHaveLength(1)
  })

  it('a plain summon still reports cause=summon', async () => {
    const scope = 'agent:arris:project:hrc-runtime:task:T-09979.plain'
    const response = await fixture.postJson('/v1/targets/ensure', {
      sessionRef: `${scope}/lane:main`,
      runtimeIntent: INTENT,
    })
    expect(response.status).toBe(200)
    await server!.sessionProjectEvents.drain()

    const born = births(scope)
    expect(born).toHaveLength(1)
    expect(born[0]?.attributes['cause']).toBe('summon')
  })

  it.each([['summon'], ['Assignment'], [''], [1], [null]])(
    'refuses birthCause %p and mints nothing',
    async (birthCause) => {
      const scope = 'agent:arris:project:hrc-runtime:task:T-09979.refused'
      const response = await fixture.postJson('/v1/targets/ensure', {
        sessionRef: `${scope}/lane:main`,
        runtimeIntent: INTENT,
        birthCause,
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error?: { code?: string; detail?: unknown } }
      expect(JSON.stringify(body)).toContain('birthCause')
      expect(server!.db.sessions.listByScopeRef(scope)).toHaveLength(0)
    }
  )
})
