import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import { toolResultFromBrokerResult } from '../packages/hrc-core/src/index.ts'
import { openHrcDatabase } from '../packages/hrc-store-sqlite/src/database.ts'
import { parsePruneStateRetentionArgs, spillToolResults } from './prune-hrc-event-deltas.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function seed() {
  const root = mkdtempSync(join(tmpdir(), 't07610-backfill-'))
  roots.push(root)
  const dbPath = join(root, 'state.sqlite')
  const db = openHrcDatabase(dbPath)
  const rawA = { output: `shared:${'a'.repeat(40_000)}`, exitCode: 0 }
  const rawB = { output: `mismatch:${'b'.repeat(40_000)}`, exitCode: 0 }
  const brokerRows = [
    ['invocation-a', 'runtime-a', 'tool-a', rawA],
    ['invocation-b', 'runtime-b', 'tool-b', rawB],
  ] as const
  for (const [invocationId, runtimeId, toolCallId, result] of brokerRows) {
    db.sqlite
      .query<never, [string, string, string]>(
        `INSERT INTO broker_invocation_events (
           invocation_id, seq, time, type, runtime_id, broker_event_json,
           projection_status, created_at
         ) VALUES (?, 1, '2026-08-27T04:00:00Z', 'tool.call.completed', ?, ?,
           'applied', '2026-08-27T04:00:00Z')`
      )
      .run(invocationId, runtimeId, JSON.stringify({ toolCallId, result }))
  }
  const canonicalA = toolResultFromBrokerResult(rawA)
  const canonicalMismatch = {
    ...toolResultFromBrokerResult(rawB),
    details: { output: 'intentionally different', exitCode: 0 },
  }
  const lifecycleRows = [
    [1, 'runtime-a', 'tool-a', canonicalA],
    [2, 'runtime-b', 'tool-b', canonicalMismatch],
  ] as const
  for (const [seq, runtimeId, toolUseId, result] of lifecycleRows) {
    db.sqlite
      .query<never, [number, number, string, string]>(
        `INSERT INTO hrc_events (
           hrc_seq, stream_seq, ts, host_session_id, scope_ref, lane_ref, generation,
           runtime_id, category, event_kind, replayed, payload_json
         ) VALUES (?, ?, '2026-08-27T04:00:00Z', 'session-1',
           'agent:cody:project:hrc-runtime:task:T-07610', 'main', 1, ?, 'tool',
           'turn.tool_result', 0, ?)`
      )
      .run(seq, seq, runtimeId, JSON.stringify({ toolUseId, result }))
  }
  db.close()
  return { dbPath, rawA, canonicalA, canonicalMismatch }
}

describe('T-07610 tool-result backfill', () => {
  test('BIE-first keyset backfill shares only exact canonical conversions and is idempotent', async () => {
    const { dbPath, rawA, canonicalA, canonicalMismatch } = seed()
    const options = parsePruneStateRetentionArgs([
      '--db',
      dbPath,
      '--spill-tool-results',
      '--apply',
      '--batch-size',
      '1',
      '--pace-millis',
      '0',
      '--max-duty-cycle',
      '1',
      '--deadline-minutes',
      '0',
      '--no-checkpoint',
    ])
    const result = await spillToolResults(options)
    expect(result).toMatchObject({
      stopReason: 'complete',
      brokerInvocationEvents: { candidates: 2, stubbed: 2 },
      hrcEvents: { candidates: 2, stubbed: 2 },
      blobs: { sharedBrokerRaw: 1, lifecycleCanonical: 1 },
      equalityCheckMisses: 1,
    })

    const db = openHrcDatabase(dbPath)
    expect(
      JSON.parse(
        db.brokerInvocationEvents.getByInvocationAndSeq('invocation-a', 1)!.brokerEventJson
      ).result
    ).toEqual(rawA)
    expect((db.hrcEvents.listFromHrcSeq(1)[0]!.payload as { result: unknown }).result).toEqual(
      canonicalA
    )
    expect((db.hrcEvents.listFromHrcSeq(2)[0]!.payload as { result: unknown }).result).toEqual(
      canonicalMismatch
    )
    expect(
      db.sqlite.query<{ count: number }, []>('SELECT COUNT(*) count FROM tool_result_blobs').get()
        ?.count
    ).toBe(3)
    db.close()

    const second = await spillToolResults(options)
    expect(second).toMatchObject({
      stopReason: 'complete',
      brokerInvocationEvents: { candidates: 0, stubbed: 0 },
      hrcEvents: { candidates: 0, stubbed: 0 },
      blobs: { sharedBrokerRaw: 0, lifecycleCanonical: 0 },
      equalityCheckMisses: 0,
    })
  })
})
