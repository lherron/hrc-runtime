/**
 * T-08566 F0w(a–c): retained rows are forwarded only in version-2 runs that keep
 * the source order; an old receiver dead-letters each retained item without the
 * cursor ever passing an unsent sequence, and a stage-2 receiver imports all of
 * them in order with its broker fan-out fenced.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import type {
  HrcBrokerInvocationEventRecord,
  HrcEventIngestBatch,
  HrcLifecycleEvent,
} from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { forwardAvailableEvents, startEventIngestListener } from '../event-ingest.js'

const roots: string[] = []
const stops: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `t08566-fwd-${label}-`))
  roots.push(root)
  return root
}

type Mark = 'L' | 'R'
const WINDOW: Array<[string, Mark]> = [
  ['L1', 'L'],
  ['L2', 'L'],
  ['R1', 'R'],
  ['R2', 'R'],
  ['L3', 'L'],
  ['R3', 'R'],
  ['L4', 'L'],
]

/** Seed the source ledger with the feed window `L1 L2 R1 R2 L3 R3 L4` in stream order. */
function seedLifecycleWindow(db: HrcDatabase): Map<string, number> {
  const streamSeqByLabel = new Map<string, number>()
  for (const [label, mark] of WINDOW) {
    const event = db.hrcEvents.append({
      ts: '2026-09-17T00:00:00.000Z',
      hostSessionId: 'hsid-source',
      scopeRef: 'agent:smokey:project:hrc-runtime',
      laneRef: 'main',
      generation: 1,
      runtimeId: 'rt-source',
      runId: 'run-source',
      category: 'turn',
      eventKind: 'turn.completed',
      transport: 'headless',
      ...(mark === 'R' ? { evidenceOrigin: 'retained' as const } : {}),
      payload: { label },
    })
    streamSeqByLabel.set(label, event.streamSeq)
  }
  return streamSeqByLabel
}

type Received = { version: number; feed: string; originSeqs: number[]; cursorAtReceipt: number }

/**
 * A pre-stage-2 receiver: the exact admission rule old daemons apply (any
 * version other than 1 is `invalid_batch` with no item named), acking version 1.
 */
function startOldReceiver(socketPath: string, cursorPath: string, received: Received[]) {
  const server = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      const batch = (await request.json()) as HrcEventIngestBatch
      let cursorAtReceipt = 0
      try {
        const cursors = JSON.parse(await readFile(cursorPath, 'utf8')) as { hrcEvents: number }
        cursorAtReceipt = cursors.hrcEvents
      } catch {
        cursorAtReceipt = 0
      }
      const originSeqs = (batch.events as Array<{ originSeq: number }>).map((e) => e.originSeq)
      received.push({ version: batch.version, feed: batch.feed, originSeqs, cursorAtReceipt })
      if (batch.version !== 1) {
        return Response.json(
          { ok: false, code: 'invalid_batch', message: 'unsupported ingest version' },
          { status: 400 }
        )
      }
      return Response.json({
        ok: true,
        feed: batch.feed,
        ackedThrough: originSeqs.at(-1),
        inserted: originSeqs.length,
        duplicates: 0,
      })
    },
  } as unknown as Parameters<typeof Bun.serve>[0])
  stops.push(() => server.stop(true))
}

describe('T-08566 origin-segmented federation forwarding', () => {
  test('(a) old receiver: retained items dead-lettered one by one, live rows in order, cursor never passes an unsent seq', async () => {
    const sourceRoot = await tempRoot('src')
    const source = openHrcDatabase(join(sourceRoot, 'state.sqlite'))
    stops.push(() => source.close())
    const seq = seedLifecycleWindow(source)
    const cursorPath = join(sourceRoot, 'event-forward-cursors.json')
    const receiverRoot = await tempRoot('old')
    const received: Received[] = []
    startOldReceiver(join(receiverRoot, 'old.sock'), cursorPath, received)

    await forwardAvailableEvents({
      db: source,
      sourceRef: 'remote:t08566:old',
      target: { kind: 'unix', socketPath: join(receiverRoot, 'old.sock') },
      cursorPath,
    })

    const at = (label: string) => seq.get(label) as number
    const lifecycleReceipts = received.filter((entry) => entry.feed === 'hrc_events')
    // Runs posted strictly in source order; the refused v2 run is bisected to single items.
    expect(lifecycleReceipts.map((entry) => [entry.version, entry.originSeqs])).toEqual([
      [1, [at('L1'), at('L2')]],
      [2, [at('R1'), at('R2')]],
      [2, [at('R1')]],
      [2, [at('R2')]],
      [1, [at('L3')]],
      [2, [at('R3')]],
      [1, [at('L4')]],
    ])
    // The durable cursor never passed an item before that item was offered.
    for (const entry of lifecycleReceipts) {
      expect(entry.cursorAtReceipt).toBeLessThan(Math.min(...entry.originSeqs))
    }
    const cursors = JSON.parse(await readFile(cursorPath, 'utf8')) as {
      hrcEvents: number
      deadLetters: Array<{ feed: string; cursor: number; code: string }>
    }
    expect(cursors.hrcEvents).toBe(at('L4'))
    expect(
      cursors.deadLetters
        .filter((letter) => letter.feed === 'hrc_events')
        .map((letter) => [letter.cursor, letter.code])
    ).toEqual([
      [at('R1'), 'invalid_batch'],
      [at('R2'), 'invalid_batch'],
      [at('R3'), 'invalid_batch'],
    ])
    // Dead letters never delete source evidence.
    expect(source.hrcEvents.listFromHrcSeq(1).map((event) => event.evidenceOrigin ?? 'L')).toEqual(
      WINDOW.map(([, mark]) => (mark === 'R' ? 'retained' : 'L'))
    )
  })

  test('(b) stage-2 receiver: all seven imported in order with origin; broker fan-out fenced for retained only', async () => {
    const sourceRoot = await tempRoot('src-new')
    const source = openHrcDatabase(join(sourceRoot, 'state.sqlite'))
    stops.push(() => source.close())
    seedLifecycleWindow(source)
    for (const [index, [label, mark]] of WINDOW.entries()) {
      source.brokerInvocationEvents.appendEvent({
        invocationId: 'inv-source',
        seq: index + 1,
        time: '2026-09-17T00:00:00.000Z',
        type: 'assistant.message.completed',
        runtimeId: 'rt-source',
        payload: { label },
        ...(mark === 'R' ? { evidenceOrigin: 'retained' as const } : {}),
      })
    }

    const receiverRoot = await tempRoot('new')
    const receiver = openHrcDatabase(join(receiverRoot, 'state.sqlite'))
    stops.push(() => receiver.close())
    const lifecycleCallbacks: HrcLifecycleEvent[] = []
    const brokerCallbacks: HrcBrokerInvocationEventRecord[] = []
    const listener = await startEventIngestListener({
      db: receiver,
      runtimeRoot: receiverRoot,
      onLifecycleEvent: (event) => lifecycleCallbacks.push(event),
      onBrokerEvent: (event) => brokerCallbacks.push(event),
    })
    stops.push(() => listener.stop())

    const result = await forwardAvailableEvents({
      db: source,
      sourceRef: 'remote:t08566:new',
      target: { kind: 'unix', socketPath: listener.socketPath },
      cursorPath: join(sourceRoot, 'event-forward-cursors.json'),
    })
    expect(result.deadLettered).toBe(0)

    const labels = (payloads: unknown[]) => payloads.map((p) => (p as { label: string }).label)
    const remote = receiver.hrcEvents
      .listFromHrcSeq(1)
      .filter((event) => event.sourceRef === 'remote:t08566:new')
    expect(labels(remote.map((event) => event.payload))).toEqual(WINDOW.map(([label]) => label))
    expect(remote.map((event) => event.evidenceOrigin ?? null)).toEqual(
      WINDOW.map(([, mark]) => (mark === 'R' ? 'retained' : null))
    )

    const brokerRows = receiver.brokerInvocationEvents.listBySourceRef('remote:t08566:new')
    expect(brokerRows.map((row) => JSON.parse(row.brokerEventJson).label)).toEqual(
      WINDOW.map(([label]) => label)
    )
    expect(brokerRows.map((row) => row.evidenceOrigin ?? null)).toEqual(
      WINDOW.map(([, mark]) => (mark === 'R' ? 'retained' : null))
    )
    // Receiver fence: broker actuator callback only for live rows.
    expect(brokerCallbacks.map((row) => JSON.parse(row.brokerEventJson).label)).toEqual(
      WINDOW.filter(([, mark]) => mark === 'L').map(([label]) => label)
    )
    // Lifecycle imports reach the server's notify path, which fences origin itself.
    expect(lifecycleCallbacks.map((event) => event.evidenceOrigin ?? null)).toEqual(
      WINDOW.map(([, mark]) => (mark === 'R' ? 'retained' : null))
    )
  })

  test('(c) marking: v2 unknown origin and broker v2 unmarked are refused naming the item; v1 marked refused', async () => {
    const receiverRoot = await tempRoot('marks')
    const receiver = openHrcDatabase(join(receiverRoot, 'state.sqlite'))
    stops.push(() => receiver.close())
    const listener = await startEventIngestListener({ db: receiver, runtimeRoot: receiverRoot })
    stops.push(() => listener.stop())
    const post = async (batch: unknown) => {
      const response = await fetch('http://hrc/v1/ingest', {
        method: 'POST',
        body: JSON.stringify(batch),
        unix: listener.socketPath,
      } as RequestInit & { unix: string })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    }
    const brokerRecord = (origin?: string) => ({
      invocationId: 'inv-remote',
      seq: 1,
      time: '2026-09-17T00:00:00.000Z',
      type: 'assistant.message.completed',
      runtimeId: 'rt-remote',
      brokerEventJson: '{}',
      projectionStatus: 'applied',
      createdAt: '2026-09-17T00:00:00.000Z',
      ...(origin ? { evidenceOrigin: origin } : {}),
    })
    const lifecycleEvent = (origin?: string) => ({
      hrcSeq: 1,
      streamSeq: 1,
      ts: '2026-09-17T00:00:00.000Z',
      hostSessionId: 'hsid-remote',
      scopeRef: 'agent:smokey:project:hrc-runtime',
      laneRef: 'main',
      generation: 1,
      category: 'turn',
      eventKind: 'turn.completed',
      replayed: false,
      payload: {},
      ...(origin ? { evidenceOrigin: origin } : {}),
    })

    expect(
      await post({
        version: 2,
        sourceRef: 'remote:c',
        feed: 'hrc_events',
        events: [
          { originSeq: 5, event: lifecycleEvent('retained') },
          { originSeq: 6, event: lifecycleEvent('recovery') },
        ],
      })
    ).toMatchObject({ status: 400, body: { code: 'invalid_batch', rejectedOriginSeq: 6 } })
    expect(
      await post({
        version: 2,
        sourceRef: 'remote:c',
        feed: 'broker_invocation_events',
        events: [{ originSeq: 7, event: brokerRecord() }],
      })
    ).toMatchObject({ status: 400, body: { code: 'invalid_batch', rejectedOriginSeq: 7 } })
    expect(
      await post({
        version: 1,
        sourceRef: 'remote:c',
        feed: 'broker_invocation_events',
        events: [{ originSeq: 8, event: brokerRecord('retained') }],
      })
    ).toMatchObject({ status: 400, body: { code: 'invalid_batch', rejectedOriginSeq: 8 } })
    // Nothing from a refused batch was persisted, including its valid first item.
    expect(receiver.hrcEvents.listFromHrcSeq(1).filter((e) => e.sourceRef === 'remote:c')).toEqual(
      []
    )
    expect(receiver.brokerInvocationEvents.listBySourceRef('remote:c')).toEqual([])
  })
})
