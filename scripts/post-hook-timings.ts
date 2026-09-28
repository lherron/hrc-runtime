/**
 * Replay recorded hook timings as `hook.settled` facts.
 *
 *   bun scripts/post-hook-timings.ts --backfill
 *
 * Idempotent: each fact is keyed `hook:<runId>`, so a replay of an already
 * posted run is reported `existing` and never overwrites the stored row.
 */

import { spawnSync } from 'node:child_process'

import {
  hookSettledPostArgs,
  readTimingRecords,
  resolveHookTimingsPath,
} from './lib/hook-timing.ts'

const args = process.argv.slice(2)
if (args.length !== 1 || args[0] !== '--backfill') {
  console.error('usage: bun scripts/post-hook-timings.ts --backfill')
  process.exit(2)
}

const path = resolveHookTimingsPath()
const { records, malformedLines } = readTimingRecords(path)
if (malformedLines > 0) {
  console.error(`[hook-timing] ${malformedLines} malformed timing line(s) in ${path}`)
  process.exit(1)
}

let created = 0
let existing = 0
let failed = 0
for (const record of records) {
  const result = spawnSync('wrkp', hookSettledPostArgs(record), {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.status !== 0 || result.error) {
    failed += 1
    console.error(
      `[hook-timing] failed to post ${record.runId}: ${result.error ?? result.stderr.trim()}`
    )
  } else if (result.stdout.includes('(existing)')) {
    existing += 1
  } else {
    created += 1
  }
}

console.log(
  `hook timing backfill: path=${path} created=${created} existing=${existing} failed=${failed}`
)
if (failed > 0) process.exit(1)
