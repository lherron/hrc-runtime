/**
 * RED/GREEN tests for hrc-sdk managed app-session and command-session methods (T-01004 / Phase 4)
 *
 * Tests the hrc-sdk typed client surface for app-session lifecycle:
 *   - ensureAppSession() — POST /v1/app-sessions/ensure
 *   - listAppSessions() — GET /v1/app-sessions
 *   - getAppSessionByKey() — GET /v1/app-sessions/by-key
 *   - removeAppSession() — POST /v1/app-sessions/remove
 *   - applyManagedAppSessions() — POST /v1/app-sessions/apply
 *   - sendLiteralInput() — POST /v1/app-sessions/literal-input
 *   - captureAppSession() — GET /v1/app-sessions/capture
 *   - attachAppSession() — GET /v1/app-sessions/attach
 *   - interruptAppSession() — POST /v1/app-sessions/interrupt
 *   - terminateAppSession() — POST /v1/app-sessions/terminate
 *
 * Pass conditions for Curly (T-01004):
 *   1.  ensureAppSession() exists and sends POST to correct endpoint
 *   2.  listAppSessions() exists and sends GET with appId query param
 *   3.  getAppSessionByKey() exists and sends GET with appId + appSessionKey
 *   4.  removeAppSession() exists and sends POST to correct endpoint
 *   5.  applyManagedAppSessions() exists and sends POST to correct endpoint
 *   6.  sendLiteralInput() exists and sends POST to /v1/app-sessions/literal-input
 *   7.  captureAppSession() exists and sends GET to /v1/app-sessions/capture
 *   8.  attachAppSession() exists and sends GET to /v1/app-sessions/attach
 *   9.  interruptAppSession() exists and sends POST to /v1/app-sessions/interrupt
 *  10.  terminateAppSession() exists and sends POST to /v1/app-sessions/terminate
 *
 * Test strategy:
 *   - Uses a stub Bun.serve on a unix socket to verify the SDK calls the
 *     correct HTTP method, path, and query params for each operation.
 *   - No real hrc-server needed; this tests the SDK client layer in isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcClient } from '../index'
import type {
  ApplyAppManagedSessionsResponse,
  EnsureAppSessionResponse,
  RemoveAppSessionResponse,
} from '../index'

import type { HrcManagedSessionRecord } from 'hrc-core'

// ---------------------------------------------------------------------------
// Stub server that captures requests and returns canned responses
// ---------------------------------------------------------------------------

type CapturedRequest = {
  method: string
  pathname: string
  search: string
  body: unknown | null
}

let tmpDir: string
let stubSocketPath: string
let stubServer: ReturnType<typeof Bun.serve> | undefined
let lastRequest: CapturedRequest

function makeStubResponse(pathname: string): Response {
  // Return realistic stubs based on the endpoint
  const managedSession: HrcManagedSessionRecord = {
    appId: 'test-app',
    appSessionKey: 'test-key',
    kind: 'command',
    activeHostSessionId: 'hsid-stub',
    generation: 1,
    status: 'active',
    createdAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
  }

  if (pathname === '/v1/app-sessions/ensure') {
    return Response.json({
      session: managedSession,
      created: true,
      restarted: false,
      status: 'created',
      runtimeId: 'rt-stub',
    } satisfies EnsureAppSessionResponse)
  }

  if (pathname === '/v1/app-sessions') {
    return Response.json([managedSession])
  }

  if (pathname === '/v1/app-sessions/by-key') {
    return Response.json(managedSession)
  }

  if (pathname === '/v1/app-sessions/remove') {
    return Response.json({
      removed: true,
      runtimeTerminated: true,
      bridgesClosed: 0,
      surfacesUnbound: 0,
    } satisfies RemoveAppSessionResponse)
  }

  if (pathname === '/v1/app-sessions/apply') {
    return Response.json({
      ensured: 1,
      removed: 0,
      results: [],
    } satisfies ApplyAppManagedSessionsResponse)
  }

  if (pathname === '/v1/app-sessions/literal-input') {
    return Response.json({ delivered: true })
  }

  if (pathname === '/v1/app-sessions/capture') {
    return Response.json({ text: 'captured output' })
  }

  if (pathname === '/v1/app-sessions/attach') {
    return Response.json({
      transport: 'tmux',
      argv: ['tmux', '-S', '/tmp/test.sock', 'attach-session', '-t', 'test'],
      bindingFence: {
        hostSessionId: 'hsid-stub',
        runtimeId: 'rt-stub',
        generation: 1,
      },
    })
  }

  if (pathname === '/v1/app-sessions/interrupt') {
    return Response.json({ ok: true, hostSessionId: 'hsid-stub', runtimeId: 'rt-stub' })
  }

  if (pathname === '/v1/app-sessions/terminate') {
    return Response.json({ ok: true, hostSessionId: 'hsid-stub', runtimeId: 'rt-stub' })
  }

  // -- Phase 5 stubs ----------------------------------------------------------

  if (pathname === '/v1/app-sessions/turns') {
    return Response.json({
      runId: 'run-stub',
      hostSessionId: 'hsid-stub',
      generation: 1,
      runtimeId: 'rt-stub',
      transport: 'sdk',
      status: 'started',
      supportsInFlightInput: true,
    })
  }

  if (pathname === '/v1/app-sessions/in-flight-input') {
    return Response.json({
      accepted: true,
      hostSessionId: 'hsid-stub',
      runtimeId: 'rt-stub',
      runId: 'run-123',
    })
  }

  if (pathname === '/v1/app-sessions/clear-context') {
    return Response.json({
      hostSessionId: 'hsid-new',
      generation: 2,
      priorHostSessionId: 'hsid-stub',
    })
  }

  return new Response('Not Found', { status: 404 })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-appsess-'))
  stubSocketPath = join(tmpDir, 'stub.sock')
  lastRequest = { method: '', pathname: '', search: '', body: null }

  stubServer = Bun.serve({
    unix: stubSocketPath,
    async fetch(req) {
      const url = new URL(req.url)
      let body: unknown = null
      if (req.method === 'POST') {
        try {
          body = await req.json()
        } catch {
          // no body
        }
      }
      lastRequest = {
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        body,
      }
      return makeStubResponse(url.pathname)
    },
  })
})

afterEach(async () => {
  if (stubServer) {
    stubServer.stop(true)
    stubServer = undefined
  }
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. ensureAppSession
// ---------------------------------------------------------------------------
describe('ensureAppSession()', () => {
  it('exists as a method and calls POST /v1/app-sessions/ensure', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: ensureAppSession method does not exist on HrcClient
    const result = await client.ensureAppSession({
      selector: { appId: 'test-app', appSessionKey: 'test-key' },
      spec: {
        kind: 'command',
        command: { argv: ['/bin/cat'] },
      },
    })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/ensure')
    expect(result.session.appId).toBe('test-app')
    expect(result.created).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. listAppSessions
// ---------------------------------------------------------------------------
describe('listAppSessions()', () => {
  it('exists as a method and calls GET /v1/app-sessions with appId', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: listAppSessions method does not exist on HrcClient
    const result = await client.listAppSessions({ appId: 'test-app' })

    expect(lastRequest.method).toBe('GET')
    expect(lastRequest.pathname).toBe('/v1/app-sessions')
    expect(lastRequest.search).toContain('appId=test-app')
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(1)
  })

  it('passes kind filter as query param', async () => {
    const client = new HrcClient(stubSocketPath)

    await client.listAppSessions({ appId: 'test-app', kind: 'command' })

    expect(lastRequest.search).toContain('kind=command')
  })
})

// ---------------------------------------------------------------------------
// 3. getAppSessionByKey
// ---------------------------------------------------------------------------
describe('getAppSessionByKey()', () => {
  it('exists as a method and calls GET /v1/app-sessions/by-key', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: getAppSessionByKey method does not exist on HrcClient
    const result = await client.getAppSessionByKey('test-app', 'test-key')

    expect(lastRequest.method).toBe('GET')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/by-key')
    expect(lastRequest.search).toContain('appId=test-app')
    expect(lastRequest.search).toContain('appSessionKey=test-key')
    expect(result.appId).toBe('test-app')
  })
})

// ---------------------------------------------------------------------------
// 4. removeAppSession
// ---------------------------------------------------------------------------
describe('removeAppSession()', () => {
  it('exists as a method and calls POST /v1/app-sessions/remove', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: removeAppSession method does not exist on HrcClient
    const result = await client.removeAppSession({
      selector: { appId: 'test-app', appSessionKey: 'test-key' },
    })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/remove')
    expect(result.removed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. applyManagedAppSessions
// ---------------------------------------------------------------------------
describe('applyManagedAppSessions()', () => {
  it('exists as a method and calls POST /v1/app-sessions/apply', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: applyManagedAppSessions method does not exist on HrcClient
    const result = await client.applyManagedAppSessions({
      appId: 'test-app',
      sessions: [
        {
          appSessionKey: 'sess-1',
          spec: { kind: 'command', command: { argv: ['/bin/sh'] } },
        },
      ],
    })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/apply')
    expect(result.ensured).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 6. sendLiteralInput
// ---------------------------------------------------------------------------
describe('sendLiteralInput()', () => {
  it('exists as a method and calls POST /v1/app-sessions/literal-input', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: sendLiteralInput method does not exist on HrcClient
    const result = await client.sendLiteralInput({
      selector: { appId: 'test-app', appSessionKey: 'test-key' },
      text: 'hello world',
      enter: true,
    })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/literal-input')
    const sentBody = lastRequest.body as Record<string, unknown>
    expect(sentBody.text).toBe('hello world')
    expect(sentBody.enter).toBe(true)
    expect(result.delivered).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. captureAppSession
// ---------------------------------------------------------------------------
describe('captureAppSession()', () => {
  it('exists as a method and calls GET /v1/app-sessions/capture', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: captureAppSession method does not exist on HrcClient
    const result = await client.captureAppSession({
      appId: 'test-app',
      appSessionKey: 'test-key',
    })

    expect(lastRequest.method).toBe('GET')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/capture')
    expect(lastRequest.search).toContain('appId=test-app')
    expect(lastRequest.search).toContain('appSessionKey=test-key')
    expect(result.text).toBe('captured output')
  })
})

// ---------------------------------------------------------------------------
// 8. attachAppSession
// ---------------------------------------------------------------------------
describe('attachAppSession()', () => {
  it('exists as a method and calls GET /v1/app-sessions/attach', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: attachAppSession method does not exist on HrcClient
    const result = await client.attachAppSession({
      appId: 'test-app',
      appSessionKey: 'test-key',
    })

    expect(lastRequest.method).toBe('GET')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/attach')
    expect(lastRequest.search).toContain('appId=test-app')
    expect(lastRequest.search).toContain('appSessionKey=test-key')
    expect(result.transport).toBe('tmux')
  })
})

// ---------------------------------------------------------------------------
// 9. interruptAppSession
// ---------------------------------------------------------------------------
describe('interruptAppSession()', () => {
  it('exists as a method and calls POST /v1/app-sessions/interrupt', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: interruptAppSession method does not exist on HrcClient
    const result = await client.interruptAppSession({
      selector: { appId: 'test-app', appSessionKey: 'test-key' },
    })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/interrupt')
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 10. terminateAppSession
// ---------------------------------------------------------------------------
describe('terminateAppSession()', () => {
  it('exists as a method and calls POST /v1/app-sessions/terminate', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: terminateAppSession method does not exist on HrcClient
    const result = await client.terminateAppSession({
      selector: { appId: 'test-app', appSessionKey: 'test-key' },
    })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/terminate')
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// Phase 5 — App-owned harness dispatch, in-flight input, clear-context
// (T-01005)
//
// RED GATE: These 3 SDK methods do not exist on HrcClient yet.
// Pass conditions for Curly (T-01005):
//   11. dispatchAppHarnessTurn() exists and sends POST to /v1/app-sessions/turns
//   12. sendAppHarnessInFlightInput() exists and sends POST to /v1/app-sessions/in-flight-input
//   13. clearAppSessionContext() exists and sends POST to /v1/app-sessions/clear-context
// ===========================================================================

// ---------------------------------------------------------------------------
// 11. dispatchAppHarnessTurn
// ---------------------------------------------------------------------------
describe('dispatchAppHarnessTurn()', () => {
  it('exists as a method and calls POST /v1/app-sessions/turns', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: dispatchAppHarnessTurn method does not exist on HrcClient
    const result = await client.dispatchAppHarnessTurn({
      selector: { appId: 'test-app', appSessionKey: 'test-key' },
      prompt: 'List files in the current directory',
    })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/turns')
    const sentBody = lastRequest.body as Record<string, unknown>
    expect(sentBody.prompt).toBe('List files in the current directory')
    expect((sentBody.selector as Record<string, unknown>).appId).toBe('test-app')
    expect(result.runId).toBe('run-stub')
    expect(result.hostSessionId).toBe('hsid-stub')
    expect(result.generation).toBe(1)
    expect(result.runtimeId).toBe('rt-stub')
    expect(result.transport).toBe('sdk')
    expect(result.supportsInFlightInput).toBe(true)
  })

  it('passes optional fences in request body', async () => {
    const client = new HrcClient(stubSocketPath)

    await client.dispatchAppHarnessTurn({
      selector: { appId: 'test-app', appSessionKey: 'test-key' },
      prompt: 'test with fences',
      fences: {
        expectedHostSessionId: 'hsid-expected',
        expectedGeneration: 2,
      },
    })

    const sentBody = lastRequest.body as Record<string, unknown>
    const fences = sentBody.fences as Record<string, unknown>
    expect(fences.expectedHostSessionId).toBe('hsid-expected')
    expect(fences.expectedGeneration).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 12. sendAppHarnessInFlightInput
// ---------------------------------------------------------------------------
describe('sendAppHarnessInFlightInput()', () => {
  it('exists as a method and calls POST /v1/app-sessions/in-flight-input', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: sendAppHarnessInFlightInput method does not exist on HrcClient
    const result = await client.sendAppHarnessInFlightInput({
      selector: { appId: 'test-app', appSessionKey: 'test-key' },
      prompt: 'Also install the dev dependencies',
      runId: 'run-123',
    })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/in-flight-input')
    const sentBody = lastRequest.body as Record<string, unknown>
    expect(sentBody.prompt).toBe('Also install the dev dependencies')
    expect(sentBody.runId).toBe('run-123')
    expect(result.accepted).toBe(true)
    expect(result.hostSessionId).toBe('hsid-stub')
    expect(result.runtimeId).toBe('rt-stub')
    expect(result.runId).toBe('run-123')
  })

  it('passes optional inputType in request body', async () => {
    const client = new HrcClient(stubSocketPath)

    await client.sendAppHarnessInFlightInput({
      selector: { appId: 'test-app', appSessionKey: 'test-key' },
      prompt: 'correction input',
      runId: 'run-456',
      inputType: 'correction',
    })

    const sentBody = lastRequest.body as Record<string, unknown>
    expect(sentBody.inputType).toBe('correction')
  })
})

// ---------------------------------------------------------------------------
// 13. clearAppSessionContext
// ---------------------------------------------------------------------------
describe('clearAppSessionContext()', () => {
  it('exists as a method and calls POST /v1/app-sessions/clear-context', async () => {
    const client = new HrcClient(stubSocketPath)

    // RED GATE: clearAppSessionContext method does not exist on HrcClient
    const result = await client.clearAppSessionContext({
      selector: { appId: 'test-app', appSessionKey: 'test-key' },
    })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/app-sessions/clear-context')
    expect(result.hostSessionId).toBe('hsid-new')
    expect(result.generation).toBe(2)
    expect(result.priorHostSessionId).toBe('hsid-stub')
  })

  it('passes relaunch flag in request body', async () => {
    const client = new HrcClient(stubSocketPath)

    await client.clearAppSessionContext({
      selector: { appId: 'test-app', appSessionKey: 'test-key' },
      relaunch: true,
    })

    const sentBody = lastRequest.body as Record<string, unknown>
    expect(sentBody.relaunch).toBe(true)
  })
})
