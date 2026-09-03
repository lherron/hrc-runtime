import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { DispatchTurnResponse, HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { appendHrcEvent } from '../hrc-event-helper.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  captureServerLog,
  completeRun,
  installMailKickerAgentHome,
  serverInternals,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'

/**
 * T-07891 — queue-class mail waits on HRC's side for an observed seat boundary.
 *
 * The two busy fixtures are deliberately different: the driven shape has an
 * HRC run row and drive slot, while the human-typed shape has neither. Both are
 * busy solely because the broker seat probe reports `turn-active`. A terminal
 * turn event wakes the driven boundary; a direct periodic wake proves the same
 * flush remains recoverable when that event was missed.
 */

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07891/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07891'
const RUNTIME_ID = 'rt-t07891-seat'
const ROTATED_RUNTIME_ID = 'rt-t07925-rotated-seat'
const INVOCATION_ID = 'inv-t07891-seat'

type Seat = { state: 'idle' } | { state: 'turn-active'; turnId: string; policy: 'open' }

type Dispatch = {
  prompt: string
  runId: string
  inputId: string
  ttlMs?: number | undefined
  submissionDoor?: string | undefined
  envelopeId?: string | undefined
}

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void
let seat: Seat
let seatProbeOverride: (() => Seat) | undefined
let withdrawCalls: unknown[]

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07891-')
  ledger = new FakeWrkqLedger()
  restoreAgentHome = (await installMailKickerAgentHome(fixture.tmpDir, 'kicker-proof')).restore
  seat = { state: 'idle' }
  seatProbeOverride = undefined
  withdrawCalls = []
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  restoreAgentHome()
  await fixture.cleanup()
})

function say(body: string, overrides: Record<string, unknown> = {}) {
  return ledger.say({
    toScopeRef: SCOPE,
    fromScopeRef: 'mable@hcs:fixall',
    roomKey: 'T-07891',
    body,
    ...overrides,
  })
}

async function startServer(): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
    })
  )
  ;(server as any).getHarnessBrokerController = () => ({
    seatProbe: async () => ({
      ok: true as const,
      response: {
        invocationId: INVOCATION_ID,
        seat: seatProbeOverride?.() ?? seat,
        brokerHeldDepth: 0,
      },
    }),
    withdraw: async (input: unknown) => {
      withdrawCalls.push(input)
      return { ok: true as const, response: { outcome: 'withdrawn' as const } }
    },
    turnManifest: async () => ({
      ok: true as const,
      response: {
        invocationId: INVOCATION_ID,
        turnId: seat.state === 'turn-active' ? seat.turnId : 'turn-none',
        policy: 'open' as const,
        submissionIds: [],
      },
    }),
  })
  return server
}

async function seedObservedSeat(initialSeat: Seat): Promise<HrcSessionRecord> {
  const instance = server as HrcServer
  const session = await fixture.resolveSession(SCOPE)
  const db = serverInternals(instance).db
  const now = timestamp()
  seat = initialSeat
  db.runtimes.insert({
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
    status: initialSeat.state === 'turn-active' ? 'busy' : 'ready',
    statusChangedAt: now,
    supportsInflightInput: false,
    adopted: false,
    activeInvocationId: INVOCATION_ID,
    createdAt: now,
    updatedAt: now,
  })
  return session
}

function installDispatchCapture(runtimeId = RUNTIME_ID): () => Dispatch[] {
  const instance = server as HrcServer
  const calls: Dispatch[] = []
  serverInternals(instance).dispatchTurnForSession = async (
    session: HrcSessionRecord,
    _intent: HrcRuntimeIntent,
    prompt: string,
    options: {
      runId?: string | undefined
      submissionDoor?: string | undefined
      submissionOrigin?: { envelopeId?: string | undefined } | undefined
      ttlMs?: number | undefined
    }
  ): Promise<Response> => {
    const runId = options.runId ?? `run-preempt-${calls.length + 1}`
    const inputId = `input-${runId}`
    calls.push({
      prompt,
      runId,
      inputId,
      ttlMs: options.ttlMs,
      submissionDoor: options.submissionDoor,
      envelopeId: options.submissionOrigin?.envelopeId,
    })
    const db = serverInternals(instance).db
    const now = timestamp()
    if (options.runId !== undefined && db.runs.getByRunId(runId) === null) {
      db.runs.insert({
        runId,
        hostSessionId: session.hostSessionId,
        runtimeId,
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
      db.runtimes.updateRunId(runtimeId, runId, now)
      serverInternals(instance).notifyEvent(
        appendHrcEvent(db, 'turn.started', {
          ts: now,
          hostSessionId: session.hostSessionId,
          scopeRef: SCOPE,
          laneRef: 'main',
          generation: session.generation,
          runtimeId,
          runId,
          transport: 'tmux',
        })
      )
      seat = { state: 'turn-active', turnId: runId, policy: 'open' }
    }
    return Response.json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId,
      transport: 'tmux',
      status: 'started',
      inputId,
      supportsInFlightInput: false,
    } satisfies DispatchTurnResponse & { inputId: string })
  }
  return () => calls
}

async function drain(reason: 'insert' | 'turn_completion' | 'periodic' = 'insert'): Promise<void> {
  ;(server as any).requestMailKickerWake(TARGET, reason)
  await (server as any).drainMailKickerTarget(TARGET)
}

function heldAttempt(db: HrcDatabase) {
  return db.mailDrives.getHeldAttempt(TARGET)
}

describe('T-07891 HRC-held busy batches', () => {
  it('coalesces one same-counterparty fan-out group into one boundary input and three receipts', async () => {
    await startServer()
    await seedObservedSeat({ state: 'idle' })
    const calls = installDispatchCapture()
    const driving = say('start the foreground turn')
    await drain()
    await waitUntil(() => calls().length === 1, 'foreground dispatch')

    const queued = [
      say('queued one', { groupId: 'EN-fanout' }),
      say('queued two', { groupId: 'EN-fanout' }),
      say('queued three', { groupId: 'EN-fanout' }),
    ]
    await drain()
    const db = serverInternals(server as HrcServer).db
    await waitUntil(() => heldAttempt(db)?.presentedCount === 3, 'three-member held batch')
    const heldDriveAttemptId = heldAttempt(db)?.driveAttemptId
    expect(calls()).toHaveLength(1)
    expect(queued.every((item) => item.presentedTo.length === 0)).toBe(true)

    // T-07926: hint calls interleaved with the active turn are count-only. They
    // neither dispatch nor receipt this batch, and cadence suppresses a repeat.
    const firstHint = await fixture.postJson('/v1/internal/mail/hint-decision', {
      runtimeId: RUNTIME_ID,
    })
    expect(await firstHint.json()).toMatchObject({ heldCount: 3, reason: 'first' })
    const repeatHint = await fixture.postJson('/v1/internal/mail/hint-decision', {
      runtimeId: RUNTIME_ID,
    })
    expect(await repeatHint.json()).toEqual({})
    expect(calls()).toHaveLength(1)
    expect(queued.every((item) => item.presentedTo.length === 0)).toBe(true)

    seat = { state: 'idle' }
    const drivingRunId = ledger.envelopes.get(driving.id)?.presentedTo[0]?.runId
    if (drivingRunId === undefined) throw new Error('foreground receipt has no run')
    await completeRun(server as HrcServer, drivingRunId)
    await waitUntil(() => calls().length === 2, 'boundary batch dispatch')
    await waitUntil(
      () => queued.every((item) => (ledger.envelopes.get(item.id)?.presentedTo.length ?? 0) === 1),
      'three boundary receipts'
    )

    const boundary = calls()[1]
    expect(boundary?.prompt).toContain('queued one')
    expect(boundary?.prompt).toContain('queued two')
    expect(boundary?.prompt).toContain('queued three')
    const receipts = queued.map((item) => ledger.envelopes.get(item.id)?.presentedTo[0])
    expect(new Set(receipts.map((receipt) => receipt?.inputId))).toEqual(
      new Set([boundary?.inputId])
    )
    expect(receipts.map((receipt) => receipt?.driveAttemptId)).toEqual([
      heldDriveAttemptId,
      heldDriveAttemptId,
      heldDriveAttemptId,
    ])

    // Simulate a crash after the broker accepted the one batch input but before
    // the last per-envelope receipt committed. Recovery fills only that receipt
    // under the same attempt/input and never actuates a second broker turn.
    const lost = ledger.envelopes.get(queued[2]?.id ?? '')
    if (lost === undefined || heldDriveAttemptId === undefined) throw new Error('missing batch')
    lost.presentedTo = []
    lost.state = 'pending'
    ledger.attemptReceipts.delete(`${heldDriveAttemptId}:${lost.id}`)
    const replay = await captureServerLog(async () => drain('periodic'))
    expect(ledger.envelopes.get(lost.id)?.presentedTo[0]).toMatchObject({
      driveAttemptId: heldDriveAttemptId,
      inputId: boundary?.inputId,
    })
    expect(replay.lines.some((line) => line.includes('queue_batch_receipts_replayed'))).toBe(true)
    expect(calls()).toHaveLength(2)

    // The later boundary still owns one exact auto-reply discharge for the
    // whole same-counterparty fan-out group.
    const boundaryRun = db.runs.getByRunId(boundary?.runId ?? '')
    if (boundaryRun === null) throw new Error('missing boundary run')
    const message = appendHrcEvent(db, 'turn.message', {
      ts: timestamp(),
      hostSessionId: boundaryRun.hostSessionId,
      scopeRef: boundaryRun.scopeRef,
      laneRef: boundaryRun.laneRef,
      generation: boundaryRun.generation,
      runtimeId: boundaryRun.runtimeId,
      runId: boundaryRun.runId,
      transport: 'tmux',
      payload: { message: { role: 'assistant', content: 'one boundary response' } },
    })
    serverInternals(server as HrcServer).notifyEvent(message)
    await completeRun(server as HrcServer, boundaryRun.runId)
    await waitUntil(() => ledger.roomSayRequests.length === 1, 'boundary auto reply')
    expect(ledger.roomSayRequests[0]).toMatchObject({
      ref: queued[0]?.roomKey,
      body: 'one boundary response',
      to: ['mable@hcs:fixall'],
      dischargeEnvelopeIds: queued.map((item) => item.id),
    })
    expect(queued.every((item) => ledger.envelopes.get(item.id)?.state === 'acked')).toBe(true)
  })

  it('serializes three held counterparties across three boundary turns', async () => {
    await startServer()
    await seedObservedSeat({ state: 'idle' })
    const calls = installDispatchCapture()
    const driving = say('start the foreground turn')
    await drain()
    await waitUntil(() => calls().length === 1, 'foreground dispatch')

    const queued = [
      say('queued probe a', { fromPrincipalRef: 'agent:probe-a', fromScopeRef: undefined }),
      say('queued probe b', { fromPrincipalRef: 'agent:probe-b', fromScopeRef: undefined }),
      say('queued probe c', { fromPrincipalRef: 'agent:probe-c', fromScopeRef: undefined }),
    ]
    await drain()
    const db = serverInternals(server as HrcServer).db
    await waitUntil(() => heldAttempt(db)?.presentedCount === 3, 'three-counterparty held batch')

    const drivingRunId = ledger.envelopes.get(driving.id)?.presentedTo[0]?.runId
    if (drivingRunId === undefined) throw new Error('foreground receipt has no run')
    for (let index = 0; index < queued.length; index += 1) {
      seat = { state: 'idle' }
      const priorRunId = index === 0 ? drivingRunId : calls()[index]?.runId
      if (priorRunId === undefined) throw new Error(`boundary ${index} has no prior run`)
      await completeRun(server as HrcServer, priorRunId)
      await waitUntil(() => calls().length === index + 2, `boundary dispatch ${index + 1}`)

      const boundary = calls()[index + 1]
      const selected = queued[index]
      if (boundary === undefined || selected === undefined) throw new Error('missing boundary')
      expect(boundary.prompt).toContain(selected.body)
      for (const other of queued.filter((_, candidateIndex) => candidateIndex !== index)) {
        expect(boundary.prompt).not.toContain(other.body)
      }
      expect(db.mailDrives.getAttemptByRunId(boundary.runId)?.autoReplyCandidate).toMatchObject({
        sourceRef: selected.id,
        sourceEnvelopeIds: [selected.id],
      })
      expect(ledger.envelopes.get(selected.id)?.presentedTo).toHaveLength(1)
    }

    expect(calls()).toHaveLength(4)
    expect(heldAttempt(db)).toBeUndefined()
  })

  it('presents only the oldest counterparty key on the first idle attempt', async () => {
    await startServer()
    await seedObservedSeat({ state: 'idle' })
    const calls = installDispatchCapture()
    const oldestGroupId = 'EN-idle-probe-a'
    const oldest = say('idle probe a', {
      fromPrincipalRef: 'agent:probe-a',
      fromScopeRef: undefined,
      groupId: oldestGroupId,
      obligation: 'fyi',
    })
    const sameKey = say('idle probe a follow-up', {
      fromPrincipalRef: 'agent:probe-a',
      fromScopeRef: undefined,
      groupId: oldestGroupId,
    })
    const deferred = [
      say('idle probe b', { fromPrincipalRef: 'agent:probe-b', fromScopeRef: undefined }),
      say('idle probe c', { fromPrincipalRef: 'agent:probe-c', fromScopeRef: undefined }),
    ]

    await drain()
    expect(calls()).toHaveLength(1)
    expect(calls()[0]?.prompt).toContain(oldest.body)
    expect(calls()[0]?.prompt).toContain(sameKey.body)
    for (const envelope of deferred) {
      expect(calls()[0]?.prompt).not.toContain(envelope.body)
      expect(ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])
    }
    expect(ledger.envelopes.get(oldest.id)?.presentedTo).toHaveLength(1)
    expect(ledger.envelopes.get(sameKey.id)?.presentedTo).toHaveLength(1)
    expect(
      serverInternals(server as HrcServer).db.mailDrives.getAttemptByRunId(calls()[0]?.runId ?? '')
        ?.autoReplyCandidate
    ).toMatchObject({
      sourceRef: oldestGroupId,
      sourceEnvelopeIds: [oldest.id, sameKey.id],
    })
  })

  it('recognizes a human-typed pane turn without any HRC run row and flushes two at the sweep boundary', async () => {
    await startServer()
    await seedObservedSeat({ state: 'turn-active', turnId: 'turn-human', policy: 'open' })
    const calls = installDispatchCapture()
    const db = serverInternals(server as HrcServer).db
    expect(db.runs.listRuns({})).toHaveLength(0)

    const queued = [
      say('human-busy one', { groupId: 'EN-human-fanout' }),
      say('human-busy two', { groupId: 'EN-human-fanout' }),
    ]
    await drain()
    expect(calls()).toHaveLength(0)
    expect(heldAttempt(db)).toMatchObject({
      state: 'held',
      presentedCount: 2,
      heldBehindTurnId: 'turn-human',
    })

    seat = { state: 'idle' }
    await drain('periodic')
    await waitUntil(() => calls().length === 1, 'human-turn boundary dispatch')
    expect(calls()[0]?.prompt).toContain('human-busy one')
    expect(calls()[0]?.prompt).toContain('human-busy two')
    expect(queued.map((item) => ledger.envelopes.get(item.id)?.presentedTo[0]?.inputId)).toEqual([
      calls()[0]?.inputId,
      calls()[0]?.inputId,
    ])
  })

  it('keeps a held attempt live when its seat rotates before the boundary flush', async () => {
    await startServer()
    const session = await seedObservedSeat({
      state: 'turn-active',
      turnId: 'turn-before-rotation',
      policy: 'open',
    })
    const calls = installDispatchCapture(ROTATED_RUNTIME_ID)
    const queued = say('reply after the rotated boundary')
    await drain()

    const active = server as HrcServer
    const db = serverInternals(active).db
    const held = heldAttempt(db)
    if (held === undefined) throw new Error('missing held attempt')
    expect(held.runtimeId).toBe(RUNTIME_ID)

    const now = timestamp()
    db.runtimes.updateStatus(RUNTIME_ID, 'terminated', now)
    db.runtimes.insert({
      runtimeId: ROTATED_RUNTIME_ID,
      runtimeKind: 'harness',
      controllerKind: 'harness-broker',
      hostSessionId: session.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: session.generation,
      transport: 'tmux',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      activeInvocationId: 'inv-t07925-rotated-seat',
      createdAt: now,
      updatedAt: now,
    })
    seat = { state: 'idle' }

    const flush = await captureServerLog(async () => drain('turn_completion'))
    expect(calls()).toHaveLength(1)
    expect(flush.lines.some((line) => line.includes('terminal_runtime_attempt_reaped'))).toBe(false)
    expect(db.mailDrives.getAttempt(held.driveAttemptId)).toMatchObject({
      state: 'started',
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: ROTATED_RUNTIME_ID,
    })

    const runId = calls()[0]?.runId
    if (runId === undefined) throw new Error('rotated dispatch has no run')
    appendHrcEvent(db, 'turn.message', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: session.generation,
      runtimeId: ROTATED_RUNTIME_ID,
      runId,
      transport: 'tmux',
      payload: { message: { role: 'assistant', content: 'rotated seat reply' } },
    })
    await completeRun(active, runId)
    await waitUntil(
      () => db.mailDrives.getAttempt(held.driveAttemptId)?.state === 'completed',
      'rotated attempt completion'
    )
    await waitUntil(
      () => db.mailDrives.listDueReminders(TARGET, '9999-12-31T23:59:59.999Z').length === 1,
      'rotated attempt reminder'
    )
    await waitUntil(
      () => db.mailDrives.getAutoReplyIntent(held.driveAttemptId) !== undefined,
      'rotated attempt auto-reply intent'
    )
    expect(db.runs.getByRunId(runId)).toMatchObject({
      status: 'completed',
      runtimeId: ROTATED_RUNTIME_ID,
    })
    expect(db.mailDrives.listDueReminders(TARGET, '9999-12-31T23:59:59.999Z')[0]).toMatchObject({
      envelopeId: queued.id,
      runtimeId: ROTATED_RUNTIME_ID,
    })
  })

  it('keeps an unreceipted HRC-held member past 30 minutes and gives it a broker TTL only at flush', async () => {
    await startServer()
    await seedObservedSeat({
      state: 'turn-active',
      turnId: 'turn-hour-long',
      policy: 'open',
    })
    const calls = installDispatchCapture()
    const queued = say('survives a turn longer than the broker TTL')
    await drain()

    const db = serverInternals(server as HrcServer).db
    const held = heldAttempt(db)
    if (held === undefined) throw new Error('missing held attempt')
    const moreThanThirtyMinutesAgo = new Date(Date.now() - 31 * 60_000).toISOString()
    db.sqlite
      .query(
        `UPDATE hrcmail_drive_attempts
         SET claimed_at = ?, updated_at = ?
         WHERE drive_attempt_id = ?`
      )
      .run(moreThanThirtyMinutesAgo, moreThanThirtyMinutesAgo, held.driveAttemptId)

    expect(calls()).toEqual([])
    expect(queued.presentedTo).toEqual([])
    expect(db.mailDrives.getHeldAttempt(TARGET)?.claimedAt).toBe(moreThanThirtyMinutesAgo)

    seat = { state: 'idle' }
    await drain('turn_completion')
    await waitUntil(() => calls().length === 1, 'post-30-minute boundary dispatch')

    expect(calls()[0]).toMatchObject({ ttlMs: 30 * 60_000 })
    expect(ledger.envelopes.get(queued.id)?.presentedTo).toHaveLength(1)
  })

  it('keeps scope-less mail held past five minutes across wakes, sweep, cold catch-up, and a failure notice', async () => {
    await startServer()
    await seedObservedSeat({
      state: 'turn-active',
      turnId: 'turn-t07917-six-minutes',
      policy: 'open',
    })
    const calls = installDispatchCapture()
    const queued = say('T-07917 held body survives every maintenance path', {
      fromPrincipalRef: 'agent:lance',
      fromScopeRef: undefined,
    })
    await drain()

    const active = server as HrcServer
    const internals = serverInternals(active)
    const held = heldAttempt(internals.db)
    if (held === undefined) throw new Error('missing held attempt')
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString()
    internals.db.sqlite
      .query(
        `UPDATE hrcmail_drive_attempts
         SET claimed_at = ?, updated_at = ?
         WHERE drive_attempt_id = ?`
      )
      .run(sixMinutesAgo, sixMinutesAgo, held.driveAttemptId)

    const expectStillHeld = (expectedDispatches = 0) => {
      expect(ledger.envelopes.get(queued.id)).toMatchObject({
        state: 'pending',
        terminal: false,
        presentedTo: [],
      })
      expect(ledger.failRequests.filter((request) => request.envelope === queued.id)).toEqual([])
      expect(heldAttempt(internals.db)).toMatchObject({
        driveAttemptId: held.driveAttemptId,
        state: 'held',
        presentedCount: 1,
      })
      expect(calls()).toHaveLength(expectedDispatches)
    }

    // Every ordinary wake class must retain the same HRC-owned, unreceipted
    // batch while the broker still observes the foreground turn.
    await drain('insert')
    await drain('turn_completion')
    await drain('periodic')
    expectStillHeld()

    // The periodic full sweep performs both D3/D7 maintenance and the seated
    // target read. Six simulated minutes of age is not terminal evidence.
    await (active as any).runMailKickerSweep()
    expectStillHeld()

    // Replay the one-time cold-start catch-up against the already-persisted
    // store. It may rediscover the target, but cannot reinterpret held mail as
    // an unborn scope.
    ;(active as any).mailKickerColdStartCatchupPending = true
    await (active as any).runWrkqLedgerTail()
    await (active as any).drainMailKickerTarget(TARGET)
    expectStillHeld()

    // A sender-side failure notice is another wake for this same busy seat.
    // It must not terminal or present the unrelated held obligation.
    const failedOutbound = ledger.say({
      toScopeRef: 'agent:unreachable:project:hrc-runtime:task:T-07917',
      fromScopeRef: SCOPE,
      roomKey: 'T-07917-failure-notice',
      body: 'seed an unrelated sender failure notice',
    })
    internals.db.wrkqLedgerCursors.advance(ledger.events.length)
    await ledger.fail({ envelope: failedOutbound.id, reason: 'undeliverable' })
    await (active as any).runWrkqLedgerTail()
    await (active as any).drainMailKickerTarget(TARGET)
    expectStillHeld(1)

    // The first observed boundary presents the original envelope exactly once;
    // a reader disposal then ends it normally rather than as undeliverable.
    seat = { state: 'idle' }
    await drain('turn_completion')
    await waitUntil(() => calls().length === 2, 'post-six-minute boundary dispatch')
    expect(ledger.envelopes.get(queued.id)?.presentedTo).toHaveLength(1)
    ledger.ack(queued.id)
    expect(ledger.envelopes.get(queued.id)?.state).toBe('acked')
  })

  it('drops acked, withdrawn, and expired members before flush and never presents them', async () => {
    await startServer()
    await seedObservedSeat({ state: 'turn-active', turnId: 'turn-human', policy: 'open' })
    const calls = installDispatchCapture()
    const [survivor, acked, withdrawn, expired] = [
      say('survives'),
      say('acked while held'),
      say('withdrawn while held'),
      say('expired while held'),
    ]
    await drain()
    for (const [envelope, state] of [
      [acked, 'acked'],
      [withdrawn, 'withdrawn'],
      [expired, 'expired'],
    ] as const) {
      envelope.state = state
      envelope.terminal = true
    }

    seat = { state: 'idle' }
    await drain('turn_completion')
    await waitUntil(() => calls().length === 1, 'surviving member dispatch')
    expect(calls()[0]?.prompt).toContain('survives')
    expect(calls()[0]?.prompt).not.toContain('while held')
    expect(ledger.envelopes.get(survivor.id)?.presentedTo).toHaveLength(1)
    for (const terminal of [acked, withdrawn, expired]) {
      expect(ledger.envelopes.get(terminal.id)?.presentedTo).toEqual([])
      expect(
        ledger.presentRequests.filter(
          (request) => request.preview !== true && request.envelope === terminal.id
        )
      ).toEqual([])
    }
  })

  it('keeps the batch held and logs when a foreign turn wins the flush re-probe', async () => {
    await startServer()
    await seedObservedSeat({ state: 'turn-active', turnId: 'turn-human', policy: 'open' })
    const calls = installDispatchCapture()
    const db = serverInternals(server as HrcServer).db
    say('wait through the foreign turn')
    await drain()
    let probes = 0
    seatProbeOverride = () => {
      probes += 1
      return probes === 1
        ? { state: 'idle' }
        : { state: 'turn-active', turnId: 'turn-foreign', policy: 'open' }
    }

    const captured = await captureServerLog(async () => drain('turn_completion'))
    expect(calls()).toHaveLength(0)
    expect(heldAttempt(db)?.state).toBe('held')
    expect(captured.lines.some((line) => line.includes('queue_batch_foreign_turn_won'))).toBe(true)
  })

  it('dispatches a preempt immediately and never appends it to an ordinary held batch', async () => {
    await startServer()
    await seedObservedSeat({ state: 'turn-active', turnId: 'turn-human', policy: 'open' })
    const calls = installDispatchCapture()
    const ordinary = say('ordinary queued sibling')
    const hold = say('operator preempt', {
      delivery: 'hold',
      fromPrincipalRef: 'agent:lance',
      fromScopeRef: undefined,
    })
    await drain()
    await waitUntil(() => calls().length === 1, 'preempt dispatch')
    expect(calls()[0]).toMatchObject({ submissionDoor: 'preempt', envelopeId: hold.id })
    expect(calls()[0]?.prompt).toContain('operator preempt')
    expect(calls()[0]?.prompt).not.toContain('ordinary queued sibling')

    await drain()
    const db = serverInternals(server as HrcServer).db
    expect(db.mailDrives.presentationEnvelopeIds(heldAttempt(db)?.driveAttemptId ?? '')).toEqual([
      ordinary.id,
    ])
    expect(ledger.envelopes.get(ordinary.id)?.presentedTo).toEqual([])
  })
})
