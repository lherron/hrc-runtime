import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { parsePruneStateRetentionArgs, pruneStateRetention } from './prune-hrc-event-deltas'

const SCRIPT_PATH = join(import.meta.dir, 'prune-hrc-event-deltas.ts')
const NOW = new Date('2026-07-18T12:00:00.000Z')
const OLD = '2026-07-14T11:59:59.999Z'
const EVENT_BOUNDARY = '2026-07-15T12:00:00.000Z'
const EVENT_NEW = '2026-07-15T12:00:00.001Z'
const BUFFER_BOUNDARY = '2026-07-17T12:00:00.000Z'
const tempDirs: string[] = []

type ScriptResult = {
  exitCode: number
  stdout: string
  stderr: string
}

function makeStore(incrementalAutoVacuum = true): { path: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'hrc-state-retention-'))
  tempDirs.push(dir)
  const path = join(dir, 'state.sqlite')
  const db = new Database(path)
  if (incrementalAutoVacuum) {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;')
  }
  db.exec(`
    CREATE TABLE runtimes (
      runtime_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      active_run_id TEXT
    );
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE broker_invocations (
      invocation_id TEXT PRIMARY KEY,
      invocation_state TEXT NOT NULL
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      run_id TEXT,
      runtime_id TEXT
    );
    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      source_ref TEXT,
      run_id TEXT,
      runtime_id TEXT
    );
    CREATE TABLE broker_invocation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invocation_id TEXT NOT NULL,
      time TEXT NOT NULL,
      run_id TEXT,
      runtime_id TEXT,
      source_ref TEXT
    );
    CREATE TABLE runtime_buffers (
      runtime_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      chunk_seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, chunk_seq)
    );
  `)
  return { path, db }
}

function seedTerminalAuthority(
  db: Database,
  suffix = 'terminal'
): {
  runtimeId: string
  runId: string
  invocationId: string
} {
  const runtimeId = `runtime-${suffix}`
  const runId = `run-${suffix}`
  const invocationId = `invocation-${suffix}`
  db.prepare('INSERT INTO runtimes (runtime_id, status, active_run_id) VALUES (?, ?, NULL)').run(
    runtimeId,
    'terminated'
  )
  db.prepare('INSERT INTO runs (run_id, status) VALUES (?, ?)').run(runId, 'completed')
  db.prepare('INSERT INTO broker_invocations (invocation_id, invocation_state) VALUES (?, ?)').run(
    invocationId,
    'exited'
  )
  return { runtimeId, runId, invocationId }
}

function insertEvent(
  db: Database,
  eventKind: string,
  options: { ts?: string; runId?: string; runtimeId?: string } = {}
): number {
  return Number(
    db
      .prepare('INSERT INTO events (ts, event_kind, run_id, runtime_id) VALUES (?, ?, ?, ?)')
      .run(options.ts ?? OLD, eventKind, options.runId ?? null, options.runtimeId ?? null)
      .lastInsertRowid
  )
}

function insertHrcEvent(
  db: Database,
  eventKind: string,
  options: { ts?: string; runId?: string; runtimeId?: string; sourceRef?: string } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO hrc_events
          (ts, event_kind, source_ref, run_id, runtime_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        options.ts ?? OLD,
        eventKind,
        options.sourceRef ?? null,
        options.runId ?? null,
        options.runtimeId ?? null
      ).lastInsertRowid
  )
}

function insertBrokerEvent(
  db: Database,
  invocationId: string,
  options: { time?: string; runId?: string; runtimeId?: string; sourceRef?: string } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO broker_invocation_events
          (invocation_id, time, run_id, runtime_id, source_ref)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        invocationId,
        options.time ?? OLD,
        options.runId ?? null,
        options.runtimeId ?? null,
        options.sourceRef ?? null
      ).lastInsertRowid
  )
}

function insertBuffer(
  db: Database,
  runtimeId: string,
  runId: string,
  chunkSeq: number,
  createdAt = OLD,
  text = 'buffer'
): void {
  db.prepare(
    `INSERT INTO runtime_buffers (runtime_id, run_id, chunk_seq, text, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(runtimeId, runId, chunkSeq, text, createdAt)
}

function ids(db: Database, table: string, key: string): number[] {
  return db
    .query<Record<string, number>, []>(`SELECT ${key} FROM ${table} ORDER BY ${key} ASC`)
    .all()
    .map((row) => row[key] ?? -1)
}

function pruneOptions(path: string, apply: boolean, batchSize = 10_000) {
  return {
    dbPath: path,
    apply,
    batchSize,
    checkpoint: false,
    eventRetentionDays: 3,
    runtimeBufferRetentionDays: 1,
    incrementalVacuumPages: 0,
    incrementalVacuumChunkPages: 200,
    deadlineMillis: 60_000,
    paceMillis: 0,
    maxWriteHoldMillis: 500,
    busyMaxRetries: 8,
    countEligible: true,
    tables: ['events', 'hrc_events', 'broker_invocation_events', 'runtime_buffers'] as const,
    now: NOW,
  }
}

function runScript(path: string, ...args: string[]): ScriptResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT_PATH, '--db', path, '--no-checkpoint', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('prune-hrc-event-deltas bounded state retention', () => {
  test('defaults are configurable by CLI and environment', () => {
    const defaults = parsePruneStateRetentionArgs([], {})
    expect(defaults.eventRetentionDays).toBe(3)
    expect(defaults.runtimeBufferRetentionDays).toBe(1)
    expect(defaults.incrementalVacuumPages).toBe(0)

    const configured = parsePruneStateRetentionArgs(
      ['--event-retention-days', '4.5', '--incremental-vacuum-pages=2500'],
      { HRC_RUNTIME_BUFFER_RETENTION_DAYS: '2' }
    )
    expect(configured.eventRetentionDays).toBe(4.5)
    expect(configured.runtimeBufferRetentionDays).toBe(2)
    expect(configured.incrementalVacuumPages).toBe(2500)
  })

  test('rejects full VACUUM and invalid retention configuration', () => {
    expect(() => parsePruneStateRetentionArgs(['--vacuum'], {})).toThrow(/offline/i)
    expect(() => parsePruneStateRetentionArgs(['--event-retention-days', '0'], {})).toThrow(
      /positive/
    )
    expect(() => parsePruneStateRetentionArgs(['--batch-size', '0'], {})).toThrow(/positive/)
    expect(() => parsePruneStateRetentionArgs(['--incremental-vacuum-pages', '-1'], {})).toThrow(
      /non-negative/
    )
  })

  test('prunes all four observation tables at their parameterized boundaries', async () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)

    const oldEvent = insertEvent(db, 'turn.message', authority)
    const boundaryEvent = insertEvent(db, 'turn.message', {
      ...authority,
      ts: EVENT_BOUNDARY,
    })
    const newEvent = insertEvent(db, 'turn.message', { ...authority, ts: EVENT_NEW })

    const oldHrcEvent = insertHrcEvent(db, 'turn.message', authority)
    const boundaryHrcEvent = insertHrcEvent(db, 'turn.message', {
      ...authority,
      ts: EVENT_BOUNDARY,
    })
    const oldBrokerEvent = insertBrokerEvent(db, authority.invocationId, authority)
    const boundaryBrokerEvent = insertBrokerEvent(db, authority.invocationId, {
      ...authority,
      time: EVENT_BOUNDARY,
    })
    insertBuffer(db, authority.runtimeId, authority.runId, 1)
    insertBuffer(db, authority.runtimeId, authority.runId, 2, BUFFER_BOUNDARY)
    db.close()

    const result = await pruneStateRetention(pruneOptions(path, true, 1))

    expect(result.deleted).toBe(4)
    expect(result.tables.events.deleted).toBe(1)
    expect(result.tables.hrc_events.deleted).toBe(1)
    expect(result.tables.broker_invocation_events.deleted).toBe(1)
    expect(result.tables.runtime_buffers.deleted).toBe(1)
    expect(result.remainingEligibleCount).toBe(0)

    const verify = new Database(path)
    try {
      expect(ids(verify, 'events', 'seq')).toEqual([boundaryEvent, newEvent])
      expect(ids(verify, 'events', 'seq')).not.toContain(oldEvent)
      expect(ids(verify, 'hrc_events', 'hrc_seq')).toEqual([boundaryHrcEvent])
      expect(ids(verify, 'hrc_events', 'hrc_seq')).not.toContain(oldHrcEvent)
      expect(ids(verify, 'broker_invocation_events', 'id')).toEqual([boundaryBrokerEvent])
      expect(ids(verify, 'broker_invocation_events', 'id')).not.toContain(oldBrokerEvent)
      expect(
        verify.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_buffers').get()
          ?.count
      ).toBe(1)
    } finally {
      verify.close()
    }
  })

  test('resume barriers remain permanently exempt at the SQL layer', async () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    const rawBarrier = insertEvent(db, 'broker.continuation.cleared', authority)
    const hrcBarriers = [
      'session.continuation_dropped',
      'context.cleared',
      'runtime.terminated',
      'broker.continuation.cleared',
    ].map((eventKind) => insertHrcEvent(db, eventKind, authority))
    const ordinary = insertHrcEvent(db, 'turn.message', authority)
    db.close()

    await pruneStateRetention({
      ...pruneOptions(path, true),
      now: new Date('2099-01-01T00:00:00.000Z'),
    })

    const verify = new Database(path)
    try {
      expect(ids(verify, 'events', 'seq')).toEqual([rawBarrier])
      expect(ids(verify, 'hrc_events', 'hrc_seq')).toEqual(hrcBarriers)
      expect(ids(verify, 'hrc_events', 'hrc_seq')).not.toContain(ordinary)
    } finally {
      verify.close()
    }
  })

  test('wrong future cutoffs cannot delete active or nonterminal authority', async () => {
    const { path, db } = makeStore()
    db.exec(`
      INSERT INTO runtimes (runtime_id, status, active_run_id)
        VALUES ('runtime-active', 'busy', 'run-active');
      INSERT INTO runs (run_id, status) VALUES ('run-active', 'running');
      INSERT INTO broker_invocations (invocation_id, invocation_state)
        VALUES ('invocation-active', 'running');
    `)
    const raw = insertEvent(db, 'turn.message', {
      runId: 'run-active',
      runtimeId: 'runtime-active',
    })
    const hrc = insertHrcEvent(db, 'turn.message', {
      runId: 'run-active',
      runtimeId: 'runtime-active',
    })
    const broker = insertBrokerEvent(db, 'invocation-active', {
      runId: 'run-active',
      runtimeId: 'runtime-active',
    })
    insertBuffer(db, 'runtime-active', 'run-active', 1)
    db.close()

    const result = await pruneStateRetention({
      ...pruneOptions(path, true),
      now: new Date('2099-01-01T00:00:00.000Z'),
    })
    expect(result.deleted).toBe(0)

    const verify = new Database(path)
    try {
      expect(ids(verify, 'events', 'seq')).toEqual([raw])
      expect(ids(verify, 'hrc_events', 'hrc_seq')).toEqual([hrc])
      expect(ids(verify, 'broker_invocation_events', 'id')).toEqual([broker])
      expect(
        verify.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_buffers').get()
          ?.count
      ).toBe(1)
    } finally {
      verify.close()
    }
  })

  test('completed run observations can expire on a reusable runtime but its buffers cannot', async () => {
    const { path, db } = makeStore()
    db.exec(`
      INSERT INTO runtimes (runtime_id, status, active_run_id)
        VALUES ('runtime-ready', 'ready', NULL);
      INSERT INTO runs (run_id, status) VALUES ('run-old', 'completed');
      INSERT INTO broker_invocations (invocation_id, invocation_state)
        VALUES ('invocation-old', 'exited');
    `)
    insertEvent(db, 'turn.completed', { runId: 'run-old', runtimeId: 'runtime-ready' })
    insertHrcEvent(db, 'turn.completed', { runId: 'run-old', runtimeId: 'runtime-ready' })
    insertBrokerEvent(db, 'invocation-old', {
      runId: 'run-old',
      runtimeId: 'runtime-ready',
    })
    insertBuffer(db, 'runtime-ready', 'run-old', 1)
    db.close()

    const result = await pruneStateRetention(pruneOptions(path, true))
    expect(result.tables.events.deleted).toBe(1)
    expect(result.tables.hrc_events.deleted).toBe(1)
    expect(result.tables.broker_invocation_events.deleted).toBe(1)
    expect(result.tables.runtime_buffers.deleted).toBe(0)
  })

  test('imported observations ride the event TTL without local authority rows', async () => {
    const { path, db } = makeStore()
    const importedHrc = insertHrcEvent(db, 'turn.message', { sourceRef: 'node:lab' })
    const importedBroker = insertBrokerEvent(db, 'remote-invocation', {
      sourceRef: 'node:lab',
    })
    const importedBarrier = insertHrcEvent(db, 'runtime.terminated', {
      sourceRef: 'node:lab',
    })
    db.close()

    await pruneStateRetention(pruneOptions(path, true))

    const verify = new Database(path)
    try {
      expect(ids(verify, 'hrc_events', 'hrc_seq')).toEqual([importedBarrier])
      expect(ids(verify, 'hrc_events', 'hrc_seq')).not.toContain(importedHrc)
      expect(ids(verify, 'broker_invocation_events', 'id')).not.toContain(importedBroker)
    } finally {
      verify.close()
    }
  })

  test('apply fails before deletion when incremental auto-vacuum is not installed', async () => {
    const { path, db } = makeStore(false)
    const authority = seedTerminalAuthority(db)
    const oldEvent = insertEvent(db, 'turn.message', authority)
    db.close()

    await expect(pruneStateRetention(pruneOptions(path, true))).rejects.toThrow(
      /auto_vacuum mode is 0/
    )

    const verify = new Database(path)
    try {
      expect(ids(verify, 'events', 'seq')).toEqual([oldEvent])
    } finally {
      verify.close()
    }
  })

  test('dry-run reports all tables without deleting and apply reclaims the freelist', async () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    for (let index = 0; index < 40; index += 1) {
      insertHrcEvent(db, 'turn.message', authority)
      insertBuffer(db, authority.runtimeId, authority.runId, index + 1, OLD, 'x'.repeat(64 * 1024))
    }
    db.close()

    const dryRun = await pruneStateRetention(pruneOptions(path, false))
    expect(dryRun.eligibleCount).toBe(80)
    expect(dryRun.deleted).toBe(0)

    const apply = await pruneStateRetention(pruneOptions(path, true, 7))
    expect(apply.deleted).toBe(80)
    expect(apply.freelistBeforeVacuumPages).toBeGreaterThan(0)
    expect(apply.freelistAfterPages).toBe(0)
    expect(apply.reclaimedPages).toBeGreaterThan(0)
  })

  test('CLI reports configured cutoffs and fails loudly for a missing store', () => {
    const { path, db } = makeStore()
    db.close()
    const result = runScript(
      path,
      '--event-retention-days',
      '5',
      '--runtime-buffer-retention-days',
      '2'
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout)
    expect(report.eventRetentionDays).toBe(5)
    expect(report.runtimeBufferRetentionDays).toBe(2)
    expect(report.tables).toHaveProperty('hrc_events')
    expect(report.tables).toHaveProperty('runtime_buffers')

    const missing = runScript(join(tmpdir(), 'hrc-retention-missing', 'state.sqlite'))
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr).toMatch(/does not exist/i)
  })
})

describe('prune-hrc-event-deltas keeps non-delta events indefinitely', () => {
  test('only runtime_buffers is selected unless event tables are named explicitly', () => {
    // Lance ruling 2026-07-28: non-delta observation events retain forever.
    expect(parsePruneStateRetentionArgs([], {}).tables).toEqual(['runtime_buffers'])
    expect(parsePruneStateRetentionArgs(['--apply'], {}).tables).toEqual(['runtime_buffers'])

    expect(parsePruneStateRetentionArgs(['--tables', 'all'], {}).tables).toEqual([
      'events',
      'hrc_events',
      'broker_invocation_events',
      'runtime_buffers',
    ])
    expect(parsePruneStateRetentionArgs(['--tables=hrc_events,events'], {}).tables).toEqual([
      'events',
      'hrc_events',
    ])
    expect(() => parsePruneStateRetentionArgs(['--tables', 'runs'], {})).toThrow(/unknown table/i)
    expect(() => parsePruneStateRetentionArgs(['--tables', ' '], {})).toThrow(/at least one/i)
  })

  test('a default apply deletes aged buffers and leaves every event table intact', async () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    // All of these are past the cutoff and would have been deleted before the
    // amendment.
    const event = insertEvent(db, 'turn.message', authority)
    const hrcEvent = insertHrcEvent(db, 'turn.message', authority)
    const brokerEvent = insertBrokerEvent(db, authority.invocationId, authority)
    insertBuffer(db, authority.runtimeId, authority.runId, 1)
    db.close()

    const result = await pruneStateRetention({
      ...pruneOptions(path, true),
      tables: parsePruneStateRetentionArgs(['--apply'], {}).tables,
    })

    expect(result.tables.runtime_buffers.deleted).toBe(1)
    expect(result.deleted).toBe(1)
    expect(result.tables.events.deleted).toBe(0)
    expect(result.tables.events.stopReason).toBe('skipped')
    expect(result.tables.hrc_events.stopReason).toBe('skipped')
    expect(result.tables.broker_invocation_events.stopReason).toBe('skipped')
    // Skipping is a configuration choice, not an interruption.
    expect(result.stopReason).toBe('complete')

    const verify = new Database(path)
    try {
      expect(ids(verify, 'events', 'seq')).toEqual([event])
      expect(ids(verify, 'hrc_events', 'hrc_seq')).toEqual([hrcEvent])
      expect(ids(verify, 'broker_invocation_events', 'id')).toEqual([brokerEvent])
      expect(
        verify.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_buffers').get()
          ?.count
      ).toBe(0)
    } finally {
      verify.close()
    }
  })

  test('CLI defaults leave event rows untouched even with a far-future cutoff', () => {
    const { path, db } = makeStore()
    const authority = seedTerminalAuthority(db)
    insertEvent(db, 'turn.message', authority)
    insertHrcEvent(db, 'turn.message', authority)
    insertBrokerEvent(db, authority.invocationId, authority)
    db.close()

    const result = runScript(path, '--apply', '--event-retention-days', '0.0001')
    expect(result.exitCode).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.tables.events.stopReason).toBe('skipped')
    expect(report.deleted).toBe(0)

    const verify = new Database(path)
    try {
      expect(ids(verify, 'events', 'seq').length).toBe(1)
      expect(ids(verify, 'hrc_events', 'hrc_seq').length).toBe(1)
      expect(ids(verify, 'broker_invocation_events', 'id').length).toBe(1)
    } finally {
      verify.close()
    }
  })
})

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
