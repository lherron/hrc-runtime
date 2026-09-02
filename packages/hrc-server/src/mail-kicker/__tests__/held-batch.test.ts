import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcSessionRecord } from 'hrc-core'

import { FakeWrkqLedger } from '../../__tests__/fixtures/fake-wrkq-ledger.js'
import {
  type HrcServerTestFixture,
  createHrcTestFixture,
} from '../../__tests__/fixtures/hrc-test-fixture.js'
import { serverInternals } from '../../__tests__/fixtures/mail-kicker-harness.js'
import { createHrcServer } from '../../index.js'
import type { HrcServer } from '../../index.js'
import { timestamp } from '../../server-util.js'
import { dropAckedHeldMember, holdQueueForBusyTarget, revalidateHeldBatch } from '../held-batch.js'

const SCOPE = 'agent:held-batch-unit:project:hrc-runtime:task:T-07891'
const TARGET = `${SCOPE}/lane:main`
const RUNTIME_ID = 'rt-held-batch-unit'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-held-batch-unit-')
  ledger = new FakeWrkqLedger()
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: false,
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

async function seedSession(): Promise<HrcSessionRecord> {
  const active = server as HrcServer
  const session = await fixture.resolveSession(SCOPE)
  const now = timestamp()
  serverInternals(active).db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    runtimeKind: 'harness',
    controllerKind: 'harness-broker',
    hostSessionId: session.hostSessionId,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: session.generation,
    transport: 'tmux',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'busy',
    statusChangedAt: now,
    supportsInflightInput: false,
    adopted: false,
    activeInvocationId: 'inv-held-batch-unit',
    createdAt: now,
    updatedAt: now,
  })
  return session
}

function say(body: string) {
  return ledger.say({
    toScopeRef: SCOPE,
    fromScopeRef: 'mable@hcs:fixall',
    roomKey: 'T-07891',
    body,
  })
}

describe('mail-kicker held-batch seam', () => {
  it('coalesces queue members locally without a broker or presentation side effect', async () => {
    const active = server as HrcServer
    const session = await seedSession()
    const first = say('first')
    const second = say('second')
    const seat = { state: 'turn-active' as const, runtimeId: RUNTIME_ID, turnId: 'turn-busy' }

    expect(
      holdQueueForBusyTarget(
        serverInternals(active),
        TARGET,
        session,
        seat,
        [first, second].map((envelope) => ({ envelope, form: 'full' as const })),
        'insert'
      )
    ).toBe(true)

    const attempt = serverInternals(active).db.mailDrives.getHeldAttempt(TARGET)
    expect(attempt).toMatchObject({
      state: 'held',
      heldBehindTurnId: 'turn-busy',
      runtimeId: RUNTIME_ID,
      presentedCount: 2,
    })
    expect(ledger.presentRequests).toEqual([])
    expect(first.presentedTo).toEqual([])
    expect(second.presentedTo).toEqual([])
  })

  it('drops terminal members at freeze time and treats ack as a pure local dequeue', async () => {
    const active = server as HrcServer
    const internals = serverInternals(active)
    const session = await seedSession()
    const survivor = say('survivor')
    const terminal = say('terminal')
    const seat = { state: 'turn-active' as const, runtimeId: RUNTIME_ID, turnId: 'turn-busy' }
    holdQueueForBusyTarget(
      internals,
      TARGET,
      session,
      seat,
      [survivor, terminal].map((envelope) => ({ envelope, form: 'full' as const })),
      'insert'
    )
    terminal.state = 'expired'
    terminal.terminal = true

    const held = internals.db.mailDrives.getHeldAttempt(TARGET)
    if (held === undefined) throw new Error('missing held attempt')
    expect((await revalidateHeldBatch(internals, held)).map((item) => item.envelope.id)).toEqual([
      survivor.id,
    ])
    expect(internals.db.mailDrives.presentationEnvelopeIds(held.driveAttemptId)).toEqual([
      survivor.id,
    ])
    expect(dropAckedHeldMember(internals, survivor.id, 'envelope_acked_before_injection')).toBe(
      true
    )
    expect(internals.db.mailDrives.getAttempt(held.driveAttemptId)?.state).toBe('withdrawn')
    expect(ledger.presentRequests).toEqual([])
  })
})
