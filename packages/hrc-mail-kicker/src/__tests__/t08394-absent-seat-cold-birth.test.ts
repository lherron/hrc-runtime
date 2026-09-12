/**
 * An absent SEAT is a cold birth, not an enqueue (T-08394).
 *
 * `target-driver.ts` has always documented the rule — "seat absent -> cold
 * birth, and the launch carries the body" — but routed on the SESSION ROW, and
 * a row outlives every runtime. So only a scope that had never been seated took
 * the launch door; every returning seat fell to `deliverToSeat`, whose
 * `doorFor` has no `absent` branch and defaults to `enqueue`.
 *
 * The specimen (EN-10310): the enqueue submission was handed to the harness
 * 61ms after `invocation.ready`, into a claude-code TUI that had not mounted its
 * input. One second later the launch's own priming prompt took the first turn
 * and the mail was never executed — `broker.submission.stalled`,
 * `lastCompletedMilestone: handed_to_harness`. The envelope stayed `pending`
 * with an empty `presentedTo` and, because its intent stayed open, was
 * subtracted from every later wake set.
 *
 * Each case is paired with its control, because "the launch door was taken" is
 * also what a fixture that delivered nothing looks like.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { KickerDispatchOptions } from '../context.js'
import { driveMailTargetOnce } from '../drive/target-driver.js'
import {
  RUNTIME_ID,
  type T08094Harness,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

let h: T08094Harness

beforeEach(async () => {
  h = await createT08094Harness()
})

afterEach(async () => {
  await destroyT08094Harness(h)
})

function doors(): unknown[] {
  return h.logs
    .filter((entry) => entry.event === 'wrkq.kicker.delivery_intent')
    .map((entry) => (entry.detail as Record<string, unknown>)['door'])
}

/**
 * Give the fixture's session a live seat: the probe filters on an active
 * invocation, so a runtime row without one reads `absent` however healthy its
 * status looks.
 */
function seatTheRuntime(): void {
  const now = new Date().toISOString()
  h.db.brokerInvocations.insert({
    invocationId: 'inv-t08394',
    operationId: 'op-t08394',
    runtimeId: RUNTIME_ID,
    brokerProtocol: 'harness-broker/1',
    brokerDriver: 'claude-code-tmux',
    invocationState: 'ready',
    capabilitiesJson: JSON.stringify({ admission: { classes: ['queue'] } }),
    specHash: 'spec-t08394',
    startRequestHash: 'req-t08394',
    selectedProfileHash: 'profile-t08394',
    specProjectionJson: '{}',
    startRequestProjectionJson: '{}',
    lifecyclePolicyHash: 'policy-t08394',
    createdAt: now,
    updatedAt: now,
  })
  h.db.runtimes.update(RUNTIME_ID, {
    activeInvocationId: 'inv-t08394',
    controllerKind: 'harness-broker',
    updatedAt: now,
  })
  // The probe is the busy/idle authority; without a reachable one the seat reads
  // `unavailable` and nothing is delivered at all.
  h.context.broker.seatProbe = async () =>
    ({ ok: true, response: { seat: { state: 'idle' } } }) as never
}

describe('T-08394 — the seat decides the door, not the session row', () => {
  it('takes the launch door when the session row outlives its runtime', async () => {
    const envelope = h.ledger.say()
    await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    // The row is present and `findTargetSession` returns it -- this is exactly
    // the case that used to reach `enqueue`.
    expect(h.context.findTargetSession(TARGET_REF)).toBeDefined()
    expect(doors()).toEqual(['launch'])

    // The launch CARRIES the body. Without this the birth runs the agent's
    // priming prompt as its first turn and the mail races a booting harness.
    const [options] = h.dispatches as KickerDispatchOptions[]
    expect(options?.launchPromptOnColdBirth).toBe(true)
    expect(options?.submissionDoor).toBe('invoke')

    // The intent binds to the runtime the launch produced, so the reconcile can
    // reach it. The stranded specimen had no runtimeId at all, which is why
    // every recovery branch in `reconcileIntent` skipped straight past it.
    expect(h.db.mailDelivery.getIntent(envelope.id)?.runtimeId).toBeDefined()
  })

  it('CONTROL: a seat with a live invocation still takes an ordinary door', async () => {
    seatTheRuntime()
    h.ledger.say()
    await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    expect(doors()).toEqual(['enqueue'])
    const [options] = h.dispatches as KickerDispatchOptions[]
    expect(options?.launchPromptOnColdBirth).toBeUndefined()
  })

  /**
   * §5 says a non-summoning envelope is never the reason a session is BORN —
   * which is not the same as saying it is never delivered.
   *
   * The session row here already exists, so delivering a fyi into it provisions
   * a runtime for a session nobody had to mint. Reading "never births" as "takes
   * no door" is what silently stopped fyi delivery to driven targets with an
   * existing session and an absent broker in 70e683c7; the T-07615 suite caught
   * it and this asserts the distinction the fix restores.
   */
  it('a fyi takes the ordinary door on an absent seat, never the launch door', async () => {
    h.ledger.say({ obligation: 'fyi' })
    await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    // Delivered — but NOT launch-carried, because no session was minted for it.
    expect(doors()).toEqual(['enqueue'])
    expect(h.dispatches).toHaveLength(1)
    expect((h.dispatches[0] as KickerDispatchOptions).launchPromptOnColdBirth).toBeUndefined()
  })

  it('a fyi riding alongside a summons does not stop the summons cold-birthing', async () => {
    h.ledger.say({ obligation: 'fyi' })
    h.ledger.say()
    await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    expect(doors()).toEqual(['launch'])
  })
})
