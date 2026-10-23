import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { type TurnAdmissionGate, turnAdmissionMarkerPath } from '../turn-admission-gate.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

let fixture: HrcServerTestFixture
let server: HrcServer & { turnAdmissionGate: TurnAdmissionGate }

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-turn-admission-server-')
  server = (await createHrcServer(
    fixture.serverOpts({ otelListenerEnabled: false })
  )) as typeof server
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

function headlessIntent(): object {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider: 'openai',
      interactive: false,
    },
    execution: { preferredMode: 'headless' },
  }
}

describe('server-owned turn admission', () => {
  it('leaves removed control routes unmatched while server subscribers still responds', async () => {
    for (const [method, path] of [
      ['GET', '/v1/server/turn-admission'],
      ['POST', '/v1/server/turn-admission/close'],
      ['POST', '/v1/server/turn-admission/reopen'],
    ] as const) {
      const response = await fixture.fetchSocket(path, { method })
      const control = await fixture.fetchSocket('/v1/server/removed-route-control', { method })
      expect(response.status).toBe(404)
      expect(control.status).toBe(404)
      expect(await response.text()).toBe(await control.text())
    }
    const live = await fixture.fetchSocket('/v1/server/subscribers')
    expect(live.status).toBe(200)
    expect(await live.json()).toEqual({ active: [], recentlyClosed: [] })
  })

  it('rejects new central dispatch with a distinct retryable code until its owner reopens', async () => {
    const { hostSessionId } = await fixture.resolveSession(
      'agent:cody:project:hrc-runtime:task:T-06576'
    )
    expect(server.turnAdmissionGate.snapshot()).toEqual({
      state: 'open',
      activeAdmissions: 0,
      durable: false,
    })

    const close = await server.turnAdmissionGate.close({
      operationId: 'restart-test',
      requestedBy: 'entity:operator',
      reason: 'test close',
    })
    expect(close).toMatchObject({
      state: 'closed',
      operationId: 'restart-test',
      activeAdmissions: 0,
      durable: true,
    })

    const rejected = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'must not be admitted',
      runtimeIntent: headlessIntent(),
      waitFor: 'accepted',
    })
    expect(rejected.status).toBe(503)
    expect(await rejected.json()).toMatchObject({
      error: {
        code: 'server_draining',
        detail: { retryable: true, operationId: 'restart-test' },
      },
    })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runs.listRuns({ hostSessionId })).toEqual([])
    } finally {
      db.close()
    }

    await expect(server.turnAdmissionGate.reopen('someone-else')).rejects.toThrow()
    const reopened = await server.turnAdmissionGate.reopen('restart-test')
    expect(reopened).toEqual({
      state: 'open',
      activeAdmissions: 0,
      durable: false,
    })
  })

  it('keeps replacement startup closed through warmup, then reopens before ready', async () => {
    await server.turnAdmissionGate.close({
      operationId: 'restart-persisted',
    })
    expect(await Bun.file(turnAdmissionMarkerPath(fixture.runtimeRoot)).exists()).toBe(true)

    await server.stop()
    server = (await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false })
    )) as typeof server

    expect(server.turnAdmissionGate.snapshot()).toEqual({
      state: 'open',
      activeAdmissions: 0,
      durable: false,
    })
    expect(await Bun.file(turnAdmissionMarkerPath(fixture.runtimeRoot)).exists()).toBe(false)
  })
})
