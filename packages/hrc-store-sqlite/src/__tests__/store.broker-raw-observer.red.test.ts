/**
 * RED unit tests for T-05083 (Phase A of T-05078):
 * BrokerInvocationEventRepository.listFromAfterSeq
 *
 * Author: smokey (TDD RED gatekeeper). These tests are EXPECTED TO FAIL until
 * Phase A implementation lands. They pin the listFromAfterSeq contract:
 *   - afterSeq is an EXCLUSIVE lower bound (seq > afterSeq, not >=)
 *   - All supplied selector fields (invocationId, runId, runtimeId) are
 *     fenced in the WHERE clause; mismatched values yield empty results
 *   - Results are returned ORDER BY seq ASC
 *   - afterSeq=0 returns all rows for the selector (fresh-cursor semantics)
 *   - Empty result when no events exist above afterSeq
 *   - NOTE: "generation" fence (HRC runtime generation) is NOT a column in
 *     broker_invocation_events — the table has invocation_id, seq, run_id,
 *     runtime_id, harness_generation (broker harness gen), etc., but NO
 *     HRC-level generation column. Generation enforcement is expected to be
 *     applied at the handler level (e.g., by verifying runtimeId matches the
 *     expected generation via a JOIN with runtimes, or by asserting at
 *     invocation resolution time). Repo tests cover the three persisted fields.
 *
 * The implementer must provide:
 *   - BrokerInvocationEventRepository.listFromAfterSeq in hrc-store-sqlite
 *     matching signature:
 *       listFromAfterSeq(selector: {
 *         invocationId: string
 *         runId?: string
 *         runtimeId: string
 *         afterSeq: number
 *       }): HrcBrokerInvocationEventRecord[]
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-store-sqlite test broker-raw-observer
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../index'

type HrcDb = ReturnType<typeof openHrcDatabase>

let tmpDir: string
let dbPath: string
let db: HrcDb

function ts(offsetSeconds = 0): string {
  return new Date(Date.UTC(2026, 5, 22, 12, 0, offsetSeconds)).toISOString()
}

const INVOCATION_ID = 'inv_raw_observer_test'
const RUN_ID = 'run_raw_observer_test'
const RUNTIME_ID = 'rt_raw_observer_test'
const ALT_RUN_ID = 'run_raw_observer_alt'
const ALT_RUNTIME_ID = 'rt_raw_observer_alt'
const ALT_INVOCATION_ID = 'inv_raw_observer_alt'

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-broker-raw-observer-'))
  dbPath = join(tmpDir, 'test.sqlite')
  db = openHrcDatabase(dbPath)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

/** Append a batch of events with sequential seq values. */
function appendEvents(
  count: number,
  overrides: {
    invocationId?: string
    runId?: string
    runtimeId?: string
    startSeq?: number
  } = {}
): void {
  const invocationId = overrides.invocationId ?? INVOCATION_ID
  const runId = overrides.runId ?? RUN_ID
  const runtimeId = overrides.runtimeId ?? RUNTIME_ID
  const startSeq = overrides.startSeq ?? 1

  for (let i = 0; i < count; i++) {
    const seq = startSeq + i
    db.brokerInvocationEvents.appendEvent({
      invocationId,
      seq,
      time: ts(seq),
      type: seq % 3 === 0 ? 'turn.completed' : 'assistant.message.delta',
      runtimeId,
      runId,
      payload: { delta: `chunk-${seq}` },
      envelopeJson: JSON.stringify({
        invocationId,
        seq,
        time: ts(seq),
        type: seq % 3 === 0 ? 'turn.completed' : 'assistant.message.delta',
        payload: { delta: `chunk-${seq}` },
      }),
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RED signal: listFromAfterSeq does not exist yet — all tests will fail with
// "listFromAfterSeq is not a function" at runtime.
// ─────────────────────────────────────────────────────────────────────────────

describe('T-05083 BrokerInvocationEventRepository.listFromAfterSeq — RED', () => {
  describe('afterSeq exclusive lower bound', () => {
    it('afterSeq=5 returns only events with seq > 5 (seq 6,7,8,9) out of seq 1-9', () => {
      appendEvents(9)

      // RED: listFromAfterSeq is not a function
      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runtimeId: RUNTIME_ID,
        afterSeq: 5,
      })

      expect(Array.isArray(results)).toBe(true)
      expect(results).toHaveLength(4)
      const seqs = results.map((r: any) => r.seq)
      expect(seqs).toEqual([6, 7, 8, 9])
    })

    it('afterSeq is EXCLUSIVE — the event AT afterSeq is not included', () => {
      appendEvents(3)

      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runtimeId: RUNTIME_ID,
        afterSeq: 2,
      })

      expect(results).toHaveLength(1)
      expect(results[0]!.seq).toBe(3)
      // seq=2 must be excluded (afterSeq is exclusive, not >=)
      expect(results.some((r: any) => r.seq === 2)).toBe(false)
    })

    it('afterSeq=0 returns ALL events (fresh-cursor semantics)', () => {
      appendEvents(5)

      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runtimeId: RUNTIME_ID,
        afterSeq: 0,
      })

      expect(results).toHaveLength(5)
      const seqs = results.map((r: any) => r.seq)
      expect(seqs).toEqual([1, 2, 3, 4, 5])
    })

    it('returns empty array when no events exist above afterSeq', () => {
      appendEvents(3)

      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runtimeId: RUNTIME_ID,
        afterSeq: 3,
      })

      expect(results).toHaveLength(0)
    })

    it('returns empty array when afterSeq exceeds the highest seq', () => {
      appendEvents(3)

      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runtimeId: RUNTIME_ID,
        afterSeq: 999,
      })

      expect(results).toHaveLength(0)
    })
  })

  describe('ORDER BY seq ASC', () => {
    it('results are ordered by seq ASC even when appended out-of-order', () => {
      // Append out of order deliberately
      db.brokerInvocationEvents.appendEvent({
        invocationId: INVOCATION_ID,
        seq: 5,
        time: ts(5),
        type: 'turn.completed',
        runtimeId: RUNTIME_ID,
        runId: RUN_ID,
        payload: { seq: 5 },
      })
      db.brokerInvocationEvents.appendEvent({
        invocationId: INVOCATION_ID,
        seq: 2,
        time: ts(2),
        type: 'assistant.message.delta',
        runtimeId: RUNTIME_ID,
        runId: RUN_ID,
        payload: { seq: 2 },
      })
      db.brokerInvocationEvents.appendEvent({
        invocationId: INVOCATION_ID,
        seq: 8,
        time: ts(8),
        type: 'assistant.message.delta',
        runtimeId: RUNTIME_ID,
        runId: RUN_ID,
        payload: { seq: 8 },
      })

      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runtimeId: RUNTIME_ID,
        afterSeq: 0,
      })

      expect(results).toHaveLength(3)
      expect(results[0]!.seq).toBe(2)
      expect(results[1]!.seq).toBe(5)
      expect(results[2]!.seq).toBe(8)
    })
  })

  describe('four-field fence (invocationId + runId + runtimeId)', () => {
    it('excludes events with a different runId', () => {
      // Insert events for primary run
      appendEvents(3, { runId: RUN_ID })
      // Insert events for alt run (different run_id, same invocationId+runtimeId)
      appendEvents(3, { runId: ALT_RUN_ID, startSeq: 10 })

      // Query with primary run ID only
      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runtimeId: RUNTIME_ID,
        afterSeq: 0,
      })

      expect(results.every((r: any) => r.runId === RUN_ID)).toBe(true)
      expect(results).toHaveLength(3)
      // Alt-run events (seq 10-12) must not appear
      expect(results.some((r: any) => r.seq >= 10)).toBe(false)
    })

    it('excludes events with a different runtimeId', () => {
      // Insert events for primary runtime
      appendEvents(3, { runtimeId: RUNTIME_ID })
      // Insert events for alt runtime (different runtime_id, same invocationId+runId)
      appendEvents(3, { runtimeId: ALT_RUNTIME_ID, startSeq: 10 })

      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runtimeId: RUNTIME_ID,
        afterSeq: 0,
      })

      expect(results).toHaveLength(3)
      expect(results.every((r: any) => r.runtimeId === RUNTIME_ID)).toBe(true)
    })

    it('excludes events with a different invocationId', () => {
      // Primary invocation
      appendEvents(3)
      // Alt invocation — same runtimeId+runId, different invocationId
      appendEvents(3, { invocationId: ALT_INVOCATION_ID, startSeq: 10 })

      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runtimeId: RUNTIME_ID,
        afterSeq: 0,
      })

      expect(results).toHaveLength(3)
      expect(results.every((r: any) => r.invocationId === INVOCATION_ID)).toBe(true)
    })

    it('returns empty when invocationId selector has no matching rows', () => {
      appendEvents(5)

      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: 'inv_does_not_exist',
        runId: RUN_ID,
        runtimeId: RUNTIME_ID,
        afterSeq: 0,
      })

      expect(results).toHaveLength(0)
    })

    it('AND-narrows: wrong runtimeId + correct invocationId + correct runId = empty', () => {
      appendEvents(5)

      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runtimeId: 'rt_wrong_entirely',
        afterSeq: 0,
      })

      expect(results).toHaveLength(0)
    })
  })

  describe('full envelope round-trip via listFromAfterSeq', () => {
    it('returns brokerEnvelopeJson intact including optional envelope fields', () => {
      const fullEnvelope = {
        invocationId: INVOCATION_ID,
        seq: 7,
        time: ts(7),
        type: 'assistant.message.delta',
        turnId: 'turn-999',
        inputId: 'input-3',
        itemId: 'item-42',
        correlation: { actionRunRef: 'wrkf:a-1' },
        driver: { kind: 'codex-app-server', rawType: 'item/text/delta' },
        payload: { delta: 'hello from observer' },
      }

      db.brokerInvocationEvents.appendEvent({
        invocationId: INVOCATION_ID,
        seq: 7,
        time: ts(7),
        type: 'assistant.message.delta',
        runtimeId: RUNTIME_ID,
        runId: RUN_ID,
        payload: fullEnvelope.payload,
        envelopeJson: JSON.stringify(fullEnvelope),
      })

      const results = (db.brokerInvocationEvents as any).listFromAfterSeq({
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runtimeId: RUNTIME_ID,
        afterSeq: 6,
      })

      expect(results).toHaveLength(1)
      const row = results[0]
      expect(row!.brokerEnvelopeJson).toBeDefined()
      const parsed = JSON.parse(row!.brokerEnvelopeJson)
      expect(parsed.turnId).toBe('turn-999')
      expect(parsed.inputId).toBe('input-3')
      expect(parsed.itemId).toBe('item-42')
      expect(parsed.correlation).toEqual({ actionRunRef: 'wrkf:a-1' })
      expect(parsed.driver).toEqual({ kind: 'codex-app-server', rawType: 'item/text/delta' })
      expect(parsed.payload).toEqual({ delta: 'hello from observer' })
    })
  })

  describe('generation note (schema documentation, not a repo-level fence)', () => {
    /**
     * NOTE: broker_invocation_events has NO HRC-level `generation` column.
     * The table has: invocation_id, seq, run_id, runtime_id, harness_generation
     * (broker harness gen), turn_attempt, broker_event_json, broker_envelope_json,
     * hrc_event_seq, projection_status, projection_error, created_at.
     *
     * HRC runtime generation enforcement (the 4th field of the contract's
     * four-field fence) must be applied at the handler level, e.g., by:
     *   - JOINing with runtimes WHERE runtime_id=? AND generation=? to verify
     *     the runtimeId belongs to the expected generation; OR
     *   - Resolving the invocationId to a runtimeId at handler entry and
     *     asserting the runtime's generation matches before streaming events.
     *
     * This test documents the schema reality: generation is NOT in the table,
     * so listFromAfterSeq cannot and does not filter on it directly.
     */
    it('broker_invocation_events has no HRC generation column — generation fence is handler-level', () => {
      const columns = db.sqlite
        .query<{ name: string }, []>('PRAGMA table_info(broker_invocation_events)')
        .all()
        .map((col) => col.name)

      // These columns DO exist
      expect(columns).toContain('invocation_id')
      expect(columns).toContain('seq')
      expect(columns).toContain('run_id')
      expect(columns).toContain('runtime_id')
      expect(columns).toContain('harness_generation') // broker harness gen, NOT HRC gen

      // HRC runtime generation is NOT in broker_invocation_events
      expect(columns).not.toContain('generation')
    })
  })
})
