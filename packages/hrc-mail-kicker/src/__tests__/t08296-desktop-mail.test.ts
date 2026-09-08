/**
 * Mail routing for a permanently reserved Codex desktop conversation
 * (campaign P-00502 leg D, approved design §5–§6).
 *
 * Each case pairs a desktop target with an IDENTICAL ordinary target, because
 * every rule here is a difference and a difference is only visible against its
 * control. Without the pairing a passing test proves nothing: "no dispatch
 * happened" is also what a broken fixture looks like, and "the obligation
 * survived" is also what a lapse sweep that never ran looks like.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { desktopRegistrationForTarget } from '../drive/desktop.js'
import { commitLanding } from '../drive/landing.js'
import { driveMailTargetOnce } from '../drive/target-driver.js'
import { failLapsedObligations } from '../terminal/runtime-lapse.js'
import { chargeBirthSweepRefusal } from '../wake/birth-retry.js'
import {
  HOST_SESSION_ID,
  RUNTIME_ID,
  SCOPE_REF,
  type T08094Harness,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

const NATIVE_THREAD_ID = '01a08138-7d09-7e12-b8ba-d82b744d9a1e'

let h: T08094Harness

beforeEach(async () => {
  h = await createT08094Harness()
})

afterEach(async () => {
  await destroyT08094Harness(h)
})

/**
 * Reserve the fixture's scope for a desktop conversation.
 *
 * The row is the ONLY thing that changes between a desktop case and its
 * control — same session, same runtime, same envelope, same seat.
 */
function registerDesktopThread(): void {
  const now = new Date().toISOString()
  h.db.desktopThreadRegistrations.insert({
    registrationKey: 'reg-t08296',
    homeIdentity: '/Users/lherron/.codex',
    sqliteHome: '/Users/lherron/.codex',
    nativeThreadId: NATIVE_THREAD_ID,
    scopeRef: SCOPE_REF,
    agentId: 'clod',
    projectId: 'hrc-runtime',
    slotToken: 'T-08094',
    laneRef: 'main',
    hostSessionId: HOST_SESSION_ID,
    projectRoot: '/Users/lherron/praesidium/clients/hrc-ios',
    workspaceCwd: '/Users/lherron/praesidium/clients/hrc-ios',
    legacyScopeRef: `agent:clod:project:praesidium:task:codex-${NATIVE_THREAD_ID}`,
    registeredVia: 'startup',
    createdAt: now,
    updatedAt: now,
  })
}

function loggedEvents(): string[] {
  return h.logs.map((entry) => entry.event)
}

function deferrals(): Array<Record<string, unknown>> {
  return h.logs
    .filter((entry) => entry.event === 'wrkq.kicker.desktop_delivery_deferred')
    .map((entry) => entry.detail)
}

describe('P-00502 §6 — an unobserved desktop conversation is a wait, not a birth', () => {
  it('CONTROL: an ordinary scope with no live seat is still dispatched into', async () => {
    h.ledger.say()
    await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    // The seat probe finds no invocation, so this is the `absent` path. For an
    // ordinary target that is a delivery, which is exactly what must NOT happen
    // for the desktop case below.
    expect(h.dispatches).toHaveLength(1)
    expect(loggedEvents()).toContain('wrkq.kicker.delivery_intent')
    expect(deferrals()).toHaveLength(0)
  })

  it('a reserved desktop scope with no observer dispatches nothing and stays pending', async () => {
    registerDesktopThread()
    const envelope = h.ledger.say()
    await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    expect(h.dispatches).toHaveLength(0)
    expect(loggedEvents()).not.toContain('wrkq.kicker.delivery_intent')
    expect(h.db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    // Still pending in the ledger: nothing was failed, nothing was presented.
    expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    expect(h.ledger.failRequests).toEqual([])

    const [deferral] = deferrals()
    expect(deferral?.['reason']).toBe('observer_absent')
    expect(deferral?.['nativeThreadId']).toBe(NATIVE_THREAD_ID)
    expect(deferral?.['envelopeIds']).toEqual([envelope.id])
  })

  it('a desktop scope whose session row is gone is not cold-birthed either', async () => {
    registerDesktopThread()
    const envelope = h.ledger.say()
    // The one path that reaches `deliverByColdBirth`: HRC has a reservation and
    // a permanent address, but no session to deliver into.
    const withoutSession = { ...h.context, findTargetSession: () => undefined }
    await driveMailTargetOnce(withoutSession, TARGET_REF, 'insert')

    expect(h.dispatches).toHaveLength(0)
    expect(h.db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(h.db.mailDelivery.listRefusedBirthTargets()).toEqual([])
    expect(deferrals()[0]?.['reason']).toBe('no_registered_session')
  })
})

describe('P-00502 §6 — a closed conversation is never reported undeliverable', () => {
  // The discriminator is the DECISION, not the ledger write. This fixture's
  // scope has a live runtime row, so D7's own liveness guard suppresses the
  // final `fail` for the ordinary target too — correctly, and for an unrelated
  // reason. `birth_refusals_exhausted` is where the bound is actually spent.
  it('CONTROL: an ordinary target spends the bound and reaches the undeliverable verdict', async () => {
    const envelope = h.ledger.say({ state: 'pending' })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await chargeBirthSweepRefusal(h.context, TARGET_REF)
    }
    expect(loggedEvents()).toContain('wrkq.kicker.birth_refusals_exhausted')
    expect(
      h.logs.find((entry) => entry.event === 'wrkq.kicker.birth_refusals_exhausted')?.detail[
        'envelope'
      ]
    ).toBe(envelope.id)
    expect(
      loggedEvents().filter((event) => event === 'wrkq.kicker.unborn_birth_retry')
    ).toHaveLength(4)
  })

  it('a desktop reservation spends no birth budget and reaches no verdict', async () => {
    registerDesktopThread()
    const envelope = h.ledger.say({ state: 'pending' })
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await chargeBirthSweepRefusal(h.context, TARGET_REF)
    }
    expect(loggedEvents()).not.toContain('wrkq.kicker.birth_refusals_exhausted')
    expect(loggedEvents()).not.toContain('wrkq.kicker.unborn_birth_retry')
    expect(h.ledger.failRequests).toEqual([])
    expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    expect(h.context.mailKickerBirthSweepBackoff.size).toBe(0)
    expect(deferrals().every((detail) => detail['reason'] === 'birth_suppressed')).toBe(true)
  })
})

describe('P-00502 §5 — an observer that ended is not a reader that lapsed', () => {
  it('CONTROL: an ordinary presented obligation fails when its runtime is gone', async () => {
    const envelope = h.ledger.say()
    envelope.state = 'presented'
    envelope.presentedTo.push({
      memberRef: SCOPE_REF,
      runtimeId: RUNTIME_ID,
      driveAttemptId: 'present-control',
      presentedAt: new Date().toISOString(),
    })

    await failLapsedObligations(h.context, TARGET_REF, new Set([RUNTIME_ID]))
    expect(h.ledger.failRequests).toEqual([{ envelope: envelope.id, reason: 'runtime_terminated' }])
  })

  it('a desktop observer that terminated leaves the obligation presented', async () => {
    registerDesktopThread()
    const envelope = h.ledger.say()
    envelope.state = 'presented'
    envelope.presentedTo.push({
      memberRef: SCOPE_REF,
      runtimeId: RUNTIME_ID,
      driveAttemptId: 'present-desktop',
      presentedAt: new Date().toISOString(),
    })

    const complete = await failLapsedObligations(h.context, TARGET_REF, new Set([RUNTIME_ID]))
    expect(complete).toBe(true)
    expect(h.ledger.failRequests).toEqual([])
    expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('presented')
    expect(deferrals()[0]?.['reason']).toBe('observer_terminal_not_a_lapse')
  })
})

describe('P-00502 §6 — a terminal envelope whose body ran anyway', () => {
  it('records the execution on the fence and writes no receipt', async () => {
    const envelope = h.ledger.say()
    const intent = h.db.mailDelivery.openIntent({
      envelopeId: envelope.id,
      targetSessionRef: TARGET_REF,
      door: 'enqueue',
      form: 'full',
      presentationId: 'present-race',
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      generation: 1,
      submissionId: 'submission_inv_1',
      submittedHrcSeq: 0,
    })
    if (intent === undefined) throw new Error('fixture intent missing')
    h.db.mailDelivery.markTerminalEnvelope(envelope.id, 'envelope.withdrawn')
    const terminal = h.db.mailDelivery.getIntent(envelope.id)
    if (terminal === undefined) throw new Error('terminal intent missing')

    const commit = await commitLanding(h.context, terminal, {
      runtimeId: RUNTIME_ID,
      eventType: 'submission.executed',
      landingHrcSeq: 99,
    })

    expect(commit).toBe('held')
    // Not revived: no receipt was requested of wrkq at all.
    expect(h.ledger.presentRequests).toEqual([])
    expect(h.ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])
    // But the execution is now a durable fact on the fence, alongside its cause.
    const after = h.db.mailDelivery.getIntent(envelope.id)
    expect(after?.terminalEnvelopeCause).toBe('envelope.withdrawn+execution_observed')
    expect(after?.terminalEnvelopeAt).toBe(terminal.terminalEnvelopeAt)
    expect(loggedEvents()).toContain('wrkq.kicker.terminal_execution_observed')
  })

  it('a second observation of the same race does not restate the cause', async () => {
    const envelope = h.ledger.say()
    h.db.mailDelivery.openIntent({
      envelopeId: envelope.id,
      targetSessionRef: TARGET_REF,
      door: 'enqueue',
      form: 'full',
      presentationId: 'present-race-2',
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      generation: 1,
      submittedHrcSeq: 0,
    })
    h.db.mailDelivery.markTerminalEnvelope(envelope.id, 'envelope.expired')
    for (let observation = 0; observation < 3; observation += 1) {
      const current = h.db.mailDelivery.getIntent(envelope.id)
      if (current === undefined) throw new Error('terminal intent missing')
      await commitLanding(h.context, current, {
        runtimeId: RUNTIME_ID,
        eventType: 'submission.executed',
        landingHrcSeq: 100 + observation,
      })
    }
    expect(h.db.mailDelivery.getIntent(envelope.id)?.terminalEnvelopeCause).toBe(
      'envelope.expired+execution_observed'
    )
  })
})

describe('the reservation predicate itself', () => {
  it('answers for the registered scope and for nothing else', () => {
    registerDesktopThread()
    expect(desktopRegistrationForTarget(h.context, TARGET_REF)?.nativeThreadId).toBe(
      NATIVE_THREAD_ID
    )
    expect(
      desktopRegistrationForTarget(h.context, 'agent:clod:project:hrc-runtime:task:other/lane:main')
    ).toBeUndefined()
    // A ref this daemon cannot parse is not a desktop target by default.
    expect(desktopRegistrationForTarget(h.context, 'not-a-session-ref')).toBeUndefined()
  })
})
