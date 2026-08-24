/**
 * RED/GREEN tests for hrc-sdk (T-00956 / T-00955)
 *
 * Tests the hrc-sdk typed Unix socket client surface:
 *   - discoverSocket() — finds socket via resolveControlSocketPath(), throws when missing
 *   - HrcClient — HTTP-over-Unix-socket constructor and request plumbing
 *   - Typed error parsing — non-2xx responses parsed into HrcDomainError
 *   - resolveSession() — POST /v1/sessions/resolve round-trip
 *   - listSessions() — GET /v1/sessions round-trip
 *   - getSession() — GET /v1/sessions/by-host/:id round-trip
 *   - watch() — GET /v1/events NDJSON parsing into AsyncIterable<HrcLifecycleEvent>
 *   - Export surface from src/index.ts
 *
 * Pass conditions for Curly (T-00955):
 *   1. discoverSocket() returns socket path when socket file exists
 *   2. discoverSocket() throws with clear error when socket file is missing
 *   3. HrcClient constructor accepts a socket path
 *   4. HrcClient methods throw HrcDomainError for non-2xx responses with typed code
 *   5. resolveSession() sends POST, returns ResolveSessionResponse
 *   6. listSessions() sends GET, returns HrcSessionRecord[]
 *   7. getSession() sends GET, returns HrcSessionRecord, throws 404 as HrcDomainError
 *   8. watch() returns AsyncIterable<HrcLifecycleEvent> from NDJSON stream
 *   9. watch({ fromSeq }) sends fromSeq query param
 *  10. All public types are exported from src/index.ts
 *
 * Test strategy:
 *   - Socket discovery tests use real filesystem (no mock)
 *   - Client round-trip tests spin up a real hrc-server on a temp socket
 *   - Error parsing tests use a minimal Bun.serve stub that returns known error shapes
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLifecycleEvent } from 'hrc-core'

// RED GATE: These imports will fail until Curly implements the sdk module
import { HrcClient } from '../index'

// ---------------------------------------------------------------------------
// 1. discoverSocket() — socket discovery
// ---------------------------------------------------------------------------
describe('watch NDJSON parsing', () => {
  let tmpDir: string
  let stubSocketPath: string
  let stubServer: ReturnType<typeof Bun.serve> | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-watch-'))
    stubSocketPath = join(tmpDir, 'watch.sock')
  })

  afterEach(async () => {
    if (stubServer) {
      stubServer.stop(true)
      stubServer = undefined
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('parses NDJSON stream into AsyncIterable<HrcLifecycleEvent>', async () => {
    const testEvents: HrcLifecycleEvent[] = [
      {
        hrcSeq: 1,
        streamSeq: 10,
        ts: '2026-03-31T15:00:00.000Z',
        hostSessionId: 'hsid-1',
        scopeRef: 'project:test',
        laneRef: 'default',
        generation: 1,
        category: 'session',
        eventKind: 'session.created',
        replayed: false,
        payload: {},
      },
      {
        hrcSeq: 2,
        streamSeq: 11,
        ts: '2026-03-31T15:00:01.000Z',
        hostSessionId: 'hsid-1',
        scopeRef: 'project:test',
        laneRef: 'default',
        generation: 1,
        category: 'session',
        eventKind: 'session.resolved',
        replayed: false,
        payload: {},
      },
    ]

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        const ndjson = `${testEvents.map((e) => JSON.stringify(e)).join('\n')}\n`
        return new Response(ndjson, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const collected: HrcLifecycleEvent[] = []

    for await (const event of client.watch()) {
      collected.push(event)
    }

    expect(collected.length).toBe(2)
    expect(collected[0]!.hrcSeq).toBe(1)
    expect(collected[0]!.eventKind).toBe('session.created')
    expect(collected[1]!.hrcSeq).toBe(2)
    expect(collected[1]!.eventKind).toBe('session.resolved')
  })

  it('passes fromSeq as query parameter', async () => {
    let capturedUrl = ''

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        capturedUrl = req.url
        return new Response('', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)

    for await (const _event of client.watch({ fromSeq: 42 })) {
      // should be empty
    }

    expect(capturedUrl).toContain('fromSeq=42')
  })

  it('passes follow as query parameter', async () => {
    let capturedUrl = ''

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        capturedUrl = req.url
        // Return empty immediately to end the stream
        return new Response('', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)

    for await (const _event of client.watch({ follow: true })) {
      // should be empty
    }

    expect(new URL(capturedUrl).searchParams.toString()).toBe('follow=true&receipt=consumer-ack-v1')
  })

  it('ACKs a decoded opted-in follow event before yielding it', async () => {
    let ackBody: Record<string, unknown> | undefined
    const event: HrcLifecycleEvent = {
      hrcSeq: 42,
      streamSeq: 42,
      ts: '2026-07-18T12:05:00.000Z',
      hostSessionId: 'hsid-receipt',
      scopeRef: 'agent:test',
      laneRef: 'main',
      generation: 1,
      category: 'turn',
      eventKind: 'turn.message',
      replayed: false,
      payload: {},
    }

    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        const url = new URL(req.url)
        if (req.method === 'POST' && url.pathname === '/v1/server/subscribers/ack') {
          ackBody = (await req.json()) as Record<string, unknown>
          return Response.json({
            ok: true,
            subscriberId: 'sub-sdk',
            seq: 42,
            disposition: 'advanced',
            lastConsumerAcknowledgedSeq: 42,
            lastStreamAcceptedSeq: 42,
          })
        }
        return new Response(`${JSON.stringify(event)}\n`, {
          headers: {
            'Content-Type': 'application/x-ndjson',
            'x-hrc-subscriber-id': 'sub-sdk',
            'x-hrc-receipt-token': 'receipt-sdk',
            'x-hrc-receipt-ack-path': '/v1/server/subscribers/ack',
          },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const received: HrcLifecycleEvent[] = []
    for await (const value of client.watch({ follow: true })) {
      received.push(value)
    }

    expect(received).toEqual([event])
    expect(ackBody).toEqual({
      subscriberId: 'sub-sdk',
      receiptToken: 'receipt-sdk',
      seq: 42,
    })
  })

  it('omits follow query parameter when false', async () => {
    let capturedUrl = ''

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        capturedUrl = req.url
        return new Response('', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)

    for await (const _event of client.watch({ follow: false })) {
      // should be empty
    }

    expect(new URL(capturedUrl).searchParams.toString()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 4. Round-trip tests (require a real hrc-server)
// ---------------------------------------------------------------------------
// These tests need hrc-server to be implemented. They demonstrate the full
// SDK → server round-trip. They will initially fail with import errors on
// hrc-server, which is expected in the RED phase. When both packages are
// implemented, these tests validate the integration seam.
// ---------------------------------------------------------------------------
// 5. Phase 6 diagnostics round-trip (T-00973 / T-00974)
//
// RED GATE: These tests call SDK methods that do not exist yet:
//   getHealth(), getStatus(), listRuntimes(), listLaunches(), adoptRuntime()
//
// Pass conditions for Curly (T-00973):
//   1. getHealth() → GET /v1/health → { ok: true }
//   2. getStatus() → GET /v1/status → capability-discovery status payload
//   3. listRuntimes() → GET /v1/runtimes → HrcRuntimeSnapshot[] (empty when none)
//   4. listRuntimes({ hostSessionId }) → GET /v1/runtimes?hostSessionId=... → filtered array
//   5. listLaunches() → GET /v1/launches → HrcLaunchRecord[] (empty when none)
//   6. listLaunches({ hostSessionId }) → filtered by hostSessionId
//   7. listLaunches({ runtimeId }) → filtered by runtimeId
//   8. adoptRuntime(runtimeId) on dead runtime → POST /v1/runtimes/adopt → { status: 'adopted', adopted: true }
//   9. adoptRuntime(runtimeId) on active runtime → throws HrcDomainError(CONFLICT/409)
//  10. adoptRuntime(unknownId) → throws HrcDomainError(UNKNOWN_RUNTIME/404)
// ---------------------------------------------------------------------------
