import { describe, expect, test } from 'bun:test'

import { createPeerProtocolRequestHandler } from '../federation/peer-protocol.js'
import { PeerToken } from '../federation/peer-token.js'

const TOKEN = 'svc-lab-token'

function handler() {
  return createPeerProtocolRequestHandler({
    localNodeId: 'lab',
    peers: new Map([
      [
        'svc',
        { nodeId: 'svc', endpoint: 'http://svc.example.ts.net:18490', token: new PeerToken(TOKEN) },
      ],
    ]),
    locate: async (scopeRef) => ({ scopeRef, localNodeId: 'lab' }),
    health: () => ({
      startedAt: '2026-09-01T07:00:00.000Z',
      capabilities: { locate: true, health: true },
    }),
  })
}

function request(path: string, headers: HeadersInit = {}): Request {
  return new Request(`http://lab.example.ts.net:18490${path}`, { headers })
}

describe('federation v1.3 peer authentication without protocol negotiation', () => {
  test('bearer authentication remains mandatory', async () => {
    const response = await handler()(request('/v1/federation/health'))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  })

  test('an authenticated request needs no version header and returns no version fields', async () => {
    const response = await handler()(
      request('/v1/federation/health', {
        authorization: `Bearer ${TOKEN}`,
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('x-hrc-peer-protocol-version')).toBeNull()
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, nodeId: 'lab' })
    expect(body['protocolVersion']).toBeUndefined()
  })

  test('legacy version headers are inert rather than negotiated', async () => {
    const response = await handler()(
      request('/v1/federation/health', {
        authorization: `Bearer ${TOKEN}`,
        'x-hrc-peer-protocol-version': '999.0',
      })
    )
    expect(response.status).toBe(200)
  })
})
