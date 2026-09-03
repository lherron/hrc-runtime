import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcSessionRecord } from 'hrc-core'

import { autoReplyCandidateFor } from '../auto-reply-handlers.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { holdQueueForBusyTarget } from '../mail-kicker/held-batch.js'
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

  const drivingEnvelope = ledger.say({
    toScopeRef: SCOPE,
    fromPrincipalRef: 'agent:mable',
    fromScopeRef: DRIVING_COUNTERPARTY,
    roomKey: 'T-07904',
    body: 'drive the active turn',
  })
  const candidate = autoReplyCandidateFor([drivingEnvelope])
  if (candidate === undefined) throw new Error('driving envelope is not auto-reply eligible')
  const claimed = db.mailDrives.claim(
    TARGET,
    'insert',
    { envelopeIds: [drivingEnvelope.id] },
    { driveAttemptId: 'drive-t07926-driving', runId: RUN_ID }
  )
  if (claimed.outcome !== 'acquired') throw new Error('failed to claim driving attempt')
  db.mailDrives.presentForAttempt(claimed.attempt.driveAttemptId, [drivingEnvelope.id])
  db.mailDrives.recordAutoReplyCandidate(claimed.attempt.driveAttemptId, candidate)

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

function hold(...envelopes: ReturnType<typeof say>[]): string {
  const active = server as HrcServer
  holdQueueForBusyTarget(
    serverInternals(active),
    TARGET,
    session,
    { state: 'turn-active', runtimeId: RUNTIME_ID, turnId: 'turn-active-hint' },
    envelopes.map((envelope) => ({ envelope, form: 'full' as const })),
    'insert'
  )
  const attempt = serverInternals(active).db.mailDrives.getHeldAttempt(TARGET)
  if (attempt === undefined) throw new Error('missing held hint attempt')
  return attempt.driveAttemptId
}

async function hint(runtimeId = RUNTIME_ID): Promise<Record<string, unknown>> {
  const response = await fixture.postJson('/v1/internal/mail/hint-decision', { runtimeId })
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

describe('T-07926 — local held-mail hint decision', () => {
  it('1. suppresses when there is no held batch and logs the reason', async () => {
    const captured = await captureServerLog(async () => hint())
    expect(captured.result).toEqual({})
    expect(
      captured.lines.some(
        (line) => line.includes('wrkq.kicker.hint_suppressed') && line.includes('no_held_batch')
      )
    ).toBe(true)
  })

  it('2. issues the first exact hint using stored scoped counterparty refs', async () => {
    const scoped = say('scoped sender', {
      principalRef: 'agent:mable',
      scopeRef: DRIVING_COUNTERPARTY,
    })
    const human = say('scope-less human', { principalRef: 'agent:lance' })
    const driveAttemptId = hold(scoped, human)
    ledger.unavailable = true

    const captured = await captureServerLog(async () => hint())
    expect(captured.result).toEqual({
      hint: MAIL_HINT_TEXT(2, 1),
      heldCount: 2,
      fromDrivingParty: 1,
      driveAttemptId,
      reason: 'first',
    })
    expect(serverInternals(server as HrcServer).db.mailDrives.getHeldAttempt(TARGET)).toMatchObject(
      {
        hintCount: 1,
        lastHintPresentedCount: 2,
      }
    )
    expect(
      serverInternals(server as HrcServer)
        .db.sqlite.query<{ counterparty_ref: string | null }, [string]>(
          `SELECT counterparty_ref FROM hrcmail_drive_presentations
            WHERE drive_attempt_id = ? ORDER BY envelope_id`
        )
        .all(driveAttemptId)
        .map((row) => row.counterparty_ref)
    ).toEqual([DRIVING_COUNTERPARTY, 'lance'])
    expect(captured.lines.some((line) => line.includes('wrkq.kicker.hint_issued'))).toBe(true)
  })

  it('3. suppresses the same count inside five minutes', async () => {
    hold(say('first', { principalRef: 'agent:lance' }))
    await hint()
    const captured = await captureServerLog(async () => hint())
    expect(captured.result).toEqual({})
    expect(captured.lines.some((line) => line.includes('"reason":"cadence"'))).toBe(true)
  })

  it('4. issues immediately when a new held member changes the count', async () => {
    hold(say('first', { principalRef: 'agent:lance' }))
    await hint()
    hold(say('second', { principalRef: 'agent:lance' }))
    expect(await hint()).toMatchObject({ heldCount: 2, reason: 'count_changed' })
  })

  it('5. issues periodically once the five-minute boundary is reached', async () => {
    const driveAttemptId = hold(say('first', { principalRef: 'agent:lance' }))
    await hint()
    serverInternals(server as HrcServer)
      .db.sqlite.query(
        `UPDATE hrcmail_drive_attempts
            SET last_hint_at = ?
          WHERE drive_attempt_id = ?`
      )
      .run(new Date(Date.now() - 5 * 60_000).toISOString(), driveAttemptId)
    expect(await hint()).toMatchObject({ heldCount: 1, reason: 'periodic' })
  })

  it('6. suppresses a missing active run and a held batch bound to another runtime', async () => {
    hold(say('first', { principalRef: 'agent:lance' }))
    const db = serverInternals(server as HrcServer).db
    db.sqlite
      .query("UPDATE hrcmail_drive_attempts SET runtime_id = ? WHERE state = 'held'")
      .run('rt-other')
    expect(await hint()).toEqual({})

    db.runtimes.updateRunId(RUNTIME_ID, undefined, timestamp())
    expect(await hint()).toEqual({})
  })

  it('7. creates no broker submission or presentation receipt', async () => {
    const first = say('first', { principalRef: 'agent:lance' })
    const second = say('second', { principalRef: 'agent:other' })
    const driveAttemptId = hold(first, second)
    expect(await hint()).toMatchObject({ heldCount: 2 })
    expect(ledger.presentRequests).toEqual([])
    expect(ledger.roomSayRequests).toEqual([])
    expect(first.presentedTo).toEqual([])
    expect(second.presentedTo).toEqual([])
    expect(
      serverInternals(server as HrcServer).db.mailDrives.presentationEnvelopeIds(driveAttemptId)
    ).toEqual([first.id, second.id])
  })

  it('fails open to an empty object on malformed input or a local store error', async () => {
    expect(
      await (await fixture.postJson('/v1/internal/mail/hint-decision', { runtimeId: '' })).json()
    ).toEqual({})
    serverInternals(server as HrcServer).db.mailDrives.evaluateHeldHint = () => {
      throw new Error('local store unavailable')
    }
    expect(await hint()).toEqual({})
  })
})
