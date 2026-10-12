/**
 * T-10760: concurrent GET /v1/attach callers for one runtime are coalesced onto
 * a single attach operation. Each caller must still receive its own descriptor
 * body. A shared Response can be consumed once, so every waiter but one used to
 * get `200` with an empty body, which the SDK's `res.json()` over the unix
 * socket resolved to `null` (ACP's mobile attach-info then threw on
 * `descriptor.argv`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

const scope = 'agent:cody:project:hrc-runtime:task:T-10760'

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-attach-concurrent-')
  server = await createHrcServer(fixture.serverOpts({ codexCliTmuxBrokerEnabled: true }))
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

async function seedBrokerTmuxRuntime(): Promise<string> {
  if (!server) throw new Error('server not initialized')
  const resolved = await fixture.resolveSession(scope)
  const runtimeId = 'rt-concurrent-attach'
  const createdAt = '2026-10-12T16:40:00.000Z'
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.runtimes.insert({
      runtimeId,
      hostSessionId: resolved.hostSessionId,
      scopeRef: scope,
      laneRef: 'default',
      generation: resolved.generation,
      transport: 'tmux',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'busy',
      controllerKind: 'harness-broker',
      tmuxJson: {
        socketPath: fixture.tmuxSocketPath,
        sessionName: `hrc-${runtimeId}`,
        windowName: 'tui',
        windowId: '@2',
        paneId: '%2',
        brokerDriver: 'codex-cli-tmux',
      },
      supportsInflightInput: true,
      createdAt,
      updatedAt: createdAt,
    })
  } finally {
    db.close()
  }

  // Hold the liveness probe open long enough that every request below joins
  // the same in-flight attach operation, as a real tmux probe does under load.
  const mutableServer = server as HrcServer & {
    reconcileTmuxRuntimeLiveness(runtime: HrcRuntimeSnapshot): Promise<HrcRuntimeSnapshot>
  }
  mutableServer.reconcileTmuxRuntimeLiveness = async (runtime) => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return runtime
  }
  return runtimeId
}

describe('GET /v1/attach with concurrent callers', () => {
  it('serves every coalesced caller a full descriptor body', async () => {
    const runtimeId = await seedBrokerTmuxRuntime()

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        fixture.fetchSocket(`/v1/attach?runtimeId=${encodeURIComponent(runtimeId)}`)
      )
    )
    const bodies = await Promise.all(responses.map((response) => response.text()))

    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(200))
    for (const body of bodies) {
      const parsed = JSON.parse(body) as { argv?: string[]; bindingFence?: { runtimeId?: string } }
      expect(parsed.bindingFence?.runtimeId).toBe(runtimeId)
      expect(parsed.argv?.at(-1)).toContain(`hrc-${runtimeId}`)
    }
  })

  it('never resolves a null descriptor through the SDK', async () => {
    const runtimeId = await seedBrokerTmuxRuntime()
    const client = new HrcClient(fixture.socketPath)

    const descriptors = await Promise.all(
      Array.from({ length: 6 }, () => client.getAttachDescriptor(runtimeId))
    )

    for (const descriptor of descriptors) {
      expect(descriptor).not.toBeNull()
      expect(descriptor.bindingFence.runtimeId).toBe(runtimeId)
    }
  })
})
