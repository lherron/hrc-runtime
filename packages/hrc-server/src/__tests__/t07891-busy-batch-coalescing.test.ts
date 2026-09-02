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
const INVOCATION_ID = 'inv-t07891-seat'

type Seat = { state: 'idle' } | { state: 'turn-active'; turnId: string; policy: 'open' }

type Dispatch = {
  prompt: string
  runId: string
  inputId: string
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

function installDispatchCapture(): () => Dispatch[] {
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
    }
  ): Promise<Response> => {
    const runId = options.runId ?? `run-preempt-${calls.length + 1}`
    const inputId = `input-${runId}`
    calls.push({
      prompt,
      runId,
      inputId,
      submissionDoor: options.submissionDoor,
      envelopeId: options.submissionOrigin?.envelopeId,
    })
    const db = serverInternals(instance).db
    const now = timestamp()
    if (options.runId !== undefined && db.runs.getByRunId(runId) === null) {
      db.runs.insert({
        runId,
        hostSessionId: session.hostSessionId,
        runtimeId: RUNTIME_ID,
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
      db.runtimes.updateRunId(RUNTIME_ID, runId, now)
      serverInternals(instance).notifyEvent(
        appendHrcEvent(db, 'turn.started', {
          ts: now,
          hostSessionId: session.hostSessionId,
          scopeRef: SCOPE,
          laneRef: 'main',
          generation: session.generation,
          runtimeId: RUNTIME_ID,
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
      runtimeId: RUNTIME_ID,
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
  it('coalesces three arrivals behind a driven turn into one boundary input and three receipts', async () => {
    await startServer()
    await seedObservedSeat({ state: 'idle' })
    const calls = installDispatchCapture()
    const driving = say('start the foreground turn')
    await drain()
    await waitUntil(() => calls().length === 1, 'foreground dispatch')

    const queued = [say('queued one'), say('queued two'), say('queued three')]
    await drain()
    const db = serverInternals(server as HrcServer).db
    await waitUntil(() => heldAttempt(db)?.presentedCount === 3, 'three-member held batch')
    const heldDriveAttemptId = heldAttempt(db)?.driveAttemptId
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
  })

  it('recognizes a human-typed pane turn without any HRC run row and flushes two at the sweep boundary', async () => {
    await startServer()
    await seedObservedSeat({ state: 'turn-active', turnId: 'turn-human', policy: 'open' })
    const calls = installDispatchCapture()
    const db = serverInternals(server as HrcServer).db
    expect(db.runs.listRuns({})).toHaveLength(0)

    const queued = [say('human-busy one'), say('human-busy two')]
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
