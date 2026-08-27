import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
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
  resolveEventForwardTarget,
  resolveEventIngestTcpPort,
  startEventIngestListener,
} from '../event-ingest.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { tcpPort?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hrc-ingest-'))
  roots.push(root)
  const db = openHrcDatabase(join(root, 'state.sqlite'))
  const listener = await startEventIngestListener({ db, runtimeRoot: root, ...options })
  return { root, db, listener }
}

async function reserveTcpPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('failed to reserve an IPv4 TCP port'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
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

async function ingestTcp(url: string, batch: HrcEventIngestBatch) {
  const response = await fetch(`${url}/v1/ingest`, {
    method: 'POST',
    body: JSON.stringify(batch),
  })
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
  test('requires one declared forward target and validates opt-in listener port', () => {
    expect(resolveEventForwardTarget({ socketPath: '/run/hrc/events.sock' })).toEqual({
      kind: 'unix',
      socketPath: '/run/hrc/events.sock',
    })
    expect(resolveEventForwardTarget({ tcpUrl: 'http://host.docker.internal:18495' })).toEqual({
      kind: 'tcp',
      url: 'http://host.docker.internal:18495',
    })
    expect(() => resolveEventForwardTarget({})).toThrow('exactly one')
    expect(() =>
      resolveEventForwardTarget({
        socketPath: '/run/hrc/events.sock',
        tcpUrl: 'http://host.docker.internal:18495',
      })
    ).toThrow('exactly one')
    for (const url of [
      'https://host.docker.internal:18495',
      'http://host.docker.internal',
      'http://host.docker.internal:18495/v1/ingest',
      'http://user:pass@host.docker.internal:18495',
    ]) {
      expect(() => resolveEventForwardTarget({ tcpUrl: url })).toThrow('HTTP origin')
    }
    expect(resolveEventIngestTcpPort(undefined)).toBeUndefined()
    expect(resolveEventIngestTcpPort('18495')).toBe(18_495)
    for (const port of ['0', '65536', '18495x', '-1']) {
      expect(() => resolveEventIngestTcpPort(port)).toThrow('integer from 1 to 65535')
    }
  })

  test('serves the identical bounded ingest path over real unix and opt-in IPv4 TCP', async () => {
    const host = await fixture({ tcpPort: await reserveTcpPort() })
    const sourceRef = 'devbox-room:T-06838:dual-transport'
    const batch: HrcEventIngestBatch = {
      version: 1,
      sourceRef,
      feed: 'hrc_events',
      events: [{ originSeq: 41, event: lifecycle() }],
    }
    expect(host.listener.tcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/)
    expect(await ingestTcp(host.listener.tcpUrl!, batch)).toMatchObject({
      status: 200,
      body: { ok: true, inserted: 1 },
    })
    expect(await ingest(host.listener.socketPath, batch)).toMatchObject({
      status: 200,
      body: { ok: true, inserted: 0, duplicates: 1 },
    })
    expect(host.db.hrcEvents.listFromHrcSeq(1, { sourceRef })).toHaveLength(1)
    expect(host.listener.counters).toMatchObject({ accepted: 1, duplicates: 1 })

    await host.listener.stop()
    host.db.close()
  })

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

  test('forwards both independently cursor-acked feeds over declared TCP and resumes', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'hrc-forward-local-'))
    roots.push(localRoot)
    const local = openHrcDatabase(join(localRoot, 'state.sqlite'))
    const host = await fixture({ tcpPort: await reserveTcpPort() })
    const sourceRef = 'devbox-room:T-06838:run-forward'
    const cursorPath = join(localRoot, 'event-forward-cursors.json')
    const target = { kind: 'tcp', url: host.listener.tcpUrl! } as const

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
    })

    const first = await forwardAvailableEvents({
      db: local,
      sourceRef,
      target,
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
      target,
      cursorPath,
    })
    expect(resumed.forwarded).toBe(0)

    await host.listener.stop()
    host.db.close()
    local.close()
  })

  test('unreachable declared unix or TCP target leaves local writes and cursors untouched', async () => {
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
        target: { kind: 'unix', socketPath: join(root, 'absent.sock') },
        cursorPath,
      })
    ).rejects.toThrow()
    const unreachablePort = await reserveTcpPort()
    await expect(
      forwardAvailableEvents({
        db,
        sourceRef: 'offline-room',
        target: { kind: 'tcp', url: `http://127.0.0.1:${unreachablePort}` },
        cursorPath,
      })
    ).rejects.toThrow()
    expect(db.hrcEvents.listFromHrcSeq(native.hrcSeq)).toHaveLength(1)
    db.close()
  })

  test('forwards addressed blob parts before stubbed ledgers and hydrates on the receiver', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'hrc-forward-blobs-'))
    roots.push(sourceRoot)
    const source = openHrcDatabase(join(sourceRoot, 'state.sqlite'))
    const body = `federated-full-result:${'f'.repeat(700_000)}`
    const native = source.hrcEvents.append({
      ts: lifecycle().ts,
      hostSessionId: lifecycle().hostSessionId,
      scopeRef: lifecycle().scopeRef,
      laneRef: lifecycle().laneRef,
      generation: lifecycle().generation,
      runtimeId: 'blob-runtime',
      category: 'tool',
      eventKind: 'turn.tool_result',
      transport: 'headless',
      replayed: false,
      payload: {
        toolUseId: 'blob-tool',
        toolName: 'exec',
        result: { content: [{ type: 'text', text: body }] },
      },
    })
    expect(
      (native.payload as { result: { content: Array<{ text: string }> } }).result.content[0]?.text
    ).toBe(body)

    const host = await fixture()
    const sourceRef = 'devbox-room:T-07610:blob-forward'
    const result = await forwardAvailableEvents({
      db: source,
      sourceRef,
      target: { kind: 'unix', socketPath: host.listener.socketPath },
      cursorPath: join(sourceRoot, 'event-forward-cursors.json'),
    })
    expect(result.forwarded).toBeGreaterThan(3)
    expect(result.cursors.toolResultBlobs).toBeGreaterThan(0)

    const imported = host.db.hrcEvents.listFromHrcSeq(1, { sourceRef })[0]!
    expect(
      (imported.payload as { result: { content: Array<{ text: string }> } }).result.content[0]?.text
    ).toBe(body)
    expect(
      host.db.sqlite
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM tool_result_blob_parts')
        .get()?.count
    ).toBe(0)
    expect(host.db.toolResultBlobs.listLocalFromRowid(0, 10)).toEqual([])

    await host.listener.stop()
    host.db.close()
    source.close()
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
