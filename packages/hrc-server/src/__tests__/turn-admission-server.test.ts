import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { turnAdmissionMarkerPath } from '../turn-admission-gate.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-turn-admission-server-')
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
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
  it('rejects new central dispatch with a distinct retryable code until its owner reopens', async () => {
    const { hostSessionId } = await fixture.resolveSession(
      'agent:cody:project:hrc-runtime:task:T-06576'
    )
    expect(await (await fixture.fetchSocket('/v1/server/turn-admission')).json()).toEqual({
      state: 'open',
      activeAdmissions: 0,
      durable: false,
    })

    const close = await fixture.postJson('/v1/server/turn-admission/close', {
      operationId: 'restart-test',
      requestedBy: 'entity:operator',
      reason: 'test close',
    })
    expect(close.status).toBe(200)
    expect(await close.json()).toMatchObject({
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

    const wrong = await fixture.postJson('/v1/server/turn-admission/reopen', {
      operationId: 'someone-else',
    })
    expect(wrong.status).toBe(409)

    const reopened = await fixture.postJson('/v1/server/turn-admission/reopen', {
      operationId: 'restart-test',
    })
    expect(reopened.status).toBe(200)
    expect(await reopened.json()).toEqual({
      state: 'open',
      activeAdmissions: 0,
      durable: false,
    })
  })

  it('keeps replacement startup closed through warmup, then reopens before ready', async () => {
    const close = await fixture.postJson('/v1/server/turn-admission/close', {
      operationId: 'restart-persisted',
    })
    expect(close.status).toBe(200)
    expect(await Bun.file(turnAdmissionMarkerPath(fixture.runtimeRoot)).exists()).toBe(true)

    await server.stop()
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    expect(await (await fixture.fetchSocket('/v1/server/turn-admission')).json()).toEqual({
      state: 'open',
      activeAdmissions: 0,
      durable: false,
    })
    expect(await Bun.file(turnAdmissionMarkerPath(fixture.runtimeRoot)).exists()).toBe(false)
  })
})
