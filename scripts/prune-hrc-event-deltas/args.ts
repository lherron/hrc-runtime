import { join } from 'node:path'

import {
  DEFAULT_BUSY_MAX_RETRIES,
  DEFAULT_DEADLINE_MINUTES,
  DEFAULT_HRC_STORE_PATH,
  DEFAULT_INCREMENTAL_VACUUM_CHUNK_PAGES,
  DEFAULT_MAX_DUTY_CYCLE,
  DEFAULT_MAX_WRITE_HOLD_MILLIS,
  DEFAULT_PACE_MILLIS,
  MILLISECONDS_PER_MINUTE,
  PURGE_DELTA_BACKLOG_OPERATION,
  RESTUB_TOOL_RESULTS_OPERATION,
  SPILL_TOOL_RESULTS_OPERATION,
  STRIP_ENVELOPE_PAYLOADS_OPERATION,
} from './constants.ts'
import type { PruneOperation, PruneStateRetentionOptions } from './types.ts'

export function usage(): string {
  return [
    'Usage: bun scripts/prune-hrc-event-deltas.ts <operation> [options]',
    'Historical repair only. Nightly retention belongs to the daemon.',
    '--strip-envelope-payloads | --restub-tool-results (required)',
    '--db PATH --apply --batch-size N --no-checkpoint',
    '--deadline-minutes N --pace-millis N --max-write-hold-millis N',
    '--max-duty-cycle N --busy-max-retries N --count-eligible --no-count-eligible',
    '--incremental-vacuum-pages N --incremental-vacuum-chunk-pages N (strip only)',
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
  const requestedOperations: string[] = [
    ...(args.includes('--purge-delta-backlog') ? [PURGE_DELTA_BACKLOG_OPERATION] : []),
    ...(args.includes('--strip-envelope-payloads') ? [STRIP_ENVELOPE_PAYLOADS_OPERATION] : []),
    ...(args.includes('--spill-tool-results') ? [SPILL_TOOL_RESULTS_OPERATION] : []),
    ...(args.includes('--restub-tool-results') ? [RESTUB_TOOL_RESULTS_OPERATION] : []),
  ]
  if (requestedOperations.length > 1) {
    throw new Error('maintenance operation flags are mutually exclusive')
  }
  const selected = requestedOperations[0] ?? 'retention'
  if (
    selected !== STRIP_ENVELOPE_PAYLOADS_OPERATION &&
    selected !== RESTUB_TOOL_RESULTS_OPERATION
  ) {
    throw new Error(
      'Nightly retention is owned by the daemon; select --strip-envelope-payloads or --restub-tool-results'
    )
  }
  const operation: PruneOperation = selected
  if (readArgValue(args, '--tables') !== undefined) {
    throw new Error(`--tables cannot be combined with --${operation}; its table set is fixed`)
  }

  return {
    dbPath: readArgValue(args, '--db') ?? resolveDefaultDbPath(env),
    operation,
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
      operation === STRIP_ENVELOPE_PAYLOADS_OPERATION
        ? ['broker_invocation_events']
        : ['broker_invocation_events', 'hrc_events'],
    incrementalVacuumPages: parseNonNegativeInteger(
      readArgValue(args, '--incremental-vacuum-pages') ?? env['HRC_INCREMENTAL_VACUUM_PAGES'],
      0,
      '--incremental-vacuum-pages'
    ),
    now: new Date(),
  }
}
