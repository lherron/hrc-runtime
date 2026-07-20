/**
 * T-06606 — peer token redaction (federation spec §6, day-one requirement).
 *
 * Tokens must never reach logs, errors, or event payloads. These tests pin the
 * structural guarantee: every stringification path yields `[REDACTED]`, while
 * receiving-side comparisons remain inside the token abstraction.
 */

import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'

import {
  resolveFederationConfig,
  summarizeFederationConfig,
} from '../federation/federation-config.js'
import { PeerToken, REDACTED_PEER_TOKEN } from '../federation/peer-token.js'
import { withFederationConfigFile } from './fixtures/federation-config-fixture.js'

const SECRET = 'super-secret-peer-token-do-not-leak'

describe('PeerToken redaction', () => {
  test('matches the secret without returning it', () => {
    const token = new PeerToken(SECRET)
    expect(token.matches(SECRET)).toBe(true)
    expect(token.matches(`${SECRET}-wrong`)).toBe(false)
  })

  test('template interpolation and concatenation redact', () => {
    const token = new PeerToken(SECRET)
    expect(`${token}`).toBe(REDACTED_PEER_TOKEN)
    expect(`bearer ${token}`).not.toContain(SECRET)
    expect(String(token)).toBe(REDACTED_PEER_TOKEN)
    expect(token.toString()).toBe(REDACTED_PEER_TOKEN)
  })

  test('JSON.stringify redacts (event payloads, HTTP bodies)', () => {
    const token = new PeerToken(SECRET)
    expect(JSON.stringify(token)).toBe(`"${REDACTED_PEER_TOKEN}"`)
    expect(JSON.stringify({ peer: { token } })).not.toContain(SECRET)
    expect(JSON.stringify([token, { nested: { token } }])).not.toContain(SECRET)
  })

  test('util.inspect / console.log formatting redacts', () => {
    const token = new PeerToken(SECRET)
    expect(inspect(token)).not.toContain(SECRET)
    expect(inspect({ deep: { token } }, { depth: 10 })).not.toContain(SECRET)
  })

  test('the secret is not an enumerable own property', () => {
    const token = new PeerToken(SECRET)
    expect(Object.keys(token)).toEqual([])
    expect(Object.values(token)).toEqual([])
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(token))).not.toContain(SECRET)
  })

  test('error messages built from a token do not leak it', () => {
    const token = new PeerToken(SECRET)
    const error = new Error(`peer auth failed with token ${token}`)
    expect(error.message).not.toContain(SECRET)
    expect(error.message).toContain(REDACTED_PEER_TOKEN)
  })
})

describe('loaded peer config never surfaces tokens', () => {
  test('summarizeFederationConfig omits tokens entirely', async () => {
    await withFederationConfigFile(
      {
        nodeId: 'lab',
        peers: { svc: { endpoint: 'https://svc.example.ts.net:8443', token: SECRET } },
      },
      async ({ stateRoot, env }) => {
        const config = await resolveFederationConfig({ stateRoot, env })

        // The token IS loaded and usable without producing a bare secret...
        expect(config.peers.get('svc' as never)?.token.matches(SECRET)).toBe(true)

        // ...but no status/log projection can carry it.
        const summary = summarizeFederationConfig(config)
        expect(JSON.stringify(summary)).not.toContain(SECRET)
        expect(summary.peers).toEqual([
          { nodeId: 'svc', endpoint: 'https://svc.example.ts.net:8443/' },
        ])
      }
    )
  })

  test('stringifying the whole loaded config does not leak tokens', async () => {
    await withFederationConfigFile(
      {
        nodeId: 'lab',
        peers: { svc: { endpoint: 'https://svc.example.ts.net:8443', token: SECRET } },
      },
      async ({ stateRoot, env }) => {
        const config = await resolveFederationConfig({ stateRoot, env })
        expect(inspect(config, { depth: 10 })).not.toContain(SECRET)
        expect(JSON.stringify({ peers: [...config.peers.values()] })).not.toContain(SECRET)
      }
    )
  })
})
