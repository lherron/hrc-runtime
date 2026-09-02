import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase, HrcMailDriveAttempt } from 'hrc-store-sqlite'

import { HarnessBrokerController } from '../broker/controller.js'
import { BrokerEventMapper } from '../broker/event-mapper.js'
import { runWrkqLedgerTail } from '../mail-kicker-handlers.js'
import {
  INVOCATION_ID,
  envelope as brokerEnvelope,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { captureServerLog } from './fixtures/mail-kicker-harness.js'

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07890/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07890'
const RUNTIME_ID = 'rt-t07890-busy'
const INPUT_ID = 'input-t07890-queued'
const REASON = 'envelope_acked_before_injection'

type WithdrawOutcome =
  | { outcome: 'withdrawn' }
  | { outcome: 'not_held'; state: 'accepted' | 'terminal' }
  | { outcome: 'unknown' }

type TailServer = {
  hrcMailKickerEnabled: boolean
  stopping: boolean
  wrkqLedgerTailInFlight: Promise<void> | undefined
  mailKickerColdStartCatchupPending: boolean
  db: HrcDatabase
  wrkqLedger: FakeWrkqLedger
  getHarnessBrokerController(): {
    withdraw(input: {
      runtimeId: string
      envelopeId: string
      reason: string
    }): Promise<{ ok: true; response: WithdrawOutcome }>
  }
  requestMailKickerWake(target: string, reason: string): void
}

describe('T-07890 queued injection withdrawal', () => {
  let dir: string
  let db: HrcDatabase
  let ledger: FakeWrkqLedger
  let withdrawOutcome: WithdrawOutcome
  let withdrawCalls: Array<{ runtimeId: string; envelopeId: string; reason: string }>
  let wakes: Array<{ target: string; reason: string }>
  let server: TailServer

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 't07890-kicker-'))
    db = openHrcDatabase(join(dir, 'state.sqlite'))
    ledger = new FakeWrkqLedger()
    withdrawOutcome = { outcome: 'withdrawn' }
    withdrawCalls = []
    wakes = []
    server = {
      hrcMailKickerEnabled: true,
      stopping: false,
      wrkqLedgerTailInFlight: undefined,
      mailKickerColdStartCatchupPending: false,
      db,
      wrkqLedger: ledger,
      getHarnessBrokerController: () => ({
        withdraw: async (input) => {
          withdrawCalls.push(input)
          return { ok: true as const, response: withdrawOutcome }
        },
      }),
      requestMailKickerWake: (target, reason) => wakes.push({ target, reason }),
    }
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function runTail(): Promise<void> {
    await runWrkqLedgerTail.call(server as never)
  }

  function recordQueueEnqueued(seq = 1): void {
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inv-t07890',
      seq,
      time: new Date().toISOString(),
      type: 'queue.enqueued',
      runtimeId: RUNTIME_ID,
      payload: { submissionId: INPUT_ID, class: 'queue', position: 0 },
    })
  }

  async function seedQueuedAttempt(): Promise<{
    envelopeId: string
    attempt: HrcMailDriveAttempt
  }> {
    const envelope = ledger.say({
      toScopeRef: SCOPE,
      fromScopeRef: 'mable@hcs:fixall',
      roomKey: 'T-07890',
    })
    const attempt = db.mailDrives.insertQueuedAttempt({
      targetSessionRef: TARGET,
      runId: 'run-t07890-queued',
      wakeReason: 'insert',
      prompt: 'queued presentation',
      envelopeIds: [envelope.id],
      queuedBehindRunId: 'run-t07890-foreground',
      hostSessionId: 'hsid-t07890',
      generation: 1,
      runtimeId: RUNTIME_ID,
    })
    await ledger.present({
      envelope: envelope.id,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      runtimeId: RUNTIME_ID,
      hostSessionId: 'hsid-t07890',
      generation: '1',
      inputId: INPUT_ID,
      deliveryOutcome: 'queued_to_live_harness',
    })
    recordQueueEnqueued()
    // Event 1 is envelope.created. The ack is the first unread row.
    db.wrkqLedgerCursors.advance(1)
    ledger.ack(envelope.id)
    return { envelopeId: envelope.id, attempt }
  }

  it('withdraws acked-before-accept input, terminals its attempt, and emits no wake', async () => {
    const { envelopeId, attempt } = await seedQueuedAttempt()

    const captured = await captureServerLog(async () => runTail())

    expect(withdrawCalls).toEqual([{ runtimeId: RUNTIME_ID, envelopeId, reason: REASON }])
    expect(db.mailDrives.getAttempt(attempt.driveAttemptId)).toMatchObject({
      state: 'withdrawn',
      lastError: REASON,
    })
    expect(wakes).toEqual([])
    expect(
      captured.lines.some(
        (line) =>
          line.includes('wrkq.kicker.queued_injection_withdrawn') &&
          line.includes(envelopeId) &&
          line.includes(INPUT_ID)
      )
    ).toBe(true)
  })

  it('drops an acked HRC-held member locally without calling broker withdrawal', async () => {
    const envelope = ledger.say({ toScopeRef: SCOPE, roomKey: 'T-07891' })
    const held = db.mailDrives.holdQueuedAttempt(
      {
        targetSessionRef: TARGET,
        wakeReason: 'insert',
        envelopeIds: [envelope.id],
        heldBehindTurnId: 'turn-human-typed',
        hostSessionId: 'hsid-t07890',
        generation: 1,
        runtimeId: RUNTIME_ID,
      },
      20
    ).attempt
    db.wrkqLedgerCursors.advance(1)
    ledger.ack(envelope.id)

    const captured = await captureServerLog(async () => runTail())

    expect(withdrawCalls).toEqual([])
    expect(wakes).toEqual([])
    expect(db.mailDrives.getAttempt(held.driveAttemptId)).toMatchObject({
      state: 'withdrawn',
      presentedCount: 0,
      lastError: REASON,
    })
    expect(
      captured.lines.some(
        (line) =>
          line.includes('wrkq.kicker.held_member_acked') &&
          line.includes(envelope.id) &&
          line.includes('"brokerWithdrawCalled":false')
      )
    ).toBe(true)
  })

  it('does not withdraw after input.accepted is durable for that runtime and input', async () => {
    const { attempt } = await seedQueuedAttempt()
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inv-t07890',
      seq: 2,
      time: new Date().toISOString(),
      type: 'input.accepted',
      runtimeId: RUNTIME_ID,
      payload: { inputId: INPUT_ID },
    })

    await runTail()

    expect(withdrawCalls).toEqual([])
    expect(db.mailDrives.getAttempt(attempt.driveAttemptId)?.state).toBe('claimed')
  })

  it('leaves a not-held attempt untouched and logs the accepted race', async () => {
    withdrawOutcome = { outcome: 'not_held', state: 'accepted' }
    const { attempt } = await seedQueuedAttempt()

    const captured = await captureServerLog(async () => runTail())

    expect(withdrawCalls).toHaveLength(1)
    expect(db.mailDrives.getAttempt(attempt.driveAttemptId)?.state).toBe('claimed')
    expect(
      captured.lines.some(
        (line) =>
          line.includes('wrkq.kicker.queued_injection_withdraw_skipped') &&
          line.includes('"outcome":"not_held"') &&
          line.includes('"state":"accepted"')
      )
    ).toBe(true)
  })

  it('ignores an acked ordinary idle-path presentation', async () => {
    const envelope = ledger.say({ toScopeRef: SCOPE, roomKey: 'T-07890' })
    const claim = db.mailDrives.claim(
      TARGET,
      'insert',
      { envelopeIds: [envelope.id] },
      { driveAttemptId: 'drive-t07890-idle', runId: 'run-t07890-idle' }
    )
    if (claim.outcome !== 'acquired') throw new Error('failed to seed ordinary drive')
    db.mailDrives.presentForAttempt(claim.attempt.driveAttemptId, [envelope.id])
    await ledger.present({
      envelope: envelope.id,
      driveAttemptId: claim.attempt.driveAttemptId,
      runtimeId: RUNTIME_ID,
      inputId: INPUT_ID,
    })
    db.wrkqLedgerCursors.advance(1)
    ledger.ack(envelope.id)

    await runTail()

    expect(withdrawCalls).toEqual([])
    expect(db.mailDrives.getAttempt(claim.attempt.driveAttemptId)?.state).toBe('claimed')
  })

  it('withdraws an ordinary claimed attempt when the broker proves it queued', async () => {
    const envelope = ledger.say({ toScopeRef: SCOPE, roomKey: 'T-07890' })
    const claim = db.mailDrives.claim(
      TARGET,
      'insert',
      { envelopeIds: [envelope.id] },
      { driveAttemptId: 'drive-t07890-interactive', runId: 'run-t07890-interactive' }
    )
    if (claim.outcome !== 'acquired') throw new Error('failed to seed interactive drive')
    db.mailDrives.presentForAttempt(claim.attempt.driveAttemptId, [envelope.id])
    await ledger.present({
      envelope: envelope.id,
      driveAttemptId: claim.attempt.driveAttemptId,
      runtimeId: RUNTIME_ID,
      inputId: INPUT_ID,
    })
    recordQueueEnqueued()
    db.wrkqLedgerCursors.advance(1)
    ledger.ack(envelope.id)

    await runTail()

    expect(withdrawCalls).toEqual([
      { runtimeId: RUNTIME_ID, envelopeId: envelope.id, reason: REASON },
    ])
    expect(db.mailDrives.getAttempt(claim.attempt.driveAttemptId)).toMatchObject({
      state: 'withdrawn',
      lastError: REASON,
    })
  })

  it('leaves a queued fyi for boundary presentation when its own presentation auto-acks it', async () => {
    const envelope = ledger.say({
      toScopeRef: SCOPE,
      roomKey: 'T-07890',
      obligation: 'fyi',
    })
    const attempt = db.mailDrives.insertQueuedAttempt({
      targetSessionRef: TARGET,
      runId: 'run-t07890-fyi',
      wakeReason: 'insert',
      prompt: 'queued fyi',
      envelopeIds: [envelope.id],
      queuedBehindRunId: 'run-t07890-foreground',
      hostSessionId: 'hsid-t07890',
      generation: 1,
      runtimeId: RUNTIME_ID,
    })
    await ledger.present({
      envelope: envelope.id,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      runtimeId: RUNTIME_ID,
      inputId: INPUT_ID,
      deliveryOutcome: 'queued_to_live_harness',
    })
    recordQueueEnqueued()
    db.wrkqLedgerCursors.advance(1)
    ledger.ack(envelope.id, 'fyi_presented')

    await runTail()

    expect(withdrawCalls).toEqual([])
    expect(db.mailDrives.getAttempt(attempt.driveAttemptId)?.state).toBe('claimed')
  })

  it('still wakes on envelope.created from the existing persisted cursor', async () => {
    db.wrkqLedgerCursors.advance(0)
    ledger.say({ toScopeRef: SCOPE, roomKey: 'T-07890', obligation: 'reply_required' })

    await runTail()

    expect(wakes).toEqual([{ target: TARGET, reason: 'insert' }])
    expect(withdrawCalls).toEqual([])
  })
})

describe('T-07890 broker withdrawal event classification', () => {
  it('routes the envelope selector through the active broker controller client', async () => {
    const fixture = await makeSeededFixture()
    try {
      const requests: unknown[] = []
      const controller = new HarnessBrokerController({ db: fixture.db })
      ;(
        controller as unknown as {
          active: Map<
            string,
            {
              runtimeId: string
              invocationId: string
              client: {
                withdraw(request: unknown): Promise<WithdrawOutcome>
              }
              closing: boolean
            }
          >
        }
      ).active.set(RUNTIME_ID, {
        runtimeId: RUNTIME_ID,
        invocationId: String(INVOCATION_ID),
        client: {
          withdraw: async (request) => {
            requests.push(request)
            return { outcome: 'withdrawn' }
          },
        },
        closing: false,
      })

      await expect(
        controller.withdraw({
          runtimeId: RUNTIME_ID,
          envelopeId: 'EN-07890',
          reason: REASON,
        })
      ).resolves.toEqual({ ok: true, response: { outcome: 'withdrawn' } })
      expect(requests).toEqual([{ envelopeId: 'EN-07890', reason: REASON }])
    } finally {
      await fixture.cleanup()
    }
  })

  it('persists both withdrawal event names for hrc monitor events', async () => {
    const fixture = await makeSeededFixture()
    try {
      const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
      mapper.apply(
        brokerEnvelope('queue.withdrawn', 60, {
          submissionId: 'submission-t07890',
          reason: REASON,
          position: 0,
        })
      )
      mapper.apply(
        brokerEnvelope('submission.withdrawn', 61, {
          submissionId: 'submission-t07890',
          reason: REASON,
        })
      )

      expect(
        fixture.db.brokerInvocationEvents
          .listByInvocationId(INVOCATION_ID)
          .filter((event) => event.seq >= 60)
          .map((event) => event.type)
      ).toEqual(['queue.withdrawn', 'submission.withdrawn'])
    } finally {
      await fixture.cleanup()
    }
  })
})
