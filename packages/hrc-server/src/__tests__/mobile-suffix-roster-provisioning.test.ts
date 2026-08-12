import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { PeerToken } from '../federation/peer-token.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { sendRemoteRosterStart } from '../federation/roster-start-client.js'
import {
  preflightSuffixRosterFamily,
  resolveImplicitSuffixRosterHome,
} from '../federation/summon-gate-server.js'
import { createHrcServer } from '../index.js'
import { suffixRosterFamily } from '../roster-claim.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const BASE_SESSION_REF = 'agent:mable:project:hrc-runtime:task:minisvc/lane:main'
const CAPABILITY_HINT = {
  placement: {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task' as const,
    bundle: { kind: 'compose' as const, compose: [] },
    dryRun: false,
  },
  harness: { provider: 'anthropic' as const, id: 'claude-code' as const, interactive: true },
}

function registryUnbound(): BindingRegistryClient {
  return {
    async consult() {
      return { outcome: 'unbound' }
    },
    async establish(request) {
      return {
        outcome: 'created',
        binding: { ...request, placementEpoch: 1, updatedAt: request.now },
      }
    },
  }
}

describe('mobile suffix-roster placement preflight', () => {
  let fixture: HrcServerTestFixture

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-mobile-roster-')
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  async function serverWithTaskDefaults(taskDefaults: Record<string, string>) {
    await writeFile(
      join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
      JSON.stringify({ nodeId: 'svc', gate: { mode: 'enforce' } }),
      { mode: 0o600 }
    )
    const server = await createHrcServer(fixture.serverOpts())
    Object.assign(server, {
      registryClient: registryUnbound(),
      policyFor: async () => ({
        placement: { defaultHomeNode: 'max3', pins: {}, taskDefaults },
        claimsTask: false,
      }),
      capabilityFor: async () => ({ outcome: 'capable' as const }),
    })
    return server
  }

  test('a complete exact family resolves and preflights without minting sessions', async () => {
    const family = suffixRosterFamily(BASE_SESSION_REF)
    const taskDefaults = Object.fromEntries(
      family.scopeRefs.map((scopeRef) => [scopeRef.slice(scopeRef.indexOf(':task:') + 6), 'svc'])
    )
    const server = await serverWithTaskDefaults(taskDefaults)
    try {
      expect(
        await resolveImplicitSuffixRosterHome(server, {
          scopeRef: family.baseScopeRef,
          capabilityHint: CAPABILITY_HINT,
        })
      ).toBe('svc')
      await preflightSuffixRosterFamily(server, {
        scopeRefs: family.scopeRefs,
        capabilityHint: CAPABILITY_HINT,
        origin: 'federated-ingress',
      })
      expect(server.db.sessions.count()).toBe(0)
      expect(server.db.rosterClaims.listByBaseScope(family.baseScopeRef)).toEqual([])
    } finally {
      await server.stop()
    }
  })

  test('one missing exact suffix declaration refuses the whole family before mutation', async () => {
    const family = suffixRosterFamily(BASE_SESSION_REF)
    const taskDefaults = Object.fromEntries(
      family.scopeRefs
        .slice(0, -1)
        .map((scopeRef) => [scopeRef.slice(scopeRef.indexOf(':task:') + 6), 'svc'])
    )
    const server = await serverWithTaskDefaults(taskDefaults)
    try {
      await expect(
        preflightSuffixRosterFamily(server, {
          scopeRefs: family.scopeRefs,
          capabilityHint: CAPABILITY_HINT,
          origin: 'federated-ingress',
        })
      ).rejects.toMatchObject({ code: 'stale_context' })
      expect(server.db.sessions.count()).toBe(0)
      expect(server.db.rosterClaims.listByBaseScope(family.baseScopeRef)).toEqual([])
    } finally {
      await server.stop()
    }
  })

  test('the origin resolves a remote exact base without asserting a destination', async () => {
    const server = await serverWithTaskDefaults({ minilab: 'lab' })
    try {
      expect(
        await resolveImplicitSuffixRosterHome(server, {
          scopeRef: 'agent:mable:project:hrc-runtime:task:minilab',
          capabilityHint: CAPABILITY_HINT,
        })
      ).toBe('lab')
    } finally {
      await server.stop()
    }
  })
})

describe('mobile suffix-roster peer client', () => {
  const peer = {
    nodeId: 'lab' as never,
    endpoint: 'http://lab.example.ts.net:18490',
    token: new PeerToken('outbound-token'),
  }
  const request = {
    baseSessionRef: 'agent:mable:project:hrc-runtime:task:minilab/lane:main',
    runtimeIntent: {
      placement: CAPABILITY_HINT.placement,
      harness: CAPABILITY_HINT.harness,
      execution: { preferredMode: 'headless' as const },
      presentation: {},
    },
    conflictPolicy: 'suffix' as const,
    summonIntent: 'implicit' as const,
    idempotencyKey: 'mobile-1',
  }

  test('capability-gates the authenticated verb and preserves the claim response', async () => {
    const calls: string[] = []
    const result = await sendRemoteRosterStart({
      peer,
      request,
      fetch: async (input, init) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/v1/federation/health')) {
          return Response.json({ capabilities: { rosterStart: true } })
        }
        expect(JSON.parse(String(init?.body))).toMatchObject({
          summonIntent: 'implicit',
          idempotencyKey: 'mobile-1',
        })
        return Response.json({
          runtimeId: 'rt-1',
          hostSessionId: 'hsid-1',
          transport: 'headless',
          status: 'ready',
          supportsInFlightInput: true,
          claim: {
            slot: 'minilab-nova',
            scopeRef: 'agent:mable:project:hrc-runtime:task:minilab-nova',
            sessionRef: 'agent:mable:project:hrc-runtime:task:minilab-nova/lane:main',
            hostSessionId: 'hsid-1',
            idempotencyKey: 'mobile-1',
            replayed: false,
          },
        })
      },
    })
    expect(calls).toEqual([
      'http://lab.example.ts.net:18490/v1/federation/health',
      'http://lab.example.ts.net:18490/v1/federation/roster-start',
    ])
    expect(result.claim).toMatchObject({ slot: 'minilab-nova', idempotencyKey: 'mobile-1' })
  })

  test('peer unreachability is a typed retryable runtime_unavailable', async () => {
    await expect(
      sendRemoteRosterStart({
        peer,
        request,
        fetch: async () => {
          throw new Error('peer asleep')
        },
      })
    ).rejects.toMatchObject({
      code: 'runtime_unavailable',
      detail: { homeNodeId: 'lab', retryable: true },
    })
  })

  test('a peer without rosterStart fails closed as stale_context', async () => {
    await expect(
      sendRemoteRosterStart({
        peer,
        request,
        fetch: async () => Response.json({ capabilities: { establish: true } }),
      })
    ).rejects.toMatchObject({
      code: 'stale_context',
      detail: { reason: 'peer_upgrade_required', retryable: false },
    })
  })
})
