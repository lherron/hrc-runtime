import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONTAINED_NODE_IDS,
  LOOPBACK_REGISTRY_URL,
  declaredNodeIdFromConfigContent,
  deriveContainmentNodeIdFromHostname,
  describePublishContainmentRefusal,
  isLoopbackRegistryUrl,
  resolveLocalNodeIdentity,
} from './publish-containment'

const CONTAINED_IDENTITY = {
  nodeId: 'hrcdev',
  source: 'daemon-status',
  detail: 'hrc server status --json',
} as const

describe('isLoopbackRegistryUrl', () => {
  test('accepts the whole loopback block and localhost', () => {
    for (const url of [
      'http://127.0.0.1:4873/',
      'http://127.1.2.3:4873',
      'http://localhost:4873/',
      'http://[::1]:4873/',
    ]) {
      expect(isLoopbackRegistryUrl(url)).toBe(true)
    }
  })

  test('rejects the shared registry and anything unparseable', () => {
    for (const url of ['http://mini:4873/', 'https://registry.npmjs.org/', 'not-a-url']) {
      expect(isLoopbackRegistryUrl(url)).toBe(false)
    }
  })

  // The defect this guard exists for: a host name that merely CONTAINS the
  // loopback literal is not loopback, and a substring check would pass it.
  test('rejects a shared host whose name embeds a loopback literal', () => {
    expect(isLoopbackRegistryUrl('http://127.0.0.1.example.test:4873/')).toBe(false)
  })
})

describe('describePublishContainmentRefusal', () => {
  test('refuses a contained node publishing to the shared registry', () => {
    const refusal = describePublishContainmentRefusal({
      identity: CONTAINED_IDENTITY,
      registryUrl: 'http://mini:4873/',
      configPath: '/state/federation.json',
    })
    expect(refusal).toBeDefined()
    expect(refusal).toContain('PUBLISH REFUSED')
    expect(refusal).toContain('hrcdev')
    expect(refusal).toContain('http://mini:4873/')
    // The refusal must carry the exact remediation and must not offer a flag.
    expect(refusal).toContain(`VERDACCIO_REGISTRY=${LOOPBACK_REGISTRY_URL} just install`)
    expect(refusal).toContain('There is no override flag')
    expect(refusal).toContain('/state/federation.json')
    expect(refusal).toContain('hrc server status --json')
  })

  test('allows a contained node publishing to loopback', () => {
    expect(
      describePublishContainmentRefusal({
        identity: CONTAINED_IDENTITY,
        registryUrl: LOOPBACK_REGISTRY_URL,
      })
    ).toBeUndefined()
  })

  test('allows an uncontained node publishing to the shared registry', () => {
    expect(
      describePublishContainmentRefusal({
        identity: { nodeId: 'max3', source: 'daemon-status', detail: 'hrc server status --json' },
        registryUrl: 'http://mini:4873/',
      })
    ).toBeUndefined()
  })

  test('refuses regardless of which surface named the node', () => {
    for (const identity of [
      { nodeId: 'hrcdev', source: 'federation-config', detail: 'declared "nodeId" in f.json' },
      {
        nodeId: 'hrcdev',
        source: 'hostname',
        detail: 'hostname (daemon down, no declared nodeId)',
      },
    ] as const) {
      expect(
        describePublishContainmentRefusal({ identity, registryUrl: 'http://mini:4873/' })
      ).toContain('PUBLISH REFUSED')
    }
  })

  test('hrcdev is the containment roster', () => {
    expect([...CONTAINED_NODE_IDS]).toEqual(['hrcdev'])
  })
})

describe('resolveLocalNodeIdentity', () => {
  test('prefers the running daemon', () => {
    expect(
      resolveLocalNodeIdentity({
        daemonStatus: () => 'hrcdev',
        federationConfig: () => ({ path: '/state/federation.json', nodeId: 'max3' }),
        hostnameNodeId: () => 'somethingelse',
      })
    ).toEqual({ nodeId: 'hrcdev', source: 'daemon-status', detail: 'hrc server status --json' })
  })

  test('falls back to the declared nodeId when the daemon is down', () => {
    const identity = resolveLocalNodeIdentity({
      daemonStatus: () => undefined,
      federationConfig: () => ({ path: '/state/federation.json', nodeId: 'hrcdev' }),
      hostnameNodeId: () => 'somethingelse',
    })
    expect(identity.nodeId).toBe('hrcdev')
    expect(identity.source).toBe('federation-config')
    expect(identity.detail).toContain('/state/federation.json')
  })

  // Absence is not permission: a rebuilt guest with no daemon and no config is
  // exactly the state in which an unguarded publish would reach the fleet.
  test('falls back to the hostname when neither daemon nor config answers', () => {
    const identity = resolveLocalNodeIdentity({
      daemonStatus: () => undefined,
      federationConfig: () => ({ path: undefined, nodeId: undefined }),
      hostnameNodeId: () => 'hrcdev',
    })
    expect(identity.nodeId).toBe('hrcdev')
    expect(identity.source).toBe('hostname')
  })
})

describe('declaredNodeIdFromConfigContent', () => {
  // Pinned against the real guest file read on 2026-09-03, not a hand-written
  // shape: the field name and nesting are the whole contract here.
  test('reads nodeId out of a real-shaped federation config', () => {
    const content = JSON.stringify({
      nodeId: 'hrcdev',
      peers: { max3: { endpoint: 'http://100.73.60.81:18490', token: 'x' } },
      gate: { mode: 'enforce', registryHost: 'svc' },
      peerListener: { bind: 'http://100.121.7.100:18490' },
    })
    expect(declaredNodeIdFromConfigContent(content)).toBe('hrcdev')
  })

  test('returns undefined for malformed, arrayed, or nodeId-less documents', () => {
    for (const content of ['{', '[]', '{}', '{"nodeId": 7}', '{"nodeId": ""}']) {
      expect(declaredNodeIdFromConfigContent(content)).toBeUndefined()
    }
  })

  test('reads a config file from disk end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-containment-'))
    try {
      const path = join(dir, 'federation.json')
      await writeFile(path, `${JSON.stringify({ nodeId: 'hrcdev' })}\n`)
      expect(declaredNodeIdFromConfigContent(await Bun.file(path).text())).toBe('hrcdev')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('deriveContainmentNodeIdFromHostname', () => {
  test('takes the lowercased short name', () => {
    expect(deriveContainmentNodeIdFromHostname('hrcdev.local')).toBe('hrcdev')
    expect(deriveContainmentNodeIdFromHostname('HRCDEV')).toBe('hrcdev')
    expect(deriveContainmentNodeIdFromHostname('  max3.tail.ts.net ')).toBe('max3')
  })
})
