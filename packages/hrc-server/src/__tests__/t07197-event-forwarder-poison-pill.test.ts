import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import type { HrcEventIngestBatch, HrcLifecycleEvent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  HRC_INGEST_MAX_BODY_BYTES,
  eventForwardRetryDelayMs,
  forwardAvailableEvents,
  startEventForwarder,
} from '../event-ingest.js'

const roots: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function lifecycle(sequence: number): Omit<HrcLifecycleEvent, 'hrcSeq' | 'streamSeq'> {
  return {
    ts: `2026-09-01T00:00:0${sequence}.000Z`,
    hostSessionId: 't07197-session',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-07197',
    laneRef: 'main',
    generation: 1,
    runtimeId: 't07197-runtime',
    runId: 't07197-run',
    category: 'turn',
    eventKind: 'turn.completed',
    transport: 'headless',
    replayed: false,
    payload: { sequence },
  }
}

type ForwardState = {
  hrcEvents?: number
  brokerInvocationEvents?: number
  deadLetters?: Array<Record<string, unknown>>
}

async function readForwardState(path: string): Promise<ForwardState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ForwardState
  } catch {
    return {}
  }
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2_000
  let value = await read()
  while (!accept(value) && Date.now() < deadline) {
    await Bun.sleep(10)
    value = await read()
  }
  return value
}

describe('T-07197 event-forwarder poison pills', () => {
  test('a deterministic 409 is attempted once, dead-lettered, and cannot halt later entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 't07197-forwarder-'))
    roots.push(root)
    const db = openHrcDatabase(join(root, 'state.sqlite'))
    db.hrcEvents.append(lifecycle(1))
    db.hrcEvents.append(lifecycle(2))
    db.brokerInvocationEvents.appendEvent({
      invocationId: 't07197-invocation',
      seq: 1,
      time: '2026-09-01T00:00:03.000Z',
      type: 'assistant.message.completed',
      runtimeId: 't07197-runtime',
      payload: { afterLifecyclePoison: true },
    })

    const attempted: Array<{ feed: HrcEventIngestBatch['feed']; sequences: number[] }> = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const batch = (await request.json()) as HrcEventIngestBatch
        const sequences = batch.events.map((event) =>
          'originSeq' in event ? event.originSeq : event.part
        )
        attempted.push({ feed: batch.feed, sequences })
        if (batch.feed === 'hrc_events' && sequences.includes(1)) {
          return Response.json(
            {
              ok: false,
              feed: batch.feed,
              code: 'divergent_duplicate',
              message: 'deterministic conflict',
              rejectedOriginSeq: 1,
            },
            { status: 409 }
          )
        }
        return Response.json({
          ok: true,
          feed: batch.feed,
          ackedThrough: sequences.at(-1),
          inserted: sequences.length,
          duplicates: 0,
        })
      },
    })
    servers.push(server)

    const forwarder = startEventForwarder({
      db,
      stateRoot: root,
      sourceRef: 't07197-source',
      target: { kind: 'tcp', url: `http://127.0.0.1:${server.port}` },
      retryMs: 100,
    })
    const state = await eventually(
      () => readForwardState(forwarder.cursorPath),
      (value) => value.hrcEvents === 2 && value.brokerInvocationEvents === 1
    )
    await forwarder.stop()

    expect(
      attempted.filter((attempt) => attempt.feed === 'hrc_events' && attempt.sequences.includes(1))
    ).toHaveLength(1)
    expect(
      attempted.some(
        (attempt) =>
          attempt.feed === 'hrc_events' &&
          attempt.sequences.length === 1 &&
          attempt.sequences[0] === 2
      )
    ).toBe(true)
    expect(attempted.some((attempt) => attempt.feed === 'broker_invocation_events')).toBe(true)
    expect(state).toMatchObject({
      hrcEvents: 2,
      brokerInvocationEvents: 1,
      deadLetters: [
        {
          feed: 'hrc_events',
          cursor: 1,
          code: 'divergent_duplicate',
          message: 'deterministic conflict',
        },
      ],
    })

    const attemptsBeforeResume = attempted.length
    const resumed = startEventForwarder({
      db,
      stateRoot: root,
      sourceRef: 't07197-source',
      target: { kind: 'tcp', url: `http://127.0.0.1:${server.port}` },
      retryMs: 100,
    })
    await Bun.sleep(150)
    await resumed.stop()
    expect(attempted).toHaveLength(attemptsBeforeResume)

    db.close()
  })

  test('invalid batches are narrowed to one poison row before dead-letter and cursor advance', async () => {
    const root = await mkdtemp(join(tmpdir(), 't07197-invalid-batch-'))
    roots.push(root)
    const db = openHrcDatabase(join(root, 'state.sqlite'))
    for (const sequence of [1, 2, 3]) db.hrcEvents.append(lifecycle(sequence))

    const attempts: number[][] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const batch = (await request.json()) as HrcEventIngestBatch
        const sequences = batch.events.map((event) =>
          'originSeq' in event ? event.originSeq : event.part
        )
        attempts.push(sequences)
        if (sequences.includes(2)) {
          return Response.json(
            { ok: false, code: 'invalid_batch', message: 'sequence 2 is invalid' },
            { status: 400 }
          )
        }
        return Response.json({
          ok: true,
          feed: batch.feed,
          ackedThrough: sequences.at(-1),
          inserted: sequences.length,
          duplicates: 0,
        })
      },
    })
    servers.push(server)
    const cursorPath = join(root, 'event-forward-cursors.json')

    const result = await forwardAvailableEvents({
      db,
      sourceRef: 't07197-invalid-source',
      target: { kind: 'tcp', url: `http://127.0.0.1:${server.port}` },
      cursorPath,
    })

    expect(result).toMatchObject({
      forwarded: 2,
      deadLettered: 1,
      cursors: { hrcEvents: 3 },
    })
    expect(attempts).toContainEqual([2])
    expect(await readForwardState(cursorPath)).toMatchObject({
      hrcEvents: 3,
      deadLetters: [
        {
          feed: 'hrc_events',
          cursor: 2,
          code: 'invalid_batch',
          message: 'sequence 2 is invalid',
        },
      ],
    })
    const attemptCount = attempts.length
    expect(
      await forwardAvailableEvents({
        db,
        sourceRef: 't07197-invalid-source',
        target: { kind: 'tcp', url: `http://127.0.0.1:${server.port}` },
        cursorPath,
      })
    ).toMatchObject({ forwarded: 0, deadLettered: 0 })
    expect(attempts).toHaveLength(attemptCount)

    db.close()
  })

  test('an oversized single event is dead-lettered without a POST and the next row proceeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 't07197-oversized-'))
    roots.push(root)
    const db = openHrcDatabase(join(root, 'state.sqlite'))
    db.hrcEvents.append({
      ...lifecycle(1),
      payload: { oversized: 'x'.repeat(HRC_INGEST_MAX_BODY_BYTES) },
    })
    db.hrcEvents.append(lifecycle(2))

    const attempts: number[][] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const batch = (await request.json()) as HrcEventIngestBatch
        const sequences = batch.events.map((event) =>
          'originSeq' in event ? event.originSeq : event.part
        )
        attempts.push(sequences)
        return Response.json({
          ok: true,
          feed: batch.feed,
          ackedThrough: sequences.at(-1),
          inserted: sequences.length,
          duplicates: 0,
        })
      },
    })
    servers.push(server)
    const cursorPath = join(root, 'event-forward-cursors.json')

    const result = await forwardAvailableEvents({
      db,
      sourceRef: 't07197-oversized-source',
      target: { kind: 'tcp', url: `http://127.0.0.1:${server.port}` },
      cursorPath,
    })

    expect(result).toMatchObject({
      forwarded: 1,
      deadLettered: 1,
      cursors: { hrcEvents: 2 },
    })
    expect(attempts).toEqual([[2]])
    expect(await readForwardState(cursorPath)).toMatchObject({
      deadLetters: [{ feed: 'hrc_events', cursor: 1, code: 'oversized_event' }],
    })

    db.close()
  })

  test('retryable failures use deterministic capped exponential backoff', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => eventForwardRetryDelayMs(attempt, 100, 800))).toEqual([
      100, 200, 400, 800, 800,
    ])
  })
})
