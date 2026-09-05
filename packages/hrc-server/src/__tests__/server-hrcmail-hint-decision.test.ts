import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcSessionRecord } from 'hrc-core'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { MAIL_HINT_TEXT } from '../wrkq/stop-gate-handlers.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { captureServerLog, serverInternals } from './fixtures/mail-kicker-harness.js'

const SCOPE = 'agent:hint-proof:project:hrc-runtime:task:T-07926'
const TARGET = `${SCOPE}/lane:main`
const RUNTIME_ID = 'rt-t07926-hint'
const RUN_ID = 'run-t07926-driving'
const DRIVING_COUNTERPARTY = 'mable@hcs:T-07904'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let session: HrcSessionRecord

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07926-hint-')
  ledger = new FakeWrkqLedger()
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: false,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
    })
  )
  const resolved = await fixture.resolveSession(SCOPE)
  const db = serverInternals(server).db
  const storedSession = db.sessions.getByHostSessionId(resolved.hostSessionId)
  if (storedSession === null) throw new Error('missing hint test session')
  session = storedSession

  const now = timestamp()
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    runtimeKind: 'harness',
    controllerKind: 'harness-broker',
    hostSessionId: session.hostSessionId,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: session.generation,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'busy',
    statusChangedAt: now,
    supportsInflightInput: false,
    adopted: false,
    activeRunId: RUN_ID,
    createdAt: now,
    updatedAt: now,
  })
  db.runs.insert({
    runId: RUN_ID,
    hostSessionId: session.hostSessionId,
    runtimeId: RUNTIME_ID,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: session.generation,
    transport: 'tmux',
    status: 'running',
    acceptedAt: now,
    startedAt: now,
    updatedAt: now,
  })
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  await fixture.cleanup()
})

function say(body: string, sender: { principalRef: string; scopeRef?: string | undefined }) {
  return ledger.say({
    toScopeRef: SCOPE,
    fromPrincipalRef: sender.principalRef,
    fromScopeRef: sender.scopeRef,
    roomKey: 'T-07926',
    body,
  })
}

/**
 * The T-08094 shape of "mail the harness is holding": an OPEN ENQUEUE INTENT.
 *
 * The hint counts submissions the seat cannot read from inside its turn. A
 * steered body is not one of them — it is already in the turn — which is why a
 * steer-capable seat is hinted zero times by construction.
 */
function outstanding(...envelopes: ReturnType<typeof say>[]): void {
  const db = serverInternals(server as HrcServer).db
  for (const envelope of envelopes) {
    const intent = db.mailDelivery.openIntent({
      envelopeId: envelope.id,
      targetSessionRef: TARGET,
      door: 'enqueue',
      form: 'full',
      presentationId: `present-${envelope.id}`,
      runtimeId: RUNTIME_ID,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      submittedHrcSeq: db.hrcEvents.maxHrcSeq(),
    })
    if (intent === undefined) throw new Error(`failed to open intent for ${envelope.id}`)
    db.mailDelivery.attachAdmission(envelope.id, { submissionId: `sub-${envelope.id}` })
  }
}

async function hint(runtimeId = RUNTIME_ID): Promise<Record<string, unknown>> {
  const response = await fixture.postJson('/v1/internal/mail/hint-decision', { runtimeId })
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

describe('T-07926 — local held-mail hint decision', () => {
  it('1. suppresses when nothing is outstanding and logs the reason', async () => {
    const captured = await captureServerLog(async () => hint())
    expect(captured.result).toEqual({})
    expect(
      captured.lines.some(
        (line) =>
          line.includes('wrkq.kicker.hint_suppressed') && line.includes('no_outstanding_mail')
      )
    ).toBe(true)
  })

  it('2. issues the first hint as a bare count over every outstanding sender', async () => {
    const scoped = say('scoped sender', {
      principalRef: 'agent:mable',
      scopeRef: DRIVING_COUNTERPARTY,
    })
    const human = say('scope-less human', { principalRef: 'agent:lance' })
    outstanding(scoped, human)
    ledger.unavailable = true

    const captured = await captureServerLog(async () => hint())
    // T-08093: the hint no longer singles out "the party driving this turn".
    // That clause was derived from the drive attempt's auto-reply candidate,
    // and with the mint retired there is no driving party to name — the seat
    // owes every sender the same explicit reply.
    expect(captured.result).toEqual({
      hint: MAIL_HINT_TEXT(2),
      heldCount: 2,
      reason: 'first',
    })
    expect(captured.result['hint']).not.toContain('driving this turn')
    expect(captured.lines.some((line) => line.includes('wrkq.kicker.hint_issued'))).toBe(true)
  })

  it('3. suppresses the same count inside the cadence window', async () => {
    outstanding(say('first', { principalRef: 'agent:lance' }))
    await hint()
    const captured = await captureServerLog(async () => hint())
    expect(captured.result).toEqual({})
    expect(captured.lines.some((line) => line.includes('"reason":"cadence"'))).toBe(true)
  })

  it('4. issues immediately when a new outstanding submission changes the count', async () => {
    outstanding(say('first', { principalRef: 'agent:lance' }))
    await hint()
    outstanding(say('second', { principalRef: 'agent:lance' }))
    expect(await hint()).toMatchObject({ heldCount: 2, reason: 'count_changed' })
  })

  it('5. issues periodically once the cadence boundary is reached', async () => {
    outstanding(say('first', { principalRef: 'agent:lance' }))
    await hint()
    serverInternals(server as HrcServer)
      .db.sqlite.query('UPDATE hrcmail_seat_hints SET last_hint_at = ? WHERE runtime_id = ?')
      .run(new Date(Date.now() - 5 * 60_000).toISOString(), RUNTIME_ID)
    expect(await hint()).toMatchObject({ heldCount: 1, reason: 'periodic' })
  })

  it('6. suppresses an outstanding submission bound to another runtime', async () => {
    outstanding(say('first', { principalRef: 'agent:lance' }))
    const db = serverInternals(server as HrcServer).db
    db.sqlite.query('UPDATE hrcmail_delivery_intents SET runtime_id = ?').run('rt-other')
    expect(await hint()).toEqual({})
  })

  it('7. creates no broker submission or presentation receipt', async () => {
    const first = say('first', { principalRef: 'agent:lance' })
    const second = say('second', { principalRef: 'agent:other' })
    outstanding(first, second)
    expect(await hint()).toMatchObject({ heldCount: 2 })
    expect(ledger.presentRequests).toEqual([])
    expect(ledger.roomSayRequests).toEqual([])
    expect(first.presentedTo).toEqual([])
    expect(second.presentedTo).toEqual([])
  })

  it('8. counts no steered submission: a steer is already inside the turn', async () => {
    const envelope = say('steered', { principalRef: 'agent:lance' })
    const db = serverInternals(server as HrcServer).db
    db.mailDelivery.openIntent({
      envelopeId: envelope.id,
      targetSessionRef: TARGET,
      door: 'steer',
      form: 'full',
      presentationId: `present-${envelope.id}`,
      runtimeId: RUNTIME_ID,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      submittedHrcSeq: db.hrcEvents.maxHrcSeq(),
    })
    expect(await hint()).toEqual({})
  })

  it('fails open to an empty object on malformed input or a local store error', async () => {
    expect(
      await (await fixture.postJson('/v1/internal/mail/hint-decision', { runtimeId: '' })).json()
    ).toEqual({})
    serverInternals(server as HrcServer).db.mailDelivery.evaluateSeatHint = () => {
      throw new Error('local store unavailable')
    }
    expect(await hint()).toEqual({})
  })
})
