#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'

const DEFAULT_HRC_STORE_PATH = '/Users/lherron/praesidium/var/state/hrc/state.sqlite'

const DELTA_EVENTS_WHERE_SQL = `
  source = 'otel'
  AND event_kind IN ('codex.websocket_event', 'codex.sse_event')
  AND json_extract(event_json, '$.otel.logRecord.attributes."event.kind"') LIKE '%.delta'
`

export type PruneDeltaEventsOptions = {
  dbPath: string
  apply: boolean
  batchSize: number
  checkpoint: boolean
  vacuum: boolean
}

export type PruneDeltaEventsResult = {
  initialCount: number
  deleted: number
  remainingCount: number
}

function usage(): string {
  return [
    'Usage: bun scripts/prune-hrc-event-deltas.ts [--db <path>] [--apply] [--batch-size <n>] [--no-checkpoint] [--vacuum]',
    '',
    'Deletes raw OTEL transport rows whose nested event.kind ends with .delta.',
    'Without --apply, prints counts only and does not delete rows.',
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
  }
}

export function countDeltaEvents(db: Database): number {
  const row = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM events WHERE ${DELTA_EVENTS_WHERE_SQL}`
    )
    .get()
  return row?.count ?? 0
}

export function deleteDeltaEventsBatch(db: Database, batchSize: number): number {
  const result = db
    .prepare<never, [number]>(
      `
        DELETE FROM events
        WHERE seq IN (
          SELECT seq
          FROM events
          WHERE ${DELTA_EVENTS_WHERE_SQL}
          LIMIT ?
        )
      `
    )
    .run(batchSize)
  return result.changes
}

export function pruneDeltaEvents(options: PruneDeltaEventsOptions): PruneDeltaEventsResult {
  if (!existsSync(options.dbPath)) {
    throw new Error(`HRC store does not exist: ${options.dbPath}`)
  }

  const db = new Database(options.dbPath)
  try {
    const initialCount = countDeltaEvents(db)
    let deleted = 0

    if (options.apply) {
      while (true) {
        const batchDeleted = deleteDeltaEventsBatch(db, options.batchSize)
        deleted += batchDeleted
        if (batchDeleted === 0 || batchDeleted < options.batchSize) {
          break
        }
      }

      if (options.checkpoint) {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      }
      if (options.vacuum) {
        db.exec('VACUUM;')
      }
    }

    return {
      initialCount,
      deleted,
      remainingCount: countDeltaEvents(db),
    }
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  try {
    const options = parsePruneDeltaEventsArgs(Bun.argv.slice(2))
    const result = pruneDeltaEvents(options)
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
