/**
 * T-07398 Wave 2b — directives are BIRTH-only, and a live scope says so.
 *
 * Provisioning is decided when a runtime is born. A DM carrying a directive
 * block at a scope that is already live therefore has exactly one honest
 * behavior: deliver anyway — never block, never hot-swap — and tell the sender
 * the block did not take, so nobody reads a delivered reply as evidence that
 * `+model=...` was applied. Stickiness is the birth intent (`lastAppliedIntentJson`),
 * which a live-scope DM must not rewrite: the runtime's ACTIVE values are the
 * ones it was born with, and its successors inherit those, not a passing DM's.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'
import { fakeBrokerClient } from '../turn-admission/__tests__/broker-boundary.fixture'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const BIRTH_PROVISION = { harness: 'claude-code', model: 'opus', reasoning: 'high' } as const

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
  provision: { ...BIRTH_PROVISION },
} as unknown as HrcRuntimeIntent

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07398-live-')
  server = await createHrcServer(
    fixture.serverOpts({
      claudeCodeTmuxBrokerEnabled: true,
      otelListenerEnabled: false,
    })
  )
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

const SCOPE_REF = 'agent:t07398-live:project:hrc-runtime:task:T-07398'
const SESSION_REF = `${SCOPE_REF}/lane:main`

async function seedLiveInteractive(): Promise<{ hostSessionId: string }> {
  const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
  const now = fixture.now()
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.updateIntent(hostSessionId, birthIntent, now)
    db.runtimes.insert({
      runtimeId: 'rt-t07398-live',
      hostSessionId,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      controllerKind: 'harness-broker',
      activeOperationId: 'op-t07398-live',
      activeInvocationId: 'inv-t07398-live',
      tmuxJson: { brokerDriver: 'claude-code-tmux' },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    db.brokerInvocations.insert({
      invocationId: 'inv-t07398-live',
      operationId: 'op-t07398-live',
      runtimeId: 'rt-t07398-live',
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'claude-code-tmux',
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({
        input: { queue: true, busyPolicies: ['reject', 'queue', 'steer'] },
        admission: { classes: ['queue'] },
      }),
      specHash: 'sha256:spec-t07398-live',
      startRequestHash: 'sha256:req-t07398-live',
      selectedProfileHash: 'sha256:profile-t07398-live',
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
  const ctx = server as unknown as HrcServerInstanceForHandlers
  ctx.getHarnessBrokerController().active.set('rt-t07398-live', {
    runtimeId: 'rt-t07398-live',
    invocationId: 'inv-t07398-live',
    client: fakeBrokerClient(ctx, 'rt-t07398-live', 'inv-t07398-live'),
    closing: false,
  })
  ctx.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
  return { hostSessionId }
}

function persistedProvision(hostSessionId: string): unknown {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const session = db.sessions.getByHostSessionId(hostSessionId)
    return (session?.lastAppliedIntentJson as { provision?: unknown } | undefined)?.provision
  } finally {
    db.close()
  }
}

describe('T-07398 live-scope directive semantics', () => {
  for (const uncertain of [false, true])
    it(`preserves directivesApplied:false and sticky birth intent (uncertain=${uncertain})`, async () => {
      const { hostSessionId } = await seedLiveInteractive()

      const ctx = server as unknown as HrcServerInstanceForHandlers
      if (uncertain)
        ctx.getHarnessBrokerController().enqueue = async () => {
          throw new Error('response lost after admission')
        }

      const response = await fixture.postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: SESSION_REF },
        body: 'a directive at a live scope must not block, and must not silently take',
        runtimeIntent: { ...birthIntent, provision: { model: 'sonnet', reasoning: 'low' } },
      })

      // Never blocks: the message lands.
      expect(response.status).toBe(200)
      const body = (await response.json()) as { directivesApplied?: boolean }

      // Says so out loud: the sender learns the block was NOT applied.
      expect(body.directivesApplied).toBe(false)
      expect(ctx.db.hrcEvents.listByKind('submission.admission').at(-1)?.payload).toMatchObject({
        door: 'dm',
        outcome: uncertain ? 'possible_write' : 'routed',
      })
      await Bun.sleep(30)

      // Birth-only stickiness: the live runtime's active values are untouched, so
      // a successor inherits what it was born with, not what a DM asked for.
      expect(persistedProvision(hostSessionId)).toEqual({ ...BIRTH_PROVISION })
    })
})
