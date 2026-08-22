/**
 * T-07438 — the federated DM placement projection and the binding gate must
 * derive one home from the same provisioning directive.
 *
 * Before this regression, the ordinary summon gate consumed `provision.node`
 * but the outbox's decision-only binding projection dropped it twice: once at
 * the index callback and once in `resolvePlacementOnServer`. A directive naming
 * this node therefore lost to the profile's remote provisioning default and
 * silently established the scope there.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { HrcConflictError, HrcErrorCode, type HrcRuntimeIntent } from 'hrc-core'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { type HrcServer, createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const LOCAL_NODE = 'max3'
const PROFILE_DEFAULT_NODE = 'lab'
const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:t07438-fixture'
const SESSION_REF = `${SCOPE_REF}/lane:default`

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
        binding: { ...request, placementEpoch: 1, updatedAt: request.now },
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

  const outbox = server.federationOriginOutbox
  if (outbox === undefined) throw new Error('federation origin outbox missing from fixture')
  // The fixture deliberately has no live registry listener. Replace only the
  // outbox's transport client; the production resolvePlacement callback created
  // by HrcServer remains intact and is the seam this test pins.
  Reflect.set(outbox, 'registry', registry)
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

describe('T-07438 directive-aware binding derivation', () => {
  it('binds on the directive node when it differs from the profile default', async () => {
    const outbox = server.federationOriginOutbox
    if (outbox === undefined) throw new Error('federation origin outbox missing from fixture')

    const placement = await outbox.resolveTargetPlacement({
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: SESSION_REF },
      body: 'T-07438 directive placement projection',
      runtimeIntent: {
        ...runtimeIntent,
        provision: { node: LOCAL_NODE },
      },
    })

    expect(placement).toEqual({ outcome: 'local' })
    expect(registry.establishCalls).toBe(0)
  })

  it('still refuses on an origin other than the directive node before mutation', async () => {
    const outbox = server.federationOriginOutbox
    if (outbox === undefined) throw new Error('federation origin outbox missing from fixture')

    let caught: unknown
    try {
      await outbox.resolveTargetPlacement({
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: SESSION_REF },
        body: 'T-07438 remote directive refusal',
        runtimeIntent: {
          ...runtimeIntent,
          provision: { node: PROFILE_DEFAULT_NODE },
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HrcConflictError)
    if (!(caught instanceof HrcConflictError)) throw caught
    expect(caught.code).toBe(HrcErrorCode.STALE_CONTEXT)
    expect(caught.detail).toMatchObject({
      reason: 'routed-elsewhere',
      homeNodeId: PROFILE_DEFAULT_NODE,
      retryable: false,
    })
    expect(registry.establishCalls).toBe(0)
    expect(server.db.sessions.count()).toBe(0)
  })
})
