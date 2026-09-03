import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HrcConflictError, HrcErrorCode } from 'hrc-core'
import type { BirthDesignationRecord, HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { installMailKickerAgentHome, waitUntil } from './fixtures/mail-kicker-harness.js'

/**
 * T-07655 acceptance 2 — a birth deferral is a FINISHED attempt and one line.
 *
 * Before this, a gate refusal on a virgin scope fell into the kicker's generic
 * catch and printed `wrkq.kicker.drive_failed`. That is how three nodes racing
 * for one birth looked like three broken drives — and the losing nodes' text
 * ("became bound on max3 while policy establishment was being committed on
 * lab") described a race, not the misplacement that actually mattered.
 *
 * Two properties are load-bearing and neither is cosmetic:
 *  - the attempt must be FINISHED, never left `claimed`. A claimed attempt owns
 *    the scope's drive slot, so a scope this node will never birth would hold
 *    its own slot forever (the T-07653 invariant).
 *  - the announcement is once per scope per designationEpoch, so a sweep every
 *    few seconds does not fill the log with a fact that has not changed — while
 *    a supersession, which advances the epoch, re-arms it.
 */

const TARGET = 'agent:kicker-birth:project:hrc-runtime:task:T-07655/lane:main'
const SCOPE = 'agent:kicker-birth:project:hrc-runtime:task:T-07655'
const SENDER = 'mable@wrkq:primary'

const DESIGNATION: BirthDesignationRecord = {
  scopeRef: SCOPE,
  homeNodeId: 'max3',
  provenance: 'default_home_node(sender)',
  birthEnvelopeId: 'EN-00722',
  senderScopeRef: 'agent:mable:project:wrkq:task:primary',
  designationEpoch: 1,
  designatedAt: '2026-08-28T05:00:00.000Z',
  state: 'live',
}

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void

function captureServerLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk))
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  return {
    lines,
    restore: () => {
      process.stderr.write = original
    },
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-kicker-birth-deferred-')
  ledger = new FakeWrkqLedger()
  restoreAgentHome = (await installMailKickerAgentHome(fixture.tmpDir, 'kicker-birth')).restore
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  restoreAgentHome()
  await fixture.cleanup()
})

async function startServer(): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
    })
  )
  return server
}

/**
 * Stand in for the gate's verdict on a scope designated elsewhere.
 *
 * The gate's own production of this refusal is proved separately
 * (t07655-gate-birth-designation.test.ts). What is under test HERE is what the
 * kicker does with it, which is the half that used to be wrong.
 */
function refuseWithDesignation(
  serverInstance: HrcServer,
  designation: BirthDesignationRecord = DESIGNATION
): void {
  ;(serverInstance as unknown as { ensureTargetSession: unknown }).ensureTargetSession =
    async (): Promise<never> => {
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        `${SCOPE} is designated to be born on ${designation.homeNodeId}`,
        {
          scopeRef: SCOPE,
          path: 'ensure-target',
          reason: 'birth-designated-elsewhere',
          retryable: false,
          homeNodeId: designation.homeNodeId,
          birthDesignation: designation,
        }
      )
    }
}

/** One drive pass. A bare drain is a no-op: it only drains PENDING targets. */
async function wake(serverInstance: HrcServer): Promise<void> {
  ;(serverInstance as any).mailKicker.mailKickerPendingTargets.set(TARGET, 'periodic')
  await (serverInstance as any).mailKicker.drainTarget(TARGET)
}

function logged(lines: string[], event: string): Record<string, unknown>[] {
  return lines
    .flatMap((line) => line.split('\n'))
    .filter((line) => line.includes(event))
    .map((line) => {
      const start = line.indexOf('{')
      try {
        return start === -1 ? {} : (JSON.parse(line.slice(start)) as Record<string, unknown>)
      } catch {
        return {}
      }
    })
}

describe('T-07655 — the kicker defers a designated birth instead of failing a drive', () => {
  it('finishes the attempt, releases the slot, and announces once per designation epoch', async () => {
    ledger.say({ toScopeRef: SCOPE, fromScopeRef: SENDER, roomKey: 'T-07655', body: 'do it' })
    await startServer()
    const live = server as HrcServer
    refuseWithDesignation(live)

    const captured = captureServerLog()
    try {
      await wake(live)
      await waitUntil(
        () => logged(captured.lines, 'wrkq.kicker.birth_deferred').length > 0,
        'the kicker announced a birth deferral'
      )

      // Three more wakes. The fact has not changed, so neither has the log.
      for (let i = 0; i < 3; i += 1) await wake(live)

      const deferrals = logged(captured.lines, 'wrkq.kicker.birth_deferred')
      expect(deferrals).toHaveLength(1)
      expect(deferrals[0]).toMatchObject({
        scopeRef: SCOPE,
        homeNodeId: 'max3',
        birthEnvelopeId: 'EN-00722',
        senderScopeRef: 'agent:mable:project:wrkq:task:primary',
        provenance: 'default_home_node(sender)',
        designationEpoch: 1,
      })

      // This node declining a birth is not a failed drive, and reporting it as
      // one is the whole defect's visible signature.
      expect(logged(captured.lines, 'wrkq.kicker.drive_failed')).toHaveLength(0)
    } finally {
      captured.restore()
    }

    // T-07653: terminal, so the scope's drive slot is free. A claimed attempt
    // here would make the target permanently undrivable by this daemon.
    const db = (live as any).db as HrcDatabase
    // One attempt per wake, and EVERY one of them terminal. The count is not
    // the property — the slot being free after each pass is, because a single
    // attempt left `claimed` makes the target permanently undrivable here.
    const attempts = db.mailDrives.listAttempts(TARGET)
    expect(attempts.length).toBeGreaterThan(0)
    expect(attempts.every((attempt) => attempt.state !== 'claimed')).toBe(true)
    expect(db.mailDrives.getActiveAttempt(TARGET)).toBeUndefined()
    // No session was minted: the deferral is BEFORE materialization.
    expect(db.sessions.listByScopeRef(SCOPE, 'main')).toHaveLength(0)
  })

  it('announces again once the designation epoch advances', async () => {
    ledger.say({ toScopeRef: SCOPE, fromScopeRef: SENDER, roomKey: 'T-07655', body: 'do it' })
    await startServer()
    const live = server as HrcServer

    const captured = captureServerLog()
    try {
      refuseWithDesignation(live)
      await wake(live)
      await waitUntil(
        () => logged(captured.lines, 'wrkq.kicker.birth_deferred').length === 1,
        'first epoch announced'
      )

      // A tier-1-4 establishment superseded the first designation and a second
      // was derived. Keying the dedupe on the scope alone would have gone
      // permanently silent about a home that has actually moved.
      refuseWithDesignation(live, { ...DESIGNATION, homeNodeId: 'lab', designationEpoch: 2 })
      await wake(live)
      await waitUntil(
        () => logged(captured.lines, 'wrkq.kicker.birth_deferred').length === 2,
        'second epoch announced'
      )

      const deferrals = logged(captured.lines, 'wrkq.kicker.birth_deferred')
      expect(deferrals.map((entry) => entry['homeNodeId'])).toEqual(['max3', 'lab'])
      expect(deferrals.map((entry) => entry['designationEpoch'])).toEqual([1, 2])
    } finally {
      captured.restore()
    }
  })

  it('still reports an ordinary summon failure as a failed drive', async () => {
    ledger.say({ toScopeRef: SCOPE, fromScopeRef: SENDER, roomKey: 'T-07655', body: 'do it' })
    await startServer()
    const live = server as HrcServer
    ;(live as unknown as { ensureTargetSession: unknown }).ensureTargetSession =
      async (): Promise<never> => {
        throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'bound elsewhere', {
          scopeRef: SCOPE,
          reason: 'bound-elsewhere',
          retryable: false,
        })
      }

    const captured = captureServerLog()
    try {
      await wake(live)
      await waitUntil(
        () => logged(captured.lines, 'wrkq.kicker.drive_failed').length > 0,
        'an unrelated refusal is still a failed drive'
      )
      expect(logged(captured.lines, 'wrkq.kicker.birth_deferred')).toHaveLength(0)
    } finally {
      captured.restore()
    }
  })
})
