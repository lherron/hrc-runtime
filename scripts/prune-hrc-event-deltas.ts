#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'

const DEFAULT_HRC_STORE_PATH = '/Users/lherron/praesidium/var/state/hrc/state.sqlite'
const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000

const EVENTS_DELTA_WHERE_SQL = `
  event_kind IN ('broker.assistant.message.delta', 'broker.tool.call.delta')
`
const BROKER_INVOCATION_EVENTS_DELTA_WHERE_SQL = `
  type IN ('assistant.message.delta', 'tool.call.delta')
`

export type PruneDeltaEventsOptions = {
  dbPath: string
  apply: boolean
  batchSize: number
  checkpoint: boolean
  vacuum: boolean
  now: Date
}

export type PruneDeltaTableResult = {
  matchedCount: number
  eligibleCount: number
  deleted: number
  remainingCount: number
}

export type PruneDeltaEventsResult = {
  cutoff: string
  matchedCount: number
  eligibleCount: number
  deleted: number
  remainingCount: number
  tables: {
    events: PruneDeltaTableResult
    broker_invocation_events: PruneDeltaTableResult
  }
}

type PredicateCounts = {
  matchedCount: number
  eligibleCount: number
}

function usage(): string {
  return [
    'Usage: bun scripts/prune-hrc-event-deltas.ts [--db <path>] [--apply] [--batch-size <n>] [--no-checkpoint] [--vacuum]',
    '',
    'Prunes broker assistant-message and tool-call delta rows older than seven days',
    'from events and broker_invocation_events. Without --apply, reports counts only.',
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

export function parsePruneDeltaEventsArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env
): PruneDeltaEventsOptions {
  if (args.includes('--help') || args.includes('-h')) {
    throw new Error(usage())
  }

  const batchSizeRaw = readArgValue(args, '--batch-size')
  const batchSize = batchSizeRaw === undefined ? 10_000 : Number(batchSizeRaw)
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('--batch-size must be a positive integer')
  }

  return {
    dbPath: readArgValue(args, '--db') ?? resolveDefaultDbPath(env),
    apply: args.includes('--apply'),
    batchSize,
    checkpoint: !args.includes('--no-checkpoint'),
    vacuum: args.includes('--vacuum'),
    now: new Date(),
  }
}

function countEvents(db: Database, cutoff: string): PredicateCounts {
  const row = db
    .query<PredicateCounts, [string]>(
      `
        SELECT
          COUNT(*) AS matchedCount,
          COALESCE(SUM(CASE WHEN ts < ? THEN 1 ELSE 0 END), 0) AS eligibleCount
        FROM events
        WHERE ${EVENTS_DELTA_WHERE_SQL}
      `
    )
    .get(cutoff)
  return row ?? { matchedCount: 0, eligibleCount: 0 }
}

function countBrokerInvocationEvents(db: Database, cutoff: string): PredicateCounts {
  const row = db
    .query<PredicateCounts, [string]>(
      `
        SELECT
          COUNT(*) AS matchedCount,
          COALESCE(SUM(CASE WHEN time < ? THEN 1 ELSE 0 END), 0) AS eligibleCount
        FROM broker_invocation_events
        WHERE ${BROKER_INVOCATION_EVENTS_DELTA_WHERE_SQL}
      `
    )
    .get(cutoff)
  return row ?? { matchedCount: 0, eligibleCount: 0 }
}

function countRemainingEvents(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM events WHERE ${EVENTS_DELTA_WHERE_SQL}`
      )
      .get()?.count ?? 0
  )
}

function countRemainingBrokerInvocationEvents(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(
        `
          SELECT COUNT(*) AS count
          FROM broker_invocation_events
          WHERE ${BROKER_INVOCATION_EVENTS_DELTA_WHERE_SQL}
        `
      )
      .get()?.count ?? 0
  )
}

function deleteEventsBatch(db: Database, cutoff: string, batchSize: number): number {
  return db
    .prepare<never, [string, number]>(
      `
        DELETE FROM events
        WHERE seq IN (
          SELECT seq
          FROM events
          WHERE ${EVENTS_DELTA_WHERE_SQL}
            AND ts < ?
          LIMIT ?
        )
      `
    )
    .run(cutoff, batchSize).changes
}

function deleteBrokerInvocationEventsBatch(
  db: Database,
  cutoff: string,
  batchSize: number
): number {
  return db
    .prepare<never, [string, number]>(
      `
        DELETE FROM broker_invocation_events
        WHERE id IN (
          SELECT id
          FROM broker_invocation_events
          WHERE ${BROKER_INVOCATION_EVENTS_DELTA_WHERE_SQL}
            AND time < ?
          LIMIT ?
        )
      `
    )
    .run(cutoff, batchSize).changes
}

function deleteInBatches(deleteBatch: () => number, batchSize: number): number {
  let deleted = 0
  while (true) {
    const batchDeleted = deleteBatch()
    deleted += batchDeleted
    if (batchDeleted < batchSize) {
      return deleted
    }
  }
}

export function pruneDeltaEvents(options: PruneDeltaEventsOptions): PruneDeltaEventsResult {
  if (!existsSync(options.dbPath)) {
    throw new Error(`HRC store does not exist: ${options.dbPath}`)
  }

  const cutoff = new Date(options.now.getTime() - RETENTION_MILLISECONDS).toISOString()
  const db = new Database(options.dbPath)
  try {
    const events = countEvents(db, cutoff)
    const brokerInvocationEvents = countBrokerInvocationEvents(db, cutoff)
    const matchedCount = events.matchedCount + brokerInvocationEvents.matchedCount

    let eventsDeleted = 0
    let brokerInvocationEventsDeleted = 0
    if (options.apply) {
      eventsDeleted = deleteInBatches(
        () => deleteEventsBatch(db, cutoff, options.batchSize),
        options.batchSize
      )
      brokerInvocationEventsDeleted = deleteInBatches(
        () => deleteBrokerInvocationEventsBatch(db, cutoff, options.batchSize),
        options.batchSize
      )

      if (options.checkpoint) {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      }
      if (options.vacuum) {
        db.exec('VACUUM;')
      }
    }

    const eventsRemaining = options.apply ? countRemainingEvents(db) : events.matchedCount
    const brokerInvocationEventsRemaining = options.apply
      ? countRemainingBrokerInvocationEvents(db)
      : brokerInvocationEvents.matchedCount

    return {
      cutoff,
      matchedCount,
      eligibleCount: events.eligibleCount + brokerInvocationEvents.eligibleCount,
      deleted: eventsDeleted + brokerInvocationEventsDeleted,
      remainingCount: eventsRemaining + brokerInvocationEventsRemaining,
      tables: {
        events: {
          ...events,
          deleted: eventsDeleted,
          remainingCount: eventsRemaining,
        },
        broker_invocation_events: {
          ...brokerInvocationEvents,
          deleted: brokerInvocationEventsDeleted,
          remainingCount: brokerInvocationEventsRemaining,
        },
      },
    }
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  try {
    const options = parsePruneDeltaEventsArgs(Bun.argv.slice(2))
    const result = pruneDeltaEvents(options)
    if (result.matchedCount === 0) {
      // A store whose delta rows have all been pruned is observationally
      // identical to one whose predicate has gone stale: both leave non-delta
      // rows behind and match nothing. Warn rather than fail, or the job goes
      // red nightly on exactly the state it exists to produce.
      console.error(
        'warning: delta predicate matched no rows in events or broker_invocation_events; ' +
          'expected if the store is already pruned, but verify the known delta kinds if this persists on an active store'
      )
    }
    console.log(
      JSON.stringify(
        {
          dbPath: options.dbPath,
          applied: options.apply,
          batchSize: options.batchSize,
          checkpoint: options.checkpoint,
          vacuum: options.vacuum,
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
