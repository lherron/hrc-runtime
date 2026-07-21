/** Isolated-daemon proof for claim-first / mint-second admission. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'

import type { PlacementBinding } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import type { TaskClaimAuthority } from '../federation/task-claim-client.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:room-coordinator:project:hrc-runtime:task:T-06624'
const AUTHORITY: TaskClaimAuthority = {
  taskId: 'T-06624',
  claimedBy: 'agent:room-coordinator',
  claimedScope: SCOPE,
  claimedNode: 'lab',
  claimedAt: '2026-07-21T04:00:00.000Z',
  claimGeneration: 4,
  claimToken: 'isolated-daemon-secret',
}

function registryStub(): BindingRegistryClient {
  const rows = new Map<string, PlacementBinding>()
  return {
    async consult(scopeRef) {
      const binding = rows.get(scopeRef)
      return binding === undefined ? { outcome: 'unbound' } : { outcome: 'bound', binding }
    },
    async establish(request) {
      const existing = rows.get(request.scopeRef)
      if (existing !== undefined) return { outcome: 'existing', binding: existing }
      const binding: PlacementBinding = {
        scopeRef: request.scopeRef,
        homeNodeId: request.homeNodeId,
        placementEpoch: request.placementEpoch,
        birthClass: request.birthClass,
        authorityProvenance: request.authorityProvenance,
        establishmentProvenance: request.establishmentProvenance,
        createdAt: request.now,
        updatedAt: request.now,
      }
      rows.set(binding.scopeRef, binding)
      return { outcome: 'created', binding }
    },
  }
}

describe('T-06624 claim-birth on a live isolated daemon', () => {
  let fixture: HrcServerTestFixture

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t06624-daemon-')
    await writeFile(
      `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({ nodeId: 'svc-test', gate: { mode: 'enforce' } }),
      { mode: 0o600 }
    )
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test('real resolve endpoint claims, establishes, mints, and persists private authority', async () => {
    const calls: string[] = []
    const server = await createHrcServer(fixture.serverOpts())
    try {
      Object.assign(server, {
        registryClient: registryStub(),
        policyFor: async () => ({
          placement: { pins: {}, defaultHomeNode: 'svc-test' },
          claimsTask: true,
        }),
        capabilityFor: async () => ({ outcome: 'capable' }),
        taskClaimClient: {
          async claim() {
            calls.push('claim')
            return AUTHORITY
          },
          async release() {
            calls.push('release')
          },
        },
      })

      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: `${SCOPE}/lane:coordinator`,
        create: true,
        summonIntent: 'explicit_local',
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        created: boolean
        hostSessionId: string
        session: unknown
      }
      expect(body.created).toBe(true)
      expect(calls).toEqual(['claim'])
      expect(server.db.sessionTaskClaimAuthorities.getByHostSessionId(body.hostSessionId)).toEqual({
        hostSessionId: body.hostSessionId,
        ...AUTHORITY,
        createdAt: expect.any(String),
      })
      expect(JSON.stringify(body.session)).not.toContain(AUTHORITY.claimToken)
    } finally {
      await server.stop()
    }
  })

  test('real resolve endpoint returns the claim error and mints nothing', async () => {
    const server = await createHrcServer(fixture.serverOpts())
    try {
      Object.assign(server, {
        registryClient: registryStub(),
        policyFor: async () => ({
          placement: { pins: {}, defaultHomeNode: 'svc-test' },
          claimsTask: true,
        }),
        capabilityFor: async () => ({ outcome: 'capable' }),
        taskClaimClient: {
          async claim() {
            throw new Error('already_claimed: held by agent:room-coordinator on max3 generation 11')
          },
          async release() {},
        },
      })

      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: `${SCOPE}/lane:coordinator`,
        create: true,
        summonIntent: 'explicit_local',
      })
      expect(response.status).toBe(409)
      const body = (await response.json()) as { error: { message: string } }
      expect(body.error.message).toContain('already_claimed')
      expect(body.error.message).toContain('max3')
      expect(server.db.sessions.count()).toBe(0)
    } finally {
      await server.stop()
    }
  })
})
