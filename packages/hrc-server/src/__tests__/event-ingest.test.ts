import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import type {
  HrcBrokerInvocationEventRecord,
  HrcEventIngestAck,
  HrcEventIngestBatch,
  HrcLifecycleEvent,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  drainEventDatabase,
  forwardAvailableEvents,
  startEventIngestListener,
} from '../event-ingest.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hrc-ingest-'))
  roots.push(root)
  const db = openHrcDatabase(join(root, 'state.sqlite'))
  const listener = await startEventIngestListener({ db, runtimeRoot: root })
  return { root, db, listener }
}

async function ingest(socketPath: string, batch: HrcEventIngestBatch) {
  const response = await fetch('http://hrc/v1/ingest', {
    method: 'POST',
    body: JSON.stringify(batch),
    unix: socketPath,
  } as RequestInit & { unix: string })
  return {
    status: response.status,
    body: (await response.json()) as HrcEventIngestAck,
  }
}

function lifecycle(streamSeq = 41): HrcLifecycleEvent {
  return {
    hrcSeq: 9,
    streamSeq,
    ts: '2026-07-24T01:02:03.000Z',
    hostSessionId: 'foreign-session',
    scopeRef: 'agent:cody:project:devbox:task:T-06838',
    laneRef: 'main',
    generation: 7,
    runtimeId: 'foreign-runtime',
    runId: 'foreign-run',
    category: 'turn',
    eventKind: 'turn.completed',
    transport: 'headless',
    replayed: true,
    payload: { final: 'preserved' },
  }
}

function broker(id = 13): HrcBrokerInvocationEventRecord {
  return {
    id,
    invocationId: 'foreign-invocation',
    seq: 2,
    time: '2026-07-24T01:02:04.000Z',
    type: 'assistant.message.completed',
    runId: 'foreign-run',
    runtimeId: 'foreign-runtime',
    harnessGeneration: 7,
    turnAttempt: 1,
    brokerEventJson: JSON.stringify({ text: 'done' }),
    brokerEnvelopeJson: JSON.stringify({
      invocationId: 'foreign-invocation',
      seq: 2,
      time: '2026-07-24T01:02:04.000Z',
      type: 'assistant.message.completed',
      payload: { text: 'done' },
    }),
    projectionStatus: 'applied',
    createdAt: '2026-07-24T01:02:04.000Z',
  }
}

describe('T-06838 dedicated observational ingest', () => {
  test('imports both feeds with origin facts, provenance, and no authority rows', async () => {
    const { db, listener } = await fixture()
    const sourceRef = 'devbox-room:T-06838:run-a'
    const first = await ingest(listener.socketPath, {
      version: 1,
      sourceRef,
      feed: 'hrc_events',
      events: [{ originSeq: 41, event: lifecycle() }],
    })
    const second = await ingest(listener.socketPath, {
      version: 1,
      sourceRef,
      feed: 'broker_invocation_events',
      events: [{ originSeq: 13, event: broker() }],
    })
    expect(first).toMatchObject({ status: 200, body: { ok: true, inserted: 1 } })
    expect(second).toMatchObject({ status: 200, body: { ok: true, inserted: 1 } })

    const imported = db.hrcEvents.listFromHrcSeq(1, { sourceRef })[0]!
    expect(imported).toMatchObject({
      sourceRef,
      originSeq: 41,
      ts: '2026-07-24T01:02:03.000Z',
      generation: 7,
      replayed: true,
    })
    const importedBroker = db.brokerInvocationEvents.listBySourceRef(sourceRef)[0]!
    expect(importedBroker).toMatchObject({
      sourceRef,
      originSeq: 13,
      projectionStatus: 'imported',
      time: '2026-07-24T01:02:04.000Z',
    })
    expect(importedBroker.hrcEventSeq).toBeUndefined()
    expect(db.runtimes.getByRuntimeId('foreign-runtime')).toBeNull()
    expect(db.brokerInvocations.getByInvocationId('foreign-invocation')).toBeNull()

    await listener.stop()
    db.close()
  })

  test('identical resend acks no-op; divergent duplicate rejects and increments counter', async () => {
    const { db, listener } = await fixture()
    const batch: HrcEventIngestBatch = {
      version: 1,
      sourceRef: 'devbox-room:T-06838:run-dedup',
      feed: 'hrc_events',
      events: [{ originSeq: 41, event: lifecycle() }],
    }
    expect((await ingest(listener.socketPath, batch)).body).toMatchObject({
      ok: true,
      inserted: 1,
    })
    expect((await ingest(listener.socketPath, batch)).body).toMatchObject({
      ok: true,
      inserted: 0,
      duplicates: 1,
    })
    const divergent: HrcEventIngestBatch = {
      ...batch,
      events: [{ originSeq: 41, event: { ...lifecycle(), payload: { divergent: true } } }],
    }
    expect(await ingest(listener.socketPath, divergent)).toMatchObject({
      status: 409,
      body: { ok: false, code: 'divergent_duplicate', rejectedOriginSeq: 41 },
    })
    expect(listener.counters.divergentDuplicates).toBe(1)
    expect(db.hrcEvents.listFromHrcSeq(1, { sourceRef: batch.sourceRef })).toHaveLength(1)
    await listener.stop()
    db.close()
  })

  test('native rows retain null provenance and pair invariant rejects half-pairs', async () => {
    const { db, listener } = await fixture()
    const native = db.hrcEvents.append({
      ...lifecycle(),
      hrcSeq: undefined as never,
      streamSeq: undefined as never,
      replayed: false,
    })
    expect(native.sourceRef).toBeUndefined()
    expect(native.originSeq).toBeUndefined()
    expect(() =>
      db.sqlite
        .query(
          `UPDATE hrc_events SET source_ref = 'half-pair', origin_seq = NULL WHERE hrc_seq = ?`
        )
        .run(native.hrcSeq)
    ).toThrow('source_ref and origin_seq must be both null or both non-null')
    await listener.stop()
    db.close()
  })

  test('accepts concurrent room connections without cross-contamination', async () => {
    const { db, listener } = await fixture()
    const sources = ['run-one', 'run-two']
    await Promise.all(
      sources.map((sourceRef, index) =>
        ingest(listener.socketPath, {
          version: 1,
          sourceRef,
          feed: 'hrc_events',
          events: [{ originSeq: 1, event: lifecycle(index + 1) }],
        })
      )
    )
    for (const sourceRef of sources) {
      expect(db.hrcEvents.listFromHrcSeq(1, { sourceRef })).toHaveLength(1)
    }
    await listener.stop()
    db.close()
  })

  test('forwards two independently cursor-acked feeds and reconnect resumes', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'hrc-forward-local-'))
    roots.push(localRoot)
    const local = openHrcDatabase(join(localRoot, 'state.sqlite'))
    const host = await fixture()
    const sourceRef = 'devbox-room:T-06838:run-forward'
    const cursorPath = join(localRoot, 'event-forward-cursors.json')

    local.hrcEvents.append({
      ts: lifecycle().ts,
      hostSessionId: lifecycle().hostSessionId,
      scopeRef: lifecycle().scopeRef,
      laneRef: lifecycle().laneRef,
      generation: lifecycle().generation,
      runtimeId: lifecycle().runtimeId,
      runId: lifecycle().runId,
      category: lifecycle().category,
      eventKind: lifecycle().eventKind,
      transport: lifecycle().transport,
      replayed: lifecycle().replayed,
      payload: lifecycle().payload,
    })
    local.brokerInvocationEvents.appendEvent({
      invocationId: broker().invocationId,
      seq: broker().seq,
      time: broker().time,
      type: broker().type,
      runId: broker().runId,
      runtimeId: broker().runtimeId,
      harnessGeneration: broker().harnessGeneration,
      turnAttempt: broker().turnAttempt,
      payload: JSON.parse(broker().brokerEventJson),
      envelopeJson: broker().brokerEnvelopeJson,
      projectionStatus: 'applied',
      createdAt: broker().createdAt,
    })

    const first = await forwardAvailableEvents({
      db: local,
      sourceRef,
      socketPath: host.listener.socketPath,
      cursorPath,
    })
    expect(first).toMatchObject({
      forwarded: 2,
      cursors: { hrcEvents: 1, brokerInvocationEvents: 1 },
    })
    expect(host.db.hrcEvents.listFromHrcSeq(1, { sourceRef })).toHaveLength(1)
    expect(host.db.brokerInvocationEvents.listBySourceRef(sourceRef)).toHaveLength(1)

    const resumed = await forwardAvailableEvents({
      db: local,
      sourceRef,
      socketPath: host.listener.socketPath,
      cursorPath,
    })
    expect(resumed.forwarded).toBe(0)

    await host.listener.stop()
    host.db.close()
    local.close()
  })

  test('missing socket rejects forwarding without changing local writes or cursors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrc-forward-offline-'))
    roots.push(root)
    const db = openHrcDatabase(join(root, 'state.sqlite'))
    const cursorPath = join(root, 'event-forward-cursors.json')
    const native = db.hrcEvents.append({
      ts: lifecycle().ts,
      hostSessionId: lifecycle().hostSessionId,
      scopeRef: lifecycle().scopeRef,
      laneRef: lifecycle().laneRef,
      generation: lifecycle().generation,
      category: lifecycle().category,
      eventKind: lifecycle().eventKind,
      replayed: false,
      payload: {},
    })
    await expect(
      forwardAvailableEvents({
        db,
        sourceRef: 'offline-room',
        socketPath: join(root, 'absent.sock'),
        cursorPath,
      })
    ).rejects.toThrow()
    expect(db.hrcEvents.listFromHrcSeq(native.hrcSeq)).toHaveLength(1)
    db.close()
  })

  test('salvage drain forwards both dead-ledger tails and re-drain is a no-op', async () => {
    const deadRoot = await mkdtemp(join(tmpdir(), 'hrc-drain-dead-'))
    roots.push(deadRoot)
    const dbPath = join(deadRoot, 'state.sqlite')
    const dead = openHrcDatabase(dbPath)
    dead.hrcEvents.append({
      ts: lifecycle().ts,
      hostSessionId: lifecycle().hostSessionId,
      scopeRef: lifecycle().scopeRef,
      laneRef: lifecycle().laneRef,
      generation: lifecycle().generation,
      category: lifecycle().category,
      eventKind: lifecycle().eventKind,
      replayed: false,
      payload: { drained: true },
    })
    dead.brokerInvocationEvents.appendEvent({
      invocationId: broker().invocationId,
      seq: broker().seq,
      time: broker().time,
      type: broker().type,
      runtimeId: broker().runtimeId,
      payload: JSON.parse(broker().brokerEventJson),
      createdAt: broker().createdAt,
    })
    dead.close()

    const host = await fixture()
    const options = {
      dbPath,
      sourceRef: 'devbox-room:T-06838:dead-run',
      socketPath: host.listener.socketPath,
    }
    expect(await drainEventDatabase(options)).toMatchObject({ forwarded: 2 })
    expect(await drainEventDatabase(options)).toMatchObject({ forwarded: 0 })
    expect(host.db.hrcEvents.listFromHrcSeq(1, { sourceRef: options.sourceRef })).toHaveLength(1)
    expect(host.db.brokerInvocationEvents.listBySourceRef(options.sourceRef)).toHaveLength(1)

    await host.listener.stop()
    host.db.close()
  })
})
