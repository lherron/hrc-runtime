import { describe, expect, test } from 'bun:test'

import {
  Database,
  OLD,
  SCRIPT_PATH,
  ids,
  insertBuffer,
  insertEvent,
  makeStore,
  parsePruneStateRetentionArgs,
  pruneOptions,
  pruneStateRetention,
  runScript,
  seedTerminalAuthority,
} from './prune-hrc-event-deltas.fixture'

describe('prune-hrc-event-deltas writer-lock guards', () => {
  test('writer-lock guards are configurable and validated', () => {
    const defaults = parsePruneStateRetentionArgs([], {})
    expect(defaults.deadlineMillis).toBe(30 * 60 * 1000)
    expect(defaults.paceMillis).toBe(250)
    expect(defaults.maxWriteHoldMillis).toBe(500)
    expect(defaults.incrementalVacuumChunkPages).toBe(100)
    expect(defaults.busyMaxRetries).toBe(8)

    const configured = parsePruneStateRetentionArgs(
      [
        '--deadline-minutes=5',
        '--pace-millis',
        '100',
        '--max-write-hold-millis=750',
        '--incremental-vacuum-chunk-pages',
        '64',
        '--busy-max-retries=2',
      ],
      {}
    )
    expect(configured.deadlineMillis).toBe(5 * 60 * 1000)
    expect(configured.paceMillis).toBe(100)
    expect(configured.maxWriteHoldMillis).toBe(750)
    expect(configured.incrementalVacuumChunkPages).toBe(64)
    expect(configured.busyMaxRetries).toBe(2)

    expect(
      parsePruneStateRetentionArgs([], { HRC_PRUNE_DEADLINE_MINUTES: '2' }).deadlineMillis
    ).toBe(2 * 60 * 1000)
    expect(parsePruneStateRetentionArgs(['--deadline-minutes', '0'], {}).deadlineMillis).toBe(0)
    expect(() => parsePruneStateRetentionArgs(['--deadline-minutes', '-1'], {})).toThrow(
      /non-negative/
    )
    expect(() =>
      parsePruneStateRetentionArgs(['--incremental-vacuum-chunk-pages', '0'], {})
    ).toThrow(/positive/)
  })

  test('the pre-flight eligible scan is skipped under --apply unless requested', () => {
    expect(parsePruneStateRetentionArgs([], {}).countEligible).toBe(true)
    expect(parsePruneStateRetentionArgs(['--apply'], {}).countEligible).toBe(false)
    expect(parsePruneStateRetentionArgs(['--apply', '--count-eligible'], {}).countEligible).toBe(
      true
    )
    expect(parsePruneStateRetentionArgs(['--no-count-eligible'], {}).countEligible).toBe(false)
  })

  test('skipped counts report unknown rather than a fabricated zero', async () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    insertEvent(db, 'turn.message', authority)
    db.close()

    const result = await pruneStateRetention({
      ...pruneOptions(path, true),
      countEligible: false,
    })
    expect(result.deleted).toBe(1)
    expect(result.eligibleCount).toBeNull()
    expect(result.remainingEligibleCount).toBeNull()
    expect(result.tables.events.eligibleCount).toBeNull()
    expect(result.stopReason).toBe('complete')
  })

  test('the duty-cycle budget yields several times longer than each hold', async () => {
    expect(parsePruneStateRetentionArgs([], {}).maxDutyCycle).toBe(0.25)
    expect(parsePruneStateRetentionArgs(['--max-duty-cycle=0.5'], {}).maxDutyCycle).toBe(0.5)
    expect(() => parsePruneStateRetentionArgs(['--max-duty-cycle', '0'], {})).toThrow(
      /greater than 0/
    )
    expect(() => parsePruneStateRetentionArgs(['--max-duty-cycle', '1.5'], {})).toThrow(/at most 1/)

    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    // Big enough rows that each batch has a hold worth pacing against.
    for (let index = 0; index < 8; index += 1) {
      insertBuffer(db, authority.runtimeId, authority.runId, index + 1, OLD, 'x'.repeat(256 * 1024))
    }
    db.close()

    const result = await pruneStateRetention({
      ...pruneOptions(path, true, 1),
      paceMillis: 0,
      maxDutyCycle: 0.25,
      tables: ['runtime_buffers'],
    })
    expect(result.deleted).toBe(8)
    // At a 25% duty cycle the job must spend at least three times as long
    // yielding as it did holding the lock.
    expect(result.heldMillis).toBeGreaterThan(0)
    expect(result.pausedMillis).toBeGreaterThanOrEqual(result.heldMillis * 2)
  })

  test('the writer lock is yielded between delete batches', async () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    for (let index = 0; index < 3; index += 1) {
      insertEvent(db, 'turn.message', authority)
    }
    db.close()

    const result = await pruneStateRetention({
      ...pruneOptions(path, true, 1),
      paceMillis: 20,
    })
    expect(result.deleted).toBe(3)
    // One pause per full batch; the final short batch exits without pausing.
    expect(result.pausedMillis).toBeGreaterThanOrEqual(60)
    expect(result.elapsedMillis).toBeGreaterThanOrEqual(60)
    expect(result.writeSteps).toBeGreaterThanOrEqual(4)
    expect(result.maxObservedWriteHoldMillis).toBeGreaterThanOrEqual(0)
  })

  test('batch size shrinks toward the hold target and never exceeds --batch-size', async () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    // Large rows so a full batch takes measurable time, like runtime_buffers does
    // on the live database.
    for (let index = 0; index < 200; index += 1) {
      insertBuffer(db, authority.runtimeId, authority.runId, index + 1, OLD, 'x'.repeat(64 * 1024))
    }
    db.close()

    // A hold target below any achievable batch time puts every batch over budget,
    // so the size ratchets down to the floor instead of holding the writer lock
    // for a whole table.
    const throttled = await pruneStateRetention({
      ...pruneOptions(path, true, 100),
      maxWriteHoldMillis: 0.0001,
    })
    expect(throttled.deleted).toBe(200)
    expect(throttled.tables.runtime_buffers.batchSize).toBe(25)

    const { path: roomyPath, db: roomyDb } = makeStore()
    const roomyAuthority = seedTerminalAuthority(roomyDb)
    for (let index = 0; index < 200; index += 1) {
      insertBuffer(
        roomyDb,
        roomyAuthority.runtimeId,
        roomyAuthority.runId,
        index + 1,
        OLD,
        'x'.repeat(64 * 1024)
      )
    }
    roomyDb.close()

    // A generous target must never push the batch past the configured ceiling.
    const roomy = await pruneStateRetention({
      ...pruneOptions(roomyPath, true, 100),
      maxWriteHoldMillis: 600_000,
    })
    expect(roomy.deleted).toBe(200)
    expect(roomy.tables.runtime_buffers.batchSize).toBe(100)
  })

  test('the first batch of a table is a small probe, not the configured ceiling', async () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    // Fewer rows than --batch-size: the whole table would otherwise go in one
    // unbounded write step, which is how the live run held the lock for 2.2s.
    for (let index = 0; index < 4000; index += 1) {
      insertEvent(db, 'turn.message', authority)
    }
    db.close()

    const result = await pruneStateRetention({
      ...pruneOptions(path, true, 10_000),
      maxWriteHoldMillis: 600_000,
    })
    expect(result.deleted).toBe(4000)
    // 4000 rows cannot have been taken in one step: the probe starts at 250 and
    // only ramps up as measured holds stay cheap.
    expect(result.writeSteps).toBeGreaterThan(1)
    expect(result.tables.events.batchSize).toBeLessThanOrEqual(10_000)
  })

  test('an expired deadline exits cleanly with partial progress instead of running on', async () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    for (let index = 0; index < 20; index += 1) {
      insertEvent(db, 'turn.message', authority)
    }
    db.close()

    const result = await pruneStateRetention({
      ...pruneOptions(path, true, 1),
      deadlineMillis: 1,
      countEligible: false,
    })
    expect(result.deadlineExceeded).toBe(true)
    expect(result.stopReason).toBe('deadline')
    expect(result.tables.events.stopReason).toBe('deadline')
    expect(result.deleted).toBeLessThan(20)

    const verify = new Database(path)
    try {
      expect(ids(verify, 'events', 'seq').length).toBeGreaterThan(0)
    } finally {
      verify.close()
    }
  })

  test('the freelist is reclaimed in bounded chunks, never one unbounded transaction', async () => {
    const source = await Bun.file(SCRIPT_PATH).text()
    // The 2026-07-28 outage was a single `PRAGMA incremental_vacuum;` draining a
    // 4.97M-page freelist across 4h+ of unbroken writer lock.
    expect(source).not.toMatch(/incremental_vacuum\s*;/)

    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    for (let index = 0; index < 40; index += 1) {
      insertBuffer(db, authority.runtimeId, authority.runId, index + 1, OLD, 'x'.repeat(64 * 1024))
    }
    db.close()

    const result = await pruneStateRetention({
      ...pruneOptions(path, true),
      incrementalVacuumChunkPages: 1,
    })
    expect(result.deleted).toBe(40)
    expect(result.freelistBeforeVacuumPages).toBeGreaterThan(0)
    expect(result.freelistAfterPages).toBe(0)
    expect(result.vacuumStopReason).toBe('complete')
    // Clamped up to the floor, then adapted toward the hold-time target.
    expect(result.vacuumChunkPages).toBeGreaterThanOrEqual(25)
    expect(result.vacuumChunkPages).toBeLessThanOrEqual(10_000)
  })

  test('a contended writer lock backs off and yields instead of spinning or crashing', async () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    insertEvent(db, 'turn.message', authority)
    db.close()

    const holder = new Database(path)
    try {
      holder.exec('BEGIN EXCLUSIVE;')
      const result = await pruneStateRetention({
        ...pruneOptions(path, true, 1),
        busyMaxRetries: 1,
        countEligible: false,
      })
      expect(result.stopReason).toBe('busy')
      expect(result.tables.events.stopReason).toBe('busy')
      expect(result.busyRetries).toBeGreaterThanOrEqual(1)
      expect(result.deleted).toBe(0)
    } finally {
      holder.exec('ROLLBACK;')
      holder.close()
    }
  }, 60_000)

  test('CLI surfaces the guard settings and stop reason and still exits 0', () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    insertBuffer(db, authority.runtimeId, authority.runId, 1)
    db.close()

    const result = runScript(path, '--apply', '--pace-millis', '0', '--deadline-minutes', '5')
    expect(result.exitCode).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.deadlineMinutes).toBe(5)
    expect(report.paceMillis).toBe(0)
    expect(report.countedEligible).toBe(false)
    expect(report.eligibleCount).toBeNull()
    expect(report.deadlineExceeded).toBe(false)
    expect(report.stopReason).toBe('complete')
    expect(report.deleted).toBe(1)
  })
})
