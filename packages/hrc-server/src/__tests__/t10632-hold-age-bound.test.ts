/**
 * T-10632 — age-bound the bipc ledger holds.
 *
 * R1: a revivable (crashed/stale/dead/detached) bound runtime past
 * HRC_BROKER_HOLD_MAX_AGE_MS stops being held as `revivable` and becomes
 * eligible for the retained-evidence attempt, but only with positive death
 * evidence at the door (daedalus F1): no process argv names its ledger dir,
 * endpoint socket or runtime id, and the T-07047 live-substrate door is closed.
 * R3: incomplete/paused outcomes stay held and are summarised by the sweep.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  type OfflineEvidenceDeps,
  recoverRetainedEvidence,
  retainedEvidenceHold,
  retainedEvidencePassCandidates,
} from '../broker/offline-evidence'
import { sweepOrphanedBrokerTmuxLeases } from '../startup-reconcile/lease-identity'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'
import { type OfflineRuntime, seedOfflineRuntime } from './fixtures/t08566-offline-reader-double'

const DAY_MS = 24 * 60 * 60 * 1000

let fixture: HrcServerTestFixture
let savedBound: string | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('t10632-hold-age-')
  savedBound = process.env['HRC_BROKER_HOLD_MAX_AGE_MS']
  Reflect.deleteProperty(process.env, 'HRC_BROKER_HOLD_MAX_AGE_MS')
})

afterEach(async () => {
  if (savedBound === undefined) Reflect.deleteProperty(process.env, 'HRC_BROKER_HOLD_MAX_AGE_MS')
  else process.env['HRC_BROKER_HOLD_MAX_AGE_MS'] = savedBound
  await fixture.cleanup()
})

/** Set the persisted status stamp directly; the repository only moves it on a status change. */
function stampStatusChangedAt(runtimeId: string, value: string | null): void {
  const db = new Database(fixture.dbPath)
  try {
    db.query('UPDATE runtimes SET status_changed_at = ? WHERE runtime_id = ?').run(value, runtimeId)
  } finally {
    db.close()
  }
}

async function seedRevivable(
  status: 'crashed' | 'stale',
  ageMs: number | null,
  outcome?: { outcome: string; outcomeClass: string }
): Promise<OfflineRuntime> {
  const seeded = await seedOfflineRuntime(fixture, 'full', { status })
  stampStatusChangedAt(
    seeded.runtimeId,
    ageMs === null ? null : new Date(Date.now() - ageMs).toISOString()
  )
  if (outcome) {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.retainedEvidenceOutcomes.append({
        runtimeId: seeded.runtimeId,
        invocationId: seeded.invocationId,
        recordedAt: new Date().toISOString(),
        outcome: outcome.outcome,
        outcomeClass: outcome.outcomeClass as never,
        trigger: 'startup',
        attempts: 1,
        detail: { schema: 'hrc.offline-evidence/v1', outcome: outcome.outcome },
      })
    } finally {
      db.close()
    }
  }
  return seeded
}

function withDb<T>(read: (db: ReturnType<typeof openHrcDatabase>) => T): T {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return read(db)
  } finally {
    db.close()
  }
}

async function sweepOnce() {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())
  } finally {
    db.close()
  }
}

function holdOf(runtimeId: string) {
  return withDb((db) => retainedEvidenceHold(db, db.runtimes.getByRuntimeId(runtimeId)!))
}

function candidates(): string[] {
  return withDb((db) => retainedEvidencePassCandidates(db, 20).runtimeIds)
}

async function dryRunEligibility(
  runtimeId: string,
  overrides: Partial<OfflineEvidenceDeps> = {}
): Promise<{ eligible: boolean; reason?: string | undefined } | undefined> {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const response = await recoverRetainedEvidence(
      {
        db,
        now: () => new Date().toISOString(),
        ownerMap: new Map(),
        probeBrokerHealth: async () => 'unreachable',
        activeClientInvocationId: () => undefined,
        notifyEvent: () => undefined,
        listProcessCommands: async () => [],
        probeLiveSubstrate: async () => false,
        ...overrides,
      },
      { runtimeId, trigger: 'startup', dryRun: true }
    )
    return response?.eligibility
  } finally {
    db.close()
  }
}

async function captureServerLog<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  try {
    return { value: await run(), lines: lines.join('').split('\n').filter(Boolean) }
  } finally {
    process.stderr.write = original
  }
}

function sweepOptions() {
  return {
    graceMs: 0,
    removeDeadSocketFiles: true,
    killLiveLeaseServers: true,
    listBrokerProcessCommands: async () => [],
    probeBrokerHealth: async () => 'unreachable' as const,
  }
}

describe('T-10632 R1 revivable hold expiry', () => {
  test('a crashed runtime past the bound is no longer held as revivable and becomes a candidate', async () => {
    const expired = await seedRevivable('crashed', 8 * DAY_MS)
    const young = await seedRevivable('stale', 6 * DAY_MS)

    expect(holdOf(expired.runtimeId)).toMatchObject({ held: true, reason: 'not_attempted' })
    expect(holdOf(young.runtimeId)).toMatchObject({ held: true, reason: 'revivable' })
    expect(candidates()).toEqual([expired.runtimeId])
  })

  test('a missing status stamp never expires (F1 of the failure-mode list)', async () => {
    const unstamped = await seedRevivable('crashed', null)
    expect(holdOf(unstamped.runtimeId)).toMatchObject({ held: true, reason: 'revivable' })
    expect(candidates()).toEqual([])
  })

  test('HRC_BROKER_HOLD_MAX_AGE_MS overrides the 7-day default', async () => {
    const seeded = await seedRevivable('crashed', 60_000)
    expect(holdOf(seeded.runtimeId).reason).toBe('revivable')
    process.env['HRC_BROKER_HOLD_MAX_AGE_MS'] = '1000'
    expect(holdOf(seeded.runtimeId).reason).toBe('not_attempted')
  })

  test('an expired runtime whose outcome is non-holding releases its directory', async () => {
    const seeded = await seedRevivable('crashed', 8 * DAY_MS, {
      outcome: 'recovered',
      outcomeClass: 'complete',
    })
    expect(holdOf(seeded.runtimeId).held).toBe(false)
  })
})

describe('T-10632 R1 death evidence at the attempt door (daedalus F1)', () => {
  test('a young revivable runtime is refused as revivable, as before', async () => {
    const seeded = await seedRevivable('crashed', 6 * DAY_MS)
    expect(await dryRunEligibility(seeded.runtimeId)).toEqual({
      eligible: false,
      reason: 'offline_read_runtime_revivable',
    })
  })

  test('an expired runtime with no process and a closed substrate door is admitted', async () => {
    const seeded = await seedRevivable('crashed', 8 * DAY_MS)
    expect(await dryRunEligibility(seeded.runtimeId)).toEqual({ eligible: true })
  })

  test('a process naming the ledger dir, the socket or the runtime id refuses it', async () => {
    const seeded = await seedRevivable('stale', 8 * DAY_MS)
    const dir = dirname(seeded.ledgerPath)
    for (const argv of [
      `harness-broker run --event-ledger ${dir}/events.ndjson`,
      `harness-broker run --socket ${dir}/missing.sock`,
      `harness-broker run --runtime-id ${seeded.runtimeId} --generation 1`,
    ]) {
      expect(
        await dryRunEligibility(seeded.runtimeId, { listProcessCommands: async () => [argv] })
      ).toEqual({ eligible: false, reason: 'offline_read_worker_live' })
    }
  })

  test('a process table that cannot be enumerated refuses it', async () => {
    const seeded = await seedRevivable('crashed', 8 * DAY_MS)
    expect(
      await dryRunEligibility(seeded.runtimeId, {
        listProcessCommands: async () => {
          throw new Error('ps timed out')
        },
      })
    ).toEqual({ eligible: false, reason: 'offline_read_worker_live' })
  })

  test('a live leased-tmux broker pane refuses it', async () => {
    const seeded = await seedRevivable('crashed', 8 * DAY_MS)
    expect(
      await dryRunEligibility(seeded.runtimeId, { probeLiveSubstrate: async () => true })
    ).toEqual({ eligible: false, reason: 'offline_read_worker_live' })
  })

  test('terminated admission is unchanged: no process-table check (R4)', async () => {
    const seeded = await seedOfflineRuntime(fixture, 'full', { status: 'terminated' })
    const dir = dirname(seeded.ledgerPath)
    expect(
      await dryRunEligibility(seeded.runtimeId, {
        listProcessCommands: async () => [`harness-broker --event-ledger ${dir}/events.ndjson`],
      })
    ).toEqual({ eligible: true })
  })
})

describe('T-10632 sweep: R1 release, R3 visibility', () => {
  test('removes an expired, recovered revivable dir with a reason and logs expiry once', async () => {
    const released = await seedRevivable('crashed', 8 * DAY_MS, {
      outcome: 'recovered',
      outcomeClass: 'complete',
    })
    const young = await seedRevivable('crashed', 6 * DAY_MS)

    const { value: first, lines } = await captureServerLog(sweepOnce)
    const { lines: secondLines } = await captureServerLog(sweepOnce)

    expect(first.removedBrokerIpcDirs).toBe(1)
    expect(existsSync(dirname(released.ledgerPath))).toBe(false)
    expect(existsSync(dirname(young.ledgerPath))).toBe(true)

    const expiredLines = [...lines, ...secondLines].filter((line) =>
      line.includes('retained_evidence.revivable_expired')
    )
    expect(expiredLines).toHaveLength(1)
    expect(expiredLines[0]).toContain(released.runtimeId)
    expect(expiredLines[0]).toContain('"status":"crashed"')

    const removed = lines.find((line) => line.includes('broker.orphan_ipc_dir_removed'))
    expect(removed).toContain('"reason":"revivable_expired"')
    expect(removed).toContain(released.runtimeId)
  })

  test('incomplete and paused outcomes stay held and are summarised', async () => {
    const incomplete = await seedRevivable('crashed', 8 * DAY_MS, {
      outcome: 'offline_reader_unsupported',
      outcomeClass: 'incomplete',
    })
    const paused = await seedOfflineRuntime(fixture, 'full', { status: 'terminated' })
    withDb((db) =>
      db.retainedEvidenceOutcomes.append({
        runtimeId: paused.runtimeId,
        invocationId: paused.invocationId,
        recordedAt: new Date().toISOString(),
        outcome: 'paused_needs_disposition',
        outcomeClass: 'retryable',
        trigger: 'startup',
        attempts: 5,
        detail: { schema: 'hrc.offline-evidence/v1', outcome: 'paused_needs_disposition' },
      })
    )

    const { value, lines } = await captureServerLog(sweepOnce)

    expect(value.removedBrokerIpcDirs).toBe(0)
    expect(existsSync(dirname(incomplete.ledgerPath))).toBe(true)
    expect(existsSync(dirname(paused.ledgerPath))).toBe(true)
    const summary = lines.find((line) => line.includes('broker.ipc_dirs_held_by_outcome'))
    expect(summary).toBeDefined()
    const payload = JSON.parse(summary!.slice(summary!.indexOf('{'))) as Record<string, number>
    expect(payload['count']).toBe(2)
    expect(payload['bytes']).toBeGreaterThan(0)
    expect(payload['oldestAgeMs']).toBeGreaterThanOrEqual(8 * DAY_MS - 60_000)
  })
})
