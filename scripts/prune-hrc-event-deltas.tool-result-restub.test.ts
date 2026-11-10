import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import {
  brokerToolResultBlobId,
  toolResultFromBrokerResult,
} from '../packages/hrc-core/src/index.ts'
import { openHrcDatabase } from '../packages/hrc-store-sqlite/src/database.ts'
import { parsePruneStateRetentionArgs, restubToolResults } from './prune-hrc-event-deltas.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function seedOversizedStubs() {
  const root = mkdtempSync(join(tmpdir(), 't08422-restub-'))
  roots.push(root)
  const dbPath = join(root, 'state.sqlite')
  const db = openHrcDatabase(dbPath)
  const rawResult = {
    content: [{ type: 'text', text: 'full result' }],
    details: { stdout: 'z'.repeat(80_000), exitCode: 0, durationMs: 42 },
  }
  const resultJson = JSON.stringify(rawResult)
  const bytes = Buffer.byteLength(resultJson)
  const descriptors = {
    valid: {
      blobId: brokerToolResultBlobId('runtime-valid', 'tool-valid'),
      bytes,
      kind: 'broker_raw',
    },
    missing: {
      blobId: 'tc:runtime-missing:tool-missing',
      bytes,
      kind: 'broker_raw',
    },
    incomplete: {
      blobId: 'tc:runtime-incomplete:tool-incomplete',
      bytes,
      kind: 'broker_raw',
    },
    mismatch: {
      blobId: 'tc:runtime-mismatch:tool-mismatch',
      bytes,
      kind: 'broker_raw',
    },
  } as const
  db.sqlite
    .query<never, [string, string, number, string]>(
      `INSERT INTO tool_result_blobs
        (blob_id, runtime_id, kind, bytes, complete, result_json, created_at)
       VALUES (?, ?, 'broker_raw', ?, 1, ?, '2026-09-13T00:00:00Z')`
    )
    .run(descriptors.valid.blobId, 'runtime-valid', bytes, resultJson)
  db.sqlite
    .query<never, [string, string, number, string]>(
      `INSERT INTO tool_result_blobs
        (blob_id, runtime_id, kind, bytes, complete, result_json, created_at)
       VALUES (?, ?, 'broker_raw', ?, 0, ?, '2026-09-13T00:00:00Z')`
    )
    .run(descriptors.incomplete.blobId, 'runtime-incomplete', bytes, resultJson)
  db.sqlite
    .query<never, [string, string, number, string]>(
      `INSERT INTO tool_result_blobs
        (blob_id, runtime_id, kind, bytes, complete, result_json, created_at)
       VALUES (?, ?, 'lifecycle_canonical', ?, 1, ?, '2026-09-13T00:00:00Z')`
    )
    .run(descriptors.mismatch.blobId, 'runtime-mismatch', bytes, resultJson)

  const cases = [
    ['valid', descriptors.valid],
    ['missing', descriptors.missing],
    ['incomplete', descriptors.incomplete],
    ['mismatch', descriptors.mismatch],
  ] as const
  for (const [index, [name, descriptor]] of cases.entries()) {
    const stub = {
      content: [{ type: 'text', text: `existing ${name} excerpt` }],
      details: {
        spill: descriptor,
        stdout: 'inline duplicate'.repeat(5_000),
        exitCode: 0,
        durationMs: 42,
      },
    }
    db.sqlite
      .query<never, [string, string, string]>(
        `INSERT INTO broker_invocation_events (
           invocation_id, seq, time, type, runtime_id, broker_event_json,
           projection_status, created_at
         ) VALUES (?, 1, '2026-09-13T00:00:00Z', 'tool.call.completed', ?, ?,
           'applied', '2026-09-13T00:00:00Z')`
      )
      .run(
        `invocation-${name}`,
        `runtime-${name}`,
        JSON.stringify({ toolCallId: `tool-${name}`, result: stub })
      )
    db.sqlite
      .query<never, [number, number, string, string]>(
        `INSERT INTO hrc_events (
           hrc_seq, stream_seq, ts, host_session_id, scope_ref, lane_ref, generation,
           runtime_id, category, event_kind, replayed, payload_json
         ) VALUES (?, ?, '2026-09-13T00:00:00Z', 'session-1',
           'agent:cody:project:hrc-runtime:task:T-08422', 'main', 1, ?, 'tool',
           'turn.tool_result', 0, ?)`
      )
      .run(
        index + 1,
        index + 1,
        `runtime-${name}`,
        JSON.stringify({ toolUseId: `tool-${name}`, result: stub })
      )
  }

  const invalidStub = {
    content: [{ type: 'text', text: 'invalid excerpt' }],
    details: { spill: { nope: true }, stdout: 'i'.repeat(80_000) },
  }
  db.sqlite
    .query<never, [string]>(
      `INSERT INTO broker_invocation_events (
         invocation_id, seq, time, type, runtime_id, broker_event_json,
         projection_status, created_at
       ) VALUES ('invocation-invalid', 1, '2026-09-13T00:00:00Z',
         'tool.call.completed', 'runtime-invalid', ?, 'applied', '2026-09-13T00:00:00Z')`
    )
    .run(JSON.stringify({ toolCallId: 'tool-invalid', result: invalidStub }))
  db.sqlite
    .query<never, [string]>(
      `INSERT INTO hrc_events (
         hrc_seq, stream_seq, ts, host_session_id, scope_ref, lane_ref, generation,
         runtime_id, category, event_kind, replayed, payload_json
       ) VALUES (5, 5, '2026-09-13T00:00:00Z', 'session-1',
         'agent:cody:project:hrc-runtime:task:T-08422', 'main', 1, 'runtime-invalid',
         'tool', 'turn.tool_result', 0, ?)`
    )
    .run(JSON.stringify({ toolUseId: 'tool-invalid', result: invalidStub }))
  db.close()
  return { dbPath, rawResult }
}

describe('T-08422 tool-result re-stub backfill', () => {
  test('dry-runs, rewrites valid authorities, reports unsafe rows, and is idempotent', async () => {
    const { dbPath, rawResult } = seedOversizedStubs()
    const baseArgs = [
      '--db',
      dbPath,
      '--restub-tool-results',
      '--batch-size',
      '1',
      '--pace-millis',
      '0',
      '--max-duty-cycle',
      '1',
      '--deadline-minutes',
      '0',
      '--no-checkpoint',
    ]
    const dryRun = await restubToolResults(parsePruneStateRetentionArgs(baseArgs))
    expect(dryRun.brokerInvocationEvents).toMatchObject({
      candidates: 5,
      rewritten: 0,
      skipped: {
        invalidDescriptor: 1,
        missingBlob: 1,
        incompleteBlob: 1,
        kindMismatch: 1,
        updateConflict: 0,
      },
    })
    expect(dryRun.hrcEvents).toMatchObject({
      candidates: 5,
      rewritten: 0,
      skipped: {
        invalidDescriptor: 1,
        missingBlob: 1,
        incompleteBlob: 1,
        kindMismatch: 1,
        updateConflict: 0,
      },
    })
    expect(dryRun.brokerInvocationEvents.bytesAfter).toBeLessThan(
      dryRun.brokerInvocationEvents.bytesBefore
    )

    const applied = await restubToolResults(parsePruneStateRetentionArgs([...baseArgs, '--apply']))
    expect(applied.brokerInvocationEvents.rewritten).toBe(1)
    expect(applied.hrcEvents.rewritten).toBe(1)

    const db = openHrcDatabase(dbPath)
    expect(
      JSON.parse(
        db.brokerInvocationEvents.getByInvocationAndSeq('invocation-valid', 1)!.brokerEventJson
      ).result
    ).toEqual(rawResult)
    expect((db.hrcEvents.listFromHrcSeq(1)[0]!.payload as { result: unknown }).result).toEqual(
      toolResultFromBrokerResult(rawResult)
    )
    const rawBrokerRow = db.sqlite
      .query<{ broker_event_json: string }, []>(
        "SELECT broker_event_json FROM broker_invocation_events WHERE invocation_id='invocation-valid'"
      )
      .get()!.broker_event_json
    expect(Buffer.byteLength(rawBrokerRow)).toBeLessThan(8_000)
    expect(JSON.parse(rawBrokerRow).result.content).toEqual([
      { type: 'text', text: 'existing valid excerpt' },
    ])
    db.close()

    const second = await restubToolResults(parsePruneStateRetentionArgs([...baseArgs, '--apply']))
    expect(second.brokerInvocationEvents).toMatchObject({
      candidates: 4,
      rewritten: 0,
    })
    expect(second.hrcEvents).toMatchObject({ candidates: 4, rewritten: 0 })
  })
})
