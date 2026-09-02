import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:broker-session-open'
const RUNTIME_ID = 'rt-broker-session-open'
const INVOCATION_ID = 'inv-broker-session-open'
const OPERATION_ID = 'op-broker-session-open'
const ACTIVE_RUN_ID = 'run-broker-session-open-active'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-broker-session-open-')
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

function seedReusableBrokerRuntime(
  hostSessionId: string,
  generation: number,
  options: {
    activeRunId?: string | undefined
    capabilitiesJson?: { admission?: { classes?: string[] } } | undefined
    durable?: boolean | undefined
    status?: string | undefined
  } = {}
) {
  const db = openHrcDatabase(fixture.dbPath)
  const now = new Date().toISOString()
  const activeRunId = options.activeRunId
  try {
    const runtime = db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      hostSessionId,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: options.status ?? 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: OPERATION_ID,
      activeInvocationId: INVOCATION_ID,
      activeRunId,
      ...(options.durable
        ? {
            runtimeStateJson: {
              schemaVersion: 'runtime-state/v1',
              kind: 'harness-broker',
              runtimeId: RUNTIME_ID,
              hostSessionId,
              generation,
              status: options.status ?? 'ready',
              broker: {
                protocolVersion: 'harness-broker/0.2',
                generation,
                endpoint: {
                  kind: 'unix-jsonrpc-ndjson',
                  socketPath: `${fixture.runtimeRoot}/broker.sock`,
                  attachTokenRef: {
                    kind: 'file',
                    path: `${fixture.runtimeRoot}/attach.token`,
                    redacted: true,
                  },
                },
                brokerWindow: {
                  socketPath: `${fixture.runtimeRoot}/btmux.sock`,
                  sessionName: `hrc-codex-app-server-${RUNTIME_ID}`,
                  sessionId: '$0',
                  windowId: '@0',
                  paneId: '%0',
                },
              },
            },
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    })
    if (activeRunId !== undefined) {
      db.runs.insert({
        runId: activeRunId,
        hostSessionId,
        runtimeId: RUNTIME_ID,
        scopeRef: SCOPE_REF,
        laneRef: 'default',
        generation,
        transport: 'headless',
        status: 'started',
        acceptedAt: now,
        startedAt: now,
        updatedAt: now,
        operationId: OPERATION_ID,
        invocationId: INVOCATION_ID,
      })
    }
    db.brokerInvocations.insert({
      invocationId: INVOCATION_ID,
      operationId: OPERATION_ID,
      runtimeId: RUNTIME_ID,
      runId: activeRunId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: activeRunId !== undefined ? 'turn_active' : 'ready',
      capabilitiesJson: JSON.stringify(
        options.capabilitiesJson ?? {
          admission: { classes: ['steer', 'queue', 'exclusive', 'preempt'] },
        }
      ),
      specHash: 'sha256:broker-session-open-spec',
      startRequestHash: 'sha256:broker-session-open-start',
      selectedProfileHash: 'sha256:broker-session-open-profile',
      createdAt: now,
      updatedAt: now,
    })
    return runtime
  } finally {
    db.close()
  }
}

function runtimeSideEffects(hostSessionId: string) {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return {
      runIds: db.runs.listRuns({ hostSessionId }).map((run) => run.runId),
      userPromptCount: db.hrcEvents.listByKind('turn.user_prompt', { hostSessionId }).length,
      runtimeActiveRunId: db.runtimes.getByRuntimeId(RUNTIME_ID)?.activeRunId,
    }
  } finally {
    db.close()
  }
}

function installSubmissionFailFast() {
  const calls: unknown[] = []
  ;(server as any).getHarnessBrokerController = () => ({
    enqueue: async (request: unknown) => {
      calls.push(request)
      return { ok: true, response: { submissionId: 'unexpected', admission: 'admitted' } }
    },
  })
  return calls
}

function installSeatProbe(state: 'idle' | 'turn-active' = 'idle') {
  ;(server as any).getHarnessBrokerController = () => ({
    seatProbe: async () => ({
      ok: true,
      response: {
        invocationId: INVOCATION_ID,
        seat:
          state === 'idle'
            ? { state: 'idle' }
            : { state: 'turn-active', turnId: 'turn-active', policy: 'open' },
        brokerHeldDepth: 0,
      },
    }),
  })
}

function installPresentationPublishSpy() {
  const runtimeIds: string[] = []
  ;(server as any).publishPresentation = async (runtime: { runtimeId: string }) => {
    runtimeIds.push(runtime.runtimeId)
  }
  return runtimeIds
}

describe('POST /v1/broker-sessions/open', () => {
  it('opens an invocation-level broker session without creating a turn run', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation)
    const presentationRuntimeIds = installPresentationPublishSpy()

    const res = await fixture.postJson('/v1/broker-sessions/open', {
      hostSessionId: resolved.hostSessionId,
      runtimeIntent: headlessBrokerIntent(),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      hostSessionId: resolved.hostSessionId,
      generation: resolved.generation,
      runtimeId: RUNTIME_ID,
      transport: 'headless',
      status: 'ready',
      startIdentity: { kind: 'broker', invocationId: INVOCATION_ID },
      supportsInputQueue: true,
    })
    expect(body.observation.broker.selector).toEqual({
      invocationId: INVOCATION_ID,
      runtimeId: RUNTIME_ID,
      generation: resolved.generation,
    })
    expect(body.observation.broker.selector.runId).toBeUndefined()
    expect(presentationRuntimeIds).toEqual([RUNTIME_ID])

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runs.listRuns({ hostSessionId: resolved.hostSessionId })).toHaveLength(0)
      expect(
        db.hrcEvents.listByKind('turn.user_prompt', { hostSessionId: resolved.hostSessionId })
      ).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('returns without waiting for an observational presentation publisher that never settles', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation)
    let presentationStarted = false
    ;(server as any).publishPresentation = async () => {
      presentationStarted = true
      return await new Promise(() => undefined)
    }

    const res = await Promise.race([
      fixture.postJson('/v1/broker-sessions/open', {
        hostSessionId: resolved.hostSessionId,
        runtimeIntent: headlessBrokerIntent(),
      }),
      Bun.sleep(250).then(() => {
        throw new Error('broker session open waited for the observational presentation publisher')
      }),
    ])

    expect(res.status).toBe(200)
    expect(presentationStarted).toBe(true)
  })

  it('publishes presentation after recovering a durable broker session', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation, {
      durable: true,
      status: 'stale',
    })
    const presentationRuntimeIds = installPresentationPublishSpy()
    ;(server as any).reattachDurableBrokerSessionForOpen = async (runtime: {
      runtimeId: string
      runtimeStateJson?: Record<string, unknown>
    }) => {
      ;(server as any).db.runtimes.update(runtime.runtimeId, {
        status: 'ready',
        updatedAt: new Date().toISOString(),
        runtimeStateJson: { ...runtime.runtimeStateJson, status: 'ready' },
      })
      return { state: 'reattached' as const }
    }
    ;(server as any).startHeadlessBrokerRuntime = async () => {
      throw new Error('durable recovery must not provision a replacement runtime')
    }

    const res = await fixture.postJson('/v1/broker-sessions/open', {
      hostSessionId: resolved.hostSessionId,
      runtimeIntent: headlessBrokerIntent(),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      runtimeId: RUNTIME_ID,
      status: 'ready',
      startIdentity: { kind: 'broker', invocationId: INVOCATION_ID },
    })
    expect(presentationRuntimeIds).toEqual([RUNTIME_ID])
  })

  it('reuses a busy queue-capable broker session without turn side effects', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation, {
      activeRunId: ACTIVE_RUN_ID,
    })
    const submissionCalls = installSubmissionFailFast()
    const before = runtimeSideEffects(resolved.hostSessionId)

    const res = await fixture.postJson('/v1/broker-sessions/open', {
      hostSessionId: resolved.hostSessionId,
      runtimeIntent: headlessBrokerIntent(),
    })

    // T-05131 RED: session-open admission must not reject solely because a
    // queue-capable broker invocation is still handling runless priming or
    // earlier active input. It should expose the same broker session for the
    // caller's first explicit queued turn without creating turn/run side effects.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      hostSessionId: resolved.hostSessionId,
      runtimeId: RUNTIME_ID,
      status: 'ready',
      startIdentity: { kind: 'broker', invocationId: INVOCATION_ID },
      supportsInputQueue: true,
    })
    expect(body.observation.broker.selector).toEqual({
      invocationId: INVOCATION_ID,
      runtimeId: RUNTIME_ID,
      generation: resolved.generation,
    })
    expect(runtimeSideEffects(resolved.hostSessionId)).toEqual(before)
    expect(submissionCalls).toHaveLength(0)
  })

  it('opens a busy broker session without admitting work when queue is not advertised', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation, {
      activeRunId: ACTIVE_RUN_ID,
      capabilitiesJson: { admission: { classes: ['steer', 'exclusive'] } },
    })
    const submissionCalls = installSubmissionFailFast()
    const presentationRuntimeIds = installPresentationPublishSpy()
    const before = runtimeSideEffects(resolved.hostSessionId)

    const res = await fixture.postJson('/v1/broker-sessions/open', {
      hostSessionId: resolved.hostSessionId,
      runtimeIntent: headlessBrokerIntent(),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.supportsInputQueue).toBe(false)
    expect(runtimeSideEffects(resolved.hostSessionId)).toEqual(before)
    expect(submissionCalls).toHaveLength(0)
    expect(presentationRuntimeIds).toEqual([RUNTIME_ID])
  })

  it('session-open itself does not infer admission from a corrupt local busy projection', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation, {
      status: 'awaiting_input',
    })
    const submissionCalls = installSubmissionFailFast()
    const presentationRuntimeIds = installPresentationPublishSpy()
    const before = runtimeSideEffects(resolved.hostSessionId)

    const res = await fixture.postJson('/v1/broker-sessions/open', {
      hostSessionId: resolved.hostSessionId,
      runtimeIntent: headlessBrokerIntent(),
    })

    expect(res.status).toBe(200)
    expect(runtimeSideEffects(resolved.hostSessionId)).toEqual(before)
    expect(submissionCalls).toHaveLength(0)
    expect(presentationRuntimeIds).toEqual([RUNTIME_ID])
  })

  it('starts a new broker invocation with profile priming allowed and no HRC run', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    const presentationRuntimeIds = installPresentationPublishSpy()
    const captured: {
      intentInitialPrompt?: unknown
      intentCorrelation?: unknown
      prompt?: string
      runId?: string
      allowCompilerInitialInputWithoutIdentity?: boolean
    } = {}
    ;(server as any).startHeadlessBrokerRuntime = async (
      _session: unknown,
      intent: { initialPrompt?: unknown; placement: { correlation?: unknown } },
      prompt: string,
      runId: string,
      options?: {
        allowCompilerInitialInputWithoutIdentity?: boolean
      }
    ) => {
      captured.intentInitialPrompt = intent.initialPrompt
      captured.intentCorrelation = intent.placement.correlation
      captured.prompt = prompt
      captured.runId = runId
      captured.allowCompilerInitialInputWithoutIdentity =
        options?.allowCompilerInitialInputWithoutIdentity
      return seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation)
    }
    installSeatProbe('idle')

    const res = await fixture.postJson('/v1/broker-sessions/open', {
      hostSessionId: resolved.hostSessionId,
      runtimeIntent: {
        ...headlessBrokerIntent(),
        initialPrompt: 'caller prompt must not become the session-open turn',
      },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ready')
    expect(body.startIdentity).toEqual({ kind: 'broker', invocationId: INVOCATION_ID })
    expect(captured.intentInitialPrompt).toBeUndefined()
    expect(captured.intentCorrelation).toEqual({
      sessionRef: { scopeRef: SCOPE_REF, laneRef: 'default' },
      hostSessionId: resolved.hostSessionId,
      generation: resolved.generation,
    })
    expect(captured.prompt).toBe('')
    expect(captured.runId?.startsWith('broker-session-open-')).toBe(true)
    expect(captured.allowCompilerInitialInputWithoutIdentity).toBe(true)
    expect(presentationRuntimeIds).toEqual([RUNTIME_ID])

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runs.listRuns({ hostSessionId: resolved.hostSessionId })).toHaveLength(0)
      expect(
        db.hrcEvents.listByKind('turn.user_prompt', { hostSessionId: resolved.hostSessionId })
      ).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('uses seat.probe idle as session-open readiness without polling local run state', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    const seeded = seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation)
    installSeatProbe('idle')

    const runtime = await (server as any).waitForBrokerSessionOpenReady(
      seeded.runtimeId,
      INVOCATION_ID
    )

    expect(runtime.runtimeId).toBe(RUNTIME_ID)
    expect(runtime.activeRunId).toBeUndefined()
  })

  it('allows raw broker observation without a runId filter', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation)
    const now = new Date().toISOString()
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.brokerInvocationEvents.appendEvent({
        invocationId: INVOCATION_ID,
        seq: 1,
        time: now,
        type: 'invocation.ready',
        runtimeId: RUNTIME_ID,
        payload: { ok: true },
        envelopeJson: JSON.stringify({
          invocationId: INVOCATION_ID,
          seq: 1,
          time: now,
          type: 'invocation.ready',
          payload: { ok: true },
        }),
      })
    } finally {
      db.close()
    }

    const res = await fixture.fetchSocket(
      `/v1/broker-events?invocationId=${INVOCATION_ID}&runtimeId=${RUNTIME_ID}&generation=${resolved.generation}&afterSeq=0&follow=false`
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"type":"invocation.ready"')
  })
})
