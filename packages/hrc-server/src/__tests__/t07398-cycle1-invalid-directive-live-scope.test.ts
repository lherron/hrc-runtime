/**
 * T-07398 DEFECT CYCLE 1, D3 — an INVALID directive is a typed refusal even
 * when the target is already live.
 *
 * The two spec clauses look like they disagree and do not: "dm to a live
 * runtime never blocks" governs a VALID directive that simply cannot apply yet
 * (birth-only, so `directivesApplied: false`), while "hard typed failure at the
 * sender ... before any session or message row" governs an input that is not
 * admissible at all. Delivery semantics are for valid-but-inapplicable
 * directives, never for invalid ones (supervisor interpretation of record,
 * C-15413 D3).
 *
 * Today the DM door re-validates only SHAPE and the deny-list, then computes
 * `directivesApplied` and delivers. So a directive that contradicts the target's
 * pin — the live repro `hrcchat dm "cody@hrc-runtime:hrcdev+node=svc"` — lands
 * as an ordinary message (observed: delivered, seq 213) and the operator is told
 * only that it "did not apply", never that it was refused.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config'
import type { BindingRegistryClient } from '../federation/registry-client'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

/** The pinned, live scope from the repro: pinned HERE, running HERE. */
const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:hrcdev'
const SESSION_REF = `${SCOPE_REF}/lane:main`
const LOCAL_NODE = 'hrcdev'

const birthIntent = {
  placement: {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
  execution: { preferredMode: 'interactive' },
} as unknown as HrcRuntimeIntent

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

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07398-c1-live-')
  await writeFile(
    join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
    JSON.stringify({
      nodeId: LOCAL_NODE,
      gate: { mode: 'enforce' },
      peers: {
        svc: { endpoint: 'http://svc.example.ts.net:18490', token: 'token-svc' },
      },
    }),
    { mode: 0o600 }
  )
  server = await createHrcServer(
    fixture.serverOpts({ claudeCodeTmuxBrokerEnabled: true, otelListenerEnabled: false })
  )
  Object.assign(server, {
    registryClient: registryUnbound(),
    policyFor: async () => ({
      provisioning: { node: LOCAL_NODE },
      placement: { pins: { 'hrc-runtime:hrcdev': LOCAL_NODE }, homes: {} },
      claimsTask: false,
    }),
    capabilityFor: async () => ({ outcome: 'capable' as const }),
  })
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

/** Seeds the target as LIVE, so the refusal below cannot be a cold-path artifact. */
async function seedLiveTarget(): Promise<void> {
  const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
  const now = fixture.now()
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.updateIntent(hostSessionId, birthIntent, now)
    db.runtimes.insert({
      runtimeId: 'rt-t07398-c1',
      hostSessionId,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: 'op-t07398-c1',
      activeInvocationId: 'inv-t07398-c1',
      tmuxJson: { brokerDriver: 'claude-code-tmux' },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    db.brokerInvocations.insert({
      invocationId: 'inv-t07398-c1',
      operationId: 'op-t07398-c1',
      runtimeId: 'rt-t07398-c1',
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'claude-code-tmux',
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({
        input: { queue: true, busyPolicies: ['reject', 'queue', 'steer'] },
      }),
      specHash: 'sha256:spec-t07398-c1',
      startRequestHash: 'sha256:req-t07398-c1',
      selectedProfileHash: 'sha256:profile-t07398-c1',
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
  ;(server as unknown as Record<string, unknown>).getHarnessBrokerController = () => ({
    dispatchInput: async () => ({
      ok: true,
      response: { accepted: true, disposition: 'queued' },
    }),
  })
}

function persistedMessageCount(): number {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.messages.query({}).length
  } finally {
    db.close()
  }
}

describe('T-07398 cycle 1 D3 — invalid directives refuse regardless of target liveness', () => {
  it('refuses a pin-conflicting directive at a LIVE scope instead of delivering it', async () => {
    await seedLiveTarget()

    const response = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: SESSION_REF },
      body: 'a directive that contradicts the pin is not a deliverable message',
      runtimeIntent: { ...birthIntent, provision: { node: 'svc' } },
    })

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('placement_directive_conflict')

    // "before any session or message row": the refusal must leave no trace of
    // a delivery the operator could mistake for a landed order.
    expect(persistedMessageCount()).toBe(0)
  })

  it('refuses an unknown-node directive at a LIVE scope rather than reporting it inapplicable', async () => {
    await seedLiveTarget()

    const response = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: SESSION_REF },
      body: 'an unregistered node is not a valid directive at any liveness',
      runtimeIntent: { ...birthIntent, provision: { node: 'notanode' } },
    })

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('unknown_node')
    expect(persistedMessageCount()).toBe(0)
  })
})
