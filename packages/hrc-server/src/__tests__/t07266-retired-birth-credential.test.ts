/**
 * T-07266 — federation v1.3 retired the parent birth credential entirely.
 *
 * Preserve the production-shaped state that exposed the old guard: the parent
 * runtime still looks busy and receives events under activeRunId, while the run
 * row is already terminal. A legacy caller may still send the removed wire
 * field during a mixed-version window. The current API must ignore that field
 * and apply ordinary local-mint placement; it must never resurrect the old
 * zombie-childbirth refusal.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'

import type { PlacementBinding } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const PARENT_SCOPE = 'agent:mable:project:hrc-runtime:task:T-07266-parent'
const CHILD_SCOPE = 'agent:cody:project:hrc-runtime:task:T-07266-child'
const PARENT_RUNTIME_ID = 'rt-t07266-parent'
const PARENT_RUN_ID = 'run-t07266-parent'

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
        createdAt: request.now,
        updatedAt: request.now,
      }
      rows.set(binding.scopeRef, binding)
      return { outcome: 'created', binding }
    },
    async deleteBinding() {
      throw new Error('retirement is outside this test')
    },
  }
}

describe('T-07266 retired birth credential', () => {
  let fixture: HrcServerTestFixture | undefined

  afterEach(async () => {
    await fixture?.cleanup()
    fixture = undefined
  })

  test('a legacy credential cannot make live event/run disagreement refuse local mint', async () => {
    fixture = await createHrcTestFixture('hrc-t07266-retired-birth-')
    await writeFile(
      `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({ nodeId: 'max3-test', gate: { mode: 'enforce' } }),
      { mode: 0o600 }
    )

    const server = await createHrcServer(fixture.serverOpts())
    try {
      const now = fixture.now()
      server.db.sessions.insert({
        hostSessionId: 'hsid-t07266-parent',
        scopeRef: PARENT_SCOPE,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      server.db.runtimes.insert({
        runtimeId: PARENT_RUNTIME_ID,
        runtimeKind: 'harness',
        hostSessionId: 'hsid-t07266-parent',
        scopeRef: PARENT_SCOPE,
        laneRef: 'main',
        generation: 1,
        transport: 'tmux',
        harness: 'codex',
        provider: 'openai',
        status: 'busy',
        supportsInflightInput: true,
        adopted: false,
        activeRunId: PARENT_RUN_ID,
        createdAt: now,
        updatedAt: now,
      })
      server.db.runs.insert({
        runId: PARENT_RUN_ID,
        hostSessionId: 'hsid-t07266-parent',
        runtimeId: PARENT_RUNTIME_ID,
        scopeRef: PARENT_SCOPE,
        laneRef: 'main',
        generation: 1,
        transport: 'tmux',
        status: 'completed',
        acceptedAt: now,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      })
      appendHrcEvent(server.db, 'turn.tool_call', {
        ts: now,
        hostSessionId: 'hsid-t07266-parent',
        scopeRef: PARENT_SCOPE,
        laneRef: 'main',
        generation: 1,
        runtimeId: PARENT_RUNTIME_ID,
        runId: PARENT_RUN_ID,
        transport: 'tmux',
        payload: { toolName: 'agent', phase: 'completed' },
      })

      Object.assign(server, {
        registryClient: registryStub(),
        policyFor: async () => ({
          placement: { pins: {}, taskDefaults: {}, defaultHomeNode: 'max3-test' },
          claimsTask: false,
        }),
        capabilityFor: async () => ({ outcome: 'capable' as const }),
      })

      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: `${CHILD_SCOPE}/lane:main`,
        create: true,
        // Removed from the v1.3 contract, but old agent-loop clients can carry
        // it through a mixed-version rollout. It must have no authority.
        birthCredential: PARENT_RUNTIME_ID,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ found: true, created: true })
      expect(server.db.runs.getByRunId(PARENT_RUN_ID)?.status).toBe('completed')
      expect(server.db.runtimes.getByRuntimeId(PARENT_RUNTIME_ID)).toMatchObject({
        status: 'busy',
        activeRunId: PARENT_RUN_ID,
      })
      expect(server.db.sessions.listByScopeRef(CHILD_SCOPE)).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })
})
