import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import {
  brokerToolResultBlobId,
  createToolResultSpillStub,
  lifecycleToolResultBlobId,
  toolResultFromBrokerResult,
} from 'hrc-core'

import { openHrcDatabase } from '../database.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(onMiss?: Parameters<typeof openHrcDatabase>[1]['onLedgerBlobMiss']) {
  const root = mkdtempSync(join(tmpdir(), 't07610-blobs-'))
  roots.push(root)
  return openHrcDatabase(join(root, 'state.sqlite'), { onLedgerBlobMiss: onMiss })
}

function lifecycle(runtimeId: string, toolUseId: string, result: unknown) {
  return {
    ts: '2026-08-27T04:00:00.000Z',
    hostSessionId: 'session-1',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-07610',
    laneRef: 'main',
    generation: 1,
    runtimeId,
    runId: 'run-1',
    category: 'tool' as const,
    eventKind: 'turn.tool_result',
    transport: 'headless' as const,
    payload: { toolUseId, toolName: 'exec', result },
  }
}

describe('T-07610 tool-result blob storage', () => {
  test('migration creates blob authority and empty federation staging tables', () => {
    const db = fixture()
    expect(db.migrations.applied).toContain('0045_tool_result_blobs')
    expect(
      db.sqlite
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tool_result_blob%' ORDER BY name"
        )
        .all()
        .map((row) => row.name)
    ).toEqual(['tool_result_blob_parts', 'tool_result_blobs'])
    db.close()
  })

  test('three broker result shapes spill once and hydrate both ledgers exactly', () => {
    const db = fixture()
    const body = `full-result-marker:${'x'.repeat(40_000)}`
    const shapes: unknown[] = [
      body,
      { output: body, exitCode: 0 },
      { content: [{ type: 'text', text: body }], details: { exitCode: 0 } },
    ]

    for (const [index, rawResult] of shapes.entries()) {
      const runtimeId = `runtime-${index}`
      const toolCallId = `tool-${index}`
      const appended = db.brokerInvocationEvents.appendEvent({
        invocationId: `invocation-${index}`,
        seq: 1,
        time: '2026-08-27T04:00:00.000Z',
        type: 'tool.call.completed',
        runtimeId,
        payload: { toolCallId, name: 'exec', result: rawResult },
      })
      expect(JSON.parse(appended.record.brokerEventJson).result).toEqual(rawResult)
      const persistedBroker = db.sqlite
        .query<{ broker_event_json: string }, [string]>(
          'SELECT broker_event_json FROM broker_invocation_events WHERE invocation_id = ?'
        )
        .get(`invocation-${index}`)!
      const brokerStub = JSON.parse(persistedBroker.broker_event_json)
      expect(brokerStub.result.details.spill).toMatchObject({
        blobId: brokerToolResultBlobId(runtimeId, toolCallId),
        kind: 'broker_raw',
      })
      expect(Buffer.byteLength(persistedBroker.broker_event_json)).toBeLessThan(8_000)

      const canonical = toolResultFromBrokerResult(rawResult)
      const event = db.hrcEvents.append(lifecycle(runtimeId, toolCallId, canonical))
      expect((event.payload as { result: unknown }).result).toEqual(canonical)
      const persistedLifecycle = db.sqlite
        .query<{ payload_json: string }, [number]>(
          'SELECT payload_json FROM hrc_events WHERE hrc_seq = ?'
        )
        .get(event.hrcSeq)!
      expect(JSON.parse(persistedLifecycle.payload_json).result.details.spill).toMatchObject({
        blobId: brokerToolResultBlobId(runtimeId, toolCallId),
        kind: 'broker_raw',
      })
      expect(Buffer.byteLength(persistedLifecycle.payload_json)).toBeLessThan(8_000)
    }

    expect(
      db.sqlite
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM tool_result_blobs')
        .get()?.count
    ).toBe(3)
    db.close()
  })

  test('inline results remain inline and an outer rollback removes blob plus ledger row', () => {
    const db = fixture()
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inline',
      seq: 1,
      time: '2026-08-27T04:00:00.000Z',
      type: 'tool.call.completed',
      runtimeId: 'runtime-inline',
      payload: { toolCallId: 'inline-tool', result: 'small' },
    })
    expect(
      db.sqlite
        .query<{ broker_event_json: string }, []>(
          "SELECT broker_event_json FROM broker_invocation_events WHERE invocation_id='inline'"
        )
        .get()?.broker_event_json
    ).toContain('small')
    expect(
      db.sqlite.query<{ count: number }, []>('SELECT COUNT(*) count FROM tool_result_blobs').get()
        ?.count
    ).toBe(0)

    const outer = db.sqlite.transaction(() => {
      db.brokerInvocationEvents.appendEvent({
        invocationId: 'rolled-back',
        seq: 1,
        time: '2026-08-27T04:00:00.000Z',
        type: 'tool.call.completed',
        runtimeId: 'runtime-rollback',
        payload: { toolCallId: 'rollback-tool', result: 'z'.repeat(40_000) },
      })
      throw new Error('rollback')
    })
    expect(() => outer.immediate()).toThrow('rollback')
    expect(
      db.sqlite
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM broker_invocation_events WHERE invocation_id='rolled-back'"
        )
        .get()?.count
    ).toBe(0)
    expect(
      db.sqlite.query<{ count: number }, []>('SELECT COUNT(*) count FROM tool_result_blobs').get()
        ?.count
    ).toBe(0)
    db.close()
  })

  test('missing blobs expose the excerpt and increment ledger.blob_miss', () => {
    const misses: string[] = []
    const db = fixture((miss) => misses.push(miss.metric))
    const blobId = 'tc:missing-runtime:missing-tool'
    const result = createToolResultSpillStub('missing body', {
      blobId,
      bytes: 40_000,
      kind: 'broker_raw',
    })
    db.sqlite
      .query<never, [string]>(
        `INSERT INTO broker_invocation_events (
          invocation_id, seq, time, type, runtime_id, broker_event_json,
          projection_status, created_at
        ) VALUES ('missing-invocation',1,'2026-08-27T04:00:00Z','tool.call.completed',
          'missing-runtime',?,'applied','2026-08-27T04:00:00Z')`
      )
      .run(JSON.stringify({ toolCallId: 'missing-tool', result }))
    const read = db.brokerInvocationEvents.getByInvocationAndSeq('missing-invocation', 1)!
    expect(JSON.parse(read.brokerEventJson).result.details.spill.blobId).toBe(blobId)
    expect(misses).toEqual(['ledger.blob_miss'])
    db.close()
  })

  test('addressed parts tolerate retry and out-of-order arrival, then assemble and clear staging', () => {
    const db = fixture()
    const resultJson = JSON.stringify({ output: `parted-${'q'.repeat(1_000)}` })
    const bytes = Buffer.byteLength(resultJson)
    const chunks = [resultJson.slice(0, 100), resultJson.slice(100)]
    const base = {
      blobId: 'tc:foreign-runtime:foreign-tool',
      runtimeId: 'foreign-runtime',
      kind: 'broker_raw' as const,
      bytes,
      parts: 2,
    }
    expect(db.toolResultBlobs.ingestPart({ ...base, part: 1, chunk: chunks[1]! })).toEqual({
      completed: false,
      duplicate: false,
    })
    expect(db.toolResultBlobs.ingestPart({ ...base, part: 1, chunk: chunks[1]! })).toEqual({
      completed: false,
      duplicate: true,
    })
    expect(db.toolResultBlobs.ingestPart({ ...base, part: 0, chunk: chunks[0]! })).toEqual({
      completed: true,
      duplicate: false,
    })
    expect(db.toolResultBlobs.get(base.blobId)?.resultJson).toBe(resultJson)
    expect(
      db.sqlite
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM tool_result_blob_parts')
        .get()?.count
    ).toBe(0)
    expect(db.toolResultBlobs.ingestPart({ ...base, part: 0, chunk: chunks[0]! })).toEqual({
      completed: true,
      duplicate: true,
    })
    db.close()
  })

  test('only locally-authored lifecycle and broker blobs are rowid-fed', () => {
    const db = fixture()
    const incarnation = db.hrcEvents.ledgerIncarnationId()
    const localLifecycle = db.hrcEvents.append(
      lifecycle('local-lifecycle-runtime', 'local-lifecycle-tool', {
        content: [{ type: 'text', text: 'c'.repeat(40_000) }],
      })
    )
    const localLifecycleBlobId = lifecycleToolResultBlobId(incarnation, localLifecycle.hrcSeq)
    db.toolResultBlobs.insert({
      blobId: lifecycleToolResultBlobId(incarnation, 99),
      runtimeId: 'foreign-runtime',
      kind: 'lifecycle_canonical',
      bytes: 2,
      resultJson: '{}',
    })
    db.sqlite
      .query<never, [string]>(
        `INSERT INTO hrc_events (
           hrc_seq, stream_seq, ts, host_session_id, scope_ref, lane_ref, generation,
           runtime_id, category, event_kind, replayed, payload_json, source_ref, origin_seq
         ) VALUES (99, 99, '2026-08-27T04:00:00Z', 'foreign-session',
           'agent:foreign:project:remote', 'main', 1, 'foreign-runtime', 'tool',
           'turn.tool_result', 0, ?, 'foreign-source', 99)`
      )
      .run(
        JSON.stringify({
          toolUseId: 'foreign-tool',
          result: createToolResultSpillStub('foreign', {
            blobId: lifecycleToolResultBlobId(incarnation, 99),
            bytes: 2,
            kind: 'lifecycle_canonical',
          }),
        })
      )
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'local-invocation',
      seq: 1,
      time: '2026-08-27T04:00:00.000Z',
      type: 'tool.call.completed',
      runtimeId: 'local-runtime',
      payload: { toolCallId: 'local-tool', result: 'l'.repeat(40_000) },
    })
    db.toolResultBlobs.insert({
      blobId: brokerToolResultBlobId('foreign-runtime', 'foreign-tool'),
      runtimeId: 'foreign-runtime',
      kind: 'broker_raw',
      bytes: 2,
      resultJson: '{}',
    })
    db.sqlite
      .query<never, [string]>(
        `INSERT INTO broker_invocation_events (
           invocation_id, seq, time, type, runtime_id, broker_event_json,
           projection_status, source_ref, origin_seq, created_at
         ) VALUES ('foreign-invocation', 1, '2026-08-27T04:00:00Z',
           'tool.call.completed', 'foreign-runtime', ?, 'applied',
           'foreign-source', 1, '2026-08-27T04:00:00Z')`
      )
      .run(
        JSON.stringify({
          toolCallId: 'foreign-tool',
          result: createToolResultSpillStub('foreign', {
            blobId: brokerToolResultBlobId('foreign-runtime', 'foreign-tool'),
            bytes: 2,
            kind: 'broker_raw',
          }),
        })
      )
    expect(db.toolResultBlobs.listLocalFromRowid(0, 10).map((blob) => blob.blobId)).toEqual([
      localLifecycleBlobId,
      brokerToolResultBlobId('local-runtime', 'local-tool'),
    ])
    db.close()
  })
})
