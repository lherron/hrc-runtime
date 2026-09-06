import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcSessionRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import type { KickerDispatchOptions, KickerDispatchResult } from '../contracts.js'
import { confirmStranded } from '../diagnostics/stranded.js'
import { deliverToSeat } from '../drive/delivery.js'
import { observeBrokerLanding } from '../drive/landing.js'
import { readActionableEnvelopes } from '../drive/presentation.js'
import { reconcileOpenIntents } from '../drive/reconcile.js'
import type { ObservedBrokerSeat } from '../drive/seat.js'
import { observeBrokerSeat, runtimeAdvertisesSteer } from '../drive/seat.js'
import { driveMailTargetOnce } from '../drive/target-driver.js'
import { KICKER_SUBMISSION_TTL_MS } from '../internal.js'
import type {
  WrkqEnvelope,
  WrkqEnvelopePendingView,
  WrkqEnvelopePresentParams,
  WrkqEnvelopePresentResult,
} from '../ledger/types.js'
import { disposeRuntimeObligations } from '../terminal/disposal.js'

/**
 * T-08094 / spec T-08092 rev 4 — the four laws D2 and D3 add, in unit form.
 *
 * Each of these is a property the drive attempt could not express, so none of
 * them had a test before:
 *
 *  1. WRITE-AHEAD — the intent exists before the door is called, and an
 *     envelope with an open intent is never actionable.
 *  2. LANDING, NOT ADMISSION — a receipt is written only when the committed
 *     broker stream reports the body joined or originated a turn.
 *  3. REFUSAL IS NOT FAILURE — a rejected or lost submission clears the record
 *     and re-wakes; the envelope stays `pending`.
 *  4. DISPOSAL BY RUNTIME AND SEQUENCE — a turn terminal on the runtime arms
 *     one reminder, and a terminal after the reminder landed strikes out, with
 *     no run or turn identity anywhere in the decision.
 */

const SCOPE = 'agent:clod:project:hrc-runtime:task:T-08094'
const TARGET = `${SCOPE}/lane:main`
const RUNTIME = 'rt-t08094'
const HOST_SESSION = 'hsid-t08094'

type Recorded = { level: string; event: string; detail: Record<string, unknown> }

class FakeLedger {
  readonly envelopes = new Map<string, WrkqEnvelope>()
  readonly presentRequests: WrkqEnvelopePresentParams[] = []
  readonly failRequests: Array<{ envelope: string; reason: string }> = []
  private seq = 0

  say(overrides: Partial<WrkqEnvelope> = {}): WrkqEnvelope {
    this.seq += 1
    const id = `EN-${String(this.seq).padStart(5, '0')}`
    const now = new Date().toISOString()
    const envelope: WrkqEnvelope = {
      uuid: `uuid-${id}`,
      id,
      roomUuid: 'room-T-08094',
      roomKey: 'T-08094',
      roomKind: 'task',
      from: { principalRef: 'agent:chief', scopeRef: 'chief@hcs:T-07987' },
      to: { principalRef: 'agent:clod', scopeRef: SCOPE },
      obligation: 'reply_required',
      delivery: 'queue',
      body: 'the body',
      state: 'pending',
      terminal: false,
      presentedTo: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
    this.envelopes.set(id, envelope)
    return envelope
  }

  pendingView(): Promise<WrkqEnvelopePendingView> {
    const items = [...this.envelopes.values()].filter((envelope) => !envelope.terminal)
    return Promise.resolve({
      items,
      blocking: items.filter((item) => item.state === 'presented').map((item) => item.id),
      repended: 0,
    })
  }

  present(params: WrkqEnvelopePresentParams): Promise<WrkqEnvelopePresentResult> {
    const envelope = this.envelopes.get(params.envelope)
    if (envelope === undefined) throw new Error(`unknown envelope ${params.envelope}`)
    this.presentRequests.push(params)
    // wrkq refuses a presentation onto a discharged row, and the exact wire
    // error is what HRC keys the disposed-before-landing branch on.
    if (params.preview !== true && envelope.terminal) {
      throw new Error('wrong_state: envelope is terminal')
    }
    if (params.preview === true) {
      return Promise.resolve({ envelope, recorded: false, historyHint: false, messageCount: 1 })
    }
    // Exactly-once per presentation id, which is what makes a replayed landing
    // idempotent on the wrkq side.
    const already = envelope.presentedTo.some(
      (receipt) => receipt.driveAttemptId === params.driveAttemptId
    )
    if (!already) {
      envelope.presentedTo.push({
        memberRef: SCOPE,
        ...(params.runtimeId === undefined ? {} : { runtimeId: params.runtimeId }),
        ...(params.inputId === undefined ? {} : { inputId: params.inputId }),
        ...(params.driveAttemptId === undefined ? {} : { driveAttemptId: params.driveAttemptId }),
        ...(params.deliveryOutcome === undefined
          ? {}
          : { deliveryOutcome: params.deliveryOutcome }),
        presentedAt: new Date().toISOString(),
      })
      envelope.state = 'presented'
    }
    return Promise.resolve({
      envelope,
      recorded: !already,
      historyHint: false,
      messageCount: 1,
    })
  }

  fail(params: { envelope: string; reason: string }): Promise<WrkqEnvelope> {
    const envelope = this.envelopes.get(params.envelope)
    if (envelope === undefined) throw new Error(`unknown envelope ${params.envelope}`)
    this.failRequests.push({ envelope: params.envelope, reason: params.reason })
    envelope.state = 'failed'
    envelope.terminal = true
    envelope.failureReason = params.reason as WrkqEnvelope['failureReason']
    return Promise.resolve(envelope)
  }

  envelopeShow(params: { envelope: string }): Promise<WrkqEnvelope> {
    const envelope = this.envelopes.get(params.envelope)
    if (envelope === undefined) throw new Error(`unknown envelope ${params.envelope}`)
    return Promise.resolve(envelope)
  }

  eventsView(): Promise<{ items: never[]; highWater: number }> {
    return Promise.resolve({ items: [], highWater: 0 })
  }
}

let dir: string
let db: HrcDatabase
let ledger: FakeLedger
let logs: Recorded[]
let wakes: string[]
let dispatches: KickerDispatchOptions[]
let dispatchResult: () => KickerDispatchResult
let context: MailKickerContext
let session: HrcSessionRecord

function seatIn(
  state: 'turn-active' | 'idle' | 'turn-observed',
  steerCapable = true
): ObservedBrokerSeat {
  if (state === 'turn-active') {
    return { state, runtimeId: RUNTIME, turnId: 'turn-1', steerCapable }
  }
  if (state === 'turn-observed') return { state, runtimeId: RUNTIME, turnId: 'turn-1' }
  return { state, runtimeId: RUNTIME }
}

function brokerRecord(type: string, payload: Record<string, unknown>) {
  return {
    invocationId: 'inv-t08094',
    seq: 1,
    time: new Date().toISOString(),
    type,
    runtimeId: RUNTIME,
    brokerEventJson: JSON.stringify(payload),
    projectionStatus: 'projected',
    createdAt: new Date().toISOString(),
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 't08094-kicker-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  ledger = new FakeLedger()
  logs = []
  wakes = []
  dispatches = []
  dispatchResult = () =>
    ({
      submissionId: 'sub-1',
      admission: 'admitted',
      runId: 'run-ignored',
      hostSessionId: HOST_SESSION,
      generation: 1,
      runtimeId: RUNTIME,
      transport: 'headless',
      stage: 'accepted',
      status: 'started',
      replayed: false,
      supportsInFlightInput: false,
      observation: {
        lifecycle: { selector: { runId: 'run-ignored', generation: 1 }, fromSeq: 0 },
      },
    }) as KickerDispatchResult

  const now = new Date().toISOString()
  db.sessions.insert({
    hostSessionId: HOST_SESSION,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME,
    hostSessionId: HOST_SESSION,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'busy',
    supportsInflightInput: true,
    adopted: false,
    createdAt: now,
    updatedAt: now,
  })
  const stored = db.sessions.getByHostSessionId(HOST_SESSION)
  if (stored === null) throw new Error('fixture session missing')
  session = stored

  context = {
    db,
    ledger: ledger as unknown as MailKickerContext['ledger'],
    nodeId: 'max3',
    registry: undefined,
    foreignHomeMemo: new Map(),
    broker: {
      seatProbe: async () => ({ ok: false, error: { message: 'not used' } }),
      withdraw: async () => ({ ok: false, error: { message: 'not used' } }),
    },
    enabled: true,
    sweepIntervalMs: 60_000,
    stopping: false,
    mailKickerSweepTimer: undefined,
    mailKickerSweepInFlight: undefined,
    wrkqLedgerTailInFlight: undefined,
    mailKickerColdStartCatchupPending: false,
    mailKickerPendingTargets: new Map(),
    mailKickerTargetOperations: new Map(),
    mailKickerForeignHomeAnnounced: new Map(),
    mailKickerBirthDeferredAnnounced: new Map(),
    mailKickerBirthSweepBackoff: new Map(),
    mailKickerLapsedRuntimes: new Set(),
    mailKickerDisposalsPending: new Set(),
    mailKickerBootReconcilePending: false,
    mailKickerStalledDeliveryAnnounced: new Set(),
    mailKickerSteerRefused: new Set(),
    mailKickerDeliveryBackoff: new Map(),
    resolveForeignHome: async () => undefined,
    resolveRuntimeIntent: () => ({}) as never,
    findTargetSession: () => session,
    ensureTargetSession: async () => session,
    dispatchTurn: async (_session, _intent, _prompt, options) => {
      dispatches.push(options)
      return dispatchResult()
    },
    preemptAuthorized: async () => false,
    log: (level, event, detail) => logs.push({ level, event, detail }),
    wake: (target) => wakes.push(target),
    drainTarget: async () => undefined,
    runSweepOnce: async () => undefined,
    runTailOnce: async () => undefined,
    observeLifecycleEvent: () => undefined,
    observeBrokerEvent: () => undefined,
  }
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

async function deliverOne(seat: ObservedBrokerSeat, envelope: WrkqEnvelope) {
  const actionable = await readActionableEnvelopes(context, TARGET)
  const item = actionable.find((candidate) => candidate.envelope.id === envelope.id)
  if (item === undefined) throw new Error(`${envelope.id} was not actionable`)
  return deliverToSeat(context, TARGET, session, seat, item, 'insert')
}

describe('D2 — steer first, and the door is chosen by what the seat is doing', () => {
  it('holds mail while an observed Codex turn awaits ownership attribution', async () => {
    const envelope = ledger.say()
    const now = new Date().toISOString()
    db.brokerInvocations.insert({
      invocationId: 'inv-observed',
      operationId: 'op-observed',
      runtimeId: RUNTIME,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'turn_active',
      capabilitiesJson: JSON.stringify({ bracketMintingMode: 'observed' }),
      specHash: 'spec-observed',
      startRequestHash: 'request-observed',
      selectedProfileHash: 'profile-observed',
      createdAt: now,
      updatedAt: now,
    })
    db.runtimes.update(RUNTIME, {
      controllerKind: 'harness-broker',
      activeInvocationId: 'inv-observed',
      updatedAt: now,
    })
    context = {
      ...context,
      broker: {
        ...context.broker,
        seatProbe: async () => ({
          ok: true,
          response: {
            invocationId: 'inv-observed' as never,
            seat: { state: 'turn-observed', turnId: 'turn-human' as never },
            brokerHeldDepth: 0,
          },
        }),
      },
    }

    expect(await observeBrokerSeat(context, session)).toEqual({
      state: 'turn-observed',
      runtimeId: RUNTIME,
      turnId: 'turn-human',
    })
    await driveMailTargetOnce(context, TARGET, 'insert')

    expect(dispatches).toEqual([])
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    expect(db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(logs.at(-1)).toMatchObject({
      event: 'wrkq.kicker.seat_not_ready',
      detail: { observedSeatState: 'turn-observed' },
    })
  })

  it('steers into a turn-active seat whose driver advertises the class', async () => {
    const envelope = ledger.say()
    expect(await deliverOne(seatIn('turn-active', true), envelope)).toBe('submitted')
    expect(dispatches[0]?.submissionDoor).toBe('steer')
    expect(dispatches[0]?.submissionOrigin.envelopeId).toBe(envelope.id)
  })

  it('enqueues into a turn-active seat whose driver does not', async () => {
    const envelope = ledger.say()
    expect(await deliverOne(seatIn('turn-active', false), envelope)).toBe('submitted')
    expect(dispatches[0]?.submissionDoor).toBe('enqueue')
  })

  it('enqueues into an idle seat, as before', async () => {
    const envelope = ledger.say()
    expect(await deliverOne(seatIn('idle'), envelope)).toBe('submitted')
    expect(dispatches[0]?.submissionDoor).toBe('enqueue')
  })

  it('reads the steer class off the frozen broker hello, never off driver code', () => {
    expect(runtimeAdvertisesSteer(context, RUNTIME)).toBe(false)
    const invocationId = 'inv-caps'
    const now = new Date().toISOString()
    db.brokerInvocations.insert({
      invocationId,
      operationId: 'op-caps',
      runtimeId: RUNTIME,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'claude-code-tmux',
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({ admission: { classes: ['steer', 'queue'] } }),
      specHash: 'spec',
      startRequestHash: 'sr',
      selectedProfileHash: 'pf',
      createdAt: now,
      updatedAt: now,
    })
    db.runtimes.update(RUNTIME, { activeInvocationId: invocationId, updatedAt: now })
    expect(runtimeAdvertisesSteer(context, RUNTIME)).toBe(true)
  })
})

describe('D2 — write-ahead, and presentation only on a landing fact', () => {
  it('commits the intent BEFORE the door and writes no receipt on admission', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)

    const intent = db.mailDelivery.getIntent(envelope.id)
    expect(intent).toMatchObject({ door: 'steer', submissionId: 'sub-1', runtimeId: RUNTIME })
    // The ORDER is the property: the intent line is written before the door is
    // called, so a crash from that moment on leaves durable intent.
    const events = logs.map((entry) => entry.event)
    expect(events.indexOf('wrkq.kicker.delivery_intent')).toBeLessThan(
      events.indexOf('wrkq.kicker.delivery_admitted')
    )
    // Admission is not presentation: the only wrkq call so far is the preview.
    expect(ledger.presentRequests.filter((request) => request.preview !== true)).toEqual([])
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
  })

  it('makes an envelope with an open intent unactionable', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)

    const actionable = await readActionableEnvelopes(context, TARGET)
    expect(actionable.map((item) => item.envelope.id)).not.toContain(envelope.id)
    // And a second delivery attempt for the same envelope is refused by the
    // primary key rather than by anything this process remembers.
    const second = db.mailDelivery.openIntent({
      envelopeId: envelope.id,
      targetSessionRef: TARGET,
      door: 'enqueue',
      form: 'full',
      presentationId: 'present-second',
      submittedHrcSeq: 0,
    })
    expect(second).toBeUndefined()
  })

  it('presents on submission.absorbed and closes the intent', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)
    await observeBrokerLanding(
      context,
      brokerRecord('submission.absorbed', { submissionId: 'sub-1', turnId: 'turn-1' })
    )

    const row = ledger.envelopes.get(envelope.id)
    expect(row?.state).toBe('presented')
    expect(row?.presentedTo).toHaveLength(1)
    expect(row?.presentedTo[0]).toMatchObject({ deliveryOutcome: 'steered', runtimeId: RUNTIME })
    // No run identity anywhere on the receipt.
    expect(row?.presentedTo[0]?.runId).toBeUndefined()
    expect(db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(db.mailDelivery.getPresentation(envelope.id, RUNTIME)?.deliveryOutcome).toBe('steered')
  })

  it('presents on submission.executed as `executed`', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('idle'), envelope)
    await observeBrokerLanding(
      context,
      brokerRecord('submission.executed', { submissionId: 'sub-1', turnId: 'turn-2' })
    )
    expect(ledger.envelopes.get(envelope.id)?.presentedTo[0]?.deliveryOutcome).toBe('executed')
  })
})

describe('D2 — a refused submission is not a failed envelope', () => {
  it('clears the record, re-wakes, and leaves the envelope pending', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)
    wakes.length = 0

    await observeBrokerLanding(
      context,
      brokerRecord('submission.rejected', { submissionId: 'sub-1', reason: 'steer_not_supported' })
    )

    expect(db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    expect(ledger.failRequests).toEqual([])
    // A capability refusal re-wakes immediately; the next pass takes enqueue.
    // (A TRANSIENT refusal re-wakes on a backoff instead — its own tests below.)
    expect(wakes).toEqual([TARGET])
    expect(logs.some((entry) => entry.event === 'wrkq.kicker.landing_refused')).toBe(true)
    // Actionable again, so the next pass re-delivers under the same policy.
    const actionable = await readActionableEnvelopes(context, TARGET)
    expect(actionable.map((item) => item.envelope.id)).toContain(envelope.id)
  })

  /**
   * The refusal CLASS decides the next door, and the default is transient.
   *
   * `pane_not_quiescent` fires whenever a human is mid-word in the pane — the
   * routine case on a tab seat somebody is sitting at. Treating it as a fact
   * about the seat's capability would degrade that runtime to enqueue for the
   * life of the daemon and defeat steer-first on exactly those seats.
   */
  async function refuseSteer(
    envelope: WrkqEnvelope,
    input: { reason: string; layer?: string | undefined }
  ): Promise<void> {
    if (input.layer !== undefined) {
      db.brokerInvocationEvents.appendEvent({
        invocationId: 'inv-t08094',
        seq: 100,
        time: new Date().toISOString(),
        type: 'admission.rejected',
        runtimeId: RUNTIME,
        payload: {
          submissionId: 'sub-1',
          class: 'steer',
          layer: input.layer,
          reason: input.reason,
        },
      })
    }
    await observeBrokerLanding(
      context,
      brokerRecord('submission.rejected', { submissionId: 'sub-1', reason: input.reason })
    )
    // The envelope must be deliverable again either way; what differs is the
    // DOOR the next pass takes.
    const actionable = await readActionableEnvelopes(context, TARGET)
    expect(actionable.map((item) => item.envelope.id)).toContain(envelope.id)
    dispatches.length = 0
  }

  it('retries STEER after a transient refusal, on a bounded backoff', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active', true), envelope)
    await refuseSteer(envelope, { reason: 'pane_not_quiescent' })

    expect(context.mailKickerSteerRefused.has(RUNTIME)).toBe(false)
    expect(context.mailKickerDeliveryBackoff.get(RUNTIME)).toBe(2_000)
    const refused = logs.find((entry) => entry.event === 'wrkq.kicker.landing_refused')
    expect(refused?.detail).toMatchObject({ refusalClass: 'transient', retryInMs: 2_000 })

    // The door that will work in a moment is the right door.
    expect(await deliverOne(seatIn('turn-active', true), envelope)).toBe('submitted')
    expect(dispatches[0]?.submissionDoor).toBe('steer')
  })

  it('paces a door that THREW on the same backoff, so no refusal path is unpaced', async () => {
    const envelope = ledger.say()
    const realDispatch = context.dispatchTurn
    context = {
      ...context,
      dispatchTurn: async () => {
        throw new Error('server turn admission is closed for a drained restart')
      },
    }
    expect(await deliverOne(seatIn('turn-active'), envelope)).toBe('refused')
    // The drain window spun five submissions in a second without this.
    expect(context.mailKickerDeliveryBackoff.get(RUNTIME)).toBe(2_000)
    expect(db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    const failed = logs.find((entry) => entry.event === 'wrkq.kicker.delivery_failed')
    expect(failed?.detail).toMatchObject({ retryInMs: 2_000 })
    context = { ...context, dispatchTurn: realDispatch }
  })

  it('doubles the transient backoff to a ceiling, and clears it on a landing', async () => {
    const envelope = ledger.say()
    for (const expected of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await deliverOne(seatIn('turn-active', true), envelope)
      await refuseSteer(envelope, { reason: 'pane_not_quiescent' })
      expect(context.mailKickerDeliveryBackoff.get(RUNTIME)).toBe(expected)
    }

    // A seat that starts accepting steers again pays nothing for the interval
    // it did not.
    await deliverOne(seatIn('turn-active', true), envelope)
    await observeBrokerLanding(
      context,
      brokerRecord('submission.absorbed', { submissionId: 'sub-1', turnId: 'turn-1' })
    )
    expect(context.mailKickerDeliveryBackoff.has(RUNTIME)).toBe(false)
  })

  it('falls to ENQUEUE only when the refusal is a capability fact', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active', true), envelope)
    await refuseSteer(envelope, { reason: 'steer_not_supported' })

    expect(context.mailKickerSteerRefused.has(RUNTIME)).toBe(true)
    expect(context.mailKickerDeliveryBackoff.has(RUNTIME)).toBe(false)
    expect(await deliverOne(seatIn('turn-active', true), envelope)).toBe('submitted')
    expect(dispatches[0]?.submissionDoor).toBe('enqueue')
  })

  it('reads the capability verdict off the admission LAYER, not the reason text', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active', true), envelope)
    // A reason string this code has never seen, refused at the capability
    // layer. The layer is the fact; the vocabulary is the broker's to change.
    await refuseSteer(envelope, { reason: 'driver-said-no', layer: 'capability' })

    expect(context.mailKickerSteerRefused.has(RUNTIME)).toBe(true)
    expect(await deliverOne(seatIn('turn-active', true), envelope)).toBe('submitted')
    expect(dispatches[0]?.submissionDoor).toBe('enqueue')
  })

  it('treats a state-layer refusal as the transient moment it is', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active', true), envelope)
    // `busy`, `invalid-state:*`, `guarded` — all true about the instant and
    // false a second later.
    await refuseSteer(envelope, { reason: 'busy', layer: 'state' })

    expect(context.mailKickerSteerRefused.has(RUNTIME)).toBe(false)
    expect(await deliverOne(seatIn('turn-active', true), envelope)).toBe('submitted')
    expect(dispatches[0]?.submissionDoor).toBe('steer')
  })

  /**
   * The reader answered FASTER than the landing was committed.
   *
   * Found live by chief on the activated daemon: three envelopes `acked` in
   * wrkq with no receipt, whose intents stayed open and retried the commit once
   * per sweep — 54 `wrong_state` lines before anyone looked. The delivery
   * happened and the obligation is already discharged, so there is nothing to
   * record and nothing to retry.
   */
  it('closes the intent when the envelope was discharged before the landing committed', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)

    // The reader replies mid-turn; wrkq terminalises the row.
    const row = ledger.envelopes.get(envelope.id)
    if (row === undefined) throw new Error('missing row')
    row.state = 'acked'
    row.terminal = true

    await observeBrokerLanding(
      context,
      brokerRecord('submission.absorbed', { submissionId: 'sub-1', turnId: 'turn-1' })
    )

    expect(db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])
    const line = logs.find((entry) => entry.event === 'wrkq.kicker.disposed_before_landing')
    expect(line?.level).toBe('INFO')
    expect(logs.some((e) => e.event === 'wrkq.kicker.presentation_commit_failed')).toBe(false)

    // And it does not retry: a second reconcile has nothing left to do.
    expect(await reconcileOpenIntents(context, { reason: 'periodic' })).toMatchObject({
      landed: 0,
      disposed: 0,
      open: 0,
    })
  })

  it('counts a disposed-before-landing commit as disposed, never as landed', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)
    const row = ledger.envelopes.get(envelope.id)
    if (row === undefined) throw new Error('missing row')
    row.state = 'acked'
    row.terminal = true
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inv-t08094',
      seq: 200,
      time: new Date().toISOString(),
      type: 'submission.absorbed',
      runtimeId: RUNTIME,
      payload: { submissionId: 'sub-1', turnId: 'turn-1' },
    })

    // A counter that says `landed` about an envelope that got no receipt is a
    // counter that lies; the reconcile summary has to be readable as evidence.
    expect(await reconcileOpenIntents(context, { reason: 'daemon_start' })).toMatchObject({
      landed: 0,
      disposed: 1,
    })
  })

  it('reconciles a landing it never observed into exactly one receipt', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)
    // The daemon died here. The broker's own record is all that survives.
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inv-t08094',
      seq: 1,
      time: new Date().toISOString(),
      type: 'submission.absorbed',
      runtimeId: RUNTIME,
      payload: { submissionId: 'sub-1', turnId: 'turn-1' },
    })

    expect(await reconcileOpenIntents(context, { reason: 'daemon_start' })).toMatchObject({
      landed: 1,
    })
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)

    // Reconciling again is idempotent: the receipt carries the intent's own
    // presentation id and wrkq dedupes on it.
    await reconcileOpenIntents(context, { reason: 'periodic' })
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
  })

  it('clears an intent whose landing never arrives, after the TTL', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)

    expect(await reconcileOpenIntents(context, { reason: 'periodic' })).toMatchObject({ open: 1 })

    db.sqlite
      .query('UPDATE hrcmail_delivery_intents SET submitted_at = ? WHERE envelope_id = ?')
      .run(new Date(Date.now() - KICKER_SUBMISSION_TTL_MS - 1_000).toISOString(), envelope.id)
    expect(await reconcileOpenIntents(context, { reason: 'periodic' })).toMatchObject({
      expired: 1,
    })
    expect(db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
  })

  /**
   * The redelivery loop is BOUNDED (chief ruling 2026-09-06, addendum to
   * T-08092 §D2 step 5). A seat that cannot land is not a slow seat, and
   * retrying it every TTL forever tells the sender nothing while the envelope
   * sits pending — the observed case ran over twelve hours that way.
   */
  it('fails the envelope undeliverable after three TTL expiries on one runtime', async () => {
    const envelope = ledger.say()
    const age = () =>
      db.sqlite
        .query('UPDATE hrcmail_delivery_intents SET submitted_at = ? WHERE envelope_id = ?')
        .run(new Date(Date.now() - KICKER_SUBMISSION_TTL_MS - 1_000).toISOString(), envelope.id)

    for (const strike of [1, 2]) {
      await deliverOne(seatIn('turn-active'), envelope)
      age()
      expect(await reconcileOpenIntents(context, { reason: 'periodic' })).toMatchObject({
        expired: 1,
      })
      expect(db.mailDelivery.intentExpiries(envelope.id, RUNTIME)).toBe(strike)
      // Still pending and still deliverable: two strikes is not a verdict.
      expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
      expect(ledger.failRequests).toEqual([])
    }

    await deliverOne(seatIn('turn-active'), envelope)
    age()
    await reconcileOpenIntents(context, { reason: 'periodic' })
    expect(ledger.failRequests).toEqual([{ envelope: envelope.id, reason: 'undeliverable' }])
    expect(db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(logs.some((e) => e.event === 'wrkq.kicker.intent_expiries_exhausted')).toBe(true)
  })

  it('resets the expiry count on a NEW runtime, and on a successful landing', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)
    db.sqlite
      .query('UPDATE hrcmail_delivery_intents SET submitted_at = ? WHERE envelope_id = ?')
      .run(new Date(Date.now() - KICKER_SUBMISSION_TTL_MS - 1_000).toISOString(), envelope.id)
    await reconcileOpenIntents(context, { reason: 'periodic' })
    expect(db.mailDelivery.intentExpiries(envelope.id, RUNTIME)).toBe(1)

    // A different runtime is a different row: rotation and restart give the next
    // seat its full allowance without anyone having to remember a reset rule.
    expect(db.mailDelivery.intentExpiries(envelope.id, 'rt-rotated')).toBe(0)

    // And a landing means the seat CAN take deliveries, so the count goes.
    await deliverOne(seatIn('turn-active'), envelope)
    await observeBrokerLanding(
      context,
      brokerRecord('submission.absorbed', { submissionId: 'sub-1', turnId: 'turn-1' })
    )
    expect(db.mailDelivery.intentExpiries(envelope.id, RUNTIME)).toBe(0)
  })

  it('clears an intent bound to a runtime that terminated before landing', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)
    db.runtimes.updateStatus(RUNTIME, 'terminated', new Date().toISOString())

    expect(await reconcileOpenIntents(context, { reason: 'runtime_terminated' })).toMatchObject({
      runtime_gone: 1,
    })
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    expect(ledger.failRequests).toEqual([])
  })
})

describe('D3 — disposal is keyed by runtime and ledger sequence', () => {
  async function landOne(): Promise<WrkqEnvelope> {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)
    await observeBrokerLanding(
      context,
      brokerRecord('submission.absorbed', { submissionId: 'sub-1', turnId: 'turn-1' })
    )
    return envelope
  }

  function disposeAt(seq: number, kind = 'turn.completed'): Promise<void> {
    disposeRuntimeObligations(context, {
      runtimeId: RUNTIME,
      targetSessionRef: TARGET,
      terminalHrcSeq: seq,
      terminalEventKind: kind,
      turnEndedAt: new Date().toISOString(),
    })
    return Promise.all([...context.mailKickerDisposalsPending]).then(() => undefined)
  }

  it('arms ONE reminder when a turn on that runtime ends undisposed', async () => {
    const envelope = await landOne()
    const landing = db.mailDelivery.getPresentation(envelope.id, RUNTIME)?.landingHrcSeq ?? 0

    await disposeAt(landing + 10)
    const armed = db.mailDelivery.getPresentation(envelope.id, RUNTIME)
    expect(armed?.reminderArmedAt).toBeDefined()
    expect(ledger.failRequests).toEqual([])

    // A second terminal re-offers the same pair and must be a no-op.
    await disposeAt(landing + 20)
    expect(db.mailDelivery.getPresentation(envelope.id, RUNTIME)?.reminderArmedAt).toBe(
      armed?.reminderArmedAt as string
    )
    expect(ledger.failRequests).toEqual([])
  })

  it('does not arm for a body that landed at or after the terminal', async () => {
    const envelope = await landOne()
    const landing = db.mailDelivery.getPresentation(envelope.id, RUNTIME)?.landingHrcSeq ?? 0

    await disposeAt(landing)
    expect(db.mailDelivery.getPresentation(envelope.id, RUNTIME)?.reminderArmedAt).toBeUndefined()
  })

  it('fails as `ignored` once the reminder itself has landed and a turn ends after it', async () => {
    const envelope = await landOne()
    const landing = db.mailDelivery.getPresentation(envelope.id, RUNTIME)?.landingHrcSeq ?? 0
    await disposeAt(landing + 10)

    // The reminder is delivered through D2 like anything else, and ITS landing
    // sequence is what the next terminal is compared against.
    db.mailDelivery.recordReminderLanding(envelope.id, RUNTIME, landing + 20)

    await disposeAt(landing + 30)
    expect(ledger.failRequests).toEqual([{ envelope: envelope.id, reason: 'ignored' }])
    expect(db.mailDelivery.getPresentation(envelope.id, RUNTIME)?.disposition).toBe(
      'failed:ignored'
    )
  })

  it('disposes nothing for an envelope the reader has already answered', async () => {
    const envelope = await landOne()
    const row = ledger.envelopes.get(envelope.id)
    if (row === undefined) throw new Error('missing row')
    row.state = 'acked'
    row.terminal = true

    await disposeAt(9_999)
    expect(ledger.failRequests).toEqual([])
    expect(db.mailDelivery.getPresentation(envelope.id, RUNTIME)?.disposition).toContain(
      'skipped:not_presented'
    )
  })

  it('registers its disposal so a stop can drain it (T-07963, carried forward)', async () => {
    const envelope = await landOne()
    const landing = db.mailDelivery.getPresentation(envelope.id, RUNTIME)?.landingHrcSeq ?? 0

    // The registration is what `MailKicker.stop()` waits on. Before T-07963 the
    // disposal was fire-and-forget and a stop 28 ms later took the whole loop
    // with it — the 51 minutes of silence EN-03687 spent presented.
    disposeRuntimeObligations(context, {
      runtimeId: RUNTIME,
      targetSessionRef: TARGET,
      terminalHrcSeq: landing + 10,
      terminalEventKind: 'turn.completed',
      turnEndedAt: new Date().toISOString(),
    })
    expect(context.mailKickerDisposalsPending.size).toBe(1)
    await Promise.all([...context.mailKickerDisposalsPending])
    expect(context.mailKickerDisposalsPending.size).toBe(0)
    // And the decision it reached is DURABLE, so a stop that still beat the
    // drain would leave the reconcile a candidate rather than silence.
    expect(db.mailDelivery.getPresentation(envelope.id, RUNTIME)?.reminderArmedAt).toBeDefined()
  })

  /**
   * The boot report must not call a healthy in-flight obligation stranded.
   *
   * Found live by chief on the first minute of the activated daemon: the very
   * envelope that DROVE the running turn was reported `stranded` while its
   * runtime was `busy`. It is in that state for the whole turn by design, and an
   * alarm that fires on the healthy case is one its reader learns to skip.
   */
  it('reports a presented obligation on a LIVE runtime as awaiting disposal, not stranded', async () => {
    const envelope = await landOne()

    const live = await confirmStranded(context, db.mailDelivery.listUndisposedPresentations())
    expect(live.stranded).toEqual([])
    expect(live.awaitingDisposal.map((item) => item.envelope)).toEqual([envelope.id])
    expect(live.awaitingDisposal[0]?.runtimeStatus).toBe('busy')

    // The same record on a runtime that has GONE is the real strand: nothing is
    // going to reach a turn terminal on it, so nothing will dispose it.
    db.runtimes.updateStatus(RUNTIME, 'terminated', new Date().toISOString())
    const gone = await confirmStranded(context, db.mailDelivery.listUndisposedPresentations())
    expect(gone.awaitingDisposal).toEqual([])
    expect(gone.stranded.map((item) => item.envelope)).toEqual([envelope.id])
  })

  it('surfaces a due reminder in POINTER form, bound to the runtime that holds it', async () => {
    const envelope = await landOne()
    const landing = db.mailDelivery.getPresentation(envelope.id, RUNTIME)?.landingHrcSeq ?? 0
    await disposeAt(landing + 10)
    db.sqlite
      .query('UPDATE hrcmail_presentations SET reminder_due_at = ? WHERE envelope_id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), envelope.id)

    const actionable = await readActionableEnvelopes(context, TARGET)
    const item = actionable.find((candidate) => candidate.envelope.id === envelope.id)
    expect(item?.form).toBe('reminder')
    expect(item?.presentation?.runtimeId).toBe(RUNTIME)
  })
})
