/**
 * RED/GREEN tests for SDK bridge method coverage (T-01006 / Phase 6)
 *
 * These tests verify that the Phase 2 canonical bridge SDK methods
 * (acquireBridgeTarget, deliverBridgeText) call the correct endpoints
 * and pass through request/response shapes.
 *
 * Also tests closeBridge event emission and listBridges filtering.
 *
 * Pass conditions:
 *   P6-SDK-1. acquireBridgeTarget() calls POST /v1/bridges/target
 *   P6-SDK-2. deliverBridgeText() calls POST /v1/bridges/deliver-text
 *   P6-SDK-3. closeBridge() calls POST /v1/bridges/close
 *   P6-SDK-4. listBridges() calls GET /v1/bridges with runtimeId filter
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcClient } from '../index'

// ---------------------------------------------------------------------------
// Stub server
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
  if (pathname === '/v1/bridges/target') {
    return Response.json({
      bridgeId: 'bridge-stub',
      transport: 'tmux',
      target: 'test-pane',
      hostSessionId: 'hsid-stub',
      runtimeId: 'rt-stub',
      status: 'active',
      createdAt: '2026-04-03T00:00:00.000Z',
    })
  }

  if (pathname === '/v1/bridges/deliver-text') {
    return Response.json({
      delivered: true,
      bridgeId: 'bridge-stub',
    })
  }

  if (pathname === '/v1/bridges/close') {
    return Response.json({
      bridgeId: 'bridge-stub',
      transport: 'tmux',
      target: 'test-pane',
      hostSessionId: 'hsid-stub',
      runtimeId: 'rt-stub',
      status: 'closed',
      closedAt: '2026-04-03T00:01:00.000Z',
      createdAt: '2026-04-03T00:00:00.000Z',
    })
  }

  if (pathname === '/v1/bridges') {
    return Response.json([
      {
        bridgeId: 'bridge-1',
        transport: 'tmux',
        target: 'pane-1',
        hostSessionId: 'hsid-stub',
        runtimeId: 'rt-stub',
        status: 'active',
        createdAt: '2026-04-03T00:00:00.000Z',
      },
    ])
  }

  return new Response('Not Found', { status: 404 })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-bridge-'))
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
// P6-SDK-1. acquireBridgeTarget
// ---------------------------------------------------------------------------
describe('acquireBridgeTarget()', () => {
  it('calls POST /v1/bridges/target with selector and transport', async () => {
    const client = new HrcClient(stubSocketPath)

    const result = await client.acquireBridgeTarget({
      selector: {
        sessionRef: 'agent:rex:project:agent-spaces/lane:main',
      },
      transport: 'tmux',
      target: 'test-pane',
    })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/bridges/target')
    const sentBody = lastRequest.body as Record<string, unknown>
    const selector = sentBody.selector as Record<string, unknown>
    expect(selector.sessionRef).toBe('agent:rex:project:agent-spaces/lane:main')
    expect(sentBody.transport).toBe('tmux')
    expect(result.bridgeId).toBe('bridge-stub')
  })
})

// ---------------------------------------------------------------------------
// P6-SDK-2. deliverBridgeText
// ---------------------------------------------------------------------------
describe('deliverBridgeText()', () => {
  it('calls POST /v1/bridges/deliver-text with text and enter flag', async () => {
    const client = new HrcClient(stubSocketPath)

    const result = await client.deliverBridgeText({
      bridgeId: 'bridge-stub',
      text: 'Hello world',
      enter: true,
      expectedHostSessionId: 'hsid-stub',
      expectedGeneration: 1,
    })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/bridges/deliver-text')
    const sentBody = lastRequest.body as Record<string, unknown>
    expect(sentBody.bridgeId).toBe('bridge-stub')
    expect(sentBody.text).toBe('Hello world')
    expect(sentBody.enter).toBe(true)
    expect(sentBody.expectedHostSessionId).toBe('hsid-stub')
    expect(sentBody.expectedGeneration).toBe(1)
    expect(result.delivered).toBe(true)
  })

  it('passes oobSuffix in request body', async () => {
    const client = new HrcClient(stubSocketPath)

    await client.deliverBridgeText({
      bridgeId: 'bridge-stub',
      text: 'payload',
      oobSuffix: '__OOB',
      enter: false,
      expectedHostSessionId: 'hsid-stub',
      expectedGeneration: 1,
    })

    const sentBody = lastRequest.body as Record<string, unknown>
    expect(sentBody.oobSuffix).toBe('__OOB')
    expect(sentBody.enter).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P6-SDK-3. closeBridge
// ---------------------------------------------------------------------------
describe('closeBridge()', () => {
  it('calls POST /v1/bridges/close with bridgeId', async () => {
    const client = new HrcClient(stubSocketPath)

    const result = await client.closeBridge({ bridgeId: 'bridge-stub' })

    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.pathname).toBe('/v1/bridges/close')
    const sentBody = lastRequest.body as Record<string, unknown>
    expect(sentBody.bridgeId).toBe('bridge-stub')
    expect(result.bridgeId).toBe('bridge-stub')
    expect(result.closedAt).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// P6-SDK-4. listBridges
// ---------------------------------------------------------------------------
describe('listBridges()', () => {
  it('calls GET /v1/bridges with runtimeId filter', async () => {
    const client = new HrcClient(stubSocketPath)

    const result = await client.listBridges({ runtimeId: 'rt-stub' })

    expect(lastRequest.method).toBe('GET')
    expect(lastRequest.pathname).toBe('/v1/bridges')
    expect(lastRequest.search).toContain('runtimeId=rt-stub')
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(1)
    expect(result[0]!.bridgeId).toBe('bridge-1')
  })
})
