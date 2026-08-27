#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Database } from 'bun:sqlite'
import {
  type ToolResultBlobKind,
  brokerToolResultBlobId,
  createToolResultSpillStub,
  lifecycleToolResultBlobId,
  toolResultExceedsSpillThreshold,
  toolResultFromBrokerResult,
} from '../packages/hrc-core/src/index.ts'

import {
  type FirstTurnRetentionResult,
  pruneFirstTurnMissingBundles,
} from '../packages/hrc-server/src/first-turn-retention.ts'
import { RuntimeArtifactRepository } from '../packages/hrc-store-sqlite/src/repositories/broker-repositories.ts'
import { FirstTurnWatchRepository } from '../packages/hrc-store-sqlite/src/repositories/first-turn-watch-repository.ts'

const DEFAULT_HRC_STORE_PATH = '/Users/lherron/praesidium/var/state/hrc/state.sqlite'
const DEFAULT_EVENT_RETENTION_DAYS = 3
const DEFAULT_RUNTIME_BUFFER_RETENTION_DAYS = 1
// T-07235 diagnostic-bundle retention. These are runtime artifact DIRECTORIES,
// not table rows: the first artifact class HRC writes to disk on its own
// initiative, so it needs its own declared policy (docs/state-retention.md).
const DEFAULT_FIRST_TURN_BUNDLE_KEEP = 3
const DEFAULT_FIRST_TURN_BUNDLE_TTL_DAYS = 14
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const MILLISECONDS_PER_MINUTE = 60 * 1000

/**
 * Writer-lock discipline. This job shares `state.sqlite` with the live daemon,
 * whose writes carry a 5s busy timeout. Every write step is therefore bounded,
 * paced, and abandonable: the prune must never be able to starve the daemon,
 * regardless of how large the database has grown.
 */
const DEFAULT_DEADLINE_MINUTES = 30
const DEFAULT_PACE_MILLIS = 250
const DEFAULT_MAX_WRITE_HOLD_MILLIS = 500
/**
 * Share of wall-clock time this job may hold the writer lock. Bounding the
 * length of a single hold is not enough on its own: the daemon has write paths
 * that surface SQLITE_BUSY immediately instead of waiting out their busy
 * timeout, so what they actually see is the probability of finding the lock
 * held. Yielding several times longer than each hold keeps that probability low.
 */
const DEFAULT_MAX_DUTY_CYCLE = 0.25
const DEFAULT_INCREMENTAL_VACUUM_CHUNK_PAGES = 100
const DEFAULT_BUSY_MAX_RETRIES = 8
const MAX_PAUSE_MILLIS = 5_000
const MIN_INCREMENTAL_VACUUM_CHUNK_PAGES = 25
const MAX_INCREMENTAL_VACUUM_CHUNK_PAGES = 10_000
const MIN_DELETE_BATCH_SIZE = 25
/**
 * Every table's first batch of the night is taken blind, before any hold has
 * been measured. Starting at the configured ceiling makes that first step
 * unbounded — the whole table can fit in one batch and hold the lock for all of
 * it. So each table probes small and ramps up toward the ceiling instead.
 */
const INITIAL_DELETE_BATCH_SIZE = 250
const BUSY_BACKOFF_BASE_MILLIS = 500
const BUSY_BACKOFF_MAX_MILLIS = 15_000

const TERMINAL_RUN_STATUSES_SQL = "'completed', 'failed', 'cancelled', 'zombie'"
const TERMINAL_RUNTIME_STATUSES_SQL = "'terminated', 'dead', 'stale', 'crashed'"
const TERMINAL_INVOCATION_STATES_SQL = "'exited', 'failed', 'disposed'"
const DELTA_EVENT_TYPES_SQL = "'assistant.message.delta', 'tool.call.delta'"
const PURGE_DELTA_BACKLOG_OPERATION = 'purge-delta-backlog'
const STRIP_ENVELOPE_PAYLOADS_OPERATION = 'strip-envelope-payloads'
const SPILL_TOOL_RESULTS_OPERATION = 'spill-tool-results'
const T07040_BACKFILL_SOURCE_REF = 'backfill-T-07040'
const T07040_EXPECTED_BACKFILL_ROWS = 822

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

/**
 * T-07045 one-time cleanup. T-07040 removed the last events-table consumer, so
 * every raw broker mirror row is now disposable, not just its delta kinds.
 * The parameter is an intentional operation token: it lets this plan share the
 * parameterized/count/delete machinery without smuggling in a retention cutoff.
 */
const PURGE_EVENTS_ELIGIBLE_SQL = `
  ? = '${PURGE_DELTA_BACKLOG_OPERATION}'
  AND e.event_kind LIKE 'broker.%'
`

/**
 * Delta rows attached to an invocation that is non-terminal at the moment this
 * statement runs stay fenced. Re-evaluating the predicate inside every DELETE
 * batch closes the race between pre-flight counting and a live invocation.
 *
 * The source-ref exclusion is deliberately redundant with the current
 * continuation.cleared type of the 822 T-07040 backfill rows. The hard count
 * assertion below catches drift; this predicate makes the rows fail closed even
 * if their type is ever repaired or rewritten.
 */
const PURGE_BROKER_INVOCATION_DELTAS_ELIGIBLE_SQL = `
  ? = '${PURGE_DELTA_BACKLOG_OPERATION}'
  AND e.type IN (${DELTA_EVENT_TYPES_SQL})
  AND COALESCE(e.source_ref, '') <> '${T07040_BACKFILL_SOURCE_REF}'
  AND NOT EXISTS (
    SELECT 1
    FROM broker_invocations AS invocation
    WHERE invocation.invocation_id = e.invocation_id
      AND invocation.invocation_state NOT IN (${TERMINAL_INVOCATION_STATES_SQL})
  )
`

export type PruneOperation =
  | 'retention'
  | 'purge-delta-backlog'
  | 'strip-envelope-payloads'
  | 'spill-tool-results'

export type PruneStateRetentionOptions = {
  dbPath: string
  operation: PruneOperation
  expectedT07040BackfillRows: number
  apply: boolean
  batchSize: number
  checkpoint: boolean
  eventRetentionDays: number
  runtimeBufferRetentionDays: number
  incrementalVacuumPages: number
  incrementalVacuumChunkPages: number
  deadlineMillis: number
  paceMillis: number
  maxWriteHoldMillis: number
  maxDutyCycle: number
  busyMaxRetries: number
  countEligible: boolean
  tables: readonly RetentionTable[]
  /** Root that holds `artifacts/<runtimeId>/first-turn-missing/<tripEventId>`. */
  runtimeRoot: string
  firstTurnBundleKeep: number
  firstTurnBundleTtlDays: number
  now: Date
}

/**
 * Why a phase stopped. `complete` drained the phase; `deadline` hit the
 * wall-clock budget; `busy` gave the writer lock back to the daemon after the
 * backoff ladder was exhausted; `skipped` means the table was not selected for
 * retention at all. Only `complete` means "nothing left to do".
 */
export type PrunePhaseStop = 'complete' | 'deadline' | 'busy' | 'skipped'

export type PruneRetentionTableResult = {
  eligibleCount: number | null
  deleted: number
  remainingEligibleCount: number | null
  stopReason: PrunePhaseStop
  /** Batch size this table settled on to keep each write step under the hold target. */
  batchSize: number
}

export type PruneStateRetentionResult = {
  operation: PruneOperation
  eventCutoff: string
  runtimeBufferCutoff: string
  t07040BackfillRowsBefore: number | null
  t07040BackfillRowsAfter: number | null
  eligibleCount: number | null
  deleted: number
  remainingEligibleCount: number | null
  autoVacuumMode: number
  freelistBeforePages: number
  freelistBeforeVacuumPages: number
  freelistAfterPages: number
  reclaimedPages: number
  stopReason: PrunePhaseStop
  deadlineExceeded: boolean
  elapsedMillis: number
  pausedMillis: number
  busyRetries: number
  /** Write steps taken, total and longest time the writer lock was held. */
  writeSteps: number
  heldMillis: number
  maxObservedWriteHoldMillis: number
  vacuumChunkPages: number
  vacuumStopReason: PrunePhaseStop
  checkpointed: boolean
  /** T-07235 bundle-directory retention. Null when the pass did not run. */
  firstTurnBundles: FirstTurnRetentionResult | null
  tables: {
    events: PruneRetentionTableResult
    hrc_events: PruneRetentionTableResult
    broker_invocation_events: PruneRetentionTableResult
    runtime_buffers: PruneRetentionTableResult
  }
}

export type StripEnvelopePayloadsResult = {
  operation: 'strip-envelope-payloads'
  eligibleCount: number | null
  stripped: number
  remainingEligibleCount: number | null
  stopReason: PrunePhaseStop
  deadlineExceeded: boolean
  elapsedMillis: number
  pausedMillis: number
  busyRetries: number
  writeSteps: number
  heldMillis: number
  maxObservedWriteHoldMillis: number
  batchSize: number
  lastInvocationId: string | null
  lastSeq: number | null
  autoVacuumMode: number
  freelistBeforePages: number
  freelistBeforeVacuumPages: number
  freelistAfterPages: number
  reclaimedPages: number
  vacuumChunkPages: number
  vacuumStopReason: PrunePhaseStop
  checkpointed: boolean
}

export type SpillToolResultsResult = {
  operation: 'spill-tool-results'
  brokerInvocationEvents: { candidates: number; stubbed: number }
  hrcEvents: { candidates: number; stubbed: number }
  blobs: { sharedBrokerRaw: number; lifecycleCanonical: number }
  equalityCheckMisses: number
  stopReason: PrunePhaseStop
  deadlineExceeded: boolean
  elapsedMillis: number
  pausedMillis: number
  busyRetries: number
  writeSteps: number
  heldMillis: number
  maxObservedWriteHoldMillis: number
  lastInvocationId: string | null
  lastBrokerSeq: number | null
  lastHrcSeq: number | null
  checkpointed: boolean
}

type RetentionTable = keyof PruneStateRetentionResult['tables']

const RETENTION_TABLES: readonly RetentionTable[] = [
  'events',
  'hrc_events',
  'broker_invocation_events',
  'runtime_buffers',
]

/**
 * Lance's 2026-07-28 ruling: non-delta observation events are kept
 * indefinitely. Only terminal runtime buffers age out, so the event tables are
 * off the retention list unless an operator names them explicitly. Encoding the
 * policy here rather than in the launchd arguments means an ad-hoc `--apply`
 * cannot quietly delete semantic history.
 */
const DEFAULT_RETENTION_TABLES: readonly RetentionTable[] = ['runtime_buffers']

type TablePlan = {
  table: RetentionTable
  alias: string
  keyColumn: string
  predicateValue: string
  eligibleSql: string
}

function usage(): string {
  return [
    'Usage: bun scripts/prune-hrc-event-deltas.ts [options]',
    '',
    'Applies bounded retention to HRC observation tables. Without --apply, reports',
    'eligible counts only. Resume barriers and active/nonterminal work are always exempt.',
    '',
    'Non-delta observation events are kept indefinitely, so only runtime_buffers is',
    'pruned by default. Naming an event table with --tables is an explicit operator',
    'decision to delete semantic history.',
    '',
    'The job shares the database with the live daemon, so every write step is',
    'bounded and paced. Work that does not fit the deadline is left for the next',
    'run: partial progress is reported and the exit code stays 0.',
    '',
    'Options:',
    '  --db <path>                         state.sqlite path',
    '  --purge-delta-backlog               T-07045 one-time mode: purge all events',
    '                                      broker.* mirrors plus terminal/orphaned',
    '                                      broker invocation deltas; requires exactly',
    '                                      822 backfill-T-07040 authority rows',
    '  --strip-envelope-payloads           remove duplicate payloads from stored broker',
    '                                      envelopes; payloads remain authoritative in',
    '                                      broker_event_json',
    '  --spill-tool-results                spill >32 KiB serialized tool results into',
    '                                      transactional SQLite blobs (BIE, then hrc_events)',
    '  --tables <a,b|all>                  tables to prune (default: runtime_buffers)',
    '  --apply                             apply the selected maintenance operation',
    '  --batch-size <n>                    rows per write batch (default: 10000)',
    '  --event-retention-days <n>          event TTL; only applies to event tables named',
    '                                      via --tables (default: 3)',
    '  --runtime-buffer-retention-days <n> terminal buffer TTL (default: 1)',
    '  --incremental-vacuum-pages <n>      pages reclaimed after apply; 0 = all (default: 0)',
    '  --incremental-vacuum-chunk-pages <n> pages per reclaim step, adapted at',
    '                                      runtime to --max-write-hold-millis (default: 200)',
    '  --no-checkpoint                     skip WAL checkpoint after apply',
    '',
    'first_turn_missing diagnostic bundles (T-07235) are runtime artifact DIRECTORIES,',
    'not table rows, and have their own declared policy:',
    '  --runtime-root <path>               root holding artifacts/<runtimeId>/first-turn-missing',
    '  --first-turn-bundle-keep <n>        bundles kept per (runtimeId, generation) (default: 3)',
    '  --first-turn-bundle-ttl-days <n>    bundle TTL (default: 14)',
    '',
    'Writer-lock guards:',
    '  --deadline-minutes <n>              wall-clock budget; 0 = unlimited (default: 30)',
    '  --pace-millis <n>                   minimum yield between write steps (default: 250)',
    '  --max-write-hold-millis <n>         target ceiling for one write step (default: 500)',
    '  --max-duty-cycle <0-1>              share of wall-clock this job may hold the',
    '                                      writer lock (default: 0.25)',
    '  --busy-max-retries <n>              SQLITE_BUSY backoff attempts (default: 8)',
    '  --count-eligible                    force the pre-flight eligible counts',
    '  --no-count-eligible                 skip them (the default under --apply)',
    '',
    'Environment fallbacks:',
    '  HRC_EVENT_RETENTION_DAYS',
    '  HRC_RUNTIME_BUFFER_RETENTION_DAYS',
    '  HRC_INCREMENTAL_VACUUM_PAGES',
    '  HRC_PRUNE_DEADLINE_MINUTES',
    '  HRC_RUNTIME_ROOT',
    '  HRC_FIRST_TURN_BUNDLE_KEEP',
    '  HRC_FIRST_TURN_BUNDLE_TTL_DAYS',
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

function parseDutyCycle(raw: string | undefined): number {
  const value = raw === undefined ? DEFAULT_MAX_DUTY_CYCLE : Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('--max-duty-cycle must be greater than 0 and at most 1')
  }
  return value
}

function parseNonNegativeNumber(raw: string | undefined, fallback: number, flag: string): number {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative number`)
  }
  return value
}

/**
 * Table selection. `all` is available for deliberate one-off maintenance; the
 * bare default deliberately excludes the event tables (see
 * DEFAULT_RETENTION_TABLES).
 */
function parseRetentionTables(raw: string | undefined): readonly RetentionTable[] {
  if (raw === undefined) {
    return DEFAULT_RETENTION_TABLES
  }
  const requested = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  if (requested.length === 0) {
    throw new Error('--tables must name at least one table')
  }
  if (requested.length === 1 && requested[0] === 'all') {
    return RETENTION_TABLES
  }
  const unknown = requested.filter((name) => !RETENTION_TABLES.includes(name as RetentionTable))
  if (unknown.length > 0) {
    throw new Error(
      `--tables has unknown table(s): ${unknown.join(', ')}; expected any of ${RETENTION_TABLES.join(', ')} or all`
    )
  }
  return RETENTION_TABLES.filter((table) => requested.includes(table))
}

/**
 * Counting eligible rows is a full predicate scan per table. It is the whole
 * point of a report run and pure overhead under --apply, where the deletes
 * report their own counts, so --apply skips it unless asked.
 */
function resolveCountEligible(args: string[], apply: boolean): boolean {
  if (args.includes('--no-count-eligible')) {
    return false
  }
  if (args.includes('--count-eligible')) {
    return true
  }
  return !apply
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

  const incrementalVacuumChunkPages = parseNonNegativeInteger(
    readArgValue(args, '--incremental-vacuum-chunk-pages'),
    DEFAULT_INCREMENTAL_VACUUM_CHUNK_PAGES,
    '--incremental-vacuum-chunk-pages'
  )
  if (incrementalVacuumChunkPages === 0) {
    throw new Error('--incremental-vacuum-chunk-pages must be a positive integer')
  }

  const apply = args.includes('--apply')
  const requestedOperations = [
    ...(args.includes('--purge-delta-backlog') ? [PURGE_DELTA_BACKLOG_OPERATION] : []),
    ...(args.includes('--strip-envelope-payloads') ? [STRIP_ENVELOPE_PAYLOADS_OPERATION] : []),
    ...(args.includes('--spill-tool-results') ? [SPILL_TOOL_RESULTS_OPERATION] : []),
  ]
  if (requestedOperations.length > 1) {
    throw new Error('maintenance operation flags are mutually exclusive')
  }
  const operation: PruneOperation = requestedOperations[0] ?? 'retention'
  if (operation !== 'retention' && readArgValue(args, '--tables') !== undefined) {
    throw new Error(`--tables cannot be combined with --${operation}; its table set is fixed`)
  }

  return {
    dbPath: readArgValue(args, '--db') ?? resolveDefaultDbPath(env),
    operation,
    expectedT07040BackfillRows: T07040_EXPECTED_BACKFILL_ROWS,
    apply,
    batchSize,
    checkpoint: !args.includes('--no-checkpoint'),
    incrementalVacuumChunkPages,
    deadlineMillis:
      parseNonNegativeNumber(
        readArgValue(args, '--deadline-minutes') ?? env['HRC_PRUNE_DEADLINE_MINUTES'],
        DEFAULT_DEADLINE_MINUTES,
        '--deadline-minutes'
      ) * MILLISECONDS_PER_MINUTE,
    paceMillis: parseNonNegativeInteger(
      readArgValue(args, '--pace-millis'),
      DEFAULT_PACE_MILLIS,
      '--pace-millis'
    ),
    maxWriteHoldMillis: parsePositiveNumber(
      readArgValue(args, '--max-write-hold-millis'),
      DEFAULT_MAX_WRITE_HOLD_MILLIS,
      '--max-write-hold-millis'
    ),
    maxDutyCycle: parseDutyCycle(readArgValue(args, '--max-duty-cycle')),
    busyMaxRetries: parseNonNegativeInteger(
      readArgValue(args, '--busy-max-retries'),
      DEFAULT_BUSY_MAX_RETRIES,
      '--busy-max-retries'
    ),
    countEligible: resolveCountEligible(args, apply),
    tables:
      operation === PURGE_DELTA_BACKLOG_OPERATION
        ? ['events', 'broker_invocation_events']
        : operation === STRIP_ENVELOPE_PAYLOADS_OPERATION
          ? ['broker_invocation_events']
          : operation === SPILL_TOOL_RESULTS_OPERATION
            ? ['broker_invocation_events', 'hrc_events']
            : parseRetentionTables(readArgValue(args, '--tables')),
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
    runtimeRoot:
      readArgValue(args, '--runtime-root') ??
      env['HRC_RUNTIME_ROOT'] ??
      join(
        dirname(readArgValue(args, '--db') ?? resolveDefaultDbPath(env)),
        '..',
        '..',
        'run',
        'hrc'
      ),
    firstTurnBundleKeep: parseNonNegativeInteger(
      readArgValue(args, '--first-turn-bundle-keep') ?? env['HRC_FIRST_TURN_BUNDLE_KEEP'],
      DEFAULT_FIRST_TURN_BUNDLE_KEEP,
      '--first-turn-bundle-keep'
    ),
    firstTurnBundleTtlDays: parseNonNegativeNumber(
      readArgValue(args, '--first-turn-bundle-ttl-days') ?? env['HRC_FIRST_TURN_BUNDLE_TTL_DAYS'],
      DEFAULT_FIRST_TURN_BUNDLE_TTL_DAYS,
      '--first-turn-bundle-ttl-days'
    ),
    now: new Date(),
  }
}

/**
 * Shared wall-clock and yield accounting for one prune run. Every write step
 * consults it before taking the lock and pays back into it afterwards.
 */
type WriteBudget = {
  startedAtMillis: number
  deadlineAtMillis: number | null
  paceMillis: number
  maxWriteHoldMillis: number
  maxDutyCycle: number
  busyMaxRetries: number
  pausedMillis: number
  busyRetries: number
  writeSteps: number
  heldMillis: number
  maxObservedWriteHoldMillis: number
  deadlineExceeded: boolean
}

function createWriteBudget(options: PruneStateRetentionOptions): WriteBudget {
  const startedAtMillis = Date.now()
  return {
    startedAtMillis,
    deadlineAtMillis: options.deadlineMillis > 0 ? startedAtMillis + options.deadlineMillis : null,
    paceMillis: options.paceMillis,
    maxWriteHoldMillis: options.maxWriteHoldMillis,
    maxDutyCycle: options.maxDutyCycle,
    busyMaxRetries: options.busyMaxRetries,
    pausedMillis: 0,
    busyRetries: 0,
    writeSteps: 0,
    heldMillis: 0,
    maxObservedWriteHoldMillis: 0,
    deadlineExceeded: false,
  }
}

function deadlineReached(budget: WriteBudget): boolean {
  if (budget.deadlineAtMillis === null) {
    return false
  }
  if (Date.now() < budget.deadlineAtMillis) {
    return false
  }
  budget.deadlineExceeded = true
  return true
}

/**
 * Yield the writer lock long enough to keep this job's share of wall-clock time
 * at or under the duty-cycle budget, so the daemon mostly finds the lock free.
 */
async function pauseAfterWrite(budget: WriteBudget, holdMillis: number): Promise<void> {
  const dutyPause = holdMillis * (1 / budget.maxDutyCycle - 1)
  const pause = Math.min(MAX_PAUSE_MILLIS, Math.max(budget.paceMillis, dutyPause))
  if (pause <= 0) {
    return
  }
  budget.pausedMillis += pause
  await Bun.sleep(pause)
}

function isBusyError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? String(Reflect.get(error, 'code')) : ''
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY/i.test(code) || /SQLITE_BUSY|database (?:table )?is locked/i.test(message)
}

/**
 * Run one write step, backing off instead of spinning when the daemon holds the
 * lock. Exhausting the ladder throws the underlying busy error; callers turn
 * that into a clean partial exit rather than a crash.
 */
async function runWriteStep<T>(
  budget: WriteBudget,
  action: () => T
): Promise<{ value: T; holdMillis: number }> {
  for (let attempt = 0; ; attempt += 1) {
    const startedAt = Date.now()
    try {
      const value = action()
      const holdMillis = Date.now() - startedAt
      budget.writeSteps += 1
      budget.heldMillis += holdMillis
      budget.maxObservedWriteHoldMillis = Math.max(budget.maxObservedWriteHoldMillis, holdMillis)
      return { value, holdMillis }
    } catch (error) {
      if (!isBusyError(error) || attempt >= budget.busyMaxRetries) {
        throw error
      }
      budget.busyRetries += 1
      const backoff = Math.min(BUSY_BACKOFF_MAX_MILLIS, BUSY_BACKOFF_BASE_MILLIS * 2 ** attempt)
      budget.pausedMillis += backoff
      await Bun.sleep(backoff)
    }
  }
}

/**
 * Contention on a read is the daemon working, not a prune failure. Degrade to a
 * fallback and let the caller report it rather than aborting the run.
 */
function tolerateBusy<T>(action: () => T, fallback: T): { value: T; busy: boolean } {
  try {
    return { value: action(), busy: false }
  } catch (error) {
    if (!isBusyError(error)) {
      throw error
    }
    return { value: fallback, busy: true }
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
      .get(plan.predicateValue)?.count ?? 0
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
    .run(plan.predicateValue, batchSize).changes
}

type EnvelopePayloadKey = {
  invocation_id: string
  seq: number
}

type StripEnvelopePayloadBatch = {
  selected: number
  stripped: number
  lastKey: EnvelopePayloadKey | null
}

const ENVELOPE_PAYLOAD_PRESENT_SQL = `
  broker_envelope_json IS NOT NULL
  AND json_type(broker_envelope_json, '$.payload') IS NOT NULL
`

function countEnvelopePayloads(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count
           FROM broker_invocation_events
          WHERE ${ENVELOPE_PAYLOAD_PRESENT_SQL}`
      )
      .get()?.count ?? 0
  )
}

function createStripEnvelopePayloadBatch(
  db: Database
): (
  afterInvocationId: string | null,
  afterSeq: number,
  batchSize: number
) => StripEnvelopePayloadBatch {
  const select = db.query<
    EnvelopePayloadKey,
    [string | null, string | null, string | null, number, number]
  >(
    `SELECT invocation_id, seq
       FROM broker_invocation_events
      WHERE ${ENVELOPE_PAYLOAD_PRESENT_SQL}
        AND (
          ? IS NULL
          OR invocation_id > ?
          OR (invocation_id = ? AND seq > ?)
        )
      ORDER BY invocation_id ASC, seq ASC
      LIMIT ?`
  )
  const update = db.prepare<
    never,
    [string | null, string | null, string | null, number, string, string, number]
  >(
    `UPDATE broker_invocation_events
        SET broker_envelope_json = json_remove(broker_envelope_json, '$.payload')
      WHERE ${ENVELOPE_PAYLOAD_PRESENT_SQL}
        AND (
          ? IS NULL
          OR invocation_id > ?
          OR (invocation_id = ? AND seq > ?)
        )
        AND (
          invocation_id < ?
          OR (invocation_id = ? AND seq <= ?)
        )`
  )
  const transaction = db.transaction(
    (
      afterInvocationId: string | null,
      afterSeq: number,
      batchSize: number
    ): StripEnvelopePayloadBatch => {
      const rows = select.all(
        afterInvocationId,
        afterInvocationId,
        afterInvocationId,
        afterSeq,
        batchSize
      )
      const lastKey = rows.at(-1) ?? null
      const stripped =
        lastKey === null
          ? 0
          : update.run(
              afterInvocationId,
              afterInvocationId,
              afterInvocationId,
              afterSeq,
              lastKey.invocation_id,
              lastKey.invocation_id,
              lastKey.seq
            ).changes
      if (stripped !== rows.length) {
        throw new Error(
          `envelope payload strip batch selected ${rows.length} rows but updated ${stripped}`
        )
      }
      return {
        selected: rows.length,
        stripped,
        lastKey,
      }
    }
  )
  return (afterInvocationId, afterSeq, batchSize) =>
    transaction.immediate(afterInvocationId, afterSeq, batchSize)
}

type T07040BackfillInvariant = {
  total: number
  continuationCleared: number
}

function readT07040BackfillInvariant(db: Database): T07040BackfillInvariant {
  return (
    db
      .query<T07040BackfillInvariant, [string]>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN type = 'continuation.cleared' THEN 1 ELSE 0 END), 0)
                  AS continuationCleared
           FROM broker_invocation_events
          WHERE source_ref = ?`
      )
      .get(T07040_BACKFILL_SOURCE_REF) ?? { total: 0, continuationCleared: 0 }
  )
}

function assertT07040BackfillInvariant(
  invariant: T07040BackfillInvariant,
  expectedRows: number,
  phase: 'before' | 'after'
): void {
  if (invariant.total !== expectedRows || invariant.continuationCleared !== expectedRows) {
    throw new Error(
      `T-07040 backfill invariant failed ${phase} purge: expected ${expectedRows} source_ref='${T07040_BACKFILL_SOURCE_REF}' continuation.cleared rows, found ${invariant.total} total and ${invariant.continuationCleared} continuation.cleared; refusing unsafe cleanup`
    )
  }
}

function assertPurgeDeltaBacklogGuardrails(options: PruneStateRetentionOptions): void {
  if (options.operation !== PURGE_DELTA_BACKLOG_OPERATION) {
    return
  }
  if (options.deadlineMillis <= 0) {
    throw new Error('--purge-delta-backlog requires a bounded --deadline-minutes greater than 0')
  }
  if (options.paceMillis < DEFAULT_PACE_MILLIS) {
    throw new Error(`--purge-delta-backlog requires --pace-millis >= ${DEFAULT_PACE_MILLIS}`)
  }
  if (options.maxWriteHoldMillis > DEFAULT_MAX_WRITE_HOLD_MILLIS) {
    throw new Error(
      `--purge-delta-backlog requires --max-write-hold-millis <= ${DEFAULT_MAX_WRITE_HOLD_MILLIS}`
    )
  }
  if (options.maxDutyCycle > DEFAULT_MAX_DUTY_CYCLE) {
    throw new Error(`--purge-delta-backlog requires --max-duty-cycle <= ${DEFAULT_MAX_DUTY_CYCLE}`)
  }
}

/**
 * Pacing between batches is worthless if one batch holds the lock for minutes.
 * Row cost varies by orders of magnitude across these tables — `runtime_buffers`
 * carries large text blobs while `events` rows are small — so the batch size
 * tracks measured hold time instead of a single configured guess. The configured
 * `--batch-size` is the ceiling, never exceeded.
 */
async function deleteInBatches(
  db: Database,
  plan: TablePlan,
  maxBatchSize: number,
  budget: WriteBudget
): Promise<{ deleted: number; stopReason: PrunePhaseStop; batchSize: number }> {
  let deleted = 0
  let batchSize = Math.min(INITIAL_DELETE_BATCH_SIZE, maxBatchSize)
  while (true) {
    if (deadlineReached(budget)) {
      return { deleted, stopReason: 'deadline', batchSize }
    }
    const requestedRows = batchSize
    let batchDeleted: number
    let holdMillis: number
    try {
      const step = await runWriteStep(budget, () => deleteBatch(db, plan, requestedRows))
      batchDeleted = step.value
      holdMillis = step.holdMillis
    } catch (error) {
      if (!isBusyError(error)) {
        throw error
      }
      return { deleted, stopReason: 'busy', batchSize }
    }
    deleted += batchDeleted
    if (batchDeleted < requestedRows) {
      return { deleted, stopReason: 'complete', batchSize }
    }
    batchSize = adaptStepSize(
      requestedRows,
      holdMillis,
      budget.maxWriteHoldMillis,
      MIN_DELETE_BATCH_SIZE,
      maxBatchSize
    )
    await pauseAfterWrite(budget, holdMillis)
  }
}

function readPragmaNumber(db: Database, pragma: 'auto_vacuum' | 'freelist_count'): number {
  const row = db.query<Record<string, number>, []>(`PRAGMA ${pragma}`).get()
  return row ? (Object.values(row)[0] ?? 0) : 0
}

function assertIncrementalAutoVacuum(mode: number): void {
  if (mode !== 2) {
    throw new Error(
      `state.sqlite auto_vacuum mode is ${mode}, expected 2 (INCREMENTAL); refusing to delete rows until a coordinated full VACUUM has installed the pointer map`
    )
  }
}

/**
 * Size the next write step from how long the last one held the lock. Work cost
 * per unit varies with row size, cache state, and database size, so no fixed
 * step size stays safe as the database grows — the measured hold does.
 */
function adaptStepSize(
  requested: number,
  holdMillis: number,
  targetMillis: number,
  minimum: number,
  maximum: number
): number {
  const clamp = (value: number): number => Math.min(maximum, Math.max(minimum, Math.round(value)))
  // Holds are measured in whole milliseconds, so a step reporting 0 was merely
  // too fast to time — not free. Floor it, or a target below the clock's
  // resolution reads as headroom and the step grows when it should shrink.
  const observedMillis = Math.max(holdMillis, 0.5)
  if (observedMillis > targetMillis) {
    return clamp((requested * targetMillis) / observedMillis)
  }
  if (observedMillis * 2 < targetMillis) {
    return clamp(requested * 1.5)
  }
  return clamp(requested)
}

/**
 * Reclaim free pages in paced chunks. `PRAGMA incremental_vacuum` with no
 * argument drains the whole freelist inside a single write transaction — on a
 * multi-million-page freelist that is hours of unbroken writer lock, which is
 * exactly how this job took the daemon down. Never issue the unbounded form.
 */
async function incrementalVacuum(
  db: Database,
  budget: WriteBudget,
  targetPages: number,
  initialChunkPages: number
): Promise<{
  reclaimedPages: number
  chunkPages: number
  stopReason: PrunePhaseStop
}> {
  const limit = targetPages === 0 ? Number.POSITIVE_INFINITY : targetPages
  let chunkPages = Math.min(
    MAX_INCREMENTAL_VACUUM_CHUNK_PAGES,
    Math.max(MIN_INCREMENTAL_VACUUM_CHUNK_PAGES, initialChunkPages)
  )
  let reclaimedPages = 0

  while (reclaimedPages < limit) {
    const before = tolerateBusy(() => readPragmaNumber(db, 'freelist_count'), 0)
    if (before.busy) {
      return { reclaimedPages, chunkPages, stopReason: 'busy' }
    }
    const freelistBefore = before.value
    if (freelistBefore === 0) {
      return { reclaimedPages, chunkPages, stopReason: 'complete' }
    }
    if (deadlineReached(budget)) {
      return { reclaimedPages, chunkPages, stopReason: 'deadline' }
    }

    const requestedPages = Math.min(chunkPages, freelistBefore, limit - reclaimedPages)
    let holdMillis: number
    try {
      const step = await runWriteStep(budget, () =>
        db.exec(`PRAGMA incremental_vacuum(${requestedPages});`)
      )
      holdMillis = step.holdMillis
    } catch (error) {
      if (!isBusyError(error)) {
        throw error
      }
      return { reclaimedPages, chunkPages, stopReason: 'busy' }
    }

    const after = tolerateBusy(() => readPragmaNumber(db, 'freelist_count'), freelistBefore)
    if (after.busy) {
      return { reclaimedPages, chunkPages, stopReason: 'busy' }
    }
    const freed = Math.max(0, freelistBefore - after.value)
    reclaimedPages += freed
    if (freed === 0) {
      return { reclaimedPages, chunkPages, stopReason: 'complete' }
    }
    chunkPages = adaptStepSize(
      requestedPages,
      holdMillis,
      budget.maxWriteHoldMillis,
      MIN_INCREMENTAL_VACUUM_CHUNK_PAGES,
      MAX_INCREMENTAL_VACUUM_CHUNK_PAGES
    )
    await pauseAfterWrite(budget, holdMillis)
  }

  return { reclaimedPages, chunkPages, stopReason: 'complete' }
}

function sumOrNull(counts: Array<number | null>): number | null {
  return counts.some((count) => count === null)
    ? null
    : counts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
}

/**
 * A skipped table is a configuration choice, not an interruption, so it never
 * downgrades the run's outcome.
 */
function worstStopReason(reasons: PrunePhaseStop[]): PrunePhaseStop {
  if (reasons.includes('deadline')) {
    return 'deadline'
  }
  if (reasons.includes('busy')) {
    return 'busy'
  }
  return 'complete'
}

/**
 * Remove the payload copy embedded in historical broker envelopes. The
 * `(invocation_id, seq)` cursor advances only after an immediate transaction
 * commits, so a deadline, SQLITE_BUSY exit, or process restart can safely
 * resume from the first still-eligible row. The eligibility predicate makes
 * the operation idempotent across repeated runs.
 */
export async function stripEnvelopePayloads(
  options: PruneStateRetentionOptions
): Promise<StripEnvelopePayloadsResult> {
  if (options.operation !== STRIP_ENVELOPE_PAYLOADS_OPERATION) {
    throw new Error('stripEnvelopePayloads requires --strip-envelope-payloads')
  }
  if (!existsSync(options.dbPath)) {
    throw new Error(`HRC store does not exist: ${options.dbPath}`)
  }

  const budget = createWriteBudget(options)
  const db = new Database(options.dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')

    let autoVacuumMode: number
    try {
      autoVacuumMode = (await runWriteStep(budget, () => readPragmaNumber(db, 'auto_vacuum'))).value
    } catch (error) {
      if (!isBusyError(error)) {
        throw error
      }
      return {
        operation: STRIP_ENVELOPE_PAYLOADS_OPERATION,
        eligibleCount: null,
        stripped: 0,
        remainingEligibleCount: null,
        stopReason: 'busy',
        deadlineExceeded: budget.deadlineExceeded,
        elapsedMillis: Date.now() - budget.startedAtMillis,
        pausedMillis: budget.pausedMillis,
        busyRetries: budget.busyRetries,
        writeSteps: budget.writeSteps,
        heldMillis: budget.heldMillis,
        maxObservedWriteHoldMillis: budget.maxObservedWriteHoldMillis,
        batchSize: options.batchSize,
        lastInvocationId: null,
        lastSeq: null,
        autoVacuumMode: 0,
        freelistBeforePages: 0,
        freelistBeforeVacuumPages: 0,
        freelistAfterPages: 0,
        reclaimedPages: 0,
        vacuumChunkPages: options.incrementalVacuumChunkPages,
        vacuumStopReason: 'busy',
        checkpointed: false,
      }
    }
    if (options.apply) {
      assertIncrementalAutoVacuum(autoVacuumMode)
    }

    const eligibleCount = options.countEligible
      ? tolerateBusy(() => countEnvelopePayloads(db), null).value
      : null
    const freelistBeforePages = tolerateBusy(() => readPragmaNumber(db, 'freelist_count'), 0).value
    let stripped = 0
    let stopReason: PrunePhaseStop = 'complete'
    let batchSize = Math.min(INITIAL_DELETE_BATCH_SIZE, options.batchSize)
    let lastKey: EnvelopePayloadKey | null = null
    let checkpointed = false
    let freelistBeforeVacuumPages = freelistBeforePages
    let vacuumChunkPages = options.incrementalVacuumChunkPages
    let vacuumStopReason: PrunePhaseStop = 'complete'

    if (options.apply) {
      const stripBatch = createStripEnvelopePayloadBatch(db)
      while (true) {
        if (deadlineReached(budget)) {
          stopReason = 'deadline'
          break
        }
        const requestedRows = batchSize
        let batch: StripEnvelopePayloadBatch
        let holdMillis: number
        try {
          const step = await runWriteStep(budget, () =>
            stripBatch(lastKey?.invocation_id ?? null, lastKey?.seq ?? -1, requestedRows)
          )
          batch = step.value
          holdMillis = step.holdMillis
        } catch (error) {
          if (!isBusyError(error)) {
            throw error
          }
          stopReason = 'busy'
          break
        }

        stripped += batch.stripped
        if (batch.lastKey !== null) {
          lastKey = batch.lastKey
        }
        if (batch.selected < requestedRows) {
          const remaining = tolerateBusy(() => countEnvelopePayloads(db), null)
          if (remaining.busy || remaining.value === null) {
            stopReason = 'busy'
            break
          }
          if (remaining.value === 0) {
            stopReason = 'complete'
            break
          }
          // A pre-cutover writer may have inserted an eligible key behind the
          // cursor. Start another keyset pass; rows already stripped no longer
          // match, so this remains bounded by the deadline and idempotent.
          lastKey = null
        }
        batchSize = adaptStepSize(
          requestedRows,
          holdMillis,
          budget.maxWriteHoldMillis,
          MIN_DELETE_BATCH_SIZE,
          options.batchSize
        )
        await pauseAfterWrite(budget, holdMillis)
      }

      if (options.checkpoint) {
        try {
          await runWriteStep(budget, () => db.exec('PRAGMA wal_checkpoint(PASSIVE);'))
          checkpointed = true
        } catch (error) {
          if (!isBusyError(error)) {
            throw error
          }
        }
      }
      freelistBeforeVacuumPages = tolerateBusy(
        () => readPragmaNumber(db, 'freelist_count'),
        freelistBeforePages
      ).value
      if (stopReason === 'complete') {
        const vacuum = await incrementalVacuum(
          db,
          budget,
          options.incrementalVacuumPages,
          options.incrementalVacuumChunkPages
        )
        vacuumStopReason = vacuum.stopReason
        vacuumChunkPages = vacuum.chunkPages
      } else {
        vacuumStopReason = stopReason
      }
    }

    const remainingEligibleCount = tolerateBusy(() => countEnvelopePayloads(db), null).value
    const freelistAfterPages = tolerateBusy(
      () => readPragmaNumber(db, 'freelist_count'),
      freelistBeforeVacuumPages
    ).value

    return {
      operation: STRIP_ENVELOPE_PAYLOADS_OPERATION,
      eligibleCount,
      stripped,
      remainingEligibleCount,
      stopReason: worstStopReason([stopReason, vacuumStopReason]),
      deadlineExceeded: budget.deadlineExceeded,
      elapsedMillis: Date.now() - budget.startedAtMillis,
      pausedMillis: budget.pausedMillis,
      busyRetries: budget.busyRetries,
      writeSteps: budget.writeSteps,
      heldMillis: budget.heldMillis,
      maxObservedWriteHoldMillis: budget.maxObservedWriteHoldMillis,
      batchSize,
      lastInvocationId: lastKey?.invocation_id ?? null,
      lastSeq: lastKey?.seq ?? null,
      autoVacuumMode,
      freelistBeforePages,
      freelistBeforeVacuumPages,
      freelistAfterPages,
      reclaimedPages: Math.max(0, freelistBeforeVacuumPages - freelistAfterPages),
      vacuumChunkPages,
      vacuumStopReason,
      checkpointed,
    }
  } finally {
    db.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    )
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]))
  )
}

type SpillBrokerRow = {
  invocation_id: string
  seq: number
  runtime_id: string
  broker_event_json: string
  created_at: string
}

type SpillLifecycleRow = {
  hrc_seq: number
  runtime_id: string | null
  payload_json: string
  ts: string
}

/**
 * Phase 4 historical backfill. Candidate discovery is a bounded set-based
 * keyset walk; the one threshold authority is applied after parsing. Each
 * qualifying row's blob INSERT and stub UPDATE commits in its own immediate
 * transaction, making a killed process safely resumable by spill presence.
 */
export async function spillToolResults(
  options: PruneStateRetentionOptions
): Promise<SpillToolResultsResult> {
  if (options.operation !== SPILL_TOOL_RESULTS_OPERATION) {
    throw new Error('spillToolResults requires --spill-tool-results')
  }
  if (!existsSync(options.dbPath)) throw new Error(`HRC store does not exist: ${options.dbPath}`)

  const budget = createWriteBudget(options)
  const db = new Database(options.dbPath)
  db.exec('PRAGMA busy_timeout = 5000;')
  let brokerCandidates = 0
  let brokerStubbed = 0
  let lifecycleCandidates = 0
  let lifecycleStubbed = 0
  let sharedBrokerRaw = 0
  let lifecycleCanonical = 0
  let equalityCheckMisses = 0
  let lastInvocationId: string | null = null
  let lastBrokerSeq: number | null = null
  let lastHrcSeq: number | null = null
  let stopReason: PrunePhaseStop = 'complete'
  let checkpointed = false

  try {
    const hasTable = db
      .query<{ present: number }, []>(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_result_blobs') AS present"
      )
      .get()?.present
    if (hasTable !== 1) throw new Error('tool_result_blobs migration is not applied')

    const selectBroker = db.query<SpillBrokerRow, [string, number, number]>(
      `SELECT invocation_id, seq, runtime_id, broker_event_json, created_at
         FROM broker_invocation_events
        WHERE type = 'tool.call.completed'
          AND length(CAST(broker_event_json AS BLOB)) > 32768
          AND json_type(broker_event_json, '$.result.details.spill') IS NULL
          AND (invocation_id, seq) > (?, ?)
        ORDER BY invocation_id ASC, seq ASC
        LIMIT ?`
    )
    const updateBroker = db.transaction((row: SpillBrokerRow, payload: Record<string, unknown>) => {
      const result = payload['result']
      const toolCallId = payload['toolCallId']
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
        throw new Error(`large broker tool result ${row.invocation_id}/${row.seq} lacks toolCallId`)
      }
      const resultJson = JSON.stringify(result)
      const bytes = Buffer.byteLength(resultJson, 'utf8')
      const blobId = brokerToolResultBlobId(row.runtime_id, toolCallId)
      db.query<never, [string, string, number, string, string]>(
        `INSERT OR IGNORE INTO tool_result_blobs (
           blob_id, runtime_id, kind, bytes, complete, result_json, created_at
         ) VALUES (?, ?, 'broker_raw', ?, 1, ?, ?)`
      ).run(blobId, row.runtime_id, bytes, resultJson, row.created_at)
      const stubbedJson = JSON.stringify({
        ...payload,
        result: createToolResultSpillStub(result, { blobId, bytes, kind: 'broker_raw' }),
      })
      return db
        .query<never, [string, string, number]>(
          `UPDATE broker_invocation_events
              SET broker_event_json = ?
            WHERE invocation_id = ? AND seq = ?
              AND json_type(broker_event_json, '$.result.details.spill') IS NULL`
        )
        .run(stubbedJson, row.invocation_id, row.seq).changes
    })

    while (stopReason === 'complete') {
      if (deadlineReached(budget)) {
        stopReason = 'deadline'
        break
      }
      const rows = selectBroker.all(lastInvocationId ?? '', lastBrokerSeq ?? -1, options.batchSize)
      if (rows.length === 0) break
      for (const row of rows) {
        lastInvocationId = row.invocation_id
        lastBrokerSeq = row.seq
        brokerCandidates += 1
        const payload = JSON.parse(row.broker_event_json) as unknown
        if (!isRecord(payload) || !toolResultExceedsSpillThreshold(payload['result'])) continue
        if (!options.apply) continue
        if (deadlineReached(budget)) {
          stopReason = 'deadline'
          break
        }
        try {
          const step = await runWriteStep(budget, () => updateBroker.immediate(row, payload))
          brokerStubbed += step.value
          await pauseAfterWrite(budget, step.holdMillis)
        } catch (error) {
          if (!isBusyError(error)) throw error
          stopReason = 'busy'
          break
        }
      }
      if (rows.length < options.batchSize) break
    }

    if (stopReason === 'complete') {
      const ledgerIncarnationId = db
        .query<{ ledger_incarnation_id: string }, []>(
          'SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata WHERE id = 1'
        )
        .get()?.ledger_incarnation_id
      if (!ledgerIncarnationId)
        throw new Error('lifecycle-event ledger incarnation metadata is missing')
      const selectLifecycle = db.query<SpillLifecycleRow, [number, number]>(
        `SELECT hrc_seq, runtime_id, payload_json, ts
           FROM hrc_events
          WHERE hrc_seq > ?
            AND event_kind = 'turn.tool_result'
            AND length(CAST(payload_json AS BLOB)) > 32768
            AND json_type(payload_json, '$.result.details.spill') IS NULL
          ORDER BY hrc_seq ASC
          LIMIT ?`
      )
      const updateLifecycle = db.transaction(
        (
          row: SpillLifecycleRow,
          payload: Record<string, unknown>,
          blobId: string,
          kind: ToolResultBlobKind,
          bytes: number,
          resultJson: string
        ) => {
          if (kind === 'lifecycle_canonical') {
            if (row.runtime_id === null) {
              throw new Error(`large lifecycle tool result ${row.hrc_seq} lacks runtime_id`)
            }
            db.query<never, [string, string, number, string, string]>(
              `INSERT OR IGNORE INTO tool_result_blobs (
                 blob_id, runtime_id, kind, bytes, complete, result_json, created_at
               ) VALUES (?, ?, 'lifecycle_canonical', ?, 1, ?, ?)`
            ).run(blobId, row.runtime_id, bytes, resultJson, row.ts)
          }
          const stubbedJson = JSON.stringify({
            ...payload,
            result: createToolResultSpillStub(payload['result'], { blobId, bytes, kind }),
          })
          return db
            .query<never, [string, number]>(
              `UPDATE hrc_events SET payload_json = ?
                WHERE hrc_seq = ?
                  AND json_type(payload_json, '$.result.details.spill') IS NULL`
            )
            .run(stubbedJson, row.hrc_seq).changes
        }
      )

      while (stopReason === 'complete') {
        if (deadlineReached(budget)) {
          stopReason = 'deadline'
          break
        }
        const rows = selectLifecycle.all(lastHrcSeq ?? 0, options.batchSize)
        if (rows.length === 0) break
        for (const row of rows) {
          lastHrcSeq = row.hrc_seq
          lifecycleCandidates += 1
          const payload = JSON.parse(row.payload_json) as unknown
          if (!isRecord(payload) || !toolResultExceedsSpillThreshold(payload['result'])) continue
          if (!row.runtime_id)
            throw new Error(`large lifecycle tool result ${row.hrc_seq} lacks runtime_id`)
          const canonicalResultJson = JSON.stringify(payload['result'])
          let blobId = lifecycleToolResultBlobId(ledgerIncarnationId, row.hrc_seq)
          let kind: ToolResultBlobKind = 'lifecycle_canonical'
          let bytes = Buffer.byteLength(canonicalResultJson, 'utf8')
          const toolUseId = payload['toolUseId']
          if (typeof toolUseId === 'string' && toolUseId.length > 0) {
            const candidateId = brokerToolResultBlobId(row.runtime_id, toolUseId)
            const candidate = db
              .query<{ result_json: string; bytes: number }, [string]>(
                `SELECT result_json, bytes FROM tool_result_blobs
                  WHERE blob_id = ? AND complete = 1 AND kind = 'broker_raw'`
              )
              .get(candidateId)
            if (candidate) {
              const converted = toolResultFromBrokerResult(
                JSON.parse(candidate.result_json) as unknown
              )
              if (deepEqual(converted, payload['result'])) {
                blobId = candidateId
                kind = 'broker_raw'
                bytes = candidate.bytes
              } else {
                equalityCheckMisses += 1
              }
            }
          }
          if (!options.apply) continue
          if (deadlineReached(budget)) {
            stopReason = 'deadline'
            break
          }
          try {
            const step = await runWriteStep(budget, () =>
              updateLifecycle.immediate(row, payload, blobId, kind, bytes, canonicalResultJson)
            )
            lifecycleStubbed += step.value
            if (step.value > 0) {
              if (kind === 'broker_raw') sharedBrokerRaw += 1
              else lifecycleCanonical += 1
            }
            await pauseAfterWrite(budget, step.holdMillis)
          } catch (error) {
            if (!isBusyError(error)) throw error
            stopReason = 'busy'
            break
          }
        }
        if (rows.length < options.batchSize) break
      }
    }

    if (options.apply && options.checkpoint) {
      try {
        await runWriteStep(budget, () => db.exec('PRAGMA wal_checkpoint(PASSIVE);'))
        checkpointed = true
      } catch (error) {
        if (!isBusyError(error)) throw error
        if (stopReason === 'complete') stopReason = 'busy'
      }
    }

    return {
      operation: SPILL_TOOL_RESULTS_OPERATION,
      brokerInvocationEvents: { candidates: brokerCandidates, stubbed: brokerStubbed },
      hrcEvents: { candidates: lifecycleCandidates, stubbed: lifecycleStubbed },
      blobs: { sharedBrokerRaw, lifecycleCanonical },
      equalityCheckMisses,
      stopReason,
      deadlineExceeded: budget.deadlineExceeded,
      elapsedMillis: Date.now() - budget.startedAtMillis,
      pausedMillis: budget.pausedMillis,
      busyRetries: budget.busyRetries,
      writeSteps: budget.writeSteps,
      heldMillis: budget.heldMillis,
      maxObservedWriteHoldMillis: budget.maxObservedWriteHoldMillis,
      lastInvocationId,
      lastBrokerSeq,
      lastHrcSeq,
      checkpointed,
    }
  } finally {
    db.close()
  }
}

export async function pruneStateRetention(
  options: PruneStateRetentionOptions
): Promise<PruneStateRetentionResult> {
  if (
    options.operation === STRIP_ENVELOPE_PAYLOADS_OPERATION ||
    options.operation === SPILL_TOOL_RESULTS_OPERATION
  ) {
    throw new Error(`--${options.operation} must run through its dedicated operation`)
  }
  assertPurgeDeltaBacklogGuardrails(options)
  if (!existsSync(options.dbPath)) {
    throw new Error(`HRC store does not exist: ${options.dbPath}`)
  }

  const eventCutoff = new Date(
    options.now.getTime() - options.eventRetentionDays * MILLISECONDS_PER_DAY
  ).toISOString()
  const runtimeBufferCutoff = new Date(
    options.now.getTime() - options.runtimeBufferRetentionDays * MILLISECONDS_PER_DAY
  ).toISOString()
  const retentionPlans: TablePlan[] = [
    {
      table: 'events',
      alias: 'e',
      keyColumn: 'seq',
      predicateValue: eventCutoff,
      eligibleSql: EVENTS_ELIGIBLE_SQL,
    },
    {
      table: 'hrc_events',
      alias: 'e',
      keyColumn: 'hrc_seq',
      predicateValue: eventCutoff,
      eligibleSql: HRC_EVENTS_ELIGIBLE_SQL,
    },
    {
      table: 'broker_invocation_events',
      alias: 'e',
      keyColumn: 'id',
      predicateValue: eventCutoff,
      eligibleSql: BROKER_INVOCATION_EVENTS_ELIGIBLE_SQL,
    },
    {
      table: 'runtime_buffers',
      alias: 'e',
      keyColumn: 'rowid',
      predicateValue: runtimeBufferCutoff,
      eligibleSql: RUNTIME_BUFFERS_ELIGIBLE_SQL,
    },
  ]
  const purgePlans: TablePlan[] = [
    {
      table: 'events',
      alias: 'e',
      keyColumn: 'seq',
      predicateValue: PURGE_DELTA_BACKLOG_OPERATION,
      eligibleSql: PURGE_EVENTS_ELIGIBLE_SQL,
    },
    {
      table: 'broker_invocation_events',
      alias: 'e',
      keyColumn: 'id',
      predicateValue: PURGE_DELTA_BACKLOG_OPERATION,
      eligibleSql: PURGE_BROKER_INVOCATION_DELTAS_ELIGIBLE_SQL,
    },
  ]
  const allPlans = options.operation === PURGE_DELTA_BACKLOG_OPERATION ? purgePlans : retentionPlans
  const plans = allPlans.filter((plan) => options.tables.includes(plan.table))

  const budget = createWriteBudget(options)
  const emptyTableResult = (stopReason: PrunePhaseStop): PruneStateRetentionResult['tables'] =>
    Object.fromEntries(
      RETENTION_TABLES.map((table) => [
        table,
        {
          eligibleCount: null,
          deleted: 0,
          remainingEligibleCount: null,
          stopReason,
          batchSize: options.batchSize,
        },
      ])
    ) as PruneStateRetentionResult['tables']

  const db = new Database(options.dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')

    // The auto-vacuum mode gates every delete, so it cannot fall back to a
    // guess. If the daemon holds the lock through the backoff ladder, this run
    // simply does not start.
    let autoVacuumMode: number
    try {
      autoVacuumMode = (await runWriteStep(budget, () => readPragmaNumber(db, 'auto_vacuum'))).value
    } catch (error) {
      if (!isBusyError(error)) {
        throw error
      }
      return {
        operation: options.operation,
        eventCutoff,
        runtimeBufferCutoff,
        t07040BackfillRowsBefore: null,
        t07040BackfillRowsAfter: null,
        eligibleCount: null,
        deleted: 0,
        remainingEligibleCount: null,
        autoVacuumMode: 0,
        freelistBeforePages: 0,
        freelistBeforeVacuumPages: 0,
        freelistAfterPages: 0,
        reclaimedPages: 0,
        stopReason: 'busy',
        deadlineExceeded: budget.deadlineExceeded,
        elapsedMillis: Date.now() - budget.startedAtMillis,
        pausedMillis: budget.pausedMillis,
        busyRetries: budget.busyRetries,
        writeSteps: budget.writeSteps,
        heldMillis: budget.heldMillis,
        maxObservedWriteHoldMillis: budget.maxObservedWriteHoldMillis,
        vacuumChunkPages: options.incrementalVacuumChunkPages,
        vacuumStopReason: 'busy',
        checkpointed: false,
        firstTurnBundles: null,
        tables: emptyTableResult('busy'),
      }
    }
    if (options.apply) {
      assertIncrementalAutoVacuum(autoVacuumMode)
    }
    let t07040BackfillRowsBefore: number | null = null
    let t07040BackfillRowsAfter: number | null = null
    if (options.operation === PURGE_DELTA_BACKLOG_OPERATION) {
      const before = readT07040BackfillInvariant(db)
      assertT07040BackfillInvariant(before, options.expectedT07040BackfillRows, 'before')
      t07040BackfillRowsBefore = before.total
    }
    const freelistBeforePages = tolerateBusy(() => readPragmaNumber(db, 'freelist_count'), 0).value
    const eligible = Object.fromEntries(
      plans.map((plan) => [
        plan.table,
        options.countEligible ? tolerateBusy(() => countEligible(db, plan), null).value : null,
      ])
    ) as Record<RetentionTable, number | null>
    const deleted = {
      events: 0,
      hrc_events: 0,
      broker_invocation_events: 0,
      runtime_buffers: 0,
    } satisfies Record<RetentionTable, number>
    const stopReasons = Object.fromEntries(
      RETENTION_TABLES.map((table) => [
        table,
        options.tables.includes(table) ? 'complete' : 'skipped',
      ])
    ) as Record<RetentionTable, PrunePhaseStop>
    const batchSizes: Record<RetentionTable, number> = {
      events: options.batchSize,
      hrc_events: options.batchSize,
      broker_invocation_events: options.batchSize,
      runtime_buffers: options.batchSize,
    }
    let freelistBeforeVacuumPages = freelistBeforePages
    let vacuumStopReason: PrunePhaseStop = 'complete'
    let vacuumChunkPages = options.incrementalVacuumChunkPages
    let checkpointed = false

    if (options.apply) {
      for (const plan of plans) {
        const outcome = await deleteInBatches(db, plan, options.batchSize, budget)
        deleted[plan.table] = outcome.deleted
        stopReasons[plan.table] = outcome.stopReason
        batchSizes[plan.table] = outcome.batchSize
      }
      if (options.operation === PURGE_DELTA_BACKLOG_OPERATION) {
        const afterDelete = readT07040BackfillInvariant(db)
        assertT07040BackfillInvariant(afterDelete, options.expectedT07040BackfillRows, 'after')
        t07040BackfillRowsAfter = afterDelete.total
      }
      if (options.checkpoint) {
        // A busy checkpoint is the daemon working; leave the WAL for next run.
        try {
          // PASSIVE, never TRUNCATE: TRUNCATE waits for readers and writers to
          // clear, which is exactly the unbounded blocking this job must not do.
          await runWriteStep(budget, () => db.exec('PRAGMA wal_checkpoint(PASSIVE);'))
          checkpointed = true
        } catch (error) {
          if (!isBusyError(error)) {
            throw error
          }
        }
      }
      freelistBeforeVacuumPages = tolerateBusy(
        () => readPragmaNumber(db, 'freelist_count'),
        freelistBeforePages
      ).value
      const vacuum = await incrementalVacuum(
        db,
        budget,
        options.incrementalVacuumPages,
        options.incrementalVacuumChunkPages
      )
      vacuumStopReason = vacuum.stopReason
      vacuumChunkPages = vacuum.chunkPages
    }

    // T-07235 bundle-directory retention. Runs AFTER the row deletes so a tight
    // wall-clock budget still spends itself on table retention first; it is a
    // handful of unlink calls plus one indexed read, and it never holds the
    // writer lock across the filesystem work.
    let firstTurnBundles: FirstTurnRetentionResult | null = null
    if (options.operation !== PURGE_DELTA_BACKLOG_OPERATION) {
      try {
        firstTurnBundles = await pruneFirstTurnMissingBundles(
          {
            firstTurnWatch: new FirstTurnWatchRepository(db),
            runtimeArtifacts: new RuntimeArtifactRepository(db),
          },
          {
            runtimeRoot: options.runtimeRoot,
            keepPerGeneration: options.firstTurnBundleKeep,
            ttlDays: options.firstTurnBundleTtlDays,
            now: options.now,
            apply: options.apply,
          }
        )
      } catch (error) {
        firstTurnBundles = {
          scanned: 0,
          overKeepLimit: 0,
          expired: 0,
          orphanDirs: 0,
          deletedDirs: 0,
          deletedArtifactRows: 0,
          errors: [error instanceof Error ? error.message : String(error)],
        }
      }
    }

    // A partial run leaves rows behind, so the remaining count is measured, not
    // assumed. Without the pre-flight scan it is honestly unknown.
    const remaining = Object.fromEntries(
      plans.map((plan) => [
        plan.table,
        options.apply
          ? options.countEligible
            ? tolerateBusy(() => countEligible(db, plan), null).value
            : null
          : eligible[plan.table],
      ])
    ) as Record<RetentionTable, number | null>
    const freelistAfterPages = tolerateBusy(
      () => readPragmaNumber(db, 'freelist_count'),
      freelistBeforeVacuumPages
    ).value
    if (options.operation === PURGE_DELTA_BACKLOG_OPERATION) {
      const after = readT07040BackfillInvariant(db)
      assertT07040BackfillInvariant(after, options.expectedT07040BackfillRows, 'after')
      t07040BackfillRowsAfter = after.total
    }
    const tableResult = Object.fromEntries(
      RETENTION_TABLES.map((table) => [
        table,
        {
          eligibleCount: eligible[table] ?? null,
          deleted: deleted[table],
          remainingEligibleCount: remaining[table] ?? null,
          stopReason: stopReasons[table],
          batchSize: batchSizes[table],
        },
      ])
    ) as PruneStateRetentionResult['tables']

    return {
      operation: options.operation,
      eventCutoff,
      runtimeBufferCutoff,
      t07040BackfillRowsBefore,
      t07040BackfillRowsAfter,
      eligibleCount: sumOrNull(Object.values(eligible)),
      deleted: Object.values(deleted).reduce((sum, count) => sum + count, 0),
      remainingEligibleCount: sumOrNull(Object.values(remaining)),
      autoVacuumMode,
      freelistBeforePages,
      freelistBeforeVacuumPages,
      freelistAfterPages,
      reclaimedPages: Math.max(0, freelistBeforeVacuumPages - freelistAfterPages),
      stopReason: worstStopReason([...Object.values(stopReasons), vacuumStopReason]),
      deadlineExceeded: budget.deadlineExceeded,
      elapsedMillis: Date.now() - budget.startedAtMillis,
      pausedMillis: budget.pausedMillis,
      busyRetries: budget.busyRetries,
      writeSteps: budget.writeSteps,
      heldMillis: budget.heldMillis,
      maxObservedWriteHoldMillis: budget.maxObservedWriteHoldMillis,
      vacuumChunkPages,
      vacuumStopReason,
      checkpointed,
      firstTurnBundles,
      tables: tableResult,
    }
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  try {
    const options = parsePruneStateRetentionArgs(Bun.argv.slice(2))
    const result =
      options.operation === STRIP_ENVELOPE_PAYLOADS_OPERATION
        ? await stripEnvelopePayloads(options)
        : options.operation === SPILL_TOOL_RESULTS_OPERATION
          ? await spillToolResults(options)
          : await pruneStateRetention(options)
    console.log(
      JSON.stringify(
        {
          startedAt: options.now.toISOString(),
          dbPath: options.dbPath,
          operation: options.operation,
          applied: options.apply,
          batchSize: options.batchSize,
          checkpoint: options.checkpoint,
          eventRetentionDays: options.eventRetentionDays,
          runtimeBufferRetentionDays: options.runtimeBufferRetentionDays,
          incrementalVacuumPages: options.incrementalVacuumPages,
          deadlineMinutes: options.deadlineMillis / MILLISECONDS_PER_MINUTE,
          paceMillis: options.paceMillis,
          maxWriteHoldMillis: options.maxWriteHoldMillis,
          maxDutyCycle: options.maxDutyCycle,
          countedEligible: options.countEligible,
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
