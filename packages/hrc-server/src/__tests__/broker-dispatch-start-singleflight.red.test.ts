/**
 * RED acceptance test for T-06313.
 *
 * Two dispatch turns that cross while an empty host session is provisioning must
 * share one broker start. The second turn is queued behind that boot instead of
 * provisioning a second runtime for the same session.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE_REF = 'agent:room-tester:project:hrc-runtime:task:T-06313'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('h63-')
  server = await createHrcServer(
    fixture.serverOpts({ headlessCodexBrokerEnabled: true, otelListenerEnabled: false })
  )
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

function headlessBrokerIntent() {
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
      id: 'codex-cli',
      interactive: false,
    },
    execution: {
      preferredMode: 'headless',
    },
  }
}

describe('headless broker dispatch start single-flight', () => {
  it('returns a detached dispatch without waiting for an observational viewer', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    const db = openHrcDatabase(fixture.dbPath)
    const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
    db.close()
    expect(session).toBeDefined()

    const now = new Date().toISOString()
    ;(server as any).startHeadlessBrokerRuntime = async () => ({
      runtimeId: 'rt-t06313-viewer-timeout',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      runtimeStateJson: {
        broker: {
          endpoint: { kind: 'stdio-jsonrpc-ndjson' },
          substrate: { kind: 'daemon-child' },
          presentation: {
            kind: 'tmux-tui',
            tuiWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    })
    let viewerStarted = false
    ;(server as any).spawnBrokerHeadlessViewer = async () => {
      viewerStarted = true
      return await new Promise(() => undefined)
    }

    const response = await Promise.race([
      (server as any).executeHeadlessBrokerStartTurn(
        session,
        headlessBrokerIntent(),
        'detached turn',
        'run-t06313-viewer-timeout',
        { waitForCompletion: false }
      ) as Promise<Response>,
      Bun.sleep(250).then(() => {
        throw new Error('detached dispatch waited for the observational viewer')
      }),
    ])

    expect(response.status).toBe(200)
    expect(viewerStarted).toBe(true)
  })

  it('converges crossing dispatches for one empty host session onto one broker start', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    const db = openHrcDatabase(fixture.dbPath)
    const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
    db.close()
    expect(session).toBeDefined()

    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    let firstStartEntered!: () => void
    const firstStart = new Promise<void>((resolve) => {
      firstStartEntered = resolve
    })
    let startCalls = 0
    let queuedDispatchCalls = 0
    ;(server as any).startHeadlessBrokerRuntime = async () => {
      startCalls += 1
      firstStartEntered()
      const call = startCalls
      await startGate

      const runtimeDb = openHrcDatabase(fixture.dbPath)
      const now = new Date().toISOString()
      const runtimeId = `rt-t06313-${call}`
      try {
        runtimeDb.runtimes.insert({
          runtimeId,
          hostSessionId: resolved.hostSessionId,
          scopeRef: SCOPE_REF,
          laneRef: 'default',
          generation: resolved.generation,
          transport: 'headless',
          harness: 'codex-cli',
          provider: 'openai',
          status: 'ready',
          supportsInflightInput: false,
          adopted: false,
          controllerKind: 'harness-broker',
          activeOperationId: `op-t06313-${call}`,
          activeInvocationId: `inv-t06313-${call}`,
          createdAt: now,
          updatedAt: now,
        })
        return runtimeDb.runtimes.getByRuntimeId(runtimeId)
      } finally {
        runtimeDb.close()
      }
    }
    ;(server as any).dispatchQueuedHeadlessTurnInput = async (
      queuedSession: { hostSessionId: string; generation: number },
      runtime: { runtimeId: string },
      _prompt: string,
      runId: string
    ) => {
      queuedDispatchCalls += 1
      return Response.json({
        runId,
        hostSessionId: queuedSession.hostSessionId,
        generation: queuedSession.generation,
        runtimeId: runtime.runtimeId,
        transport: 'headless',
        status: 'started',
        supportsInFlightInput: false,
      })
    }

    const firstDispatch = (server as any).handleHeadlessBrokerDispatchTurn(
      session,
      headlessBrokerIntent(),
      'first crossing DM',
      'run-t06313-first',
      { waitForCompletion: false }
    ) as Promise<Response>
    await firstStart

    const secondDispatch = (server as any).handleHeadlessBrokerDispatchTurn(
      session,
      headlessBrokerIntent(),
      'second crossing DM',
      'run-t06313-second',
      { waitForCompletion: false }
    ) as Promise<Response>
    const startsWhileBothDispatchesAreInFlight = startCalls

    releaseStart()
    const results = await Promise.allSettled([firstDispatch, secondDispatch])

    const inspectionDb = openHrcDatabase(fixture.dbPath)
    try {
      expect({
        startsWhileBothDispatchesAreInFlight,
        runtimeCount: inspectionDb.runtimes.listByHostSessionId(resolved.hostSessionId).length,
        queuedDispatchCalls,
        secondDispatchStatus: results[1]?.status,
      }).toEqual({
        startsWhileBothDispatchesAreInFlight: 1,
        runtimeCount: 1,
        queuedDispatchCalls: 1,
        secondDispatchStatus: 'fulfilled',
      })
    } finally {
      inspectionDb.close()
    }
  })
})
