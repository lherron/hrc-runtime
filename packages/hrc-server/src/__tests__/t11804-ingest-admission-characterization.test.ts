/**
 * T-11804 characterization of the ingest listener's admission and refusal acks
 * and the forwarder's cursor-file tolerance: the public behavior the existing
 * T-06838/T-07197/T-08566 suites leave unpinned, frozen before the module split.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { HrcEventIngestAck, HrcEventIngestBatch, HrcLifecycleEvent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { forwardAvailableEvents } from '../event-ingest/forward-sweep.js'
import { startEventIngestListener } from '../event-ingest/listener.js'
import { HRC_INGEST_MAX_BATCH_EVENTS, HRC_INGEST_MAX_BODY_BYTES } from '../event-ingest/protocol.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hrc-t11804-'))
  roots.push(root)
  return root
}

function lifecycle(): HrcLifecycleEvent {
  return {
    hrcSeq: 1,
    streamSeq: 1,
    ts: '2026-10-25T00:00:00.000Z',
    hostSessionId: 't11804-session',
    scopeRef: 'agent:clod:project:hrc-runtime:task:T-11804',
    laneRef: 'main',
    generation: 1,
    runtimeId: 't11804-runtime',
    runId: 't11804-run',
    category: 'turn',
    eventKind: 'turn.completed',
    transport: 'headless',
    replayed: false,
    payload: {},
  }
}

function lifecycleBatch(count: number): HrcEventIngestBatch {
  return {
    version: 1,
    sourceRef: 'node:t11804',
    feed: 'hrc_events',
    events: Array.from({ length: count }, (_, index) => ({
      originSeq: index + 1,
      event: lifecycle(),
    })),
  }
}

async function post(socketPath: string, init: RequestInit, path = '/v1/ingest') {
  const response = await fetch(`http://hrc${path}`, {
    method: 'POST',
    ...init,
    unix: socketPath,
  } as RequestInit & { unix: string })
  return { status: response.status, text: await response.text() }
}

function ack(text: string): HrcEventIngestAck {
  return JSON.parse(text) as HrcEventIngestAck
}

describe('T-11804 ingest admission and refusal acks', () => {
  test('only POST /v1/ingest is routed; anything else is a plain 404', async () => {
    const root = await tempRoot()
    const db = openHrcDatabase(join(root, 'state.sqlite'))
    const listener = await startEventIngestListener({ db, runtimeRoot: root })
    try {
      const get = await post(listener.socketPath, { method: 'GET' })
      const otherPath = await post(
        listener.socketPath,
        { body: JSON.stringify(lifecycleBatch(1)) },
        '/v1/other'
      )
      expect(get).toEqual({ status: 404, text: 'not found' })
      expect(otherPath).toEqual({ status: 404, text: 'not found' })
      expect(listener.counters).toEqual({
        accepted: 0,
        duplicates: 0,
        divergentDuplicates: 0,
        rejected: 0,
      })
    } finally {
      await listener.stop()
      db.close()
    }
  })

  test('declared and streamed frames over the byte limit and batches over the event limit are invalid_batch', async () => {
    const root = await tempRoot()
    const db = openHrcDatabase(join(root, 'state.sqlite'))
    const listener = await startEventIngestListener({ db, runtimeRoot: root })
    try {
      const declared = await post(listener.socketPath, {
        body: 'x'.repeat(HRC_INGEST_MAX_BODY_BYTES + 1),
      })
      const oversized = new TextEncoder().encode('x'.repeat(64 * 1024))
      let sent = 0
      const streamed = await post(listener.socketPath, {
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent > HRC_INGEST_MAX_BODY_BYTES) {
              controller.close()
              return
            }
            sent += oversized.byteLength
            controller.enqueue(oversized)
          },
        }),
      })
      const tooMany = await post(listener.socketPath, {
        body: JSON.stringify(lifecycleBatch(HRC_INGEST_MAX_BATCH_EVENTS + 1)),
      })

      for (const response of [declared, streamed]) {
        expect(response.status).toBe(400)
        expect(ack(response.text)).toEqual({
          ok: false,
          code: 'invalid_batch',
          message: 'ingest frame exceeds byte limit',
        })
      }
      expect(tooMany.status).toBe(400)
      expect(ack(tooMany.text)).toEqual({
        ok: false,
        code: 'invalid_batch',
        message: 'ingest batch exceeds event limit',
      })
      expect(listener.counters.rejected).toBe(3)
      expect(db.hrcEvents.listFromStreamSeq(1, { sourceRef: 'node:t11804' })).toHaveLength(0)
    } finally {
      await listener.stop()
      db.close()
    }
  })

  test('a store failure that is not a conflict is a 500 ingest_error naming the item', async () => {
    const root = await tempRoot()
    const db = openHrcDatabase(join(root, 'state.sqlite'))
    spyOn(db.hrcEvents, 'appendImported').mockImplementation(() => {
      throw new Error('store unavailable')
    })
    const listener = await startEventIngestListener({ db, runtimeRoot: root })
    try {
      const response = await post(listener.socketPath, {
        body: JSON.stringify(lifecycleBatch(2)),
      })
      expect(response.status).toBe(500)
      expect(ack(response.text)).toEqual({
        ok: false,
        feed: 'hrc_events',
        code: 'ingest_error',
        message: 'store unavailable',
        rejectedOriginSeq: 1,
      })
      expect(listener.counters).toMatchObject({ rejected: 1, accepted: 0, divergentDuplicates: 0 })
    } finally {
      await listener.stop()
      db.close()
    }
  })

  test('the 65th in-flight request is refused ingest_busy and admission reopens after drain', async () => {
    const root = await tempRoot()
    const db = openHrcDatabase(join(root, 'state.sqlite'))
    const listener = await startEventIngestListener({ db, runtimeRoot: root })
    const held: Array<ReadableStreamDefaultController<Uint8Array>> = []
    const started: Array<() => void> = []
    const inFlight: Array<Promise<{ status: number; text: string }>> = []
    try {
      for (let index = 0; index < 64; index += 1) {
        const opened = new Promise<void>((resolve) => started.push(resolve))
        inFlight.push(
          post(listener.socketPath, {
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                held.push(controller)
                controller.enqueue(new TextEncoder().encode('{'))
                started[index]?.()
              },
            }),
          })
        )
        await opened
      }
      // Each held request is inside the handler once its first chunk is read.
      const deadline = Date.now() + 2_000
      let busy = await post(listener.socketPath, { body: JSON.stringify(lifecycleBatch(1)) })
      while (busy.status !== 503 && Date.now() < deadline) {
        await Bun.sleep(10)
        busy = await post(listener.socketPath, { body: JSON.stringify(lifecycleBatch(1)) })
      }
      expect(busy.status).toBe(503)
      expect(ack(busy.text)).toEqual({
        ok: false,
        code: 'ingest_busy',
        message: 'ingest concurrency limit reached',
      })

      for (const controller of held) controller.close()
      const drained = await Promise.all(inFlight)
      expect(new Set(drained.map((response) => response.status))).toEqual(new Set([400]))

      const reopened = await post(listener.socketPath, {
        body: JSON.stringify({ ...lifecycleBatch(1), sourceRef: 'node:t11804-reopened' }),
      })
      expect(reopened.status).toBe(200)
      expect(ack(reopened.text)).toMatchObject({ ok: true, ackedThrough: 1, inserted: 1 })
    } finally {
      for (const controller of held) {
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
      await listener.stop()
      db.close()
    }
  })
})

describe('T-11804 forward cursor file tolerance', () => {
  async function readThroughEmptyLedger(cursorFile: string | undefined) {
    const root = await tempRoot()
    const cursorPath = join(root, 'event-forward-cursors.json')
    if (cursorFile !== undefined) await writeFile(cursorPath, cursorFile)
    const db = openHrcDatabase(join(root, 'state.sqlite'))
    try {
      return await forwardAvailableEvents({
        db,
        sourceRef: 'node:t11804',
        target: { kind: 'unix', socketPath: join(root, 'absent.sock') },
        cursorPath,
      })
    } finally {
      db.close()
    }
  }

  test('a pre-blob cursor file keeps its sequenced cursors and starts blobs at zero', async () => {
    const result = await readThroughEmptyLedger(
      JSON.stringify({ version: 1, hrcEvents: 5, brokerInvocationEvents: 7 })
    )
    expect(result).toEqual({
      cursors: {
        version: 1,
        toolResultBlobs: 0,
        hrcEvents: 5,
        brokerInvocationEvents: 7,
        deadLetters: [],
      },
      forwarded: 0,
      deadLettered: 0,
    })
  })

  test('a missing, corrupt or wrong-version cursor file starts at the ledger beginning', async () => {
    const initial = {
      version: 1,
      toolResultBlobs: 0,
      hrcEvents: 0,
      brokerInvocationEvents: 0,
      deadLetters: [],
    }
    for (const file of [
      undefined,
      '{not json',
      JSON.stringify({ version: 2, hrcEvents: 5, brokerInvocationEvents: 7 }),
      JSON.stringify({ version: 1, hrcEvents: 'five', brokerInvocationEvents: 7 }),
    ]) {
      expect((await readThroughEmptyLedger(file)).cursors).toEqual(initial)
    }
  })
})
