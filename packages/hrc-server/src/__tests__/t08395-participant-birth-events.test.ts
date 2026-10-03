import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

/**
 * T-08395 — participant identity minting is a session birth, even though no
 * runtime has attached yet. Drive the real HTTP doors and publisher rather
 * than mirroring the database writes in a fixture.
 */

const DIRECT_SCOPE = 'agent:arris:project:hrc-runtime:task:T-08395-direct'
const SECOND_SCOPE = 'agent:arris:project:hrc-runtime:task:T-08395-second'
type RegistrationResponse = {
  status: string
  created: boolean
  hostSessionId: string
}

describe('T-08395 participant registrations produce project-visible births', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined
  let ledger: FakeWrkqLedger

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t08395-')
    ledger = new FakeWrkqLedger()
    server = await createHrcServer(
      fixture.serverOpts({
        otelListenerEnabled: false,
        wrkqLedger: ledger,
      })
    )
  })

  afterEach(async () => {
    await server?.stop()
    server = undefined
    await fixture.cleanup()
  })

  async function register(body: Record<string, unknown>): Promise<RegistrationResponse> {
    const response = await fixture.postJson('/v1/participants/register', body)
    expect(response.status).toBe(200)
    return (await response.json()) as RegistrationResponse
  }

  test('publishes one durable birth per true direct registration and none on retries', async () => {
    const directRequest = {
      registrationMode: 'direct',
      requestedSessionRef: DIRECT_SCOPE,
      hostIncarnationId: 't08395-direct-incarnation',
    }
    const secondRequest = {
      registrationMode: 'direct',
      requestedSessionRef: SECOND_SCOPE,
      hostIncarnationId: 't08395-second-incarnation',
    }

    const direct = await register(directRequest)
    const directRetry = await register(directRequest)
    const second = await register(secondRequest)
    const secondRetry = await register(secondRequest)

    expect(direct).toMatchObject({ status: 'registered', created: true })
    expect(directRetry).toMatchObject({ status: 'registered', created: false })
    expect(directRetry.hostSessionId).toBe(direct.hostSessionId)
    expect(second).toMatchObject({ status: 'registered', created: true })
    expect(secondRetry).toMatchObject({ status: 'registered', created: false })
    expect(secondRetry.hostSessionId).toBe(second.hostSessionId)

    const births = server!.db.hrcEvents
      .listFromHrcSeq(1)
      .filter((event) => event.eventKind === 'session.created')
    expect(births).toHaveLength(2)
    expect(births.map((event) => event.hostSessionId)).toEqual(
      expect.arrayContaining([direct.hostSessionId, second.hostSessionId])
    )
    for (const birth of births) {
      expect(birth).toMatchObject({ laneRef: 'main', generation: 1, payload: { created: true } })
    }

    await server!.sessionProjectEvents.drain()
    expect(ledger.projectEventPosts).toHaveLength(2)
    expect(ledger.projectEventPosts.map((post) => post.type)).toEqual([
      'session.born',
      'session.born',
    ])
    expect(ledger.projectEventPosts.map((post) => post.attributes['session'])).toEqual(
      expect.arrayContaining([direct.hostSessionId, second.hostSessionId])
    )
    expect(ledger.projectEventPosts.every((post) => post.attributes['cause'] === 'resolve')).toBe(
      true
    )
  })
})
