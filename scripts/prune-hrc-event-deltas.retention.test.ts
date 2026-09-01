import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUFFER_BOUNDARY,
  Database,
  EVENT_BOUNDARY,
  EVENT_NEW,
  OLD,
  ids,
  insertBrokerEvent,
  insertBuffer,
  insertEvent,
  insertHrcEvent,
  makeProductStore,
  makeStore,
  parsePruneStateRetentionArgs,
  pruneOptions,
  pruneStateRetention,
  runScript,
  seedTerminalAuthority,
} from './prune-hrc-event-deltas.fixture'

describe('prune-hrc-event-deltas bounded state retention', () => {
  test('a fresh product database is born incrementally vacuumable and accepts its first apply', async () => {
    const { path, db } = makeProductStore()
    try {
      expect(db.sqlite.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()).toEqual({
        auto_vacuum: 2,
      })
    } finally {
      db.close()
    }

    const result = await pruneStateRetention({
      ...pruneOptions(path, true),
      tables: ['runtime_buffers'],
    })
    expect(result.autoVacuumMode).toBe(2)
    expect(result.stopReason).toBe('complete')
    expect(result.deleted).toBe(0)
  })

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
    const newEvent = insertEvent(db, 'turn.message', {
      ...authority,
      ts: EVENT_NEW,
    })

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
    insertEvent(db, 'turn.completed', {
      runId: 'run-old',
      runtimeId: 'runtime-ready',
    })
    insertHrcEvent(db, 'turn.completed', {
      runId: 'run-old',
      runtimeId: 'runtime-ready',
    })
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
    const importedHrc = insertHrcEvent(db, 'turn.message', {
      sourceRef: 'node:lab',
    })
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
