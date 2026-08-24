import { describe, expect, test } from 'bun:test'

import {
  Database,
  ids,
  insertBrokerEvent,
  insertBuffer,
  insertEvent,
  insertHrcEvent,
  makeStore,
  parsePruneStateRetentionArgs,
  pruneOptions,
  pruneStateRetention,
  runScript,
  seedTerminalAuthority,
} from './prune-hrc-event-deltas.fixture'

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

describe('prune-hrc-event-deltas T-07045 backlog purge', () => {
  test('selects its fixed tables and cannot be mixed with retention table selection', () => {
    const options = parsePruneStateRetentionArgs(['--purge-delta-backlog'], {})
    expect(options.operation).toBe('purge-delta-backlog')
    expect(options.expectedT07040BackfillRows).toBe(822)
    expect(options.tables).toEqual(['events', 'broker_invocation_events'])
    expect(() =>
      parsePruneStateRetentionArgs(
        ['--purge-delta-backlog', '--tables', 'broker_invocation_events'],
        {}
      )
    ).toThrow(/table set is fixed/i)
  })

  test('purges every raw broker mirror and only terminal invocation deltas', async () => {
    const { path, db } = makeStore()
    const terminal = seedTerminalAuthority(db)
    db.prepare(
      'INSERT INTO broker_invocations (invocation_id, invocation_state) VALUES (?, ?)'
    ).run('invocation-live', 'turn_active')

    const ordinaryRaw = insertEvent(db, 'turn.message')
    insertEvent(db, 'broker.assistant.message.delta')
    insertEvent(db, 'broker.continuation.cleared')

    insertBrokerEvent(db, terminal.invocationId, {
      ...terminal,
      type: 'assistant.message.delta',
    })
    insertBrokerEvent(db, terminal.invocationId, {
      ...terminal,
      type: 'tool.call.delta',
    })
    const terminalSemantic = insertBrokerEvent(db, terminal.invocationId, {
      ...terminal,
      type: 'assistant.message.completed',
    })
    const liveDelta = insertBrokerEvent(db, 'invocation-live', {
      type: 'assistant.message.delta',
    })
    const orphanDelta = insertBrokerEvent(db, 'invocation-orphan', {
      type: 'tool.call.delta',
    })
    const backfillRows = [
      insertBrokerEvent(db, 'backfill-a', {
        type: 'continuation.cleared',
        sourceRef: 'backfill-T-07040',
      }),
      insertBrokerEvent(db, 'backfill-b', {
        type: 'continuation.cleared',
        sourceRef: 'backfill-T-07040',
      }),
    ]
    db.close()

    const result = await pruneStateRetention({
      ...pruneOptions(path, true),
      operation: 'purge-delta-backlog',
      expectedT07040BackfillRows: 2,
      tables: ['events', 'broker_invocation_events'],
      paceMillis: 250,
      maxDutyCycle: 0.25,
    })

    expect(result.operation).toBe('purge-delta-backlog')
    expect(result.tables.events.deleted).toBe(2)
    expect(result.tables.broker_invocation_events.deleted).toBe(3)
    expect(result.t07040BackfillRowsBefore).toBe(2)
    expect(result.t07040BackfillRowsAfter).toBe(2)

    const verify = new Database(path)
    try {
      expect(ids(verify, 'events', 'seq')).toEqual([ordinaryRaw])
      expect(ids(verify, 'broker_invocation_events', 'id')).toEqual([
        terminalSemantic,
        liveDelta,
        ...backfillRows,
      ])
      expect(ids(verify, 'broker_invocation_events', 'id')).not.toContain(orphanDelta)
    } finally {
      verify.close()
    }
  })

  test('refuses all deletion before an unexpected backfill count can lose authority', async () => {
    const { path, db } = makeStore()
    const terminal = seedTerminalAuthority(db)
    const rawBroker = insertEvent(db, 'broker.assistant.message.delta')
    insertBrokerEvent(db, terminal.invocationId, {
      ...terminal,
      type: 'assistant.message.delta',
    })
    insertBrokerEvent(db, 'backfill-a', {
      type: 'continuation.cleared',
      sourceRef: 'backfill-T-07040',
    })
    db.close()

    await expect(
      pruneStateRetention({
        ...pruneOptions(path, true),
        operation: 'purge-delta-backlog',
        expectedT07040BackfillRows: 2,
        tables: ['events', 'broker_invocation_events'],
        paceMillis: 250,
        maxDutyCycle: 0.25,
      })
    ).rejects.toThrow(/backfill invariant failed before purge/i)

    const verify = new Database(path)
    try {
      expect(ids(verify, 'events', 'seq')).toEqual([rawBroker])
      expect(ids(verify, 'broker_invocation_events', 'id')).toHaveLength(2)
    } finally {
      verify.close()
    }
  })

  test('refuses guard settings hotter than the armed cron', async () => {
    const { path, db } = makeStore()
    db.close()
    const options = {
      ...pruneOptions(path, false),
      operation: 'purge-delta-backlog' as const,
      tables: ['events', 'broker_invocation_events'] as const,
      paceMillis: 250,
      maxWriteHoldMillis: 500,
      maxDutyCycle: 0.25,
    }

    await expect(pruneStateRetention({ ...options, deadlineMillis: 0 })).rejects.toThrow(
      /bounded.*deadline/i
    )
    await expect(pruneStateRetention({ ...options, paceMillis: 249 })).rejects.toThrow(
      /pace-millis >= 250/i
    )
    await expect(pruneStateRetention({ ...options, maxWriteHoldMillis: 501 })).rejects.toThrow(
      /max-write-hold-millis <= 500/i
    )
    await expect(pruneStateRetention({ ...options, maxDutyCycle: 0.251 })).rejects.toThrow(
      /max-duty-cycle <= 0.25/i
    )
  })
})
