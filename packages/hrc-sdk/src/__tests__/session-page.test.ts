import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcClient } from '../index.js'

describe('session page SDK methods', () => {
  let tmpDir: string
  let socketPath: string
  let server: ReturnType<typeof Bun.serve> | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-session-page-'))
    socketPath = join(tmpDir, 'sdk.sock')
  })

  afterEach(async () => {
    server?.stop(true)
    server = undefined
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('listSessionsPage preserves the opaque cursor and additive filters', async () => {
    let observed: URL | undefined
    server = Bun.serve({
      unix: socketPath,
      fetch(request) {
        observed = new URL(request.url)
        return Response.json({
          items: [],
          eventHighWater: { lab: 12, svc: 34 },
          complete: true,
          peerStatus: {},
        })
      },
    })
    const client = new HrcClient(socketPath)
    const response = await client.listSessionsPage({
      limit: 50,
      cursor: 'opaque+/cursor=',
      q: 'task:T-07221',
      agentId: 'cody',
      projectId: 'hrc-runtime',
      laneRef: 'main',
      effectiveStatus: 'active',
      executionMode: 'interactive',
      nodes: 'lab,svc',
    })
    expect(observed?.pathname).toBe('/v1/sessions/page')
    expect(response.eventHighWater).toEqual({ lab: 12, svc: 34 })
    expect(Object.fromEntries(observed?.searchParams ?? [])).toEqual({
      limit: '50',
      cursor: 'opaque+/cursor=',
      q: 'task:T-07221',
      agentId: 'cody',
      projectId: 'hrc-runtime',
      laneRef: 'main',
      effectiveStatus: 'active',
      executionMode: 'interactive',
      nodes: 'lab,svc',
    })
  })

  test('getSessionFacets sends no pagination fields and returns count maps', async () => {
    let observed: URL | undefined
    server = Bun.serve({
      unix: socketPath,
      fetch(request) {
        observed = new URL(request.url)
        return Response.json({
          total: 3,
          byEffectiveStatus: { active: 3 },
          byExecutionMode: { interactive: 2, headless: 1 },
          byAgentId: { cody: 3 },
          byNodeId: { svc: 3 },
          complete: true,
          peerStatus: {},
        })
      },
    })
    const client = new HrcClient(socketPath)
    const facets = await client.getSessionFacets({ nodes: 'svc', agentId: 'cody' })
    expect(observed?.pathname).toBe('/v1/sessions/facets')
    expect(Object.fromEntries(observed?.searchParams ?? [])).toEqual({
      agentId: 'cody',
      nodes: 'svc',
    })
    expect(facets.total).toBe(3)
    expect(facets.byNodeId).toEqual({ svc: 3 })
  })
})
