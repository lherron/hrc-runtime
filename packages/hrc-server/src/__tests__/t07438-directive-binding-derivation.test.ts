/**
 * T-07438 — binding derivation must honour the provisioning directive.
 *
 * Before this regression, the ordinary summon gate consumed `provision.node`
 * but the decision-only binding projection dropped it, so a directive naming
 * this node lost to the profile's remote provisioning default and silently
 * established the scope there.
 *
 * The original vehicle was the federated DM placement projection, deleted with
 * the federation MESSAGE path at the T-07616 flag day. The seam it was really
 * pinning — `resolvePlacementOnServer` honouring `provision` — is birth and
 * placement authority, which survives, so the fence now sits directly on it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { resolvePlacementOnServer } from '../federation/summon-gate-server.js'
import { type HrcServer, createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const LOCAL_NODE = 'max3'
const PROFILE_DEFAULT_NODE = 'lab'
const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:t07438-fixture'

const runtimeIntent = {
  placement: {
    agentRoot: '/tmp/t07438-agent',
    projectRoot: '/tmp/t07438-project',
    cwd: '/tmp/t07438-project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { provider: 'openai', id: 'codex-cli', interactive: false },
  execution: { preferredMode: 'nonInteractive' },
} satisfies HrcRuntimeIntent

function unboundRegistry(): BindingRegistryClient & { establishCalls: number } {
  return {
    establishCalls: 0,
    async consult() {
      return { outcome: 'unbound' }
    },
    async establish(request) {
      this.establishCalls += 1
      return {
        outcome: 'created',
        binding: {
          scopeRef: request.scopeRef,
          homeNodeId: request.homeNodeId,
          createdAt: request.now,
          updatedAt: request.now,
        },
      }
    },
  }
}

let fixture: HrcServerTestFixture
let server: HrcServer
let registry: ReturnType<typeof unboundRegistry>

beforeEach(async () => {
  fixture = await createHrcTestFixture('h74-')
  await writeFile(
    join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
    JSON.stringify({
      nodeId: LOCAL_NODE,
      gate: { mode: 'enforce' },
      peers: {
        [PROFILE_DEFAULT_NODE]: {
          endpoint: 'http://lab.example.ts.net:18490',
          token: 'token-lab',
        },
      },
    }),
    { mode: 0o600 }
  )
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  registry = unboundRegistry()
  Object.assign(server, {
    registryClient: registry,
    policyFor: async () => ({
      provisioning: { node: PROFILE_DEFAULT_NODE },
      placement: { pins: {}, homes: {} },
      claimsTask: false,
    }),
    capabilityFor: async () => ({ outcome: 'capable' as const }),
  })

  // The fixture deliberately has no live registry listener; only the transport
  // client is replaced. The derivation under test is untouched.
  Reflect.set(server, 'federationRegistryClient', registry)
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

describe('T-07438 directive-aware binding derivation', () => {
  const derive = async (directiveNode: string) =>
    await resolvePlacementOnServer(server, {
      scopeRef: SCOPE_REF,
      path: 'ensure-target',
      intent: 'implicit',
      origin: 'local',
      capabilityHint: {
        placement: runtimeIntent.placement,
        harness: runtimeIntent.harness,
      },
      provision: { node: directiveNode },
    })

  it('binds on the directive node when it differs from the profile default', async () => {
    expect(await derive(LOCAL_NODE)).toMatchObject({
      outcome: 'local-establish',
      homeNodeId: LOCAL_NODE,
    })
    expect(registry.establishCalls).toBe(0)
  })

  it('still refuses on an origin other than the directive node before mutation', async () => {
    expect(await derive(PROFILE_DEFAULT_NODE)).toMatchObject({
      outcome: 'remote-establish',
      candidateHomeNodeId: PROFILE_DEFAULT_NODE,
      reason: 'routed-elsewhere',
    })
    expect(registry.establishCalls).toBe(0)
    expect(server.db.sessions.count()).toBe(0)
  })
})
