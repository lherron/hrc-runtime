import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

const incidentScope = 'agent:cody:project:agent-spaces:task:e2e-T-06423-appserver'

function codexIntent(interactive: boolean): HrcRuntimeIntent {
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
      interactive,
      id: 'codex-cli',
    },
    execution: {
      preferredMode: interactive ? 'interactive' : 'headless',
    },
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-failed-start-attach-by-id-')
  server = await createHrcServer(
    fixture.serverOpts({
      headlessCodexBrokerEnabled: false,
      codexCliTmuxBrokerEnabled: true,
    })
  )
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

describe('retired headless CLI start', () => {
  it('fails before allocating a runtime row while preserving the resolved host session', async () => {
    const resolved = await fixture.resolveSession(incidentScope)

    const response = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: resolved.hostSessionId,
      intent: codexIntent(false),
    })
    const body = (await response.json()) as {
      error?: { code?: string; message?: string }
    }

    expect(response.status).toBe(503)
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.message).toContain('headless CLI start path retired for broker cutover')
    expect(body.error?.message).toContain('provision via the first broker dispatch turn instead')

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.listByHostSessionId(resolved.hostSessionId)).toEqual([])
    } finally {
      db.close()
    }

    const resolvedAgain = await fixture.resolveSession(incidentScope)
    expect(resolvedAgain.hostSessionId).toBe(resolved.hostSessionId)
  })
})

type AttachScenario = {
  requestedRuntimeId: string
  siblingRuntimeId: string
}

async function seedAttachRedirectScenario(
  requestedStatus: 'ready' | 'stale'
): Promise<AttachScenario> {
  if (!server) throw new Error('server not initialized')

  const resolved = await fixture.resolveSession(incidentScope)
  const requestedRuntimeId = `rt-requested-${requestedStatus}`
  const siblingRuntimeId = `rt-sibling-${requestedStatus}`
  const requestedCreatedAt = '2026-07-15T23:48:53.000Z'
  const siblingCreatedAt = '2026-07-15T23:49:27.000Z'

  const db = openHrcDatabase(fixture.dbPath)
  let siblingRuntime: HrcRuntimeSnapshot
  try {
    db.sessions.updateIntent(resolved.hostSessionId, codexIntent(true), requestedCreatedAt)
    db.runtimes.insert({
      runtimeId: requestedRuntimeId,
      hostSessionId: resolved.hostSessionId,
      scopeRef: incidentScope,
      laneRef: 'default',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: requestedStatus,
      supportsInflightInput: false,
      adopted: false,
      createdAt: requestedCreatedAt,
      updatedAt: requestedCreatedAt,
    })
    siblingRuntime = db.runtimes.insert({
      runtimeId: siblingRuntimeId,
      hostSessionId: resolved.hostSessionId,
      scopeRef: incidentScope,
      laneRef: 'default',
      generation: resolved.generation,
      transport: 'tmux',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      controllerKind: 'harness-broker',
      tmuxJson: {
        socketPath: fixture.tmuxSocketPath,
        sessionName: `hrc-${siblingRuntimeId}`,
        windowName: 'tui',
        windowId: '@2',
        paneId: '%2',
        brokerDriver: 'codex-cli-tmux',
      },
      supportsInflightInput: true,
      adopted: false,
      createdAt: siblingCreatedAt,
      updatedAt: siblingCreatedAt,
    })
  } finally {
    db.close()
  }

  const mutableServer = server as HrcServer & {
    reconcileTmuxRuntimeLiveness(runtime: HrcRuntimeSnapshot): Promise<HrcRuntimeSnapshot>
    startRuntimeForSession(): Promise<HrcRuntimeSnapshot>
  }
  mutableServer.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
  mutableServer.startRuntimeForSession = async () => siblingRuntime

  return { requestedRuntimeId, siblingRuntimeId }
}

type AttachBody = {
  bindingFence?: { runtimeId?: string }
  error?: { code?: string }
}

describe('attach by explicit runtime id', () => {
  for (const requestedStatus of ['stale', 'ready'] as const) {
    const admission = requestedStatus === 'stale' ? 'broker-start' : 'stale-and-reprovision'

    it(`GET /v1/attach never returns a sibling after ${admission}`, async () => {
      const { requestedRuntimeId, siblingRuntimeId } =
        await seedAttachRedirectScenario(requestedStatus)

      const response = await fixture.fetchSocket(
        `/v1/attach?runtimeId=${encodeURIComponent(requestedRuntimeId)}`
      )
      const body = (await response.json()) as AttachBody

      expect([200, 503]).toContain(response.status)
      if (response.status === 200) {
        expect(body.bindingFence?.runtimeId).toBe(requestedRuntimeId)
        expect(body.bindingFence?.runtimeId).not.toBe(siblingRuntimeId)
      } else {
        expect(body.error?.code).toBe('runtime_unavailable')
      }
    })
  }

  it('POST /v1/runtimes/attach retains scope-attach reprovision to the sibling runtime', async () => {
    const { requestedRuntimeId, siblingRuntimeId } = await seedAttachRedirectScenario('stale')

    const response = await fixture.postJson('/v1/runtimes/attach', {
      runtimeId: requestedRuntimeId,
    })
    const body = (await response.json()) as AttachBody

    expect(response.status).toBe(200)
    expect(body.bindingFence?.runtimeId).toBe(siblingRuntimeId)
  })
})
