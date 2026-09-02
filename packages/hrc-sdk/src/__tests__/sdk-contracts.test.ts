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
describe('Step 4 red-gate: SDK contract fixes (T-00981)', () => {
  let tmpDir: string
  let stubSocketPath: string
  let stubServer: ReturnType<typeof Bun.serve> | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-step4-'))
    stubSocketPath = join(tmpDir, 'step4.sock')
  })

  afterEach(async () => {
    if (stubServer) {
      stubServer.stop(true)
      stubServer = undefined
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  // -- M-10: watch() crashes on malformed NDJSON --
  // Current code: JSON.parse(trimmed) at client.ts:251 with no try-catch.
  // One malformed line kills the async generator with SyntaxError.
  // Expected: generator skips/yields-error for the bad line and yields remaining valid events.
  it('M-10: watch() survives malformed NDJSON and yields valid events', async () => {
    const validEvent1: HrcLifecycleEvent = {
      hrcSeq: 1,
      streamSeq: 10,
      ts: '2026-04-01T00:00:00Z',
      hostSessionId: 'hsid-m10',
      scopeRef: 'project:m10',
      laneRef: 'default',
      generation: 1,
      category: 'session',
      eventKind: 'session.created',
      replayed: false,
      payload: {},
    }
    const validEvent2: HrcLifecycleEvent = {
      hrcSeq: 3,
      streamSeq: 12,
      ts: '2026-04-01T00:00:02Z',
      hostSessionId: 'hsid-m10',
      scopeRef: 'project:m10',
      laneRef: 'default',
      generation: 1,
      category: 'session',
      eventKind: 'session.resolved',
      replayed: false,
      payload: {},
    }

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        // Line 2 is malformed JSON — should not crash the generator
        const ndjson = `${[
          JSON.stringify(validEvent1),
          '{broken json <<< THIS IS NOT VALID',
          JSON.stringify(validEvent2),
        ].join('\n')}\n`
        return new Response(ndjson, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const collected: HrcLifecycleEvent[] = []

    // This should NOT throw — the generator must handle malformed lines gracefully
    for await (const event of client.watch()) {
      collected.push(event)
    }

    // Both valid events should be yielded; the malformed line should be skipped
    expect(collected.length).toBe(2)
    expect(collected[0]!.hrcSeq).toBe(1)
    expect(collected[1]!.hrcSeq).toBe(3)
  })

  // -- m-20: watch() has no AbortSignal/cancellation --
  // Current code: WatchOptions only has fromSeq and follow — no signal field.
  // Expected: WatchOptions accepts optional `signal: AbortSignal` and terminates
  // iteration when aborted.
  it('m-20: watch() terminates on AbortSignal after first event', async () => {
    const events: HrcLifecycleEvent[] = Array.from({ length: 5 }, (_, i) => ({
      hrcSeq: i + 1,
      streamSeq: i + 10,
      ts: `2026-04-01T00:00:0${i}Z`,
      hostSessionId: 'hsid-m20',
      scopeRef: 'project:m20',
      laneRef: 'default',
      generation: 1,
      category: 'session',
      eventKind: 'session.created',
      replayed: false,
      payload: {},
    }))

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        // Send 5 events as separate NDJSON lines
        const ndjson = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
        return new Response(ndjson, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const controller = new AbortController()
    const collected: HrcLifecycleEvent[] = []

    // Pass signal in WatchOptions — this field does not exist yet (RED)
    for await (const event of client.watch({ signal: controller.signal } as any)) {
      collected.push(event)
      if (collected.length === 1) {
        controller.abort()
      }
    }

    // Should stop after first event — not consume all 5
    expect(collected.length).toBe(1)
    expect(collected[0]!.hrcSeq).toBe(1)
  })

  // -- m-22: throwTypedError discards non-JSON response bodies --
  // Current code: catch block in throwTypedError (client.ts:83-84) throws
  // "HRC request failed with status 502" — no body excerpt.
  // Expected: error message includes an excerpt of the actual response body text.
  it('m-22: throwTypedError includes body excerpt for non-JSON 502', async () => {
    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        return new Response('Bad Gateway: upstream service unavailable', {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    try {
      await client.getSession('any-id')
      expect.unreachable('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      // Current behavior: generic "HRC request failed with status 502"
      // Required: message must include excerpt from the response body
      expect(msg).toContain('502')
      expect(msg).toMatch(/Bad Gateway/i)
    }
  })

  // -- m-19: SendInFlightInputRequest.prompt should be required --
  // Current type: prompt is optional. Server requires it.
  // This test validates runtime behavior: sendInFlightInput with prompt provided
  // should send the prompt field. The type change (making prompt required) is
  // validated at compile time by Curly's implementation.
  it('m-19: sendInFlightInput sends prompt field to server', async () => {
    let capturedBody: any
    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/v1/in-flight-input') {
          capturedBody = await req.json()
          return Response.json({ accepted: true, runtimeId: 'rt-1', runId: 'run-1' })
        }
        return new Response('Not found', { status: 404 })
      },
    })

    const client = new HrcClient(stubSocketPath)
    // prompt is required; the deprecated top-level `input` field has been dropped
    // from both the type and the client payload (T-04727 SDK contraction).
    await client.sendInFlightInput({
      runtimeId: 'rt-1',
      runId: 'run-1',
      prompt: 'Continue with analysis',
    })

    expect(capturedBody).toBeDefined()
    expect(capturedBody.prompt).toBe('Continue with analysis')
    // Payload must contain ONLY the canonical fields — no legacy `input`.
    expect(capturedBody.input).toBeUndefined()
    expect(Object.keys(capturedBody).sort()).toEqual(['prompt', 'runId', 'runtimeId'])
  })

  // -- m-19b: inputType is forwarded when provided (and still no `input`) --
  it('m-19: sendInFlightInput forwards inputType and never emits legacy input', async () => {
    let capturedBody: any
    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/v1/in-flight-input') {
          capturedBody = await req.json()
          return Response.json({ accepted: true, runtimeId: 'rt-1', runId: 'run-1' })
        }
        return new Response('Not found', { status: 404 })
      },
    })

    const client = new HrcClient(stubSocketPath)
    await client.sendInFlightInput({
      runtimeId: 'rt-1',
      runId: 'run-1',
      prompt: 'Continue with analysis',
      inputType: 'text',
    })

    expect(capturedBody).toBeDefined()
    expect(capturedBody.input).toBeUndefined()
    expect(Object.keys(capturedBody).sort()).toEqual(['inputType', 'prompt', 'runId', 'runtimeId'])
  })

  it('semanticTurnHandoff posts to the handoff endpoint and returns watch filters', async () => {
    let capturedBody: any
    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/v1/messages/turn-handoff') {
          capturedBody = await req.json()
          return Response.json({
            messageId: 'msg-1',
            sessionRef: 'agent:cody:project:agent-spaces/lane:main',
            scopeRef: 'agent:cody:project:agent-spaces',
            laneRef: 'default',
            hostSessionId: 'hsid-1',
            runtimeId: 'rt-1',
            runId: 'run-1',
            generation: 1,
            fromSeq: 42,
          })
        }
        return new Response('Not found', { status: 404 })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const response = await client.semanticTurnHandoff({
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:cody:project:agent-spaces/lane:main' },
      body: 'handoff body',
    })

    expect(capturedBody.body).toBe('handoff body')
    expect(response).toEqual({
      messageId: 'msg-1',
      sessionRef: 'agent:cody:project:agent-spaces/lane:main',
      scopeRef: 'agent:cody:project:agent-spaces',
      laneRef: 'default',
      hostSessionId: 'hsid-1',
      runtimeId: 'rt-1',
      runId: 'run-1',
      generation: 1,
      fromSeq: 42,
    })
  })

  it('freezes the four submission DTOs as four class-named SDK methods', async () => {
    const observed: Array<{ path: string; body: Record<string, unknown> }> = []
    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        const url = new URL(req.url)
        observed.push({ path: url.pathname, body: (await req.json()) as Record<string, unknown> })
        return Response.json({ submissionId: `sub-${observed.length}`, admission: 'admitted' })
      },
    })
    const client = new HrcClient(stubSocketPath)
    const common = {
      target: 'agent:cody:project:hrc-runtime:task:T-07867/lane:main',
      body: 'ship it',
      origin: { principalRef: 'agent:cody' },
    }
    await client.steer(common)
    await client.enqueue({ ...common, ttlMs: 5_000, turnPolicy: 'guarded', wait: true })
    await client.invoke({ ...common, turnPolicy: 'guarded', wait: true })
    await client.preempt({ ...common, ttlMs: 5_000, turnPolicy: 'guarded', wait: true })

    expect(observed.map((entry) => entry.path)).toEqual([
      '/v1/submissions/steer',
      '/v1/submissions/enqueue',
      '/v1/submissions/invoke',
      '/v1/submissions/preempt',
    ])
    expect(Object.keys(observed[0]?.body ?? {}).sort()).toEqual(['body', 'origin', 'target'].sort())
    expect(observed.slice(1).every((entry) => entry.body.turnPolicy === 'guarded')).toBe(true)
  })
})
