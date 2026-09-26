import { afterEach, beforeEach, expect, test } from 'bun:test'

import type { HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

let fixture: HrcServerTestFixture
let server: HrcServer
let internal: HrcServerInstanceForHandlers
let session: HrcSessionRecord

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08207-owner-protected-input-')
  server = await createHrcServer(
    fixture.serverOpts({ otelListenerEnabled: false, brokerDurableIpcEnabled: false })
  )
  internal = server as unknown as HrcServerInstanceForHandlers
  const resolved = await fixture.resolveSession(
    'agent:cody:project:hrc-runtime:task:T-08207:role:protected-input'
  )
  const found = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
  if (found === null) throw new Error('fixture session missing')
  session = found
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

function post(body: Record<string, unknown>): Request {
  return new Request('http://hrc.local/v1/terminate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('owner termination preserves another durable protected input after in-memory rendezvous is gone', async () => {
  const now = fixture.now()
  const runtime: HrcRuntimeSnapshot = {
    runtimeId: 'rt-t08207-protected-input',
    runtimeKind: 'harness',
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'tmux',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    createdAt: now,
    updatedAt: now,
  }
  internal.db.runtimes.insert(runtime)
  internal.db.inputs.insert({
    inputId: 'input-t08207-other-after-restart',
    admissionHostSessionId: session.hostSessionId,
    idempotencyKey: 'idem-t08207-other',
    requestHash: 'sha256:t08207-other',
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    operationId: 'op-t08207-other',
    invocationId: 'inv-t08207-other',
    status: 'accepted',
    cleanupProtection: 'protected',
    admittedAt: now,
    createdAt: now,
    updatedAt: now,
  })
  // Startup has no in-memory rendezvous to consult; the durable row alone must
  // keep an owner-scoped teardown from killing its still-possible carrier.
  internal.invokeFirstTurnRendezvous.clear()
  let terminations = 0
  internal.terminateRuntime = async () => {
    terminations += 1
    return Response.json({ ok: true })
  }

  const response = await internal.handleTerminate(
    post({ runtimeId: runtime.runtimeId, ownerRunId: 'run-t08207-owner' })
  )

  expect((await response.json()).warning).toContain('input-t08207-other-after-restart')
  expect(terminations).toBe(0)
  expect(internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.status).toBe('ready')
})
