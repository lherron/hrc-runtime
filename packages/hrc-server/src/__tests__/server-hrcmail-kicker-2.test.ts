import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { MailKicker } from 'hrc-mail-kicker'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import type { AspdObservationDouble } from './fixtures/aspd-observation-doubles.js'
import type { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  captureServerLog,
  completeRun,
  installDeterministicStart,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'
import {
  SCOPE,
  SENDER,
  TARGET,
  buildKickerServer,
  farFuture,
  installQueuedDispatch,
  sayToLedger,
  setupKickerPreamble,
  teardownKickerPreamble,
} from './server-hrcmail-kicker.setup.js'

/**
 * T-07615 (T-07612 wave 3) — HRC drives the wrkq collaboration ledger (part 2).
 * Shared fixture lives in `./server-hrcmail-kicker.setup.js`; part 1 is
 * `server-hrcmail-kicker.test.ts`. Split by the 1000-line test-size gate;
 * case count is unchanged.
 */

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void
let aspdDouble: AspdObservationDouble | undefined
let savedAspdSocket: string | undefined

beforeEach(async () => {
  ;({ fixture, ledger, restoreAgentHome, aspdDouble, savedAspdSocket } =
    await setupKickerPreamble())
})

afterEach(async () => {
  await teardownKickerPreamble({ server, fixture, aspdDouble, savedAspdSocket, restoreAgentHome })
  server = undefined
  aspdDouble = undefined
})

function say(overrides: Partial<Parameters<FakeWrkqLedger['say']>[0]> = {}) {
  return sayToLedger(ledger, overrides)
}

const kicker = (): MailKicker => (server as any).mailKicker

async function startServer(options: Record<string, unknown> = {}): Promise<HrcServer> {
  server = await buildKickerServer(fixture, ledger, options)
  return server
}

describe('T-07615 — HRC drives the wrkq collaboration ledger', () => {
  it('does not infer a busy seat for fyi delivery from an HRC run row', async () => {
    await startServer()
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-busy-v1',
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'busy',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      activeRunId: 'run-busy-v1',
      createdAt: now,
      updatedAt: now,
    })
    db.runs.insert({
      runId: 'run-busy-v1',
      hostSessionId: resolved.hostSessionId,
      runtimeId: 'rt-busy-v1',
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
    const queued = installQueuedDispatch(server as HrcServer)

    const envelope = say({
      obligation: 'fyi',
      body: 'do not wait for the active turn to finish',
    })
    kicker().wake(TARGET, 'insert')
    // T-07891: this fixture has no broker controller/turn observation. Its HRC
    // run row therefore cannot classify the seat as busy; this is an ordinary
    // slot-owning drive, and the fyi auto-acks on commit as before.
    await waitUntil(() => queued.calls() === 1, 'ordinary fyi delivery')
    await waitUntil(() => ledger.envelopes.get(envelope.id)?.state === 'acked', 'fyi commit')
    expect(
      ledger.presentRequests.filter((request) => request.envelope === envelope.id)
    ).toHaveLength(2)
  })

  // rev 5.1 D2, replacing rev 4's redelivery floor entirely. The floor existed
  // to slow a re-presentation down; there is no re-presentation to slow. The
  // four RATIFIED SCENARIOS and the D3 terminal-status matrix live in
  // `t07704-rev51-obligation-lifetime.test.ts`; what stays here is the kicker's
  // own unit behaviour.
  it('never re-presents a presented envelope, floor or no floor', async () => {
    const envelope = say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'first drive')

    const db = (server as any).db as HrcDatabase
    await completeRun(server as HrcServer, deterministic.runIds()[0] as string)
    await waitUntil(
      () => db.mailDelivery.listDueReminders(TARGET, farFuture()).length === 1,
      'reminder armed'
    )

    // Age the receipt by an hour: under rev 4 that alone bought a redelivery.
    const aged = ledger.envelopes.get(envelope.id)
    const receipt = aged?.presentedTo[aged.presentedTo.length - 1]
    if (receipt !== undefined) {
      receipt.presentedAt = new Date(Date.now() - 60 * 60_000).toISOString()
    }
    kicker().wake(TARGET, 'periodic')
    await kicker().drainTarget(TARGET)
    await Bun.sleep(50)
    // Still exactly one drive: the only thing that surfaces it again is its own
    // DUE reminder, and that one is held for a minute.
    expect(deterministic.calls()).toBe(1)
  })

  it('delivers a first presentation immediately — there is nothing to hold back', async () => {
    say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'first delivery is immediate')
  })

  it('retains an uncertain intent when dispatch throws after preview', async () => {
    await startServer()
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-preview-then-throw',
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    ;(server as any).dispatchTurnForSession = async (): Promise<Response> => {
      throw new Error('dispatch rejected after preview')
    }
    const envelope = say({ obligation: 'fyi', body: 'must stay pending' })
    kicker().wake(TARGET, 'insert')
    await kicker().drainTarget(TARGET)

    const requests = ledger.presentRequests.filter((request) => request.envelope === envelope.id)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ preview: true })
    expect(ledger.envelopes.get(envelope.id)).toMatchObject({
      state: 'pending',
      terminal: false,
    })
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])
    // T-08205 rev2: a thrown dispatch is possible-write ambiguity. It retains
    // the write-ahead fence, makes the body non-actionable, and forbids a
    // second submission until positive no-write/removal evidence arrives.
    expect(db.mailDelivery.getIntent(envelope.id)).toMatchObject({
      uncertainCause: 'dispatch_error',
      lastEvidenceKind: 'dispatch_error',
    })
    kicker().wake(TARGET, 'periodic')
    await kicker().drainTarget(TARGET)
    expect(
      ledger.presentRequests.filter((request) => request.envelope === envelope.id)
    ).toHaveLength(1)
    expect(db.mailDelivery.listOpenIntents(TARGET)).toHaveLength(1)
  })

  it('never treats a run row alone as observed busy-seat state', async () => {
    await startServer()
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-busy-visible',
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'busy',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      activeRunId: 'run-busy-visible',
      createdAt: now,
      updatedAt: now,
    })
    db.runs.insert({
      runId: 'run-busy-visible',
      hostSessionId: resolved.hostSessionId,
      runtimeId: 'rt-busy-visible',
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
    const queued = installQueuedDispatch(server as HrcServer)

    const held = say()
    const captured = await captureServerLog(async () => {
      kicker().wake(TARGET, 'insert')
      await kicker().drainTarget(TARGET)
    })
    // T-07891: status/activeRunId are not busy authority. This fixture has no
    // broker controller or active invocation, so it is an ABSENT seat even
    // though its leftover run row says `busy`. A summoning envelope must take
    // cold birth rather than infer a busy seat and steer into it.
    expect(queued.calls()).toBe(1)
    expect(captured.lines.some((line) => line.includes('wrkq.kicker.delivery_intent'))).toBe(true)
    // This does not assert runtime ownership: installQueuedDispatch replaces
    // dispatchTurnForSession and does not exercise admission/provisioning. It
    // asserts only the kicker's authority boundary: no broker observation is
    // no busy-seat observation. The launch door preserves the initial prompt
    // rather than racing it through an enqueue; the receipt assertion below
    // remains the control that the body actually landed.
    expect(
      captured.lines.some(
        (line) => line.includes('wrkq.kicker.delivery_intent') && line.includes('"door":"launch"')
      )
    ).toBe(true)
    await waitUntil(
      () => ledger.envelopes.get(held.id)?.presentedTo.length === 1,
      'the delivery landed'
    )
  })

  it('opens no intent when this node cannot resolve the target placement', async () => {
    const stranded = 'agent:not-an-agent-here:project:wrkq:task:T-00001'
    const strandedTarget = `${stranded}/lane:main`
    await startServer()
    ledger.say({ toScopeRef: stranded, fromScopeRef: SENDER })

    const captured = await captureServerLog(async () => {
      kicker().wake(strandedTarget, 'insert')
      await kicker().drainTarget(strandedTarget)
    })
    expect(captured.lines.some((line) => line.includes('wrkq.kicker.placement_unresolvable'))).toBe(
      true
    )

    // Nothing is left in flight. Under the drive slot a `claimed` attempt here
    // owned the scope forever and made it undrivable; the intent equivalent is
    // an open row, and there must be none.
    const db = (server as any).db as HrcDatabase
    expect(db.mailDelivery.listOpenIntents(strandedTarget)).toHaveLength(0)
    expect(db.mailDelivery.listIntentTargets()).not.toContain(strandedTarget)
  })

  it('B2.1: a daemon kill between the intent and the landing yields ONE receipt', async () => {
    // The T-08094 shape of the old slot-CAS crash test. There is no claim to
    // kill after any more; the fence is the WRITE-AHEAD INTENT, and the property
    // it must hold is the same one: a process that dies between committing the
    // intent and observing the landing recovers exactly one receipt and makes no
    // second delivery.
    const envelope = say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const db = (server as any).db as HrcDatabase

    // Deliver, but suppress the landing: the door was called and admitted, and
    // this daemon never saw what happened next.
    const kickerInstance = kicker()
    const realObserve = kickerInstance.observeBrokerEvent.bind(kickerInstance)
    kickerInstance.observeBrokerEvent = () => undefined
    kickerInstance.wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'the door was called')
    await waitUntil(() => db.mailDelivery.listOpenIntents(TARGET).length === 1, 'intent committed')
    await Bun.sleep(30)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])

    // The envelope is NOT actionable while the intent stands, so no wake can
    // deliver it a second time — the whole point of writing ahead.
    kickerInstance.wake(TARGET, 'periodic')
    await kickerInstance.drainTarget(TARGET)
    expect(deterministic.calls()).toBe(1)

    // Now the mirrored broker evidence arrives, exactly as the reconcile would
    // read it after a restart.
    const intent = db.mailDelivery.listOpenIntents(TARGET)[0]
    const submissionId = intent?.submissionId as string
    const runtimeId = intent?.runtimeId as string
    db.brokerInvocationEvents.appendEvent({
      invocationId: `inv-${runtimeId}`,
      seq: 1,
      time: timestamp(),
      type: 'admission.requested',
      runtimeId,
      payload: { submissionId, class: 'queue', origin: { envelopeId: envelope.id } },
    })
    db.brokerInvocationEvents.appendEvent({
      invocationId: `inv-${runtimeId}`,
      seq: 2,
      time: timestamp(),
      type: 'submission.executed',
      runtimeId,
      payload: { submissionId, turnId: 'turn-b21' },
    })
    kickerInstance.observeBrokerEvent = realObserve

    await kickerInstance.runSweepOnce()
    await waitUntil(
      () => ledger.envelopes.get(envelope.id)?.presentedTo.length === 1,
      'the reconcile wrote exactly one receipt'
    )
    expect(db.mailDelivery.listOpenIntents(TARGET)).toHaveLength(0)

    // Reconciling again changes nothing: the receipt carries the intent's own
    // presentation id and wrkq dedupes on it.
    await kickerInstance.runSweepOnce()
    await Bun.sleep(30)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
    expect(deterministic.calls()).toBe(1)
  }, 20_000)

  /**
   * T-07671 — RCA-grade logging.
   *
   * The RCA that produced this task had three `presented`+`acked` fyi
   * envelopes in the wrkq ledger, each stamped with a runId and a
   * driveAttemptId, and ZERO server-log lines for either drive. The only way to
   * learn that no turn was ever dispatched was to read `hrcmail_drive_attempts`
   * in `state.sqlite` by hand. These tests pin the lines that make that
   * reconstruction a `grep <scope>` instead.
   */
  it('leaves a full delivery_intent → delivery_admitted → presented trail for a fyi drive', async () => {
    await startServer()
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-fyi-trail',
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    const deterministic = installDeterministicStart(server as HrcServer)
    const envelope = say({
      obligation: 'fyi',
      body: 'for your information only',
    })

    const captured = await captureServerLog(async () => {
      kicker().wake(TARGET, 'insert')
      await kicker().drainTarget(TARGET)
      await waitUntil(
        () => ledger.envelopes.get(envelope.id)?.state === 'acked',
        'fyi presented and auto-acked'
      )
    })
    expect(deterministic.calls()).toBe(1)

    const kindLine = (kind: string): string => {
      const lines = captured.lines.filter((line) => line.includes(`wrkq.kicker.${kind}`))
      expect(lines).not.toHaveLength(0)
      return lines[lines.length - 1] as string
    }

    // Head of the timeline: the intent is committed BEFORE any door is called,
    // so a crash from here on leaves durable evidence rather than nothing.
    const intent = kindLine('delivery_intent')
    expect(intent).toContain(TARGET)
    expect(intent).toContain(envelope.id)
    expect(intent).toContain('"door":')

    const dispatched = kindLine('delivery_admitted')
    expect(dispatched).toContain(envelope.id)
    expect(dispatched).toContain(deterministic.inputIds()[0] as string)

    // The receipt the ledger holds is logged only after the LANDING FACT, with
    // the broker submission that joins the two records.
    const presented = kindLine('presented')
    expect(presented).toContain(envelope.id)
    expect(presented).toContain(deterministic.inputIds()[0] as string)
    expect(presented).toContain('"landedOn":"submission.executed"')
    expect(captured.lines.indexOf(dispatched)).toBeLessThan(captured.lines.indexOf(presented))
  })

  it('names the envelope and the door on every line of a reply_required delivery', async () => {
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const envelope = say()

    const captured = await captureServerLog(async () => {
      kicker().wake(TARGET, 'insert')
      await waitUntil(() => deterministic.calls() === 1, 'drive dispatched')
    })

    const admitted = captured.lines.filter((line) => line.includes('wrkq.kicker.delivery_admitted'))
    expect(admitted).not.toHaveLength(0)
    const line = admitted[admitted.length - 1] as string
    expect(line).toContain(TARGET)
    expect(line).toContain(envelope.id)
    expect(line).toContain('"door"')

    // The same presentation id threads intent → landing, so one grep of the
    // scope reconstructs the delivery in order.
    const db = (server as any).db as HrcDatabase
    await waitUntil(
      () => db.mailDelivery.presentationsForTarget(TARGET).length === 1,
      'the delivery landed'
    )
    const presentationId = db.mailDelivery.presentationsForTarget(TARGET)[0]
      ?.presentationId as string
    for (const kind of ['delivery_intent', 'presented']) {
      const kindLines = captured.lines.filter((entry) => entry.includes(`wrkq.kicker.${kind}`))
      expect(kindLines).not.toHaveLength(0)
      expect(kindLines[kindLines.length - 1]).toContain(presentationId)
    }
  })
})
