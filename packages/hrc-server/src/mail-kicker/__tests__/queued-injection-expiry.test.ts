import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { FakeWrkqLedger } from '../../__tests__/fixtures/fake-wrkq-ledger.js'
import {
  type HrcServerTestFixture,
  createHrcTestFixture,
} from '../../__tests__/fixtures/hrc-test-fixture.js'
import { captureServerLog, serverInternals } from '../../__tests__/fixtures/mail-kicker-harness.js'
import { createHrcServer } from '../../index.js'
import type { HrcServer } from '../../index.js'
import type { WrkqEnvelope, WrkqEnvelopeFailParams } from '../../wrkq/ledger-types.js'
import { handleQueuedInjectionExpiry } from '../queued-injection-expiry.js'

const SCOPE = 'agent:expiry-unit:project:hrc-runtime:task:T-07891'
const TARGET = `${SCOPE}/lane:main`
const RUNTIME_ID = 'rt-expiry-unit'
const INVOCATION_ID = 'inv-expiry-unit'
const INPUT_ID = 'submission-expiry-unit'

/** Prospective wrkq contract required by Amendment 6; current wrkq rejects this transition. */
class PresentedUndeliverableLedger extends FakeWrkqLedger {
  override async fail(params: WrkqEnvelopeFailParams): Promise<WrkqEnvelope> {
    const envelope = this.envelopes.get(params.envelope)
    if (
      envelope !== undefined &&
      envelope.state === 'presented' &&
      params.reason === 'undeliverable'
    ) {
      this.failRequests.push({ ...params })
      envelope.state = 'failed'
      envelope.terminal = true
      envelope.failureReason = params.reason
      return envelope
    }
    return super.fail(params)
  }
}

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: PresentedUndeliverableLedger

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-queued-expiry-unit-')
  ledger = new PresentedUndeliverableLedger()
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

describe('mail-kicker queued injection expiry', () => {
  it('fails every receipted batch member undeliverable and warns once across both broker expiry events', async () => {
    const active = server as HrcServer
    const internals = serverInternals(active)
    const envelopes = [
      ledger.say({ toScopeRef: SCOPE, roomKey: 'T-07891', body: 'first' }),
      ledger.say({ toScopeRef: SCOPE, roomKey: 'T-07891', body: 'second' }),
    ]
    const claim = internals.db.mailDrives.claim(
      TARGET,
      'turn_completion',
      { envelopeIds: envelopes.map((envelope) => envelope.id) },
      { driveAttemptId: 'drive-expiry-unit', runId: 'run-expiry-unit' }
    )
    if (claim.outcome !== 'acquired') throw new Error('failed to claim expiry fixture')
    internals.db.mailDrives.presentForAttempt(
      claim.attempt.driveAttemptId,
      envelopes.map((envelope) => envelope.id)
    )
    for (const envelope of envelopes) {
      await ledger.present({
        envelope: envelope.id,
        runtimeId: RUNTIME_ID,
        inputId: INPUT_ID,
        runId: claim.attempt.runId,
        driveAttemptId: claim.attempt.driveAttemptId,
        deliveryOutcome: 'queued_to_live_harness',
      })
    }

    internals.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 1,
      time: new Date().toISOString(),
      type: 'admission.requested',
      runtimeId: RUNTIME_ID,
      payload: {
        submissionId: INPUT_ID,
        class: 'queue',
        origin: { principalRef: 'agent:mable', envelopeId: envelopes[0]?.id },
      },
    })
    const queueExpired = internals.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 2,
      time: new Date().toISOString(),
      type: 'queue.expired',
      runtimeId: RUNTIME_ID,
      payload: { submissionId: INPUT_ID },
    }).record
    const submissionExpired = internals.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 3,
      time: new Date().toISOString(),
      type: 'submission.expired',
      runtimeId: RUNTIME_ID,
      payload: { submissionId: INPUT_ID },
    }).record

    const captured = await captureServerLog(async () => {
      await Promise.all([
        handleQueuedInjectionExpiry(internals, queueExpired),
        handleQueuedInjectionExpiry(internals, submissionExpired),
      ])
    })

    expect(envelopes.map((envelope) => ledger.envelopes.get(envelope.id))).toEqual([
      expect.objectContaining({
        state: 'failed',
        failureReason: 'undeliverable',
      }),
      expect.objectContaining({
        state: 'failed',
        failureReason: 'undeliverable',
      }),
    ])
    expect(ledger.failRequests).toEqual(
      envelopes.map((envelope) => ({
        envelope: envelope.id,
        reason: 'undeliverable',
        runtime: RUNTIME_ID,
      }))
    )
    expect(
      captured.lines.filter((line) => line.includes('wrkq.kicker.queued_injection_expired'))
    ).toHaveLength(2)
    for (const envelope of envelopes) {
      expect(
        captured.lines.some(
          (line) =>
            line.includes('wrkq.kicker.queued_injection_expired') &&
            line.includes(`"envelopeId":"${envelope.id}"`) &&
            line.includes(`"runtimeId":"${RUNTIME_ID}"`) &&
            line.includes(`"inputId":"${INPUT_ID}"`)
        )
      ).toBe(true)
    }
    expect(internals.db.mailDrives.getAttempt(claim.attempt.driveAttemptId)).toMatchObject({
      state: 'failed',
    })
  })
})
