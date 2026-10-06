/**
 * T-10418 — federated session read. Two real daemons over the loopback peer
 * transport: `max3` (origin) holds an active placement row naming `svc` (home)
 * for the seat, plus a shadow continuity of its own that must never be served.
 * The relay cases drive a scripted peer so each terminal is provoked exactly.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'

import type { HrcBoundedEventStreamRecord, HrcEventTail } from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import type { PeerEntry } from '../federation/federation-config.js'
import {
  HOME_NODE_HEADER,
  type ScopeReadServer,
  forwardBoundedStream,
  forwardScopeJson,
  routeScopeRead,
} from '../federation/scope-read-routing.js'
import type { createHrcServer } from '../index.js'
import { HRC_BOUNDED_EVENTS_MAX_BYTES } from '../server-constants.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  FEDERATION_TEST_MODE_ENV,
  createFederationTestServer,
  federationTestHost,
} from './fixtures/live-tailnet-test.js'

type Server = Awaited<ReturnType<typeof createHrcServer>>

const TOKEN = 't10418-session-read-token'
const SEAT = 'agent:clod:project:foundry:task:T-10417'
const UNBOUND = 'agent:clod:project:foundry:task:T-unbound'

function seed(fixture: HrcServerTestFixture, scopeRef: string, hostSessionId: string) {
  const db = openHrcDatabase(fixture.dbPath)
  const ts = '2026-10-06T17:13:05.382Z'
  try {
    db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    })
    db.continuities.upsert({
      scopeRef,
      laneRef: 'main',
      activeHostSessionId: hostSessionId,
      updatedAt: ts,
    })
  } finally {
    db.close()
  }
}

function bind(fixture: HrcServerTestFixture, scopeRef: string, homeNodeId: string) {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    createPlacementLedgerRepository(db.sqlite).installActive({
      scopeRef,
      homeNodeId,
      updatedAt: '2026-10-06T17:13:05.382Z',
    })
  } finally {
    db.close()
  }
}

async function readRecords(
  response: Response,
  until: (record: HrcBoundedEventStreamRecord) => boolean
): Promise<{ records: HrcBoundedEventStreamRecord[]; closed: boolean }> {
  const reader = response.body!.getReader()
  const records: HrcBoundedEventStreamRecord[] = []
  let buffered = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { records, closed: true }
    buffered += new TextDecoder().decode(value)
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line.length > 0) {
        const record = JSON.parse(line) as HrcBoundedEventStreamRecord
        records.push(record)
        if (until(record)) {
          reader.releaseLock()
          return { records, closed: false }
        }
      }
      newline = buffered.indexOf('\n')
    }
  }
}

describe('T-10418 federated session read (two daemons)', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  test('routes resolve, get, tail, runs and follow to the home; refuses peer creation; one terminal on home death', async () => {
    const priorMode = process.env[FEDERATION_TEST_MODE_ENV]
    process.env[FEDERATION_TEST_MODE_ENV] = 'loopback'
    const host = federationTestHost(undefined)
    if (host === undefined) throw new Error('loopback federation host unavailable')
    const svc = await createHrcTestFixture('hrc-t10418-svc-')
    const max3 = await createHrcTestFixture('hrc-t10418-max3-')
    fixtures.push(svc, max3)
    const probes = [0, 1].map(() =>
      Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
    )
    const [svcPort, max3Port] = probes.map((probe) => probe.port)
    for (const probe of probes) probe.stop(true)
    const svcBind = `http://${host}:${svcPort}`
    const max3Bind = `http://${host}:${max3Port}`
    await writeFile(
      `${svc.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({
        nodeId: 'svc',
        peers: { max3: { endpoint: max3Bind, token: TOKEN } },
        peerListener: { bind: svcBind },
      }),
      { mode: 0o600 }
    )
    await writeFile(
      `${max3.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({
        nodeId: 'max3',
        peers: { svc: { endpoint: svcBind, token: TOKEN } },
        peerListener: { bind: max3Bind },
      }),
      { mode: 0o600 }
    )
    seed(svc, SEAT, 'hsid-svc-home')
    bind(svc, SEAT, 'svc')
    // F8: a shadow continuity on the origin for the svc-bound scope.
    seed(max3, SEAT, 'hsid-max3-shadow')
    bind(max3, SEAT, 'svc')
    bind(max3, 'agent:clod:project:foundry:task:T-ghost', 'ghost')

    let svcServer: Server | undefined
    let max3Server: Server | undefined
    try {
      svcServer = await createFederationTestServer(svc, { otelListenerEnabled: false })
      max3Server = await createFederationTestServer(max3, {
        otelListenerEnabled: false,
        scopeReadTimeouts: { connectMs: 1_000, idleMs: 15_000 },
      })

      // F25: status advertises the capability.
      const status = (await (await max3.fetchSocket('/v1/status')).json()) as {
        capabilities: { federatedSessionRead?: boolean }
      }
      expect(status.capabilities.federatedSessionRead).toBe(true)

      // F1/F8/F25: resolve without create is answered by svc, never the shadow.
      const resolved = await max3.postJson('/v1/sessions/resolve', {
        sessionRef: `${SEAT}/lane:main`,
      })
      expect(resolved.status).toBe(200)
      expect(resolved.headers.get(HOME_NODE_HEADER)).toBe('svc')
      expect(await resolved.json()).toMatchObject({
        found: true,
        hostSessionId: 'hsid-svc-home',
        homeNodeId: 'svc',
      })
      // create:false is still a read and still forwarded.
      const resolvedFalse = await max3.postJson('/v1/sessions/resolve', {
        sessionRef: `${SEAT}/lane:main`,
        create: false,
      })
      expect(((await resolvedFalse.json()) as { hostSessionId: string }).hostSessionId).toBe(
        'hsid-svc-home'
      )

      // sessions/get moves onto the same routing.
      const got = await max3.fetchSocket(`/v1/sessions/get?scopeRef=${encodeURIComponent(SEAT)}`)
      expect(got.status).toBe(200)
      expect(got.headers.get(HOME_NODE_HEADER)).toBe('svc')
      expect(
        ((await got.json()) as { generation: { hostSessionId: string } }).generation.hostSessionId
      ).toBe('hsid-svc-home')

      // Write an event on the home (metadata change carries the seat's scope).
      const patch = (title: string) =>
        svc.fetchSocket('/v1/sessions/metadata', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scopeRef: SEAT, set: { title } }),
        })
      expect((await patch('one')).status).toBe(200)

      // Tail by scope is the home's ledger page; hostSessionId-only stays local (F17).
      const tailResponse = await max3.fetchSocket(
        `/v1/events/tail?limit=10&scopeRef=${encodeURIComponent(SEAT)}&laneRef=main`
      )
      expect(tailResponse.status).toBe(200)
      expect(tailResponse.headers.get(HOME_NODE_HEADER)).toBe('svc')
      const tail = (await tailResponse.json()) as HrcEventTail
      expect(tail.ledgerIncarnationId).toBe(svcServer.db.hrcEvents.ledgerIncarnationId())
      expect(tail.events.length).toBeGreaterThan(0)
      expect(tail.events.every((event) => event.hostSessionId === 'hsid-svc-home')).toBe(true)
      const localOnly = await max3.fetchSocket(
        '/v1/events/tail?limit=10&hostSessionId=hsid-svc-home'
      )
      expect(localOnly.headers.get(HOME_NODE_HEADER)).toBeNull()
      expect(((await localOnly.json()) as HrcEventTail).events).toEqual([])

      // Runs by scope go to the home too.
      const runs = await max3.fetchSocket(
        `/v1/runs?limit=1&scopeRef=${encodeURIComponent(SEAT)}&laneRef=main`
      )
      expect(runs.status).toBe(200)
      expect(runs.headers.get(HOME_NODE_HEADER)).toBe('svc')

      // F2: follow from the home head, then a NEW home event arrives through the relay.
      const cursor = tail.events.at(-1)!.hrcSeq
      const follow = await max3.fetchSocket(
        `/v1/events/bounded-stream?follow=true&ledgerIncarnationId=${tail.ledgerIncarnationId}&afterSeq=${cursor}&scopeRef=${encodeURIComponent(SEAT)}&laneRef=main`
      )
      expect(follow.status).toBe(200)
      expect(follow.headers.get(HOME_NODE_HEADER)).toBe('svc')
      const reader = follow.body!.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      const records: HrcBoundedEventStreamRecord[] = []
      const next = async (): Promise<HrcBoundedEventStreamRecord | 'closed'> => {
        for (;;) {
          const newline = buffered.indexOf('\n')
          if (newline >= 0) {
            const line = buffered.slice(0, newline)
            buffered = buffered.slice(newline + 1)
            if (line.length === 0) continue
            const record = JSON.parse(line) as HrcBoundedEventStreamRecord
            records.push(record)
            return record
          }
          const { done, value } = await reader.read()
          if (done) return 'closed'
          buffered += decoder.decode(value)
        }
      }
      expect(await next()).toMatchObject({ type: 'ready', acceptedAfterHrcSeq: cursor })
      // A notified lifecycle fact on the home, appended after attach.
      const home = svcServer as unknown as {
        db: Server['db']
        appendEvent(session: unknown, kind: string, payload: unknown): unknown
        notifyEvent(event: unknown): void
      }
      home.notifyEvent(
        home.appendEvent(home.db.sessions.getByHostSessionId('hsid-svc-home'), 'session.created', {
          t10418: 'after-attach',
        })
      )
      const live = await next()
      expect(live).toMatchObject({ type: 'event' })
      const lastSeen = (live as { event: { hrcSeq: number } }).event.hrcSeq
      expect(lastSeen).toBeGreaterThan(cursor)

      // F7/F22: the peer surface is read-only, before any create code runs.
      const counts = () => ({
        sessions: svcServer!.db.sessions.count(),
        continuities: svcServer!.db.sqlite.query('SELECT COUNT(*) AS n FROM continuities').get(),
        placements: createPlacementLedgerRepository(svcServer!.db.sqlite).list().length,
      })
      const before = counts()
      const peerPost = (path: string, body: unknown, method = 'POST') =>
        fetch(new URL(path, svcBind), {
          method,
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
        })
      for (const body of [
        { sessionRef: `${UNBOUND}/lane:main`, create: true },
        { sessionRef: `${UNBOUND}/lane:main`, summonIntent: 'explicit_local' },
        { sessionRef: `${UNBOUND}/lane:main`, create: false, runtimeIntent: {} },
      ]) {
        const refused = await peerPost('/v1/sessions/resolve', body)
        expect(refused.status).toBe(403)
        expect(await refused.json()).toMatchObject({ error: { code: 'peer_read_only' } })
      }
      expect(counts()).toEqual(before)
      expect((await peerPost('/v1/events/tail?scopeRef=x', {})).status).toBe(403)
      expect((await peerPost('/v1/runs?scopeRef=x', {})).status).toBe(403)
      // A direct peer read is localOnly: svc answers from its own ledger.
      const peerRead = await peerPost('/v1/sessions/resolve', { sessionRef: `${SEAT}/lane:main` })
      expect(((await peerRead.json()) as { hostSessionId: string }).hostSessionId).toBe(
        'hsid-svc-home'
      )

      // F20: a home absent from federation.json is unreachable, not not-found.
      const ghost = await max3.postJson('/v1/sessions/resolve', {
        sessionRef: 'agent:clod:project:foundry:task:T-ghost/lane:main',
      })
      expect(ghost.status).toBe(503)
      expect(await ghost.json()).toMatchObject({ error: { code: 'session_home_unreachable' } })

      // F6: no ledger row and a registry that cannot answer → unknown, never found:false.
      const unknown = await max3.postJson('/v1/sessions/resolve', {
        sessionRef: `${UNBOUND}/lane:main`,
      })
      expect(unknown.status).toBe(503)
      expect(await unknown.json()).toMatchObject({ error: { code: 'session_home_unknown' } })
      const unknownTail = await max3.fetchSocket(
        `/v1/events/tail?limit=1&scopeRef=${encodeURIComponent(UNBOUND)}`
      )
      expect(unknownTail.status).toBe(503)

      // create:true keeps today's path (not forwarded, not refused as a read).
      // Daemon-category reads are not placeable and stay local.
      const serverTail = await max3.fetchSocket('/v1/events/tail?limit=1&scopeRef=server:hrc')
      expect(serverTail.status).toBe(200)
      expect(serverTail.headers.get(HOME_NODE_HEADER)).toBeNull()

      // F5: the home dies mid-follow → exactly one retryable terminal, then close.
      await svcServer.stop()
      svcServer = undefined
      const terminal = await next()
      expect(terminal).toEqual({
        type: 'home_unreachable',
        homeNodeId: 'svc',
        retryable: true,
        reason: 'disconnected',
      })
      expect(await next()).toBe('closed')
      expect(
        records.filter((r) => r.type === 'home_unreachable' || r.type === 'ledger_replaced')
      ).toHaveLength(1)

      // F4: before headers, the dead home is a 503, not found:false.
      const down = await max3.postJson('/v1/sessions/resolve', { sessionRef: `${SEAT}/lane:main` })
      expect(down.status).toBe(503)
      expect(await down.json()).toMatchObject({ error: { code: 'session_home_unreachable' } })
      const downStream = await max3.fetchSocket(
        `/v1/events/bounded-stream?follow=true&ledgerIncarnationId=${tail.ledgerIncarnationId}&afterSeq=${lastSeen}&scopeRef=${encodeURIComponent(SEAT)}`
      )
      expect(downStream.status).toBe(503)

      // Resume from the last fully received event after recovery: nothing lost or repeated.
      svcServer = await createFederationTestServer(svc, { otelListenerEnabled: false })
      expect((await patch('three')).status).toBe(200)
      const resumed = await max3.fetchSocket(
        `/v1/events/bounded-stream?follow=true&ledgerIncarnationId=${tail.ledgerIncarnationId}&afterSeq=${lastSeen}&scopeRef=${encodeURIComponent(SEAT)}&laneRef=main`
      )
      expect(resumed.status).toBe(200)
      const { records: after } = await readRecords(resumed, (r) => r.type === 'event')
      const replayed = after.filter((r) => r.type === 'event') as Array<{
        event: { hrcSeq: number }
      }>
      // The home's own ledger says which scope event is next after the cursor.
      const homeAfter = svcServer.db.hrcEvents
        .tail(50, { scopeRef: SEAT })
        .events.filter((e) => e.hrcSeq > lastSeen)
      expect(homeAfter.length).toBeGreaterThan(0)
      expect(replayed[0]!.event.hrcSeq).toBe(homeAfter[0]!.hrcSeq)
      await resumed.body?.cancel()
    } finally {
      await max3Server?.stop()
      await svcServer?.stop()
      if (priorMode === undefined) delete process.env[FEDERATION_TEST_MODE_ENV]
      else process.env[FEDERATION_TEST_MODE_ENV] = priorMode
    }
  }, 30_000)
})

// -- §1 table against a real placement ledger and a scripted registry --------

function routingServer(
  fixture: HrcServerTestFixture,
  consult: () => Promise<unknown>
): ScopeReadServer {
  const db = openHrcDatabase(fixture.dbPath)
  return {
    db,
    federationNodeId: 'max3',
    federationRegistryClient: { consult } as never,
    foreignHomeMemo: new Map(),
    options: {
      federationConfig: {
        sourceExists: true,
        peers: new Map([['svc', fakePeer('http://127.0.0.1:1')]]),
      } as never,
    },
  }
}

function fakePeer(endpoint: string): PeerEntry {
  return {
    nodeId: 'svc',
    endpoint,
    token: { reveal: () => TOKEN, matches: () => true },
  } as unknown as PeerEntry
}

describe('T-10418 routeScopeRead home-authority table', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  test('bound-local, bound-foreign, unbound, retired gap and unknown', async () => {
    const fixture = await createHrcTestFixture('hrc-t10418-route-')
    fixtures.push(fixture)
    let registry: () => Promise<unknown> = async () => ({ outcome: 'unbound' })
    const server = routingServer(fixture, () => registry())
    const ledger = createPlacementLedgerRepository(server.db.sqlite)
    const scope = (n: string) => `agent:clod:project:foundry:task:T-${n}`
    ledger.installActive({ scopeRef: scope('local'), homeNodeId: 'max3', updatedAt: 'x' })
    ledger.installActive({ scopeRef: scope('foreign'), homeNodeId: 'svc', updatedAt: 'x' })
    ledger.installActive({ scopeRef: scope('retired'), homeNodeId: 'max3', updatedAt: 'x' })
    expect(
      ledger.retire({
        scopeRef: scope('retired'),
        expectedHomeNodeId: 'max3',
        reason: 'test',
        retiredAt: '2026-10-06T00:00:00.000Z',
      }).outcome
    ).toBe('retired')

    expect(await routeScopeRead(server, scope('local'))).toEqual({ kind: 'local' })
    expect(await routeScopeRead(server, scope('foreign'))).toMatchObject({
      kind: 'forward',
      homeNodeId: 'svc',
    })
    expect(await routeScopeRead(server, scope('never-placed'))).toEqual({ kind: 'local' })
    // F9: unbound with a retired local row is the retirement gap.
    await expect(routeScopeRead(server, scope('retired'))).rejects.toMatchObject({
      code: 'session_home_pending',
      status: 503,
    })
    // A registry still naming this node after retirement is unbound/retired too.
    registry = async () => ({
      outcome: 'bound',
      binding: { scopeRef: scope('retired'), homeNodeId: 'max3', createdAt: 'x', updatedAt: 'x' },
    })
    await expect(routeScopeRead(server, scope('retired'))).rejects.toMatchObject({
      code: 'session_home_pending',
    })
    // F6: the registry failing is unknown, never a local fallback.
    registry = async () => {
      throw new Error('registry down')
    }
    await expect(routeScopeRead(server, scope('never-placed-2'))).rejects.toMatchObject({
      code: 'session_home_unknown',
      status: 503,
    })
    // ...but an active local placement never needs the registry.
    expect(await routeScopeRead(server, scope('local'))).toEqual({ kind: 'local' })
    server.db.close()
  })
})

// -- relay against a scripted home -------------------------------------------

type Script = (controller: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal) => void

function scriptedHome(script: Script, onAbort?: () => void) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      request.signal.addEventListener('abort', () => onAbort?.(), { once: true })
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => script(controller, request.signal),
          cancel: () => onAbort?.(),
        }),
        { headers: { 'content-type': 'application/x-ndjson' } }
      )
    },
  })
}

const enc = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`)
const READY = {
  type: 'ready',
  ledgerIncarnationId: 'L',
  acceptedAfterHrcSeq: 0,
  replayHeadHrcSeq: 0,
}
const event = (hrcSeq: number) => ({
  type: 'event',
  ledgerIncarnationId: 'L',
  event: { hrcSeq, eventKind: 'turn.started' },
})

async function relay(endpoint: string, idleMs: number, signal?: AbortSignal) {
  const server = {
    options: { scopeReadTimeouts: { connectMs: 1_000, idleMs } },
  } as unknown as ScopeReadServer
  return forwardBoundedStream(server, {
    route: { kind: 'forward', homeNodeId: 'svc', peer: fakePeer(endpoint) },
    scopeRef: SEAT,
    url: new URL(`http://origin/v1/events/bounded-stream?scopeRef=${encodeURIComponent(SEAT)}`),
    signal,
  })
}

describe('T-10418 record-level relay', () => {
  test('relays live records and maps a clean close without terminal to disconnected', async () => {
    const home = scriptedHome((c) => {
      c.enqueue(enc(READY))
      c.enqueue(new Uint8Array([0x0a]))
      setTimeout(() => {
        c.enqueue(enc(event(1)))
        c.close()
      }, 50)
    })
    try {
      const response = await relay(home.url.toString(), 1_000)
      expect(response.headers.get(HOME_NODE_HEADER)).toBe('svc')
      const text = await response.text()
      const lines = text.split('\n')
      expect(lines[1]).toBe('') // keepalive passes through as a keepalive
      const records = lines.filter((l) => l.length > 0).map((l) => JSON.parse(l))
      expect(records.map((r) => r.type)).toEqual(['ready', 'event', 'home_unreachable'])
      expect(records[2]).toEqual({
        type: 'home_unreachable',
        homeNodeId: 'svc',
        retryable: true,
        reason: 'disconnected',
      })
    } finally {
      home.stop(true)
    }
  })

  test('F11: ledger_replaced is the only terminal even when the home then closes', async () => {
    const home = scriptedHome((c) => {
      c.enqueue(enc(READY))
      c.enqueue(
        enc({
          type: 'ledger_replaced',
          expectedLedgerIncarnationId: 'L',
          currentLedgerIncarnationId: 'M',
        })
      )
      c.close()
    })
    try {
      const records = (await (await relay(home.url.toString(), 1_000)).text())
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))
      expect(records.map((r) => r.type)).toEqual(['ready', 'ledger_replaced'])
    } finally {
      home.stop(true)
    }
  })

  test('F15: a malformed line ends the relay with one malformed terminal', async () => {
    const home = scriptedHome((c) => {
      c.enqueue(enc(READY))
      c.enqueue(new TextEncoder().encode('{not json\n'))
      c.enqueue(enc(event(2)))
    })
    try {
      const records = (await (await relay(home.url.toString(), 1_000)).text())
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))
      expect(records.map((r) => r.type)).toEqual(['ready', 'home_unreachable'])
      expect(records[1].reason).toBe('malformed')
    } finally {
      home.stop(true)
    }
  })

  test('F15: a line over the byte ceiling ends the relay with oversize', async () => {
    const home = scriptedHome((c) => {
      c.enqueue(enc(READY))
      c.enqueue(new TextEncoder().encode(`"${'x'.repeat(HRC_BOUNDED_EVENTS_MAX_BYTES + 16)}`))
    })
    try {
      const records = (await (await relay(home.url.toString(), 5_000)).text())
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))
      expect(records.map((r) => r.type)).toEqual(['ready', 'home_unreachable'])
      expect(records[1].reason).toBe('oversize')
    } finally {
      home.stop(true)
    }
  })

  test('idle bound fires only on an outstanding read that the home never answers', async () => {
    const home = scriptedHome((c) => c.enqueue(enc(READY)))
    try {
      const started = Date.now()
      const records = (await (await relay(home.url.toString(), 200)).text())
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))
      expect(records.map((r) => r.reason ?? r.type)).toEqual(['ready', 'idle_timeout'])
      expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    } finally {
      home.stop(true)
    }
  })

  test('F10: a paused consumer far longer than the idle bound never trips it', async () => {
    let seq = 0
    const home = scriptedHome((c, signal) => {
      c.enqueue(enc(READY))
      // A healthy home: keepalive-cadence data while the reader is away.
      const tick = setInterval(() => {
        if (signal.aborted) return clearInterval(tick)
        try {
          c.enqueue(seq % 2 === 0 ? new Uint8Array([0x0a]) : enc(event(seq)))
        } catch {
          clearInterval(tick)
        }
        seq += 1
      }, 50)
    })
    try {
      const response = await relay(home.url.toString(), 150)
      const reader = response.body!.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('"ready"')
      // Paused 8x the idle bound with no downstream pull.
      await Bun.sleep(1_200)
      const seen: string[] = []
      for (let i = 0; i < 6; i += 1) {
        const { done, value } = await reader.read()
        if (done) break
        seen.push(new TextDecoder().decode(value))
      }
      expect(seen.join('')).not.toContain('home_unreachable')
      expect(seen.join('')).toContain('"event"')
      await reader.cancel()
    } finally {
      home.stop(true)
    }
  })

  test('F19: a client abort cancels the peer fetch', async () => {
    let aborted = false
    const home = scriptedHome(
      (c) => c.enqueue(enc(READY)),
      () => {
        aborted = true
      }
    )
    try {
      const client = new AbortController()
      const response = await relay(home.url.toString(), 5_000, client.signal)
      const reader = response.body!.getReader()
      await reader.read()
      client.abort()
      for (let i = 0; i < 40 && !aborted; i += 1) await Bun.sleep(25)
      expect(aborted).toBe(true)
    } finally {
      home.stop(true)
    }
  })

  test('F18: a forwarded tail page over the ceiling is 502 session_home_malformed', async () => {
    const home = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(`{"events":"${'x'.repeat(HRC_BOUNDED_EVENTS_MAX_BYTES)}"}`, {
          headers: { 'content-type': 'application/json' },
        }),
    })
    try {
      const server = { options: {} } as unknown as ScopeReadServer
      await expect(
        forwardScopeJson(server, {
          route: { kind: 'forward', homeNodeId: 'svc', peer: fakePeer(home.url.toString()) },
          scopeRef: SEAT,
          url: new URL('http://origin/v1/events/tail?limit=1'),
        })
      ).rejects.toMatchObject({ code: 'session_home_malformed', status: 502 })
    } finally {
      home.stop(true)
    }
  })

  test('F4: connect/headers bound is an unreachable refusal', async () => {
    const home = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async () => {
        await Bun.sleep(2_000)
        return new Response('{}')
      },
    })
    try {
      const server = {
        options: { scopeReadTimeouts: { connectMs: 200 } },
      } as unknown as ScopeReadServer
      await expect(
        forwardBoundedStream(server, {
          route: { kind: 'forward', homeNodeId: 'svc', peer: fakePeer(home.url.toString()) },
          scopeRef: SEAT,
          url: new URL('http://origin/v1/events/bounded-stream'),
        })
      ).rejects.toMatchObject({ code: 'session_home_unreachable', status: 503 })
    } finally {
      home.stop(true)
    }
  })
})
