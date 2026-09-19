import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HrcInjectionPort } from 'hrc-mail-kicker'
import { HrcClient } from 'hrc-sdk'

import { appendHrcEvent } from '../hrc-event-helper.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import type { AspdObservationDouble } from './fixtures/aspd-observation-doubles.js'
import type { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture.js'
import { serverInternals, waitUntil } from './fixtures/mail-kicker-harness.js'
import {
  SCOPE,
  TARGET,
  buildKickerServer,
  kickerOf,
  setupKickerPreamble,
  teardownKickerPreamble,
} from './server-hrcmail-kicker.setup.js'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void
let aspdDouble: AspdObservationDouble | undefined
let savedAspdSocket: string | undefined

beforeEach(async () => {
  ;({ fixture, ledger, restoreAgentHome, aspdDouble, savedAspdSocket } =
    await setupKickerPreamble())
  server = await buildKickerServer(fixture, ledger)
})

afterEach(async () => {
  await teardownKickerPreamble({ server, fixture, aspdDouble, savedAspdSocket, restoreAgentHome })
  server = undefined
  aspdDouble = undefined
})

function port(): HrcInjectionPort {
  if (server === undefined) throw new Error('missing contract server')
  return kickerOf(server).port
}

/**
 * The shared port contract starts here rather than in a database fixture: the
 * implementation under test is bound to a real hrc-server on its temp unix
 * socket. SocketInjectionPort will execute these same cases unchanged.
 */
describe('HrcInjectionPort contract — real daemon', () => {
  it('resolves a scope over the socket without caller-side placement paths', async () => {
    const response = await new HrcClient(fixture.socketPath).resolveRuntimeIntent({
      scopeRef: SCOPE,
    })
    expect(response.intent.placement.agentRoot).toContain('agents/kicker-proof')
  })

  it('resolves and ensures a cold target without exposing daemon state', async () => {
    const intent = await port().resolveRuntimeIntent(SCOPE, undefined)
    expect(intent).toBeDefined()
    if (intent === undefined) return

    const session = await port().ensureTargetSession(TARGET, intent, { persistIntent: false })
    expect(session.scopeRef).toBe(SCOPE)
    expect((await port().targetBySessionRef(TARGET))?.hostSessionId).toBe(session.hostSessionId)
  })

  it('reads lifecycle evidence through a cursor-resuming subscription', async () => {
    const head = await port().eventsHead()
    const observed: string[] = []
    const unsubscribe = await port().subscribeLifecycle({
      afterSeq: head.hrcSeq,
      onEvent: (event) => observed.push(event.eventKind),
    })
    try {
      const intent = await port().resolveRuntimeIntent(SCOPE, undefined)
      if (intent === undefined) throw new Error('contract target intent missing')
      const target = await port().ensureTargetSession(TARGET, intent, { persistIntent: false })
      const event = appendHrcEvent(serverInternals(server as HrcServer).db, 'turn.started', {
        ts: timestamp(),
        hostSessionId: target.hostSessionId,
        scopeRef: target.scopeRef,
        laneRef: target.laneRef,
        generation: target.generation,
        transport: 'headless',
      })
      serverInternals(server as HrcServer).notifyEvent(event)
      await waitUntil(() => observed.includes('turn.started'), 'lifecycle contract delivery')
    } finally {
      unsubscribe()
    }
  })
})
