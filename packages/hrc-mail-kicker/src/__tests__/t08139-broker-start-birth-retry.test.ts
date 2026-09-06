import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcLifecycleEvent } from 'hrc-core'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { observeMailDriveLifecycleEvent } from '../controller.js'
import { unbornBirthWakeCandidates } from '../wake/birth-retry.js'
import { runMailKickerSweep } from '../wake/sweep.js'
import type { Recorded, T08094Harness } from './t08094-harness.js'
import {
  RUNTIME_ID as OLD_RUNTIME,
  SCOPE_REF as SCOPE,
  TARGET_REF as TARGET,
  createT08094Harness,
  deliverOneTo,
  destroyT08094Harness,
  seatIn,
} from './t08094-harness.js'

/**
 * T-08139 D2 — a delivery-driven broker birth that fails before landing must
 * remain visible to the periodic sweep even though the scope has a session and
 * a placement binding. The write-ahead intent is the causation record: it is
 * still open when the synchronous `turn.failed` lifecycle event is observed,
 * then the failed door clears it as an ordinary refusal.
 */

const FAILED_RUNTIME = 'rt-t08139-failed-replacement'

let harness: T08094Harness
let context: MailKickerContext
let logs: Recorded[]

beforeEach(async () => {
  harness = await createT08094Harness()
  ;({ context, logs } = harness)
})

afterEach(async () => {
  await destroyT08094Harness(harness)
})

function brokerStartFailedEvent(): HrcLifecycleEvent {
  return {
    hrcSeq: 81_139,
    streamSeq: 81_139,
    ts: new Date().toISOString(),
    hostSessionId: harness.session.hostSessionId,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: harness.session.generation,
    runtimeId: FAILED_RUNTIME,
    runId: 'run-t08139-failed-replacement',
    category: 'turn',
    eventKind: 'turn.failed',
    transport: 'tmux',
    replayed: false,
    payload: {
      code: 'broker_start_failed',
      message: 'thread already has an active writer',
      phase: 'broker-invocation-start',
    },
  }
}

describe('T-08139 D2 — broker-start failure returns a seated target to the sweep', () => {
  it('records the refused delivery and drives it with wakeReason periodic on the next sweep', async () => {
    // This is an already-established scope, not a virgin birth. The old
    // candidate filter treated this binding as proof that no retry was owed,
    // even after the runtime itself was gone.
    createPlacementLedgerRepository(harness.db.sqlite).installActive({
      scopeRef: SCOPE,
      homeNodeId: 'max3',
      updatedAt: new Date().toISOString(),
    })

    const envelope = harness.ledger.say({ body: 'delivery that triggers reprovision' })
    context = {
      ...context,
      dispatchTurn: async () => {
        const now = new Date().toISOString()
        harness.db.runtimes.update(OLD_RUNTIME, {
          status: 'stale',
          statusChangedAt: now,
          updatedAt: now,
        })
        harness.db.runtimes.insert({
          runtimeId: FAILED_RUNTIME,
          hostSessionId: harness.session.hostSessionId,
          scopeRef: SCOPE,
          laneRef: 'main',
          generation: harness.session.generation,
          transport: 'tmux',
          harness: 'codex-cli',
          provider: 'openai',
          status: 'failed',
          supportsInflightInput: true,
          adopted: false,
          createdAt: now,
          updatedAt: now,
        })
        observeMailDriveLifecycleEvent.call(context, brokerStartFailedEvent())
        throw new Error('interactive broker start failed')
      },
    }
    harness.context = context

    expect(await deliverOneTo(harness, seatIn('idle'), envelope)).toBe('refused')
    expect(harness.db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(harness.db.runtimes.listLiveSessionRefs()).not.toContain(TARGET)

    const refusal = harness.db.mailDelivery.getBirthRefusal(TARGET)
    expect(refusal?.lastReason).toContain(envelope.id)
    expect(refusal?.lastReason).toContain('broker-invocation-start')
    expect(
      logs.find((entry) => entry.event === 'wrkq.kicker.delivery_birth_refused')?.detail
    ).toMatchObject({
      targetSessionRef: TARGET,
      envelope: envelope.id,
      runtimeId: FAILED_RUNTIME,
      reason: 'broker-invocation-start',
    })

    expect(
      await unbornBirthWakeCandidates(context, harness.db.runtimes.listLiveSessionRefs())
    ).toContain(TARGET)

    const driven: Array<{ targetSessionRef: string; wakeReason: string | undefined }> = []
    context.drainTarget = async (targetSessionRef) => {
      driven.push({
        targetSessionRef,
        wakeReason: context.mailKickerPendingTargets.get(targetSessionRef),
      })
    }
    await runMailKickerSweep.call(context)
    expect(driven).toContainEqual({ targetSessionRef: TARGET, wakeReason: 'periodic' })
  })
})
