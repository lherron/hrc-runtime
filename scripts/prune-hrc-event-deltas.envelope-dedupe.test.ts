import { describe, expect, test } from 'bun:test'

import {
  Database,
  makeStore,
  parsePruneStateRetentionArgs,
  runScript,
  stripEnvelopePayloads,
} from './prune-hrc-event-deltas.fixture'

function insertBrokerEnvelope(
  db: Database,
  invocationId: string,
  seq: number,
  payload: unknown,
  includeEnvelopePayload = true
): void {
  const envelope = {
    invocationId,
    seq,
    time: '2026-08-26T00:00:00.000Z',
    type: 'tool.call.completed',
    itemId: `item-${invocationId}-${seq}`,
    ...(includeEnvelopePayload ? { payload } : {}),
  }
  db.prepare(
    `INSERT INTO broker_invocation_events
      (invocation_id, seq, time, type, runtime_id, broker_event_json, broker_envelope_json)
     VALUES (?, ?, ?, 'tool.call.completed', 'runtime-dedupe', ?, ?)`
  ).run(invocationId, seq, envelope.time, JSON.stringify(payload), JSON.stringify(envelope))
}

function envelopeOptions(path: string, apply: boolean) {
  return parsePruneStateRetentionArgs(
    [
      '--db',
      path,
      '--strip-envelope-payloads',
      ...(apply ? ['--apply'] : []),
      '--count-eligible',
      '--no-checkpoint',
      '--pace-millis',
      '0',
    ],
    {}
  )
}

describe('prune-hrc-event-deltas envelope payload dedupe', () => {
  test('parses an isolated maintenance mode and rejects retention table selection', () => {
    const options = parsePruneStateRetentionArgs(['--strip-envelope-payloads'], {})
    expect(options.operation).toBe('strip-envelope-payloads')
    expect(options.tables).toEqual(['broker_invocation_events'])
    expect(() =>
      parsePruneStateRetentionArgs(['--strip-envelope-payloads', '--tables', 'events'], {})
    ).toThrow(/table set is fixed/)
    expect(() =>
      parsePruneStateRetentionArgs(['--strip-envelope-payloads', '--purge-delta-backlog'], {})
    ).toThrow(/mutually exclusive/)
  })

  test('walks (invocation_id, seq), strips only envelope payloads, and is idempotent', () => {
    const { path, db } = makeStore()
    const samples = [
      ['inv-z', 2, { result: 'z'.repeat(32_000) }],
      ['inv-a', 5, { nested: { result: ['a', 'b'] } }],
      ['inv-a', 1, null],
    ] as const
    for (const [invocationId, seq, payload] of samples) {
      insertBrokerEnvelope(db, invocationId, seq, payload)
    }
    insertBrokerEnvelope(db, 'inv-m', 3, { already: 'deduped' }, false)
    db.close()

    const dryRun = runScript(path, '--strip-envelope-payloads', '--count-eligible')
    expect(dryRun.exitCode).toBe(0)
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      operation: 'strip-envelope-payloads',
      applied: false,
      eligibleCount: 3,
      stripped: 0,
      remainingEligibleCount: 3,
    })

    const applied = runScript(
      path,
      '--strip-envelope-payloads',
      '--apply',
      '--count-eligible',
      '--batch-size',
      '1',
      '--pace-millis',
      '0'
    )
    expect(applied.exitCode).toBe(0)
    expect(JSON.parse(applied.stdout)).toMatchObject({
      operation: 'strip-envelope-payloads',
      eligibleCount: 3,
      stripped: 3,
      remainingEligibleCount: 0,
      stopReason: 'complete',
    })

    const verify = new Database(path)
    try {
      for (const [invocationId, seq, payload] of samples) {
        const row = verify
          .query<{ broker_event_json: string; broker_envelope_json: string }, [string, number]>(
            `SELECT broker_event_json, broker_envelope_json
               FROM broker_invocation_events
              WHERE invocation_id = ? AND seq = ?`
          )
          .get(invocationId, seq)
        expect(JSON.parse(row!.broker_event_json)).toEqual(payload)
        expect(JSON.parse(row!.broker_envelope_json)).not.toHaveProperty('payload')
      }
    } finally {
      verify.close()
    }

    const repeated = runScript(
      path,
      '--strip-envelope-payloads',
      '--apply',
      '--count-eligible',
      '--pace-millis',
      '0'
    )
    expect(repeated.exitCode).toBe(0)
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      stripped: 0,
      remainingEligibleCount: 0,
    })
  })

  test('resumes safely after a deadline-limited partial keyset pass', async () => {
    const { path, db } = makeStore()
    for (let seq = 1; seq <= 4; seq += 1) {
      insertBrokerEnvelope(db, `inv-${seq % 2}`, seq, {
        seq,
        body: 'x'.repeat(64_000),
      })
    }
    db.close()

    const partial = await stripEnvelopePayloads({
      ...envelopeOptions(path, true),
      batchSize: 1,
      paceMillis: 75,
      deadlineMillis: 50,
    })
    expect(partial.stopReason).toBe('deadline')
    expect(partial.stripped).toBeGreaterThan(0)
    expect(partial.remainingEligibleCount).toBeGreaterThan(0)

    const resumed = await stripEnvelopePayloads({
      ...envelopeOptions(path, true),
      batchSize: 1,
      deadlineMillis: 60_000,
    })
    expect(resumed.stopReason).toBe('complete')
    expect(resumed.remainingEligibleCount).toBe(0)
  })
})
