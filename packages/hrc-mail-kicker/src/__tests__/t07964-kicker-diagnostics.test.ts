import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLifecycleEvent, HrcRuntimeIntent } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { type MailKicker, createMailKicker } from '../controller.js'
import { observeMailDriveLifecycleEvent } from '../controller.js'
import { reportBootReconcile, reportStalledDeliveries } from '../diagnostics/stranded.js'
import { observeAttempt } from '../drive/attempt-lifecycle.js'
import { failDriveAfterThrow } from '../drive/authority.js'
import { declineForInFlightAttempt } from '../drive/live-seat-delivery.js'
import type { MailKickerLedger } from '../ledger/client.js'
import type { WrkqEnvelope } from '../ledger/types.js'

/**
 * The diagnostic lines T-07964 added, replayed over the shape that lost
 * EN-03687 on 2026-09-03 (T-07963).
 *
 * The fixture is that incident's own sequence, seeded into a real store: a
 * cold-birth drive claims a `reply_required` envelope, writes its presentation
 * receipt, is failed by a daemon stop while its run is still `accepted` with a
 * NULL `dispatched_input_id`, and the seat's turn completes afterwards with no
 * drive left to own it. Every assertion below is about a line that did not
 * exist while that was happening.
 */

const SCOPE = 'agent:cody:project:agent-spaces:task:T-07962'
const TARGET = `${SCOPE}/lane:main`
const ENVELOPE = 'EN-03687'
const RUNTIME = 'rt-ab0029c2'
const HOST_SESSION = 'hsid-246e7572'
const DRIVE = 'drive-72fece2f'
const RUN = 'run-72fece2f'

const INTENT: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/cody',
    projectRoot: '/tmp/agent-spaces',
    cwd: '/tmp/agent-spaces',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { provider: 'openai', id: 'codex-app-server', interactive: false },
  execution: { preferredMode: 'nonInteractive' },
}

type LogLine = { level: string; event: string; detail: Record<string, unknown> }

let tmpDir: string
let db: HrcDatabase
let logs: LogLine[]
let ledgerRows: Map<string, WrkqEnvelope>
let ledgerGate: (() => void) | undefined
let server: MailKicker

function envelopeRow(overrides: Partial<WrkqEnvelope> = {}): WrkqEnvelope {
  return {
    uuid: `uuid-${ENVELOPE}`,
    id: ENVELOPE,
    roomUuid: 'room-T-07962',
    roomKey: 'T-07962',
    roomKind: 'task',
    from: { principalRef: 'agent:mable', scopeRef: 'mable@agent-spaces:primary' },
    to: { principalRef: 'agent:cody', scopeRef: 'cody@agent-spaces:T-07962' },
    obligation: 'reply_required',
    delivery: 'queue',
    body: 'Implement T-07962.',
    state: 'presented',
    terminal: false,
    presentedTo: [
      {
        memberRef: 'cody@agent-spaces:T-07962',
        runtimeId: RUNTIME,
        runId: RUN,
        driveAttemptId: DRIVE,
        presentedAt: '2026-09-03T22:56:52Z',
      },
    ],
    createdAt: '2026-09-03T22:56:50Z',
    updatedAt: '2026-09-03T22:56:52Z',
    ...overrides,
  }
}

/** A ledger that answers from a map, and can be held open mid-read on demand. */
function ledger(): MailKickerLedger {
  const unsupported = () => Promise.reject(new Error('not used by these tests'))
  return {
    pendingView: () => Promise.resolve({ items: [], repended: 0 }),
    present: unsupported,
    fail: unsupported,
    eventsView: () => Promise.resolve({ items: [], highWater: 0 }),
    async envelopeShow({ envelope }) {
      if (ledgerGate !== undefined) {
        await new Promise<void>((resolve) => {
          ledgerGate = resolve
        })
      }
      const row = ledgerRows.get(envelope)
      if (row === undefined) throw new Error(`no such envelope ${envelope}`)
      return row
    },
  } as MailKickerLedger
}

function seedRuntime(runStatus: string, options: { dispatchedInputId?: string } = {}): void {
  const now = '2026-09-03T22:56:52Z'
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
    harness: 'codex-app-server',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    createdAt: now,
    updatedAt: now,
  })
  db.runs.insert({
    runId: RUN,
    hostSessionId: HOST_SESSION,
    runtimeId: RUNTIME,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    status: runStatus,
    acceptedAt: now,
    updatedAt: now,
    ...(options.dispatchedInputId === undefined
      ? {}
      : { dispatchedInputId: options.dispatchedInputId }),
  })
}

/** Claim the drive and write its presentation receipt, exactly as the kicker does. */
function seedClaimedDrive(): void {
  const claim = db.mailDrives.claim(
    TARGET,
    'insert',
    { envelopeIds: [ENVELOPE], materializationIntent: INTENT },
    { driveAttemptId: DRIVE, runId: RUN }
  )
  expect(claim.outcome).toBe('acquired')
  db.mailDrives.recordSession(DRIVE, {
    hostSessionId: HOST_SESSION,
    generation: 1,
    runtimeId: RUNTIME,
  })
  db.mailDrives.presentForAttempt(DRIVE, [ENVELOPE])
}

function appendEvent(eventKind: string, ts: string): HrcLifecycleEvent {
  return db.hrcEvents.append({
    ts,
    hostSessionId: HOST_SESSION,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    runtimeId: RUNTIME,
    runId: RUN,
    category: 'turn',
    eventKind,
    replayed: false,
    payload: {},
  })
}

function lines(event: string): LogLine[] {
  return logs.filter((line) => line.event === event)
}

/** Let the fire-and-forget disposal loop run to completion. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/** The one server-owned projection, stubbed here (T-07969 criterion 4). */
const CANONICAL_RESPONSE = 'the answer that was never minted'
let projectedRuns: string[]

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 't07964-'))
  db = openHrcDatabase(join(tmpDir, 'state.sqlite'))
  logs = []
  projectedRuns = []
  ledgerGate = undefined
  ledgerRows = new Map([[ENVELOPE, envelopeRow()]])
  server = createMailKicker(
    {
      db,
      ledger: ledger(),
      nodeId: 'max3',
      foreignHomeMemo: new Map(),
      resolveForeignHome: () => Promise.resolve(undefined),
      resolveRuntimeIntent: () => INTENT,
      findTargetSession: () => undefined,
      ensureTargetSession: () => Promise.reject(new Error('unused')),
      dispatchTurn: () => Promise.reject(new Error('unused')),
      broker: {
        seatProbe: () => Promise.resolve({ ok: false, error: { message: 'unused' } }),
        withdraw: () => Promise.resolve({ ok: false, error: { message: 'unused' } }),
      },
      preemptAuthorized: () => Promise.resolve(false),
      requestAutoReplyReconcile: () => {},
      projectTurnResponse: (runId) => {
        projectedRuns.push(runId)
        return { body: CANONICAL_RESPONSE, truncated: false }
      },
      log: (level, event, detail) => logs.push({ level, event, detail }),
    },
    { enabled: true, sweepIntervalMs: 60_000 }
  )
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('T-07964 §1 attempt_terminal', () => {
  it('names the target, the run and the envelopes an ending attempt was holding', async () => {
    seedRuntime('completed')
    seedClaimedDrive()
    appendEvent('turn.started', '2026-09-03T22:56:54Z')
    appendEvent('turn.completed', '2026-09-03T23:50:51Z')

    expect(observeAttempt(server, db.mailDrives.getAttempt(DRIVE)!)).toBe('finished')
    await settle()

    const [terminal] = lines('wrkq.kicker.attempt_terminal')
    expect(terminal?.detail).toMatchObject({
      targetSessionRef: TARGET,
      driveAttemptId: DRIVE,
      runId: RUN,
      runtimeId: RUNTIME,
      state: 'completed',
      reason: 'turn.completed',
      runStatus: 'completed',
      presentedEnvelopeIds: [ENVELOPE],
    })
  })

  it('fires for an attempt failed before its turn ever started', () => {
    seedRuntime('failed')
    seedClaimedDrive()

    // The drive threw before dispatch: `failDriveAfterThrow` finishes a
    // never-started attempt, which is a terminal transition and owes a line.
    expect(failDriveAfterThrow(server, db.mailDrives.getAttempt(DRIVE)!, 'boom')).toBe('failed')

    const [terminal] = lines('wrkq.kicker.attempt_terminal')
    expect(terminal?.detail).toMatchObject({
      targetSessionRef: TARGET,
      driveAttemptId: DRIVE,
      runId: RUN,
      state: 'failed',
      reason: 'drive_threw',
      lastError: 'boom',
      presentedEnvelopeIds: [ENVELOPE],
    })
  })
})

describe('T-07964 §2 dispose_begin / dispose_outcome / dispose_interrupted', () => {
  it('reports one outcome per envelope, and reminds when the obligation survives', async () => {
    seedRuntime('completed')
    seedClaimedDrive()
    appendEvent('turn.started', '2026-09-03T22:56:54Z')
    appendEvent('turn.completed', '2026-09-03T23:50:51Z')

    observeAttempt(server, db.mailDrives.getAttempt(DRIVE)!)
    await settle()

    expect(lines('wrkq.kicker.dispose_begin')[0]?.detail).toMatchObject({
      targetSessionRef: TARGET,
      driveAttemptId: DRIVE,
      envelopeIds: [ENVELOPE],
    })
    expect(lines('wrkq.kicker.dispose_outcome')[0]?.detail).toMatchObject({
      driveAttemptId: DRIVE,
      envelope: ENVELOPE,
      outcome: 'reminded',
      runtimeId: RUNTIME,
    })
  })

  it('distinguishes a superseded receipt from one that was never presented', async () => {
    seedRuntime('completed')
    seedClaimedDrive()
    appendEvent('turn.started', '2026-09-03T22:56:54Z')
    appendEvent('turn.completed', '2026-09-03T23:50:51Z')
    ledgerRows.set(
      ENVELOPE,
      envelopeRow({
        presentedTo: [
          {
            memberRef: 'cody@agent-spaces:T-07962',
            runtimeId: RUNTIME,
            driveAttemptId: 'drive-someone-else',
            presentedAt: '2026-09-03T23:59:00Z',
          },
        ],
      })
    )

    observeAttempt(server, db.mailDrives.getAttempt(DRIVE)!)
    await settle()

    expect(lines('wrkq.kicker.dispose_outcome')[0]?.detail).toMatchObject({
      envelope: ENVELOPE,
      outcome: 'skipped:superseded',
      newestDriveAttemptId: 'drive-someone-else',
    })
  })

  it('names the envelopes a stop interrupted mid-disposal', async () => {
    seedRuntime('completed')
    seedClaimedDrive()
    appendEvent('turn.started', '2026-09-03T22:56:54Z')
    appendEvent('turn.completed', '2026-09-03T23:50:51Z')
    // Hold the ledger read open: this is the 28 ms window that lost EN-03687.
    ledgerGate = () => {}

    observeAttempt(server, db.mailDrives.getAttempt(DRIVE)!)
    await settle()
    await server.stop()

    const [interrupted] = lines('wrkq.kicker.dispose_interrupted')
    expect(interrupted?.level).toBe('WARN')
    expect(interrupted?.detail).toMatchObject({ disposals: 1, pendingEnvelopes: 1 })
    expect(interrupted?.detail['interrupted']).toEqual([
      expect.objectContaining({
        targetSessionRef: TARGET,
        driveAttemptId: DRIVE,
        runId: RUN,
        envelopeIds: [ENVELOPE],
      }),
    ])
  })
})

describe('T-07964 §3 auto_reply.unowned_turn', () => {
  it('fires when a turn ends on a runtime still holding a presented envelope', async () => {
    seedRuntime('failed')
    seedClaimedDrive()
    db.mailDrives.failWithoutStart(DRIVE, 'compiler priming wait aborted')

    const completed = appendEvent('turn.completed', '2026-09-03T23:50:51Z')
    observeMailDriveLifecycleEvent.call(server, completed)
    await settle()

    const [unowned] = lines('wrkq.auto_reply.unowned_turn')
    expect(unowned?.level).toBe('WARN')
    expect(unowned?.detail).toMatchObject({
      targetSessionRef: TARGET,
      runtimeId: RUNTIME,
      runId: RUN,
      turnEventKind: 'turn.completed',
      terminalAttemptId: DRIVE,
      terminalAttemptState: 'failed',
      envelopeIds: [ENVELOPE],
    })
  })

  it('names the canonical response the stranded turn would have replied', async () => {
    // T-07969 criterion 4: the diagnostic reads the ONE server-owned projection
    // rather than a second reader, so the line quotes exactly what an auto-reply
    // would have minted. "The turn's canonical response was sitting right there"
    // becomes something an operator can read.
    seedRuntime('failed')
    seedClaimedDrive()
    db.mailDrives.failWithoutStart(DRIVE, 'compiler priming wait aborted')

    observeMailDriveLifecycleEvent.call(
      server,
      appendEvent('turn.completed', '2026-09-03T23:50:51Z')
    )
    await settle()

    const [unowned] = lines('wrkq.auto_reply.unowned_turn')
    expect(unowned?.detail).toMatchObject({ canonicalResponse: CANONICAL_RESPONSE })
    expect(projectedRuns).toEqual([RUN])
  })

  it('does not pay for the response read on the healthy path', async () => {
    // This runs on EVERY mail-drive turn terminal on the node. The projection
    // read lives INSIDE the stranded guard; a read above it would put the cost
    // on every healthy turn.
    seedRuntime('running')
    seedClaimedDrive()

    observeMailDriveLifecycleEvent.call(
      server,
      appendEvent('turn.completed', '2026-09-03T23:50:51Z')
    )
    await settle()

    expect(lines('wrkq.auto_reply.unowned_turn')).toHaveLength(0)
    expect(projectedRuns).toEqual([])
  })

  it('stays silent when a live attempt owns the turn', async () => {
    seedRuntime('running')
    seedClaimedDrive()

    observeMailDriveLifecycleEvent.call(
      server,
      appendEvent('turn.completed', '2026-09-03T23:50:51Z')
    )
    await settle()

    expect(lines('wrkq.auto_reply.unowned_turn')).toHaveLength(0)
  })

  it('stays silent when a failure notice already told the sender', async () => {
    seedRuntime('failed')
    seedClaimedDrive()
    db.mailDrives.failWithoutStart(DRIVE, 'seeded')
    db.mailDrives.recordFailureNotice({
      envelopeId: ENVELOPE,
      targetSessionRef: 'agent:mable:project:agent-spaces/lane:main',
      notice: 'your envelope failed',
    })

    observeMailDriveLifecycleEvent.call(
      server,
      appendEvent('turn.completed', '2026-09-03T23:50:51Z')
    )
    await settle()

    expect(lines('wrkq.auto_reply.unowned_turn')).toHaveLength(0)
  })

  it("does not attribute another runtime's stranded envelope to this turn", async () => {
    seedRuntime('failed')
    seedClaimedDrive()
    // Bind the receipt to a runtime this turn did not happen on (the binding is
    // only writable while the attempt is live, so it precedes the failure).
    db.mailDrives.recordSession(DRIVE, {
      hostSessionId: HOST_SESSION,
      generation: 1,
      runtimeId: 'rt-somebody-else',
    })
    expect(db.mailDrives.getAttempt(DRIVE)?.runtimeId).toBe('rt-somebody-else')
    db.mailDrives.failWithoutStart(DRIVE, 'seeded')

    observeMailDriveLifecycleEvent.call(
      server,
      appendEvent('turn.completed', '2026-09-03T23:50:51Z')
    )
    await settle()

    expect(lines('wrkq.auto_reply.unowned_turn')).toHaveLength(0)
  })

  it('stays silent once the obligation has been disposed', async () => {
    seedRuntime('failed')
    seedClaimedDrive()
    db.mailDrives.failWithoutStart(DRIVE, 'seeded')
    db.mailDrives.armReminder({
      envelopeId: ENVELOPE,
      runtimeId: RUNTIME,
      targetSessionRef: TARGET,
      turnEndedAt: '2026-09-03T23:47:33Z',
      remindAt: '2026-09-03T23:48:33Z',
    })

    observeMailDriveLifecycleEvent.call(
      server,
      appendEvent('turn.completed', '2026-09-03T23:50:51Z')
    )
    await settle()

    expect(lines('wrkq.auto_reply.unowned_turn')).toHaveLength(0)
  })
})

describe('T-07964 §4 boot_reconcile', () => {
  it('reports both populations the restart left behind', async () => {
    seedRuntime('accepted')
    seedClaimedDrive()
    db.mailDrives.failWithoutStart(DRIVE, 'compiler priming wait aborted')
    db.runs.update(RUN, { acceptedAt: '2026-09-03T22:56:52Z' })

    await reportBootReconcile(server)

    const [boot] = lines('wrkq.kicker.boot_reconcile')
    expect(boot?.level).toBe('WARN')
    expect(boot?.detail).toMatchObject({ nodeId: 'max3', strandedCount: 1, undispatchedCount: 1 })
    expect(boot?.detail['stranded']).toEqual([
      expect.objectContaining({
        envelope: ENVELOPE,
        driveAttemptId: DRIVE,
        targetSessionRef: TARGET,
        attemptState: 'failed',
        runtimeId: RUNTIME,
      }),
    ])
    expect(boot?.detail['undispatched']).toEqual([
      expect.objectContaining({
        driveAttemptId: DRIVE,
        runId: RUN,
        runStatus: 'accepted',
        targetSessionRef: TARGET,
      }),
    ])
  })

  it('reports an empty pair at INFO on a clean boot', async () => {
    await reportBootReconcile(server)
    const [boot] = lines('wrkq.kicker.boot_reconcile')
    expect(boot?.level).toBe('INFO')
    expect(boot?.detail).toMatchObject({ strandedCount: 0, undispatchedCount: 0 })
  })

  it('runs at most once per process', async () => {
    await server.runSweepOnce()
    await server.runSweepOnce()
    expect(lines('wrkq.kicker.boot_reconcile')).toHaveLength(1)
  })
})

/**
 * The interim net for T-07971, assigned by mable: a LIVE attempt holding an
 * obligation whose turn never started is wedged, not awaited.
 *
 * Every other reader here keys on a terminal attempt. Without these the wedged
 * case is silent between boots and `hrc mail inspect` calls it `awaiting_turn`,
 * which is indistinguishable from a healthy in-flight delivery — the same
 * silence that lost EN-03687.
 */
describe('T-07964 stalled_delivery (T-07971 interim net)', () => {
  /** Backdate the claim without touching the repository's own transitions. */
  function ageClaim(minutes: number): void {
    db.sqlite
      .query('UPDATE hrcmail_drive_attempts SET claimed_at = ? WHERE drive_attempt_id = ?')
      .run(new Date(Date.now() - minutes * 60_000).toISOString(), DRIVE)
  }

  it('reports an attempt claimed six hours ago whose turn never started', async () => {
    seedRuntime('accepted')
    seedClaimedDrive()
    ageClaim(360)

    await reportStalledDeliveries(server)

    const [line] = lines('wrkq.kicker.stalled_delivery')
    expect(line?.level).toBe('WARN')
    expect(line?.detail).toMatchObject({
      targetSessionRef: TARGET,
      driveAttemptId: DRIVE,
      runId: RUN,
      runtimeId: RUNTIME,
      envelope: ENVELOPE,
      attemptState: 'claimed',
      thresholdMs: 5 * 60_000,
    })
    expect(line?.detail['liveAgeMs']).toBeGreaterThan(5 * 60_000)
  })

  it('stays silent for an attempt claimed two seconds ago', async () => {
    seedRuntime('accepted')
    seedClaimedDrive()

    await reportStalledDeliveries(server)

    expect(lines('wrkq.kicker.stalled_delivery')).toHaveLength(0)
  })

  it('stays silent for a started attempt at any age, structurally', async () => {
    seedRuntime('running')
    seedClaimedDrive()
    appendEvent('turn.started', '2026-09-03T22:56:54Z')
    // recordStart writes state='started' and started_at in one statement, so a
    // turn that began cannot be stalled however long it runs.
    observeAttempt(server, db.mailDrives.getAttempt(DRIVE)!)
    ageClaim(360)
    expect(db.mailDrives.getAttempt(DRIVE)?.startedAt).toBeDefined()

    await reportStalledDeliveries(server)

    expect(lines('wrkq.kicker.stalled_delivery')).toHaveLength(0)
  })

  it('does not fire on a held batch that is waiting behind a live turn', async () => {
    seedRuntime('running')
    seedClaimedDrive()
    ageClaim(360)
    db.sqlite
      .query("UPDATE hrcmail_drive_attempts SET state = 'held' WHERE drive_attempt_id = ?")
      .run(DRIVE)
    // A held batch waits for a turn boundary BY DESIGN and turns legitimately
    // run for an hour; EN-03687's own ran 54 minutes.
    db.runtimes.updateRunId(RUNTIME, RUN, new Date().toISOString())

    await reportStalledDeliveries(server)

    expect(lines('wrkq.kicker.stalled_delivery')).toHaveLength(0)
  })

  it('does fire on a held batch whose runtime has nothing running', async () => {
    seedRuntime('accepted')
    seedClaimedDrive()
    ageClaim(360)
    db.sqlite
      .query("UPDATE hrcmail_drive_attempts SET state = 'held' WHERE drive_attempt_id = ?")
      .run(DRIVE)

    await reportStalledDeliveries(server)

    expect(lines('wrkq.kicker.stalled_delivery')[0]?.detail).toMatchObject({
      envelope: ENVELOPE,
      attemptState: 'held',
    })
  })

  it('reports the daedalus flaw-1 shape: claimed with a placeholder prompt after a crash', async () => {
    seedRuntime('accepted')
    // The flaw-1 sequence: claim writes the placeholder prompt, presentForAttempt
    // writes the local receipt, and the crash lands before the full presentation
    // is composed — so `recordPresentation` never runs and the prompt stays the
    // placeholder while the receipt exists.
    seedClaimedDrive()
    ageClaim(360)
    const attempt = db.mailDrives.getAttempt(DRIVE)!
    expect(attempt.state).toBe('claimed')
    expect(attempt.startedAt).toBeUndefined()
    expect(db.mailDrives.presentationEnvelopeIds(DRIVE)).toEqual([ENVELOPE])

    await reportStalledDeliveries(server)

    expect(lines('wrkq.kicker.stalled_delivery')[0]?.detail).toMatchObject({
      driveAttemptId: DRIVE,
      envelope: ENVELOPE,
      attemptState: 'claimed',
    })
  })

  it('names the population in boot_reconcile and repeats no attempt per process', async () => {
    seedRuntime('accepted')
    seedClaimedDrive()
    ageClaim(360)

    await reportBootReconcile(server)
    const [boot] = lines('wrkq.kicker.boot_reconcile')
    expect(boot?.level).toBe('WARN')
    expect(boot?.detail).toMatchObject({ stalledCount: 1, stalledThresholdMs: 5 * 60_000 })
    expect(boot?.detail['stalled']).toEqual([
      expect.objectContaining({
        envelope: ENVELOPE,
        driveAttemptId: DRIVE,
        attemptState: 'claimed',
      }),
    ])

    await reportStalledDeliveries(server)
    await reportStalledDeliveries(server)
    expect(lines('wrkq.kicker.stalled_delivery')).toHaveLength(1)
  })

  it('does not dispose anything it reports', async () => {
    seedRuntime('accepted')
    seedClaimedDrive()
    ageClaim(360)

    await reportStalledDeliveries(server)

    expect(db.mailDrives.getAttempt(DRIVE)?.state).toBe('claimed')
    expect(db.mailDrives.remindersForEnvelope(ENVELOPE)).toHaveLength(0)
    expect(db.mailDrives.failureNoticesForEnvelope(ENVELOPE)).toHaveLength(0)
  })
})

describe('T-07964 §5 drive_in_flight', () => {
  it('carries the run status and input binding that tell a long turn from a dead one', async () => {
    seedRuntime('accepted')
    seedClaimedDrive()

    await declineForInFlightAttempt(
      server,
      TARGET,
      db.mailDrives.getAttempt(DRIVE)!,
      undefined,
      [],
      'periodic',
      { state: 'turn-active', runtimeId: RUNTIME, turnId: '01a0697d' },
      { via: 'slot', observation: 'waiting' }
    )

    const [inFlight] = lines('wrkq.kicker.drive_in_flight')
    expect(inFlight?.detail).toMatchObject({
      targetSessionRef: TARGET,
      driveAttemptId: DRIVE,
      runId: RUN,
      runStatus: 'accepted',
      dispatchedInputId: null,
      turnId: '01a0697d',
      observedTurnId: '01a0697d',
    })
  })
})
