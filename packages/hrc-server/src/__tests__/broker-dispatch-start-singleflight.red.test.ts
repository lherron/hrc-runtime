/**
 * RED acceptance test for T-06313.
 *
 * Two dispatch turns that cross while an empty host session is provisioning must
 * share one broker start. The second turn is queued behind that boot instead of
 * provisioning a second runtime for the same session.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

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

function seedColdDurableHeadlessRuntime(hostSessionId: string, generation: number): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = new Date().toISOString()
  const outsideRuntimeRoot = join(fixture.tmpDir, 'outside-runtime-root')
  try {
    db.runtimes.insert({
      runtimeId: 'rt-t07196-cold-durable',
      hostSessionId,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'stale',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId: 'rt-t07196-cold-durable',
        hostSessionId,
        generation,
        status: 'stale',
        broker: {
          endpoint: {
            kind: 'unix-jsonrpc-ndjson',
            protocolVersion: 'harness-broker/0.2',
            socketPath: join(outsideRuntimeRoot, 'broker.sock'),
            attachTokenRef: {
              kind: 'file',
              path: join(outsideRuntimeRoot, 'attach.token'),
              redacted: true,
            },
          },
          substrate: {
            kind: 'leased-tmux',
            tmuxSocketPath: join(outsideRuntimeRoot, 'tmux.sock'),
            sessionName: 'hrc-codex-cli-t07196',
            brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
            generation,
            eventLedgerPath: join(outsideRuntimeRoot, 'events.ndjson'),
          },
          presentation: { kind: 'none' },
        },
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
  } finally {
    db.close()
  }
}

function seedFailedDurableHeadlessRuntime(hostSessionId: string, generation: number): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = new Date().toISOString()
  const runtimeId = 'rt-t07031-failed-durable'
  const invocationId = 'inv-t07031-failed-durable'
  const runtimeRoot = join(fixture.tmpDir, 'runtime')
  try {
    db.sessions.updateContinuation(
      hostSessionId,
      { provider: 'openai', kind: 'thread', key: 'thread-t07031-stored' },
      now
    )
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'crashed',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: 'op-t07031-failed-durable',
      activeInvocationId: invocationId,
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId,
        hostSessionId,
        generation,
        status: 'crashed',
        broker: {
          endpoint: {
            kind: 'unix-jsonrpc-ndjson',
            protocolVersion: 'harness-broker/0.2',
            socketPath: join(runtimeRoot, runtimeId, 'broker.sock'),
            attachTokenRef: {
              kind: 'file',
              path: join(runtimeRoot, runtimeId, 'attach.token'),
              redacted: true,
            },
          },
          substrate: {
            kind: 'leased-tmux',
            tmuxSocketPath: join(runtimeRoot, runtimeId, 'tmux.sock'),
            sessionName: 'hrc-codex-cli-t07031',
            brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
            generation,
            eventLedgerPath: join(runtimeRoot, runtimeId, 'events.ndjson'),
          },
          presentation: { kind: 'none' },
        },
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    db.brokerInvocations.insert({
      invocationId,
      operationId: 'op-t07031-failed-durable',
      runtimeId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'failed',
      capabilitiesJson: JSON.stringify({}),
      specHash: 'sha256:t07031-spec',
      startRequestHash: 'sha256:t07031-request',
      selectedProfileHash: 'sha256:t07031-profile',
      lifecycleTerminalReason: 'invalid peer certificate: UnsupportedCertVersion',
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

describe('headless broker dispatch start single-flight', () => {
  it('returns a detached dispatch without waiting for an observational presentation publisher', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    const db = openHrcDatabase(fixture.dbPath)
    const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
    db.close()
    expect(session).toBeDefined()

    const now = new Date().toISOString()
    let compilerPrimingAllowed = false
    ;(server as any).startHeadlessBrokerRuntime = async (
      _session: unknown,
      _intent: unknown,
      _prompt: unknown,
      _runId: unknown,
      options: { allowCompilerInitialInputWithoutIdentity?: boolean }
    ) => {
      compilerPrimingAllowed = options.allowCompilerInitialInputWithoutIdentity === true
      return {
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
      }
    }
    let presentationStarted = false
    ;(server as any).publishPresentation = async () => {
      presentationStarted = true
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
        throw new Error('detached dispatch waited for the observational presentation publisher')
      }),
    ])

    expect(response.status).toBe(200)
    expect(presentationStarted).toBe(true)
    // T-07963: a dispatch WITH a caller prompt allocates a real input identity,
    // so the identity-less compiler-priming escape hatch is not requested. It
    // survives only for the promptless boot, which has nothing to bind.
    expect(compilerPrimingAllowed).toBe(false)
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

  it('holds a turn joining lifecycle boot until compiler priming is terminal', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    const db = openHrcDatabase(fixture.dbPath)
    const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
    db.close()
    expect(session).toBeDefined()

    const planHash = 'plan-t07880-joining-priming'
    const profileHash = 'profile-t07880-joining-priming'
    const invocationId = 'inv-t07880-joining-priming'
    const submissionId = 'input-t07880-compiler-priming'
    const turnId = 'turn-t07880-compiler-priming'
    const runtime = {
      runtimeId: 'rt-t07880-joining-priming',
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
      activeOperationId: 'op-t07880-joining-priming',
      activeInvocationId: invocationId,
      planHash,
      selectedProfileHash: profileHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    ;(server as any).db.compiledRuntimePlans.insert({
      planHash,
      compileId: 'compile-t07880-joining-priming',
      schemaVersion: 'agent-runtime-plan/v1',
      compilerName: 'agent-spaces',
      compilerVersion: 'test',
      planProjectionJson: JSON.stringify({
        executionProfiles: [
          {
            profileHash,
            harnessInvocation: { startRequest: { initialInput: { inputId: submissionId } } },
          },
        ],
      }),
      createdAt: new Date().toISOString(),
    })
    ;(server as any).runtimeStartOperations.set(resolved.hostSessionId, Promise.resolve(runtime))

    let queuedDispatchCalls = 0
    ;(server as any).dispatchQueuedHeadlessTurnInput = async () => {
      queuedDispatchCalls += 1
      return Response.json({ ok: true })
    }

    const dispatch = (server as any).handleHeadlessBrokerDispatchTurn(
      session,
      headlessBrokerIntent(),
      'caller turn joining lifecycle boot',
      'run-t07880-joining-priming',
      { waitForCompletion: false }
    ) as Promise<Response>
    await Bun.sleep(0)
    expect(queuedDispatchCalls).toBe(0)

    const append = (seq: number, type: string, payload: Record<string, unknown>) => {
      const time = new Date(Date.UTC(2026, 8, 2, 8, 0, seq)).toISOString()
      ;(server as any).db.brokerInvocationEvents.appendEvent({
        invocationId,
        seq,
        time,
        type,
        runtimeId: runtime.runtimeId,
        runId: 'run-t07880-joining-priming',
        payload,
        envelopeJson: JSON.stringify({ invocationId, seq, time, type, payload }),
      })
      for (const subscriber of (server as any).rawBrokerSubscribers) {
        subscriber({ record: { invocationId } })
      }
    }
    append(1, 'submission.executed', { submissionId, turnId })
    await Bun.sleep(0)
    expect(queuedDispatchCalls).toBe(0)

    append(2, 'turn.completed', { turnId, status: 'completed' })
    await dispatch
    expect(queuedDispatchCalls).toBe(1)
  })

  it('holds single-flight ownership while a cold durable runtime is reattached or replaced', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    const db = openHrcDatabase(fixture.dbPath)
    const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
    db.close()
    expect(session).toBeDefined()
    seedColdDurableHeadlessRuntime(resolved.hostSessionId, resolved.generation)

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
      const now = new Date().toISOString()
      return {
        runtimeId: `rt-t07196-fresh-${call}`,
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
        activeOperationId: `op-t07196-${call}`,
        activeInvocationId: `inv-t07196-${call}`,
        createdAt: now,
        updatedAt: now,
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
      'first cold durable dispatch',
      'run-t07196-first',
      { waitForCompletion: false }
    ) as Promise<Response>
    const secondDispatch = (server as any).handleHeadlessBrokerDispatchTurn(
      session,
      headlessBrokerIntent(),
      'second cold durable dispatch',
      'run-t07196-second',
      { waitForCompletion: false }
    ) as Promise<Response>

    await firstStart
    await Bun.sleep(0)
    const startsWhileBothDispatchesAreInFlight = startCalls
    releaseStart()

    const [firstResponse, secondResponse] = await Promise.all([firstDispatch, secondDispatch])
    const [firstBody, secondBody] = await Promise.all([
      firstResponse.json() as Promise<{ runtimeId: string; runId: string }>,
      secondResponse.json() as Promise<{ runtimeId: string; runId: string }>,
    ])

    expect({
      startsWhileBothDispatchesAreInFlight,
      startCalls,
      queuedDispatchCalls,
      runtimeStartOperationCount: (server as any).runtimeStartOperations.size,
      runtimeIds: [firstBody.runtimeId, secondBody.runtimeId],
      runIds: [firstBody.runId, secondBody.runId],
    }).toEqual({
      startsWhileBothDispatchesAreInFlight: 1,
      startCalls: 1,
      queuedDispatchCalls: 1,
      runtimeStartOperationCount: 0,
      runtimeIds: ['rt-t07196-fresh-1', 'rt-t07196-fresh-1'],
      runIds: ['run-t07196-first', 'run-t07196-second'],
    })
  })

  it('starts a fresh invocation on the stored continuation after a definitive durable failure', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    seedFailedDurableHeadlessRuntime(resolved.hostSessionId, resolved.generation)
    const db = openHrcDatabase(fixture.dbPath)
    const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
    db.close()
    expect(session).toBeDefined()

    const cleanupCalls: Array<{ runtimeId: string; dropContinuation?: boolean }> = []
    const starts: Array<{ continuation: unknown; prompt: string; runId: string }> = []
    const invokedPrompts: string[] = []
    ;(server as any).terminateRuntime = async (
      runtime: { runtimeId: string },
      options: { dropContinuation?: boolean }
    ) => {
      cleanupCalls.push({ runtimeId: runtime.runtimeId, ...options })
      return Response.json({ ok: true })
    }
    ;(server as any).startHeadlessBrokerRuntime = async (
      startSession: { continuation?: unknown },
      _intent: unknown,
      prompt: string,
      runId: string
    ) => {
      starts.push({ continuation: startSession.continuation, prompt, runId })
      const now = new Date().toISOString()
      return {
        runtimeId: 'rt-t07031-fresh',
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
        activeOperationId: 'op-t07031-fresh',
        activeInvocationId: 'inv-t07031-fresh',
        createdAt: now,
        updatedAt: now,
      }
    }
    ;(server as any).publishPresentation = async () => undefined
    ;(server as any).executeHeadlessBrokerInputTurn = async (
      _session: unknown,
      _runtime: unknown,
      prompt: string
    ) => {
      invokedPrompts.push(prompt)
      return Response.json({ ok: true })
    }

    const response = await (server as any).handleHeadlessBrokerDispatchTurn(
      session,
      headlessBrokerIntent(),
      'fresh turn after exhausted retries',
      'run-t07031-fresh',
      { waitForCompletion: false }
    )
    const body = (await response.json()) as { runtimeId: string }
    await Bun.sleep(0)

    expect(cleanupCalls).toEqual([
      { runtimeId: 'rt-t07031-failed-durable', dropContinuation: false },
    ])
    expect(starts).toEqual([
      {
        continuation: { provider: 'openai', kind: 'thread', key: 'thread-t07031-stored' },
        // T-07963: the caller prompt rides the fresh start rather than a
        // follow-up invoke, so the retry's replacement invocation carries the
        // delivery itself.
        prompt: 'fresh turn after exhausted retries',
        runId: 'run-t07031-fresh',
      },
    ])
    expect(invokedPrompts).toEqual([])
    expect(body.runtimeId).toBe('rt-t07031-fresh')
    expect((server as any).runtimeStartOperations.size).toBe(0)
  })
})
