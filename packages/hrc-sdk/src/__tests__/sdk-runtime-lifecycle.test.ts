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

import type { HrcTargetView } from 'hrc-core'

// RED GATE: These imports will fail until Curly implements the sdk module
import { HrcClient } from '../index'

// ---------------------------------------------------------------------------
// 1. discoverSocket() — socket discovery
// ---------------------------------------------------------------------------
describe('runtime lifecycle client methods', () => {
  let tmpDir: string
  let stubSocketPath: string
  let stubServer: ReturnType<typeof Bun.serve> | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-lifecycle-'))
    stubSocketPath = join(tmpDir, 'lifecycle.sock')
  })

  afterEach(async () => {
    if (stubServer) {
      stubServer.stop(true)
      stubServer = undefined
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('listRuntimes transparently drains bounded runtime pages', async () => {
    const capturedQueries: string[] = []

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        const url = new URL(req.url)
        capturedQueries.push(url.search)
        if (url.searchParams.get('cursor') === null) {
          return Response.json([{ runtimeId: 'rt-page-1' }], {
            headers: { 'x-hrc-next-cursor': 'cursor-2' },
          })
        }
        return Response.json([{ runtimeId: 'rt-page-2' }])
      },
    })

    const client = new HrcClient(stubSocketPath)
    const runtimes = await client.listRuntimes({ all: true })

    expect(runtimes.map((runtime) => runtime.runtimeId)).toEqual(['rt-page-1', 'rt-page-2'])
    expect(capturedQueries).toEqual(['?all=true&limit=500', '?all=true&limit=500&cursor=cursor-2'])
  })

  it('listRuntimesPage preserves the array wire shape and returns cursor metadata', async () => {
    let capturedQuery = ''

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        capturedQuery = new URL(req.url).search
        return Response.json([{ runtimeId: 'rt-one-page' }], {
          headers: { 'x-hrc-next-cursor': 'cursor-next' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const page = await client.listRuntimesPage({ all: true, limit: 1 })

    expect(page.runtimes.map((runtime) => runtime.runtimeId)).toEqual(['rt-one-page'])
    expect(page.nextCursor).toBe('cursor-next')
    expect(capturedQuery).toBe('?all=true&limit=1')
  })

  it('startRuntime posts to /v1/runtimes/start and returns the typed response', async () => {
    let capturedPath = ''
    let capturedBody: unknown

    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        capturedPath = new URL(req.url).pathname
        capturedBody = await req.json()
        return Response.json({
          runtimeId: 'rt-start-1',
          hostSessionId: 'hsid-start-1',
          transport: 'tmux',
          status: 'ready',
          supportsInFlightInput: false,
          tmux: {
            sessionId: '$1',
            windowId: '@1',
            paneId: '%1',
          },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const result = await (client as any).startRuntime({
      hostSessionId: 'hsid-start-1',
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: {
          provider: 'openai',
          interactive: true,
        },
        execution: {
          preferredMode: 'headless',
        },
      },
    })

    expect(capturedPath).toBe('/v1/runtimes/start')
    expect(capturedBody).toEqual({
      hostSessionId: 'hsid-start-1',
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: {
          provider: 'openai',
          interactive: true,
        },
        execution: {
          preferredMode: 'headless',
        },
      },
    })
    expect(result.runtimeId).toBe('rt-start-1')
    expect(result.transport).toBe('tmux')
  })

  it('attachRuntime posts to /v1/runtimes/attach and returns the attach descriptor', async () => {
    let capturedPath = ''
    let capturedBody: unknown

    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        capturedPath = new URL(req.url).pathname
        capturedBody = await req.json()
        return Response.json({
          transport: 'tmux',
          argv: ['tmux', 'attach', '-t', 'hrc-demo'],
          bindingFence: {
            hostSessionId: 'hsid-attach-1',
            runtimeId: 'rt-attach-1',
            generation: 1,
            windowId: '@1',
            paneId: '%1',
          },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const result = await (client as any).attachRuntime({
      runtimeId: 'rt-attach-1',
    })

    expect(capturedPath).toBe('/v1/runtimes/attach')
    expect(capturedBody).toEqual({ runtimeId: 'rt-attach-1' })
    expect(result.bindingFence.runtimeId).toBe('rt-attach-1')
    expect(result.argv).toEqual(['tmux', 'attach', '-t', 'hrc-demo'])
  })

  it('forwards run ownership on interrupt and terminate cleanup', async () => {
    const captured: Array<{ path: string; body: unknown }> = []
    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        captured.push({ path: new URL(req.url).pathname, body: await req.json() })
        return Response.json({
          ok: true,
          hostSessionId: 'hsid-owner-1',
          runtimeId: 'rt-owner-1',
          droppedContinuation: false,
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    await client.interrupt('rt-owner-1', { ownerRunId: 'run-owner-1' })
    await client.terminate('rt-owner-1', {
      ownerRunId: 'run-owner-1',
      source: 'agent-loop',
    })

    expect(captured).toEqual([
      {
        path: '/v1/interrupt',
        body: { runtimeId: 'rt-owner-1', ownerRunId: 'run-owner-1' },
      },
      {
        path: '/v1/terminate',
        body: {
          runtimeId: 'rt-owner-1',
          ownerRunId: 'run-owner-1',
          source: 'agent-loop',
        },
      },
    ])
  })

  it('listRuns sends filters to /v1/runs and returns run lifecycle rows', async () => {
    let capturedPath = ''
    let capturedQuery = ''

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        const url = new URL(req.url)
        capturedPath = url.pathname
        capturedQuery = url.searchParams.toString()
        return Response.json([
          {
            runId: 'run-list-1',
            hostSessionId: 'hsid-list-1',
            runtimeId: 'rt-list-1',
            scopeRef: 'agent:test:project:hrc-sdk',
            laneRef: 'default',
            generation: 3,
            transport: 'tmux',
            status: 'running',
            acceptedAt: '2026-05-18T12:00:00.000Z',
            startedAt: '2026-05-18T12:00:01.000Z',
            updatedAt: '2026-05-18T12:00:02.000Z',
          },
        ])
      },
    })

    const client = new HrcClient(stubSocketPath)
    const result = await client.listRuns({
      hostSessionId: 'hsid-list-1',
      generation: 3,
      runtimeId: 'rt-list-1',
      limit: 1,
    })

    expect(capturedPath).toBe('/v1/runs')
    expect(capturedQuery).toBe('hostSessionId=hsid-list-1&generation=3&runtimeId=rt-list-1&limit=1')
    expect(result[0].runId).toBe('run-list-1')
    expect(result[0].status).toBe('running')
    expect(result[0].acceptedAt).toBe('2026-05-18T12:00:00.000Z')
    expect(result[0].startedAt).toBe('2026-05-18T12:00:01.000Z')
    expect(result[0].updatedAt).toBe('2026-05-18T12:00:02.000Z')
  })

  it('listRuns serializes the T-05010 enrichment filters to /v1/runs', async () => {
    let capturedPath = ''
    let capturedParams: URLSearchParams | undefined

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        const url = new URL(req.url)
        capturedPath = url.pathname
        capturedParams = url.searchParams
        return Response.json([
          {
            runId: 'run-enrich-1',
            hostSessionId: 'hsid-enrich-1',
            runtimeId: 'rt-enrich-1',
            scopeRef: 'agent:clod:project:hrc-runtime:task:T-05010',
            laneRef: 'main',
            generation: 1,
            transport: 'tmux',
            status: 'running',
            updatedAt: '2026-06-21T10:00:00.000Z',
          },
        ])
      },
    })

    const client = new HrcClient(stubSocketPath)
    const result = await client.listRuns({
      runId: 'run-enrich-1',
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-05010',
      laneRef: 'main',
      status: ['running', 'completed'],
      limit: 5,
    })

    expect(capturedPath).toBe('/v1/runs')
    expect(capturedParams?.get('runId')).toBe('run-enrich-1')
    expect(capturedParams?.get('scopeRef')).toBe('agent:clod:project:hrc-runtime:task:T-05010')
    expect(capturedParams?.get('laneRef')).toBe('main')
    // status arrays serialize as a single comma-joined param.
    expect(capturedParams?.get('status')).toBe('running,completed')
    expect(capturedParams?.get('limit')).toBe('5')
    expect(result[0].runId).toBe('run-enrich-1')
    expect(result[0].laneRef).toBe('main')
  })

  it('getRun wraps listRuns({ runId, limit: 1 }) and returns the single run or null', async () => {
    let capturedPath = ''
    let capturedParams: URLSearchParams | undefined
    let respondEmpty = false

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        const url = new URL(req.url)
        capturedPath = url.pathname
        capturedParams = url.searchParams
        if (respondEmpty) {
          return Response.json([])
        }
        return Response.json([
          {
            runId: 'run-getrun-1',
            hostSessionId: 'hsid-getrun-1',
            scopeRef: 'agent:clod:project:hrc-runtime',
            laneRef: 'main',
            generation: 1,
            transport: 'tmux',
            status: 'completed',
            updatedAt: '2026-06-21T10:00:00.000Z',
          },
        ])
      },
    })

    const client = new HrcClient(stubSocketPath)
    const found = await client.getRun('run-getrun-1')

    expect(capturedPath).toBe('/v1/runs')
    expect(capturedParams?.get('runId')).toBe('run-getrun-1')
    expect(capturedParams?.get('limit')).toBe('1')
    expect(found?.runId).toBe('run-getrun-1')

    respondEmpty = true
    expect(await client.getRun('missing-run')).toBeNull()
  })

  it('getStatus preserves includeArchived as a true-or-absent query flag', async () => {
    const capturedQueries: string[] = []

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        const url = new URL(req.url)
        capturedQueries.push(url.searchParams.toString())
        return Response.json({ ok: true })
      },
    })

    const client = new HrcClient(stubSocketPath)

    await client.getStatus()
    await client.getStatus({ includeArchived: false })
    await client.getStatus({ includeArchived: true })

    expect(capturedQueries).toEqual(['', '', 'includeArchived=true'])
  })

  it('listTargets preserves discover/includeDormant as true-or-absent query flags', async () => {
    const capturedQueries: string[] = []

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        const url = new URL(req.url)
        capturedQueries.push(url.searchParams.toString())
        return Response.json([])
      },
    })

    const client = new HrcClient(stubSocketPath)

    await client.listTargets({ projectId: 'project-a', lane: 'main' })
    await client.listTargets({ projectId: 'project-a', lane: 'main', discover: false })
    await client.listTargets({ projectId: 'project-a', lane: 'main', discover: true })
    await client.listTargets({ projectId: 'project-a', lane: 'main', includeDormant: true })

    expect(capturedQueries).toEqual([
      'projectId=project-a&lane=main',
      'projectId=project-a&lane=main',
      'projectId=project-a&lane=main&discover=true',
      'projectId=project-a&lane=main&includeDormant=true',
    ])
  })

  it('listTargets preserves producer-exposed ambiguity candidates', async () => {
    const target: HrcTargetView = {
      sessionRef: 'agent:cody:project:hrc-runtime:task:T-05460/lane:main',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-05460',
      laneRef: 'main',
      state: 'bound',
      activeHostSessionId: 'hsid-newer',
      generation: 2,
      runtime: {
        runtimeId: 'rt-newer',
        transport: 'tmux',
        status: 'ready',
        supportsLiteralSend: true,
        supportsCapture: true,
        operatorAttachable: true,
      },
      ambiguityCandidates: [
        {
          sessionRef: 'agent:cody:project:hrc-runtime:task:T-05460/lane:main',
          scopeRef: 'agent:cody:project:hrc-runtime:task:T-05460',
          laneRef: 'main',
          state: 'bound',
          activeHostSessionId: 'hsid-older',
          generation: 1,
          runtime: {
            runtimeId: 'rt-older',
            transport: 'tmux',
            status: 'ready',
            supportsLiteralSend: true,
            supportsCapture: true,
            operatorAttachable: true,
          },
        },
      ],
      capabilities: {
        state: 'bound',
        modesSupported: ['headless'],
        defaultMode: 'headless',
        dmReady: true,
        sendReady: true,
        peekReady: true,
      },
    }

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        return Response.json([target])
      },
    })

    const client = new HrcClient(stubSocketPath)
    const targets = await client.listTargets()

    expect(targets[0]?.ambiguityCandidates?.[0]?.runtime?.runtimeId).toBe('rt-older')
  })
})

// Error parsing tests use a minimal HTTP server that returns known error shapes
