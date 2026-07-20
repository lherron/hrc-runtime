/**
 * T-06606 — node-local federation config: parse, validate, reject.
 *
 * Spec §3 (node identity), §6 (peer config). Every rejection must name the
 * problem — "invalid config" is never an acceptable diagnostic.
 */

import { describe, expect, test } from 'bun:test'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'

import {
  FEDERATION_CONFIG_BASENAME,
  HRC_PEER_CONFIG_FILE_ENV,
  deriveNodeIdFromHostname,
  isSingleNodeMode,
  resolveFederationConfig,
  resolveFederationConfigPath,
} from '../federation/federation-config.js'
import { isValidNodeId } from '../federation/node-id.js'
import { withFederationConfigFile } from './fixtures/federation-config-fixture.js'

const ENDPOINT = 'https://svc.example.ts.net:8443'

describe('config path resolution', () => {
  test('defaults to <stateRoot>/federation.json', () => {
    expect(resolveFederationConfigPath('/state', {})).toBe(
      join('/state', FEDERATION_CONFIG_BASENAME)
    )
  })

  test('honours HRC_PEER_CONFIG_FILE', () => {
    expect(
      resolveFederationConfigPath('/state', { [HRC_PEER_CONFIG_FILE_ENV]: '/etc/hrc/fed.json' })
    ).toBe('/etc/hrc/fed.json')
  })

  test('ignores a blank override', () => {
    expect(resolveFederationConfigPath('/state', { [HRC_PEER_CONFIG_FILE_ENV]: '   ' })).toBe(
      join('/state', FEDERATION_CONFIG_BASENAME)
    )
  })
})

describe('absent file = valid single-node mode', () => {
  test('derives a valid nodeId and reports single-node mode', async () => {
    await withFederationConfigFile(undefined, async ({ stateRoot, env, configPath }) => {
      const config = await resolveFederationConfig({ stateRoot, env })
      expect(config.sourceExists).toBe(false)
      expect(config.sourcePath).toBe(configPath)
      expect(config.peers.size).toBe(0)
      expect(isSingleNodeMode(config)).toBe(true)
      expect(config.nodeIdProvenance).toBe('derived')
      expect(isValidNodeId(config.nodeId)).toBe(true)
    })
  })
})

describe('hostname derivation', () => {
  test('is deterministic and grammar-valid', () => {
    const cases: [string, string][] = [
      ['mini', 'mini'],
      ['Lances-MacBook-Pro.local', 'lances-macbook-pro'],
      ['MAX3.tail1234.ts.net', 'max3'],
      ['host_with.underscore', 'host_with'],
      ['weird host!', 'weird-host-'],
      ['', 'unknown-node'],
      ['   ', 'unknown-node'],
      ['local', 'unknown-node'],
      ['Local.local', 'unknown-node'],
    ]
    for (const [input, expected] of cases) {
      expect(deriveNodeIdFromHostname(input)).toBe(expected)
      expect(isValidNodeId(deriveNodeIdFromHostname(input))).toBe(true)
    }
  })

  test('truncates over-long hostnames to the 64-char grammar', () => {
    const derived = deriveNodeIdFromHostname('a'.repeat(200))
    expect(derived.length).toBe(64)
    expect(isValidNodeId(derived)).toBe(true)
  })
})

describe('valid declared config', () => {
  test('loads nodeId and peers', async () => {
    await withFederationConfigFile(
      {
        nodeId: 'lab',
        peers: {
          svc: { endpoint: ENDPOINT, token: 'tok-a' },
          max3: { endpoint: 'http://max3.example.ts.net:9000', token: 'tok-b' },
        },
      },
      async ({ stateRoot, env }) => {
        const config = await resolveFederationConfig({ stateRoot, env })
        expect(config.nodeId).toBe('lab')
        expect(config.nodeIdProvenance).toBe('declared')
        expect(config.sourceExists).toBe(true)
        expect(isSingleNodeMode(config)).toBe(false)
        expect([...config.peers.keys()].sort()).toEqual(['max3', 'svc'])
        expect(config.warnings).toEqual([])
      }
    )
  })

  test('a declared nodeId with no peers is single-node mode', async () => {
    await withFederationConfigFile({ nodeId: 'lab' }, async ({ stateRoot, env }) => {
      const config = await resolveFederationConfig({ stateRoot, env })
      expect(config.nodeId).toBe('lab')
      expect(config.nodeIdProvenance).toBe('declared')
      expect(isSingleNodeMode(config)).toBe(true)
    })
  })

  test('an empty peers object is single-node mode, not a refusal', async () => {
    await withFederationConfigFile({ peers: {} }, async ({ stateRoot, env }) => {
      const config = await resolveFederationConfig({ stateRoot, env })
      expect(isSingleNodeMode(config)).toBe(true)
      expect(config.nodeIdProvenance).toBe('derived')
    })
  })
})

describe('peers-without-declared-nodeId is a hard refusal', () => {
  // A hostname-derived id is not a §4 roster identity. Letting a peered node
  // run on one would key ledger/registry rows (T-06607) to a name no other node
  // agrees on. Refuse instead, and name the fix.
  test('refuses and names both the problem and the fix', async () => {
    await withFederationConfigFile(
      { peers: { svc: { endpoint: ENDPOINT, token: 'tok' } } },
      async ({ stateRoot, env, configPath }) => {
        const promise = resolveFederationConfig({ stateRoot, env })
        await expect(promise).rejects.toThrow(/declares 1 peer\(s\) but no "nodeId"/)
        await expect(promise).rejects.toThrow(/Fix: add a "nodeId" field to/)
        await expect(promise).rejects.toThrow(new RegExp(configPath.replace(/[.]/g, '\\.')))
      }
    )
  })
})

describe('malformed config produces a diagnostic naming the problem', () => {
  const cases: { name: string; content: unknown | string; expected: RegExp }[] = [
    { name: 'not JSON', content: '{ this is not json', expected: /is not valid JSON/ },
    { name: 'JSON array', content: [1, 2, 3], expected: /must contain a JSON object/ },
    { name: 'JSON scalar', content: '"just-a-string"', expected: /must contain a JSON object/ },
    {
      name: 'non-string nodeId',
      content: { nodeId: 42 },
      expected: /field "nodeId" must be a string/,
    },
    {
      name: 'nodeId violating the grammar',
      content: { nodeId: 'bad id' },
      expected: /field "nodeId" is not a valid nodeId .*disallowed character/,
    },
    {
      name: 'reserved nodeId',
      content: { nodeId: 'local' },
      expected: /reserved placement sentinel/,
    },
    {
      name: 'peers not an object',
      content: { nodeId: 'lab', peers: [] },
      expected: /field "peers" must be a JSON object/,
    },
    {
      name: 'peer key violating the grammar',
      content: { nodeId: 'lab', peers: { 'bad key': { endpoint: ENDPOINT, token: 't' } } },
      expected: /peer "bad key" has an invalid nodeId key/,
    },
    {
      name: 'peer key is the reserved sentinel',
      content: { nodeId: 'lab', peers: { local: { endpoint: ENDPOINT, token: 't' } } },
      expected: /peer "local" has an invalid nodeId key: .*reserved placement sentinel/,
    },
    {
      name: 'peer entry not an object',
      content: { nodeId: 'lab', peers: { svc: 'https://svc' } },
      expected: /peer "svc" must be a JSON object with "endpoint" and "token"/,
    },
    {
      name: 'peer missing endpoint',
      content: { nodeId: 'lab', peers: { svc: { token: 't' } } },
      expected: /peer "svc" is missing a non-empty string "endpoint"/,
    },
    {
      name: 'peer missing token',
      content: { nodeId: 'lab', peers: { svc: { endpoint: ENDPOINT } } },
      expected: /peer "svc" is missing a non-empty string "token"/,
    },
    {
      name: 'peer with empty token',
      content: { nodeId: 'lab', peers: { svc: { endpoint: ENDPOINT, token: '' } } },
      expected: /peer "svc" is missing a non-empty string "token"/,
    },
    {
      name: 'peer endpoint not a URL',
      content: { nodeId: 'lab', peers: { svc: { endpoint: 'not a url', token: 't' } } },
      expected: /peer "svc" endpoint is not a valid URL/,
    },
    {
      name: 'peer endpoint with a non-http scheme',
      content: { nodeId: 'lab', peers: { svc: { endpoint: 'ftp://svc/', token: 't' } } },
      expected: /peer "svc" endpoint must use http: or https:/,
    },
    {
      name: 'peer endpoint bound to the wildcard address',
      content: { nodeId: 'lab', peers: { svc: { endpoint: 'https://0.0.0.0:8443', token: 't' } } },
      expected: /peer "svc" endpoint must name a specific host/,
    },
    {
      name: 'peer that is this node itself',
      content: { nodeId: 'lab', peers: { lab: { endpoint: ENDPOINT, token: 't' } } },
      expected: /peer "lab" is this node's own nodeId — a node cannot be its own peer/,
    },
  ]

  for (const { name, content, expected } of cases) {
    test(name, async () => {
      await withFederationConfigFile(content, async ({ stateRoot, env }) => {
        await expect(resolveFederationConfig({ stateRoot, env })).rejects.toThrow(expected)
      })
    })
  }

  test('every diagnostic names the offending file', async () => {
    await withFederationConfigFile('{ nope', async ({ stateRoot, env, configPath }) => {
      await expect(resolveFederationConfig({ stateRoot, env })).rejects.toThrow(
        new RegExp(configPath.replace(/[.]/g, '\\.'))
      )
    })
  })

  test('a malformed file never silently degrades to single-node mode', async () => {
    await withFederationConfigFile('{ nope', async ({ stateRoot, env }) => {
      let threw = false
      try {
        await resolveFederationConfig({ stateRoot, env })
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    })
  })
})

describe('file mode', () => {
  test('0600 produces no warning', async () => {
    await withFederationConfigFile({ nodeId: 'lab' }, async ({ stateRoot, env }) => {
      const config = await resolveFederationConfig({ stateRoot, env })
      expect(config.warnings).toEqual([])
    })
  })

  test('a group/other-readable file warns and names the chmod fix', async () => {
    await withFederationConfigFile(
      { nodeId: 'lab', peers: { svc: { endpoint: ENDPOINT, token: 'tok' } } },
      async ({ stateRoot, env, configPath }) => {
        await chmod(configPath, 0o644)
        const config = await resolveFederationConfig({ stateRoot, env })
        expect(config.warnings).toHaveLength(1)
        expect(config.warnings[0]).toContain('mode 644')
        expect(config.warnings[0]).toContain('expected 0600')
        expect(config.warnings[0]).toContain(`chmod 600 ${configPath}`)
        // Still loads — permissive mode is advisory, not fatal.
        expect(config.nodeId).toBe('lab')
      }
    )
  })
})
