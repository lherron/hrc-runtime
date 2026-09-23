import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../index'

/**
 * T-08781: turn ownership reads only the few rows of the types it decides on.
 * The query must select exactly the rows the in-memory filter over the whole
 * invocation used to select, including its turnId precedence: the envelope's
 * string turnId wins, otherwise the payload's string turnId, and malformed or
 * non-string values never match.
 */

let tmpDir: string
let db: ReturnType<typeof openHrcDatabase>

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-t08781-'))
  db = openHrcDatabase(join(tmpDir, 'test.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

let nextSeq = 1
function append(input: {
  type: string
  runtimeId?: string
  payload?: unknown
  envelope?: Record<string, unknown> | string
}): number {
  const seq = nextSeq++
  db.brokerInvocationEvents.appendEvent({
    invocationId: 'inv-1',
    seq,
    time: new Date(Date.UTC(2026, 8, 22, 0, 0, seq)).toISOString(),
    type: input.type,
    runtimeId: input.runtimeId ?? 'rt-1',
    payload: input.payload ?? {},
    ...(input.envelope === undefined
      ? {}
      : {
          envelopeJson:
            typeof input.envelope === 'string' ? input.envelope : JSON.stringify(input.envelope),
        }),
  })
  return seq
}

function seqs(rows: { seq: number }[]): number[] {
  return rows.map((row) => row.seq)
}

describe('brokerInvocationEvents.listByInvocationIdAndTypes', () => {
  beforeEach(() => {
    nextSeq = 1
  })

  it('returns only the requested types in seq order, bounded by throughSeq and runtime', () => {
    const a = append({ type: 'turn.started', envelope: { turnId: 't1' } })
    append({ type: 'tool.call.started', envelope: { turnId: 't1' } })
    const c = append({ type: 'submission.executed', payload: { submissionId: 's1' } })
    append({ type: 'turn.started', runtimeId: 'rt-other', envelope: { turnId: 't1' } })
    const e = append({ type: 'turn.attributed', envelope: { turnId: 't1' } })
    append({ type: 'turn.started', envelope: { turnId: 't2' } })

    const rows = db.brokerInvocationEvents.listByInvocationIdAndTypes({
      invocationId: 'inv-1',
      types: ['turn.started', 'turn.attributed', 'submission.executed'],
      throughSeq: e,
      runtimeId: 'rt-1',
    })
    expect(seqs(rows)).toEqual([a, c, e])
  })

  it('matches turnId with envelope precedence over payload, strings only', () => {
    const envelopeWins = append({
      type: 'turn.started',
      envelope: { turnId: 't1' },
      payload: { turnId: 'other' },
    })
    append({ type: 'turn.started', envelope: { turnId: 'other' }, payload: { turnId: 't1' } })
    const payloadFallback = append({ type: 'turn.started', payload: { turnId: 't1' } })
    const nonStringEnvelope = append({
      type: 'turn.started',
      envelope: { turnId: 7 },
      payload: { turnId: 't1' },
    })
    const malformedEnvelope = append({
      type: 'turn.started',
      envelope: '{not json',
      payload: { turnId: 't1' },
    })
    append({ type: 'turn.started', payload: { turnId: 7 } })
    append({ type: 'turn.started', payload: ['t1'] })

    const rows = db.brokerInvocationEvents.listByInvocationIdAndTypes({
      invocationId: 'inv-1',
      types: ['turn.started'],
      turnId: 't1',
    })
    expect(seqs(rows)).toEqual([
      envelopeWins,
      payloadFallback,
      nonStringEnvelope,
      malformedEnvelope,
    ])
  })

  it('hasTurnId + limit selects the first row that carries any string turnId', () => {
    append({ type: 'turn.started', payload: { note: 'no turn id' } })
    append({ type: 'turn.started', envelope: { turnId: 9 } })
    const first = append({ type: 'turn.started', payload: { turnId: 't3' } })
    append({ type: 'turn.started', envelope: { turnId: 't4' } })

    const rows = db.brokerInvocationEvents.listByInvocationIdAndTypes({
      invocationId: 'inv-1',
      types: ['turn.started'],
      hasTurnId: true,
      limit: 1,
    })
    expect(seqs(rows)).toEqual([first])
  })
})
