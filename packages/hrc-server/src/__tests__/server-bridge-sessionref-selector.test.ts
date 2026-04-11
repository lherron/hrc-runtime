import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcLocalBridgeRecord } from 'hrc-core'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-bridge-sessionref-')
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('POST /v1/bridges/target — sessionRef selector', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(fixture.serverOpts())
  })

  afterEach(async () => {
    await server.stop()
  })

  it('resolves the active session by canonical sessionRef', async () => {
    const scopeRef = 'agent:larry:project:agent-spaces:task:T-01082'
    const sessionRef = `${scopeRef}/lane:default`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)

    const ensureRes = await fixture.postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: fixture.tmpDir },
        harness: { provider: 'anthropic', interactive: true },
      },
      restartStyle: 'reuse_pty',
    })
    expect(ensureRes.status).toBe(200)
    const runtime = (await ensureRes.json()) as { runtimeId: string }

    const bridgeRes = await fixture.postJson('/v1/bridges/target', {
      selector: { sessionRef },
      transport: 'tmux',
      target: 'sessionref-pane@test',
      runtimeId: runtime.runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    expect(bridgeRes.status).toBe(200)
    const bridge = (await bridgeRes.json()) as HrcLocalBridgeRecord
    expect(bridge.hostSessionId).toBe(hostSessionId)
    expect(bridge.runtimeId).toBe(runtime.runtimeId)
    expect(bridge.transport).toBe('tmux')
    expect(bridge.target).toBe('sessionref-pane@test')
  })
})
