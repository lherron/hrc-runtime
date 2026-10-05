import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HrcRuntimeIntent, HrcRuntimeSnapshot } from 'hrc-core'
import { type HrcServer, HrcServerInstance, createHrcServer } from '../index'
import { assertNoOperatorPresentationConflict } from '../presentation-operator'
import { omitPersistedSelectionForReuse } from '../selector-message-handlers/selection-request'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'
import { seedDispatchedBrokerInvocation } from './persisted-invocation.fixture'

// Exercise the real HTTP request resolution and real conflict guard. Only the
// broker execution after admission is doubled; live max3 covers that boundary.
let fixture: HrcServerTestFixture
let server: HrcServer
let internal: HrcServerInstanceForHandlers
let hostSessionId: string
let deliveries: number
const birthIntent: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { interactive: false },
  presentation: { operator: 'none' },
  selection: { presentation: false },
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t10183-')
  server = await createHrcServer(fixture.serverOpts())
  if (!(server instanceof HrcServerInstance)) throw new Error('expected concrete HRC server')
  internal = server
  hostSessionId = (await fixture.resolveSession('agent:t10183:project:hrc-runtime:task:probe'))
    .hostSessionId
  internal.db.sessions.updateIntent(hostSessionId, birthIntent, fixture.now())
  const now = fixture.now()
  const runtime = {
    runtimeId: 'rt-t10183',
    hostSessionId,
    scopeRef: 'agent:t10183:project:hrc-runtime:task:probe',
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    controllerKind: 'harness-broker',
    status: 'ready',
    supportsInflightInput: true,
    createdAt: now,
    updatedAt: now,
    activeInvocationId: 'inv-t10183',
    runtimeStateJson: {
      broker: {
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: '/tmp/t10183.sock',
          attachTokenRef: { kind: 'file', path: '/tmp/t10183.token' },
        },
        substrate: { kind: 'external' },
        presentation: {
          kind: 'tmux-tui',
          operatorAttachTarget: true,
          tuiWindow: { sessionId: '$1', windowId: '@2', paneId: '%2' },
        },
      },
    },
  } as HrcRuntimeSnapshot
  internal.db.runtimes.insert(runtime)
  seedDispatchedBrokerInvocation(internal.db, {
    invocationId: 'inv-t10183',
    runtimeId: runtime.runtimeId,
  })
  deliveries = 0
  internal.executeAdmittedTurn = async (_session, intent) => {
    if (!intent) throw new Error('missing intent')
    assertNoOperatorPresentationConflict(intent, [runtime])
    deliveries++
    return Response.json({
      submissionId: 'sub-t10183',
      admission: 'admitted',
      runId: 'run-t10183',
      hostSessionId,
      generation: 1,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: true,
      startIdentity: { kind: 'broker', invocationId: 'inv-t10183' },
    })
  }
})
afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

describe('T-10183 inherited birth presentation at delivery doors', () => {
  for (const door of ['steer', 'enqueue', 'invoke']) {
    it(`${door} delivers without replaying a birth-only operator choice`, async () => {
      const before = internal.db.runtimes.getByRuntimeId('rt-t10183')
      const response = await fixture.postJson(`/v1/submissions/${door}`, {
        target: `${internal.db.sessions.getByHostSessionId(hostSessionId)?.scopeRef}/lane:default`,
        body: 'probe',
        wait: false,
        origin: { principalRef: 'agent:cody' },
      })
      expect(response.status, await response.clone().text()).toBe(202)
      expect(deliveries).toBe(1)
      expect(internal.db.runtimes.getByRuntimeId('rt-t10183')).toEqual(before)
      expect(internal.db.sessions.getByHostSessionId(hostSessionId)?.lastAppliedIntentJson).toEqual(
        birthIntent
      )
    })
  }
  it('dispatch turn inherits policy without replaying presentation authority', async () => {
    const response = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'probe',
      waitFor: 'accepted',
    })
    expect(response.status, await response.clone().text()).toBe(202)
    expect(deliveries).toBe(1)
  })
  for (const door of ['enqueue', 'invoke']) {
    it(`${door} refuses an explicit conflicting choice before delivery`, async () => {
      const before = internal.db.runtimes.getByRuntimeId('rt-t10183')
      const response = await fixture.postJson(`/v1/submissions/${door}`, {
        target: `${internal.db.sessions.getByHostSessionId(hostSessionId)?.scopeRef}/lane:default`,
        body: 'probe',
        wait: false,
        origin: { principalRef: 'agent:cody' },
        runtimeIntent: birthIntent,
      })
      expect(response.status, await response.clone().text()).toBe(409)
      expect(await response.json()).toMatchObject({ error: { code: 'presentation_conflict' } })
      expect(deliveries).toBe(0)
      expect(internal.db.runtimes.getByRuntimeId('rt-t10183')).toEqual(before)
    })
  }
  it('dispatch turn preserves an explicit conflicting choice', async () => {
    const response = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'probe',
      runtimeIntent: birthIntent,
      waitFor: 'accepted',
    })
    expect(response.status, await response.clone().text()).toBe(409)
    expect(deliveries).toBe(0)
  })
  it('the shared inherited-policy sanitizer preserves viewer placement and leaves the stored intent intact', () => {
    const stored = {
      ...birthIntent,
      presentation: { operator: 'none' as const, viewerWindow: 'review' },
    }
    const inherited = omitPersistedSelectionForReuse(stored)
    expect(inherited.presentation).toEqual({ viewerWindow: 'review' })
    expect(inherited.selection).toBeUndefined()
    expect(inherited.placement).toEqual(stored.placement)
    expect(stored.presentation.operator).toBe('none')
  })
})
