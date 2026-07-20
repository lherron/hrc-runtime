import { describe, expect, test } from 'bun:test'

import { resolveFederationConfig } from '../federation/federation-config.js'
import { withFederationConfigFile } from './fixtures/federation-config-fixture.js'

const PEERS = {
  lab: { endpoint: 'http://lab.example.ts.net:18490', token: 'lab-token' },
}

describe('T-06607 registry listener config', () => {
  test('absence is the feature flag and starts with no registry config', async () => {
    await withFederationConfigFile(
      { nodeId: 'svc', peers: PEERS },
      async ({ stateRoot, env }) => {
        const config = await resolveFederationConfig({ stateRoot, env })
        expect(config.registry).toBeUndefined()
      }
    )
  })

  for (const bind of [
    'http://svc.example.ts.net:18491',
    'http://100.64.12.34:18491',
    'http://100.127.255.254:18491',
    'http://[fd7a:115c:a1e0::1234]:18491',
  ]) {
    test(`accepts tailnet-only bind ${bind}`, async () => {
      await withFederationConfigFile(
        { nodeId: 'svc', peers: PEERS, registry: { bind } },
        async ({ stateRoot, env }) => {
          const config = await resolveFederationConfig({ stateRoot, env })
          expect(config.registry).toEqual({ bind })
        }
      )
    })
  }

  test('registry listener refuses a derived node identity', async () => {
    await withFederationConfigFile(
      { registry: { bind: 'http://100.64.12.34:18491' } },
      async ({ stateRoot, env }) => {
        await expect(resolveFederationConfig({ stateRoot, env })).rejects.toThrow(
          /registry listener.*requires a declared "nodeId"/
        )
      }
    )
  })

  const invalid: Array<[string, unknown, RegExp]> = [
    ['non-object', true, /field "registry" must be a JSON object/],
    ['missing bind', {}, /registry is missing a non-empty string "bind"/],
    ['invalid URL', { bind: 'nope' }, /registry bind is not a valid URL/],
    ['TLS without listener TLS config', { bind: 'https://svc.example.ts.net:18491' }, /must use http:/],
    ['missing explicit port', { bind: 'http://svc.example.ts.net' }, /must include an explicit port/],
    ['wildcard v4', { bind: 'http://0.0.0.0:18491' }, /tailnet host/],
    ['wildcard v6', { bind: 'http://[::]:18491' }, /tailnet host/],
    ['loopback v4', { bind: 'http://127.0.0.1:18491' }, /tailnet host/],
    ['loopback hostname', { bind: 'http://localhost:18491' }, /tailnet host/],
    ['public address', { bind: 'http://8.8.8.8:18491' }, /tailnet host/],
    ['non-tailnet hostname', { bind: 'http://svc.example.com:18491' }, /tailnet host/],
    ['wrong CGNAT range', { bind: 'http://100.128.0.1:18491' }, /tailnet host/],
  ]

  for (const [name, registry, expected] of invalid) {
    test(`rejects ${name}`, async () => {
      await withFederationConfigFile(
        { nodeId: 'svc', peers: PEERS, registry },
        async ({ stateRoot, env, configPath }) => {
          const promise = resolveFederationConfig({ stateRoot, env })
          await expect(promise).rejects.toThrow(expected)
          await expect(promise).rejects.toThrow(configPath)
        }
      )
    })
  }
})
