#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'

const DEFAULT_HRC_STORE_PATH = '/Users/lherron/praesidium/var/state/hrc/state.sqlite'
const DEFAULT_EVENT_RETENTION_DAYS = 3
const DEFAULT_RUNTIME_BUFFER_RETENTION_DAYS = 1
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

const TERMINAL_RUN_STATUSES_SQL = "'completed', 'failed', 'cancelled', 'zombie'"
const TERMINAL_RUNTIME_STATUSES_SQL = "'terminated', 'dead', 'stale', 'crashed'"
const TERMINAL_INVOCATION_STATES_SQL = "'exited', 'failed', 'disposed'"

/**
 * These event kinds are durable resume barriers. They remain exempt even when
 * the payload does not represent a barrier (for example stale auto-rotation);
 * the small over-retention makes a malformed payload fail closed.
 */
const RESUME_BARRIER_EVENT_KINDS_SQL = `
  'session.continuation_dropped',
  'context.cleared',
  'runtime.terminated',
  'broker.continuation.cleared'
`

const EVENTS_ELIGIBLE_SQL = `
  e.ts < ?
  AND e.event_kind NOT IN (${RESUME_BARRIER_EVENT_KINDS_SQL})
  AND (
    e.run_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM runs AS run
      WHERE run.run_id = e.run_id
        AND run.status IN (${TERMINAL_RUN_STATUSES_SQL})
    )
  )
  AND (
    e.runtime_id IS NULL
    OR (
      e.run_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM runtimes AS current_runtime
        WHERE current_runtime.runtime_id = e.runtime_id
          AND current_runtime.active_run_id = e.run_id
      )
    )
    OR EXISTS (
      SELECT 1
      FROM runtimes AS terminal_runtime
      WHERE terminal_runtime.runtime_id = e.runtime_id
        AND terminal_runtime.status IN (${TERMINAL_RUNTIME_STATUSES_SQL})
        AND terminal_runtime.active_run_id IS NULL
    )
  )
`

const HRC_EVENTS_ELIGIBLE_SQL = `
  e.ts < ?
  AND e.event_kind NOT IN (${RESUME_BARRIER_EVENT_KINDS_SQL})
  AND (
    e.source_ref IS NOT NULL
    OR (
      (
        e.run_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM runs AS run
          WHERE run.run_id = e.run_id
            AND run.status IN (${TERMINAL_RUN_STATUSES_SQL})
        )
      )
      AND (
        e.runtime_id IS NULL
        OR (
          e.run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM runtimes AS current_runtime
            WHERE current_runtime.runtime_id = e.runtime_id
              AND current_runtime.active_run_id = e.run_id
          )
        )
        OR EXISTS (
          SELECT 1
          FROM runtimes AS terminal_runtime
          WHERE terminal_runtime.runtime_id = e.runtime_id
            AND terminal_runtime.status IN (${TERMINAL_RUNTIME_STATUSES_SQL})
            AND terminal_runtime.active_run_id IS NULL
        )
      )
    )
  )
`

const BROKER_INVOCATION_EVENTS_ELIGIBLE_SQL = `
  e.time < ?
  AND (
    e.source_ref IS NOT NULL
    OR (
      EXISTS (
        SELECT 1
        FROM broker_invocations AS invocation
        WHERE invocation.invocation_id = e.invocation_id
          AND invocation.invocation_state IN (${TERMINAL_INVOCATION_STATES_SQL})
      )
      AND (
        e.run_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM runs AS run
          WHERE run.run_id = e.run_id
            AND run.status IN (${TERMINAL_RUN_STATUSES_SQL})
        )
      )
      AND (
        e.runtime_id IS NULL
        OR (
          e.run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM runtimes AS current_runtime
            WHERE current_runtime.runtime_id = e.runtime_id
              AND current_runtime.active_run_id = e.run_id
          )
        )
        OR EXISTS (
          SELECT 1
          FROM runtimes AS terminal_runtime
          WHERE terminal_runtime.runtime_id = e.runtime_id
            AND terminal_runtime.status IN (${TERMINAL_RUNTIME_STATUSES_SQL})
            AND terminal_runtime.active_run_id IS NULL
        )
      )
    )
  )
`

const RUNTIME_BUFFERS_ELIGIBLE_SQL = `
  e.created_at < ?
  AND EXISTS (
    SELECT 1
    FROM runs AS run
    WHERE run.run_id = e.run_id
      AND run.status IN (${TERMINAL_RUN_STATUSES_SQL})
  )
  AND EXISTS (
    SELECT 1
    FROM runtimes AS runtime
    WHERE runtime.runtime_id = e.runtime_id
      AND runtime.status IN (${TERMINAL_RUNTIME_STATUSES_SQL})
      AND runtime.active_run_id IS NULL
  )
`

export type PruneStateRetentionOptions = {
  dbPath: string
  apply: boolean
  batchSize: number
  checkpoint: boolean
  eventRetentionDays: number
  runtimeBufferRetentionDays: number
  incrementalVacuumPages: number
  now: Date
}

export type PruneRetentionTableResult = {
  eligibleCount: number
  deleted: number
  remainingEligibleCount: number
}

export type PruneStateRetentionResult = {
  eventCutoff: string
  runtimeBufferCutoff: string
  eligibleCount: number
  deleted: number
  remainingEligibleCount: number
  autoVacuumMode: number
  freelistBeforePages: number
  freelistBeforeVacuumPages: number
  freelistAfterPages: number
  reclaimedPages: number
  tables: {
    events: PruneRetentionTableResult
    hrc_events: PruneRetentionTableResult
    broker_invocation_events: PruneRetentionTableResult
    runtime_buffers: PruneRetentionTableResult
  }
}

type RetentionTable = keyof PruneStateRetentionResult['tables']

type TablePlan = {
  table: RetentionTable
  alias: string
  keyColumn: string
  cutoff: string
  eligibleSql: string
}

function usage(): string {
  return [
    'Usage: bun scripts/prune-hrc-event-deltas.ts [options]',
    '',
    'Applies bounded retention to HRC observation tables. Without --apply, reports',
    'eligible counts only. Resume barriers and active/nonterminal work are always exempt.',
    '',
    'Options:',
    '  --db <path>                         state.sqlite path',
    '  --apply                             delete eligible rows',
    '  --batch-size <n>                    rows per DELETE (default: 10000)',
    '  --event-retention-days <n>          event history TTL (default: 3)',
    '  --runtime-buffer-retention-days <n> terminal buffer TTL (default: 1)',
    '  --incremental-vacuum-pages <n>      pages reclaimed after apply; 0 = all (default: 0)',
    '  --no-checkpoint                     skip WAL checkpoint after apply',
    '',
    'Environment fallbacks:',
    '  HRC_EVENT_RETENTION_DAYS',
    '  HRC_RUNTIME_BUFFER_RETENTION_DAYS',
    '  HRC_INCREMENTAL_VACUUM_PAGES',
  ].join('\n')
}

function readArgValue(args: string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`))
  if (inline !== undefined) {
    return inline.slice(flag.length + 1)
  }
  const index = args.indexOf(flag)
  if (index >= 0) {
    return args[index + 1]
  }
  return undefined
}

function resolveDefaultDbPath(env: Record<string, string | undefined>): string {
  const stateDir = env['HRC_STATE_DIR']
  if (stateDir !== undefined && stateDir.trim().length > 0) {
    return join(stateDir, 'state.sqlite')
  }
  return DEFAULT_HRC_STORE_PATH
}

function parsePositiveNumber(raw: string | undefined, fallback: number, flag: string): number {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive number`)
  }
  return value
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number, flag: string): number {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer`)
  }
  return value
}

export function parsePruneStateRetentionArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env
): PruneStateRetentionOptions {
  if (args.includes('--help') || args.includes('-h')) {
    throw new Error(usage())
  }
  if (args.includes('--vacuum')) {
    throw new Error(
      '--vacuum is not supported: full VACUUM requires a coordinated offline maintenance window'
    )
  }

  const batchSize = parseNonNegativeInteger(
    readArgValue(args, '--batch-size'),
    10_000,
    '--batch-size'
  )
  if (batchSize === 0) {
    throw new Error('--batch-size must be a positive integer')
  }

  return {
    dbPath: readArgValue(args, '--db') ?? resolveDefaultDbPath(env),
    apply: args.includes('--apply'),
    batchSize,
    checkpoint: !args.includes('--no-checkpoint'),
    eventRetentionDays: parsePositiveNumber(
      readArgValue(args, '--event-retention-days') ?? env['HRC_EVENT_RETENTION_DAYS'],
      DEFAULT_EVENT_RETENTION_DAYS,
      '--event-retention-days'
    ),
    runtimeBufferRetentionDays: parsePositiveNumber(
      readArgValue(args, '--runtime-buffer-retention-days') ??
        env['HRC_RUNTIME_BUFFER_RETENTION_DAYS'],
      DEFAULT_RUNTIME_BUFFER_RETENTION_DAYS,
      '--runtime-buffer-retention-days'
    ),
    incrementalVacuumPages: parseNonNegativeInteger(
      readArgValue(args, '--incremental-vacuum-pages') ?? env['HRC_INCREMENTAL_VACUUM_PAGES'],
      0,
      '--incremental-vacuum-pages'
    ),
    now: new Date(),
  }
}

function countEligible(db: Database, plan: TablePlan): number {
  return (
    db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
           FROM ${plan.table} AS ${plan.alias}
          WHERE ${plan.eligibleSql}`
      )
      .get(plan.cutoff)?.count ?? 0
  )
}

function deleteBatch(db: Database, plan: TablePlan, batchSize: number): number {
  return db
    .prepare<never, [string, number]>(
      `DELETE FROM ${plan.table}
        WHERE ${plan.keyColumn} IN (
          SELECT ${plan.alias}.${plan.keyColumn}
            FROM ${plan.table} AS ${plan.alias}
           WHERE ${plan.eligibleSql}
           ORDER BY ${plan.alias}.${plan.keyColumn} ASC
           LIMIT ?
        )`
    )
    .run(plan.cutoff, batchSize).changes
}

function deleteInBatches(db: Database, plan: TablePlan, batchSize: number): number {
  let deleted = 0
  while (true) {
    const batchDeleted = deleteBatch(db, plan, batchSize)
    deleted += batchDeleted
    if (batchDeleted < batchSize) {
      return deleted
    }
  }
}

function readPragmaNumber(db: Database, pragma: 'auto_vacuum' | 'freelist_count'): number {
  const row = db.query<Record<string, number>, []>(`PRAGMA ${pragma}`).get()
  return row ? (Object.values(row)[0] ?? 0) : 0
}

function assertIncrementalAutoVacuum(db: Database): number {
  const mode = readPragmaNumber(db, 'auto_vacuum')
  if (mode !== 2) {
    throw new Error(
      `state.sqlite auto_vacuum mode is ${mode}, expected 2 (INCREMENTAL); refusing to delete rows until a coordinated full VACUUM has installed the pointer map`
    )
  }
  return mode
}

function incrementalVacuum(db: Database, pages: number): void {
  if (pages === 0) {
    db.exec('PRAGMA incremental_vacuum;')
    return
  }
  db.exec(`PRAGMA incremental_vacuum(${pages});`)
}

export function pruneStateRetention(
  options: PruneStateRetentionOptions
): PruneStateRetentionResult {
  if (!existsSync(options.dbPath)) {
    throw new Error(`HRC store does not exist: ${options.dbPath}`)
  }

  const eventCutoff = new Date(
    options.now.getTime() - options.eventRetentionDays * MILLISECONDS_PER_DAY
  ).toISOString()
  const runtimeBufferCutoff = new Date(
    options.now.getTime() - options.runtimeBufferRetentionDays * MILLISECONDS_PER_DAY
  ).toISOString()
  const plans: TablePlan[] = [
    {
      table: 'events',
      alias: 'e',
      keyColumn: 'seq',
      cutoff: eventCutoff,
      eligibleSql: EVENTS_ELIGIBLE_SQL,
    },
    {
      table: 'hrc_events',
      alias: 'e',
      keyColumn: 'hrc_seq',
      cutoff: eventCutoff,
      eligibleSql: HRC_EVENTS_ELIGIBLE_SQL,
    },
    {
      table: 'broker_invocation_events',
      alias: 'e',
      keyColumn: 'id',
      cutoff: eventCutoff,
      eligibleSql: BROKER_INVOCATION_EVENTS_ELIGIBLE_SQL,
    },
    {
      table: 'runtime_buffers',
      alias: 'e',
      keyColumn: 'rowid',
      cutoff: runtimeBufferCutoff,
      eligibleSql: RUNTIME_BUFFERS_ELIGIBLE_SQL,
    },
  ]

  const db = new Database(options.dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    const autoVacuumMode = readPragmaNumber(db, 'auto_vacuum')
    if (options.apply) {
      assertIncrementalAutoVacuum(db)
    }
    const freelistBeforePages = readPragmaNumber(db, 'freelist_count')
    const eligible = Object.fromEntries(
      plans.map((plan) => [plan.table, countEligible(db, plan)])
    ) as Record<RetentionTable, number>
    const deleted = {
      events: 0,
      hrc_events: 0,
      broker_invocation_events: 0,
      runtime_buffers: 0,
    } satisfies Record<RetentionTable, number>
    let freelistBeforeVacuumPages = freelistBeforePages

    if (options.apply) {
      for (const plan of plans) {
        deleted[plan.table] = deleteInBatches(db, plan, options.batchSize)
      }
      if (options.checkpoint) {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      }
      freelistBeforeVacuumPages = readPragmaNumber(db, 'freelist_count')
      incrementalVacuum(db, options.incrementalVacuumPages)
    }

    const remaining = options.apply
      ? ({
          events: 0,
          hrc_events: 0,
          broker_invocation_events: 0,
          runtime_buffers: 0,
        } satisfies Record<RetentionTable, number>)
      : eligible
    const freelistAfterPages = readPragmaNumber(db, 'freelist_count')
    const tableResult = Object.fromEntries(
      plans.map((plan) => [
        plan.table,
        {
          eligibleCount: eligible[plan.table],
          deleted: deleted[plan.table],
          remainingEligibleCount: remaining[plan.table],
        },
      ])
    ) as PruneStateRetentionResult['tables']

    return {
      eventCutoff,
      runtimeBufferCutoff,
      eligibleCount: Object.values(eligible).reduce((sum, count) => sum + count, 0),
      deleted: Object.values(deleted).reduce((sum, count) => sum + count, 0),
      remainingEligibleCount: Object.values(remaining).reduce((sum, count) => sum + count, 0),
      autoVacuumMode,
      freelistBeforePages,
      freelistBeforeVacuumPages,
      freelistAfterPages,
      reclaimedPages: Math.max(0, freelistBeforeVacuumPages - freelistAfterPages),
      tables: tableResult,
    }
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  try {
    const options = parsePruneStateRetentionArgs(Bun.argv.slice(2))
    const result = pruneStateRetention(options)
    console.log(
      JSON.stringify(
        {
          dbPath: options.dbPath,
          applied: options.apply,
          batchSize: options.batchSize,
          checkpoint: options.checkpoint,
          eventRetentionDays: options.eventRetentionDays,
          runtimeBufferRetentionDays: options.runtimeBufferRetentionDays,
          incrementalVacuumPages: options.incrementalVacuumPages,
          ...result,
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
