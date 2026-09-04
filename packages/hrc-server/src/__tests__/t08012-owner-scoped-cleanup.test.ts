import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import type { InvokeFirstTurnRendezvous } from '../server-types.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:slugger:project:hrc-runtime:task:slugs:role:t08012-cleanup'

let fixture: HrcServerTestFixture
let server: HrcServer
let internal: HrcServerInstanceForHandlers
let session: HrcSessionRecord

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08012-owner-cleanup-')
  server = await createHrcServer(
    fixture.serverOpts({
      otelListenerEnabled: false,
      brokerDurableIpcEnabled: false,
    })
  )
  internal = server as unknown as HrcServerInstanceForHandlers
  const resolved = await fixture.resolveSession(SCOPE)
  const found = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
  if (found === null) throw new Error('T-08012 fixture session missing')
  session = found
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

function seedRuntime(overrides: Partial<HrcRuntimeSnapshot> = {}): HrcRuntimeSnapshot {
  const now = fixture.now()
  const runtime: HrcRuntimeSnapshot = {
    runtimeId: 'rt-t08012-owner-cleanup',
    runtimeKind: 'harness',
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  internal.db.runtimes.insert(runtime)
  return runtime
}

function postBody(body: Record<string, unknown>): Request {
  return new Request('http://hrc.local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('T-08012 owner-scoped cleanup', () => {
  it('skips interrupt when the owned run is no longer active or another run is active', async () => {
    const runtime = seedRuntime({ activeRunId: 'run-crossing' })
    let interrupts = 0
    internal.interruptRuntime = async () => {
      interrupts += 1
      return Response.json({ ok: true })
    }

    const scoped = await internal.handleInterrupt(
      postBody({ runtimeId: runtime.runtimeId, ownerRunId: 'run-owner' })
    )
    expect((await scoped.json()).warning).toContain('another run is active')
    expect(interrupts).toBe(0)

    await internal.handleInterrupt(postBody({ runtimeId: runtime.runtimeId }))
    expect(interrupts).toBe(1)

    internal.db.runtimes.updateRunId(runtime.runtimeId, undefined, fixture.now())
    const inactive = await internal.handleInterrupt(
      postBody({ runtimeId: runtime.runtimeId, ownerRunId: 'run-owner' })
    )
    expect((await inactive.json()).warning).toContain('no longer active')
    expect(interrupts).toBe(1)
  })

  it('preserves a registered crossing invoke before its accepted row exists', async () => {
    const runtime = seedRuntime()
    const rendezvous: InvokeFirstTurnRendezvous = {
      ownerRunId: 'run-owner',
      operation: Promise.resolve(runtime),
      crossingRunIds: new Set(['run-crossing']),
      settled: true,
      runtimeId: runtime.runtimeId,
    }
    internal.invokeFirstTurnRendezvous.set(session.hostSessionId, rendezvous)
    let terminations = 0
    internal.terminateRuntime = async () => {
      terminations += 1
      return Response.json({ ok: true })
    }

    const response = await internal.handleTerminate(
      postBody({ runtimeId: runtime.runtimeId, ownerRunId: 'run-owner' })
    )
    expect((await response.json()).warning).toContain('run-crossing')
    expect(terminations).toBe(0)
    expect(internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.status).toBe('ready')
  })

  it('preserves an accepted off-pointer run after rendezvous registration hands off', async () => {
    const runtime = seedRuntime()
    internal.db.runs.insert({
      runId: 'run-crossing',
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: fixture.now(),
      updatedAt: fixture.now(),
    })
    let terminations = 0
    internal.terminateRuntime = async () => {
      terminations += 1
      return Response.json({ ok: true })
    }

    const response = await internal.handleTerminate(
      postBody({ runtimeId: runtime.runtimeId, ownerRunId: 'run-owner' })
    )
    expect((await response.json()).warning).toContain('run-crossing')
    expect(terminations).toBe(0)
  })

  it('transitions an unshared runtime before owner-scoped teardown but not operator teardown', async () => {
    const runtime = seedRuntime()
    const observedStatuses: string[] = []
    internal.terminateRuntime = async (snapshot) => {
      observedStatuses.push(
        internal.db.runtimes.getByRuntimeId(snapshot.runtimeId)?.status ?? 'missing'
      )
      return Response.json({
        ok: true,
        hostSessionId: snapshot.hostSessionId,
        runtimeId: snapshot.runtimeId,
        droppedContinuation: false,
      })
    }

    await internal.handleTerminate(
      postBody({ runtimeId: runtime.runtimeId, ownerRunId: 'run-owner' })
    )
    expect(observedStatuses).toEqual(['stopping'])

    internal.db.runtimes.update(runtime.runtimeId, {
      status: 'ready',
      statusChangedAt: fixture.now(),
      updatedAt: fixture.now(),
    })
    await internal.handleTerminate(postBody({ runtimeId: runtime.runtimeId }))
    expect(observedStatuses).toEqual(['stopping', 'ready'])
  })
})
