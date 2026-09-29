import { dirname, join } from 'node:path'

import {
  DEFAULT_BUSY_MAX_RETRIES,
  DEFAULT_DEADLINE_MINUTES,
  DEFAULT_EVENT_RETENTION_DAYS,
  DEFAULT_FIRST_TURN_BUNDLE_KEEP,
  DEFAULT_FIRST_TURN_BUNDLE_TTL_DAYS,
  DEFAULT_HRC_STORE_PATH,
  DEFAULT_INCREMENTAL_VACUUM_CHUNK_PAGES,
  DEFAULT_MAX_DUTY_CYCLE,
  DEFAULT_MAX_WRITE_HOLD_MILLIS,
  DEFAULT_PACE_MILLIS,
  DEFAULT_RUNTIME_BUFFER_RETENTION_DAYS,
  MILLISECONDS_PER_MINUTE,
  PURGE_DELTA_BACKLOG_OPERATION,
  RESTUB_TOOL_RESULTS_OPERATION,
  SPILL_TOOL_RESULTS_OPERATION,
  STRIP_ENVELOPE_PAYLOADS_OPERATION,
  T07040_EXPECTED_BACKFILL_ROWS,
} from './constants.ts'
import {
  DEFAULT_RETENTION_TABLES,
  type PruneOperation,
  type PruneStateRetentionOptions,
  RETENTION_TABLES,
  type RetentionTable,
} from './types.ts'

export function usage(): string {
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
    '  --restub-tool-results               bound >32 KiB rows that already have a complete',
    '                                      matching spill blob (BIE, then hrc_events)',
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

export function readArgValue(args: string[], flag: string): string | undefined {
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

export function resolveDefaultDbPath(env: Record<string, string | undefined>): string {
  const stateDir = env['HRC_STATE_DIR']
  if (stateDir !== undefined && stateDir.trim().length > 0) {
    return join(stateDir, 'state.sqlite')
  }
  return DEFAULT_HRC_STORE_PATH
}

export function parsePositiveNumber(
  raw: string | undefined,
  fallback: number,
  flag: string
): number {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive number`)
  }
  return value
}

export function parseNonNegativeInteger(
  raw: string | undefined,
  fallback: number,
  flag: string
): number {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer`)
  }
  return value
}

export function parseDutyCycle(raw: string | undefined): number {
  const value = raw === undefined ? DEFAULT_MAX_DUTY_CYCLE : Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('--max-duty-cycle must be greater than 0 and at most 1')
  }
  return value
}

export function parseNonNegativeNumber(
  raw: string | undefined,
  fallback: number,
  flag: string
): number {
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
export function parseRetentionTables(raw: string | undefined): readonly RetentionTable[] {
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
export function resolveCountEligible(args: string[], apply: boolean): boolean {
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
    ...(args.includes('--restub-tool-results') ? [RESTUB_TOOL_RESULTS_OPERATION] : []),
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
            : operation === RESTUB_TOOL_RESULTS_OPERATION
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
