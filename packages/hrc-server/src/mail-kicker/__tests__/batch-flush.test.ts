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
import { prepareHeldBatchForBoundary, replayHeldBatchReceipts } from '../batch-flush.js'
import { holdQueueForBusyTarget } from '../held-batch.js'

const SCOPE = 'agent:batch-flush-unit:project:hrc-runtime:task:T-07891'
const TARGET = `${SCOPE}/lane:main`
const RUNTIME_ID = 'rt-batch-flush-unit'
const ROTATED_RUNTIME_ID = 'rt-batch-flush-unit-rotated'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-batch-flush-unit-')
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
    activeInvocationId: 'inv-batch-flush-unit',
    createdAt: now,
    updatedAt: now,
  })
  return session
}

function say(body: string, groupId = 'EN-batch-flush-fanout') {
  return ledger.say({
    toScopeRef: SCOPE,
    fromScopeRef: 'mable@hcs:fixall',
    roomKey: 'T-07891',
    body,
    groupId,
  })
}

async function heldFixture() {
  const active = server as HrcServer
  const internals = serverInternals(active)
  const session = await seedSession()
  const envelopes = [say('first'), say('second')]
  holdQueueForBusyTarget(
    internals,
    TARGET,
    session,
    { state: 'turn-active', runtimeId: RUNTIME_ID, turnId: 'turn-busy' },
    envelopes.map((envelope) => ({ envelope, form: 'full' as const })),
    'insert'
  )
  const held = internals.db.mailDrives.getHeldAttempt(TARGET)
  if (held === undefined) throw new Error('missing held attempt')
  return { internals, session, envelopes, held }
}

describe('mail-kicker batch-flush seam', () => {
  it('freezes one stable batch only after the authoritative second probe is idle', async () => {
    const { internals, session, envelopes, held } = await heldFixture()
    const prepared = await prepareHeldBatchForBoundary(
      internals,
      TARGET,
      session,
      held,
      envelopes.map((envelope) => ({ envelope, form: 'full' as const })),
      'turn_completion',
      async () => ({ state: 'idle', runtimeId: RUNTIME_ID })
    )

    expect(prepared?.attempt).toMatchObject({
      driveAttemptId: held.driveAttemptId,
      runId: held.runId,
      state: 'claimed',
    })
    expect(prepared?.actionable.map((item) => item.envelope.id)).toEqual(
      envelopes.map((envelope) => envelope.id)
    )
  })

  it('atomically rebinds a held attempt to the runtime that wins the boundary', async () => {
    const { internals, session, envelopes, held } = await heldFixture()
    const prepared = await prepareHeldBatchForBoundary(
      internals,
      TARGET,
      session,
      held,
      envelopes.map((envelope) => ({ envelope, form: 'full' as const })),
      'turn_completion',
      async () => ({ state: 'idle', runtimeId: ROTATED_RUNTIME_ID })
    )

    expect(prepared?.attempt).toMatchObject({
      driveAttemptId: held.driveAttemptId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: ROTATED_RUNTIME_ID,
      state: 'claimed',
    })
  })

  it('keeps the batch held when a foreign turn wins the second probe', async () => {
    const { internals, session, envelopes, held } = await heldFixture()
    const prepared = await prepareHeldBatchForBoundary(
      internals,
      TARGET,
      session,
      held,
      envelopes.map((envelope) => ({ envelope, form: 'full' as const })),
      'turn_completion',
      async () => ({
        state: 'turn-active',
        runtimeId: RUNTIME_ID,
        turnId: 'turn-foreign',
      })
    )

    expect(prepared).toBeUndefined()
    expect(internals.db.mailDrives.getAttempt(held.driveAttemptId)?.state).toBe('held')
    expect(ledger.presentRequests).toEqual([])
  })

  it('replays missing per-envelope receipts under the accepted batch input identity', async () => {
    const { internals, session, envelopes, held } = await heldFixture()
    const prepared = await prepareHeldBatchForBoundary(
      internals,
      TARGET,
      session,
      held,
      envelopes.map((envelope) => ({ envelope, form: 'full' as const })),
      'turn_completion',
      async () => ({ state: 'idle', runtimeId: RUNTIME_ID })
    )
    if (prepared === undefined) throw new Error('batch did not activate')

    const now = timestamp()
    const inputId = 'input-batch-flush-unit'
    internals.db.runs.insert({
      runId: prepared.attempt.runId,
      hostSessionId: session.hostSessionId,
      runtimeId: RUNTIME_ID,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: session.generation,
      transport: 'tmux',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
      dispatchedInputId: inputId,
    })
    await ledger.present({
      envelope: envelopes[0]?.id ?? '',
      node: 'max3',
      hostSessionId: session.hostSessionId,
      generation: String(session.generation),
      runtimeId: RUNTIME_ID,
      runId: prepared.attempt.runId,
      inputId,
      driveAttemptId: prepared.attempt.driveAttemptId,
    })

    await replayHeldBatchReceipts(internals, prepared.attempt)
    const receipts = envelopes.map((envelope) => envelope.presentedTo[0])
    expect(receipts.map((receipt) => receipt?.driveAttemptId)).toEqual([
      prepared.attempt.driveAttemptId,
      prepared.attempt.driveAttemptId,
    ])
    expect(receipts.map((receipt) => receipt?.inputId)).toEqual([inputId, inputId])
  })
})
