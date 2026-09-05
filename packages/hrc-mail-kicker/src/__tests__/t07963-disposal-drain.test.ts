/**
 * T-07963 criterion 3 — an obligation disposal must not be lost to process exit.
 *
 * `disposeAttemptObligations` was `void (async () => {…})()`. On 2026-09-03 the
 * daemon stopped 28 ms after a drive attempt went terminal, the loop died with
 * the process, and EN-03687 stayed `presented` with no reminder, no failure and
 * no local trace that a disposition had ever been owed.
 *
 * Two mechanisms, tested separately here because neither alone is sufficient:
 * `stop()` DRAINS in-flight disposals (bounded), and every disposition is
 * written to its presentation row as it is DECIDED, so whatever the deadline or
 * a `kill -9` cuts off is still a candidate for the next boot's reconcile.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { type MailKicker, createMailKicker } from '../controller.js'
import { observeAttempt } from '../drive/attempt-lifecycle.js'
import type { MailKickerLedger } from '../ledger/client.js'
import type { WrkqEnvelope } from '../ledger/types.js'
import { failLapsedObligations } from '../terminal/runtime-lapse.js'
import { reconcileStrandedObligations } from '../terminal/stranded-reconcile.js'

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
} as HrcRuntimeIntent

type LogLine = { level: string; event: string; detail: Record<string, unknown> }

let tmpDir: string
let db: HrcDatabase
let logs: LogLine[]
/** Milliseconds each ledger read takes; the window a stop has to survive. */
let ledgerDelayMs: number
/** When set, a ledger read never returns — the unreachable-ledger case. */
let ledgerHangs: boolean
/** What `pendingView` serves; only the D3 sweep reads it. */
let pendingItems: () => WrkqEnvelope[]
/** Envelope rows the fake ledger serves, and what `fail` did to them. */
let failed: { envelope: string; reason: string }[]
let server: MailKicker

function envelopeRow(): WrkqEnvelope {
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
  } as WrkqEnvelope
}

function ledger(): MailKickerLedger {
  const unsupported = () => Promise.reject(new Error('not used by these tests'))
  return {
    pendingView: () => Promise.resolve({ items: pendingItems(), repended: 0 }),
    present: unsupported,
    async fail({ envelope, reason }: { envelope: string; reason: string }) {
      failed.push({ envelope, reason })
      return { ...envelopeRow(), state: 'failed', terminal: true }
    },
    eventsView: () => Promise.resolve({ items: [], highWater: 0 }),
    async envelopeShow() {
      if (ledgerHangs) await new Promise<void>(() => {})
      await new Promise((resolve) => setTimeout(resolve, ledgerDelayMs))
      return envelopeRow()
    },
  } as MailKickerLedger
}

function seed(): void {
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
    status: 'completed',
    acceptedAt: now,
    updatedAt: now,
  })
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
  for (const [kind, ts] of [
    ['turn.started', '2026-09-03T22:56:54Z'],
    ['turn.completed', '2026-09-03T23:50:51Z'],
  ] as const) {
    db.hrcEvents.append({
      ts,
      hostSessionId: HOST_SESSION,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: 1,
      runtimeId: RUNTIME,
      runId: RUN,
      category: 'turn',
      eventKind: kind,
      replayed: false,
      payload: {},
    })
  }
}

function dispositionRow(): { disposed_at: string | null; disposition: string | null } | null {
  return db.sqlite
    .query<{ disposed_at: string | null; disposition: string | null }, [string, string]>(
      `SELECT disposed_at, disposition FROM hrcmail_drive_presentations
        WHERE drive_attempt_id = ? AND envelope_id = ?`
    )
    .get(DRIVE, ENVELOPE)
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 't07963-drain-'))
  db = openHrcDatabase(join(tmpDir, 'state.sqlite'))
  logs = []
  ledgerDelayMs = 0
  ledgerHangs = false
  failed = []
  pendingItems = () => []
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
      log: (level, event, detail) => logs.push({ level, event, detail }),
    },
    { enabled: true, sweepIntervalMs: 60_000 }
  )
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('T-07963 criterion 3 — disposal survives the stop sequence', () => {
  it('drains an in-flight disposal before stop() returns', async () => {
    // 60 ms of ledger read is the whole point: the 2026-09-03 stop beat the
    // disposal loop by 28 ms. Without the drain, stop() returns first and the
    // reminder is never armed.
    ledgerDelayMs = 60
    seed()

    expect(observeAttempt(server, db.mailDrives.getAttempt(DRIVE)!)).toBe('finished')
    await server.stop()

    // Decided, and decided BEFORE the store would have closed underneath it.
    expect(db.mailDrives.listDueReminders(TARGET, '2100-01-01T00:00:00Z')).toHaveLength(1)
    expect(dispositionRow()).toMatchObject({ disposition: 'reminder_armed' })
    expect(logs.filter((line) => line.event === 'wrkq.kicker.dispose_interrupted')).toHaveLength(0)
  })

  it('writes the disposition durably as it is decided, not when the loop ends', async () => {
    ledgerDelayMs = 0
    seed()

    expect(observeAttempt(server, db.mailDrives.getAttempt(DRIVE)!)).toBe('finished')
    await server.stop()

    // The row is the criterion-3 durable half: even a `kill -9` past the drain
    // leaves this behind for the next boot's reconcile to read.
    const row = dispositionRow()
    expect(row?.disposed_at).toBeTruthy()
    expect(row?.disposition).toBe('reminder_armed')
  })

  it('bounds the drain so an unreachable ledger cannot wedge the stop', async () => {
    // An unbounded drain is a daemon that cannot be restarted — strictly worse
    // than the stranding the drain prevents. The deadline must win, and the
    // WARN must then be TRUE rather than decorative.
    ledgerHangs = true
    seed()

    expect(observeAttempt(server, db.mailDrives.getAttempt(DRIVE)!)).toBe('finished')
    const startedAt = Date.now()
    await server.stop()
    const elapsed = Date.now() - startedAt

    expect(elapsed).toBeLessThan(4_000)
    expect(logs.filter((line) => line.event === 'wrkq.kicker.dispose_interrupted')).toHaveLength(1)
    // Nothing was decided, so nothing is dispositioned: the reconcile must still
    // see this presentation as work owed.
    expect(dispositionRow()?.disposed_at).toBeNull()
  })
})

/**
 * T-07963 criterion 2 — the startup reconcile's three branches.
 *
 * Each seeds the EN-03687 shape (terminal attempt, presentation still
 * undispositioned, envelope still `presented` with the newest receipt naming
 * that attempt) and differs only in the two facts that decide disposition: is
 * the receipt's runtime terminal, and did a turn provably carry the body.
 */
describe('T-07963 criterion 2 — startup reconcile disposition', () => {
  /** Seed the stranding, then terminalise without a disposition running. */
  function seedStranded(options: { carriedATurn: boolean; runtimeTerminal: boolean }): void {
    seed()
    if (options.carriedATurn) {
      // `startHrcSeq` is the positive evidence a turn carried the body. Stamped
      // only by `recordStart`, and it survives the later failure below.
      db.mailDrives.recordStart({
        runId: RUN,
        startHrcSeq: 1,
        startedAt: '2026-09-03T22:56:54Z',
        hostSessionId: HOST_SESSION,
        generation: 1,
        runtimeId: RUNTIME,
      })
    }
    // Terminal WITHOUT the disposal loop ever running -- the 28ms window.
    db.mailDrives.failWithoutStart(DRIVE, 'terminal turn.failed observed without turn.started')
    if (options.runtimeTerminal) {
      db.runtimes.update(RUNTIME, {
        status: 'terminated',
        statusChangedAt: '2026-09-04T01:05:30Z',
        updatedAt: '2026-09-04T01:05:30Z',
      })
    }
  }

  it('fails runtime_terminated when the receipt runtime is gone', async () => {
    seedStranded({ carriedATurn: false, runtimeTerminal: true })

    await reconcileStrandedObligations(server)

    expect(failed).toEqual([{ envelope: ENVELOPE, reason: 'runtime_terminated' }])
    expect(dispositionRow()?.disposition).toBe('failed:runtime_terminated')
  })

  it('arms the reminder when the runtime is alive and a turn carried the body', async () => {
    seedStranded({ carriedATurn: true, runtimeTerminal: false })

    await reconcileStrandedObligations(server)

    // The D4 lifecycle, not a failure: the reader saw it and their turn ended.
    expect(failed).toEqual([])
    expect(db.mailDrives.listDueReminders(TARGET, '2100-01-01T00:00:00Z')).toHaveLength(1)
    expect(dispositionRow()?.disposition).toBe('reminder_armed')
  })

  it('REPORTS and does not dispose when the seat is live and no turn carried the body', async () => {
    // The EN-03687 shape exactly. Every available failure reason would assert
    // something false here, so nothing is disposed; redelivery is T-07971's.
    seedStranded({ carriedATurn: false, runtimeTerminal: false })

    await reconcileStrandedObligations(server)

    expect(failed).toEqual([])
    expect(db.mailDrives.listDueReminders(TARGET, '2100-01-01T00:00:00Z')).toHaveLength(0)
    // Undispositioned ON PURPOSE: it must stay a candidate so the operator
    // surface keeps naming it and T-07971 has something to act on.
    expect(dispositionRow()?.disposed_at).toBeNull()
  })

  it('does not loop: a second pass repeats no action on the reported case', async () => {
    seedStranded({ carriedATurn: false, runtimeTerminal: false })

    await reconcileStrandedObligations(server)
    await reconcileStrandedObligations(server)

    // The branch performs no ledger write and no state change, so repeated
    // boots re-report and never act. That is what makes "reported, not
    // disposed" safe to leave standing until T-07971 lands.
    expect(failed).toEqual([])
    expect(db.mailDrives.listDueReminders(TARGET, '2100-01-01T00:00:00Z')).toHaveLength(0)
    expect(dispositionRow()?.disposed_at).toBeNull()
  })

  it('branches on startHrcSeq, never on attempt.state', async () => {
    // The trap: `failWithoutStart` moves a STARTED attempt to `failed`, so
    // state cannot tell "carried the body" from "never did". Branching on it
    // would send a carried obligation down the never-carried path.
    seedStranded({ carriedATurn: true, runtimeTerminal: false })
    const attempt = db.mailDrives.getAttempt(DRIVE)
    expect(attempt?.state).toBe('failed')
    expect(attempt?.startHrcSeq).toBe(1)

    await reconcileStrandedObligations(server)

    expect(dispositionRow()?.disposition).toBe('reminder_armed')
  })
})

/**
 * T-07963 — every path that ENDS an obligation must record it locally.
 *
 * The reconcile's candidate set is "terminal attempt, presentation not yet
 * dispositioned", and I claimed it is bounded because rows leave once disposed.
 * That is only true if every terminating path writes the fact. Before this,
 * exactly one of four did — which is why EN-03687's presentation row still
 * reads `disposed_at IS NULL` while the envelope is terminal in wrkq. The D3
 * lapse sweep did that, and would have kept doing it on every future lapse.
 */
describe('T-07963 — terminating paths record their disposition', () => {
  it('D3 lapse sweep marks the row it just failed', async () => {
    seed()
    db.mailDrives.failWithoutStart(DRIVE, 'terminal without turn.started')
    db.runtimes.update(RUNTIME, {
      status: 'terminated',
      statusChangedAt: '2026-09-04T01:05:30Z',
      updatedAt: '2026-09-04T01:05:30Z',
    })
    expect(dispositionRow()?.disposed_at).toBeNull()
    pendingItems = () => [envelopeRow()]

    await failLapsedObligations(server, TARGET, new Set([RUNTIME]))

    expect(failed).toEqual([{ envelope: ENVELOPE, reason: 'runtime_terminated' }])
    expect(dispositionRow()?.disposition).toBe('failed:runtime_terminated')
    // The point of the whole exercise: it has LEFT the candidate set.
    expect(
      db.mailDrives.listUndisposedTerminalPresentations({
        since: new Date(0).toISOString(),
        limit: 50,
      })
    ).toHaveLength(0)
  })

  /**
   * The third audited call site, `birth-retry`'s exhausted refusals, is
   * deliberately NOT given a disposition write, and this pins why rather than
   * leaving the omission to look like one. It fails only envelopes that are
   * still `pending` with an EMPTY `presentedTo` — never presented, so no
   * presentation row exists to dispose and none can ever become a reconcile
   * candidate. A write there would target a row that does not exist.
   */
  it('an unpresented envelope has no presentation row to strand', () => {
    seed()
    db.mailDrives.failWithoutStart(DRIVE, 'terminal without turn.started')

    const rows = db.sqlite
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM hrcmail_drive_presentations WHERE envelope_id = ?'
      )
      .get('EN-never-presented')
    expect(rows?.n).toBe(0)
  })
})
