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

function seedReusableBrokerRuntime(hostSessionId: string, generation: number) {
  const db = openHrcDatabase(fixture.dbPath)
  const now = new Date().toISOString()
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
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: OPERATION_ID,
      activeInvocationId: INVOCATION_ID,
      createdAt: now,
      updatedAt: now,
    })
    db.brokerInvocations.insert({
      invocationId: INVOCATION_ID,
      operationId: OPERATION_ID,
      runtimeId: RUNTIME_ID,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({ input: { queue: true } }),
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

describe('POST /v1/broker-sessions/open', () => {
  it('opens an invocation-level broker session without creating a turn run', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation)

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

  it('starts a new broker invocation with profile priming allowed and no HRC run', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    const captured: {
      intentInitialPrompt?: unknown
      prompt?: string
      runId?: string
      allowCompilerInitialInputWithoutIdentity?: boolean
    } = {}
    ;(server as any).startHeadlessBrokerRuntime = async (
      _session: unknown,
      intent: { initialPrompt?: unknown },
      prompt: string,
      runId: string,
      options?: {
        allowCompilerInitialInputWithoutIdentity?: boolean
      }
    ) => {
      captured.intentInitialPrompt = intent.initialPrompt
      captured.prompt = prompt
      captured.runId = runId
      captured.allowCompilerInitialInputWithoutIdentity =
        options?.allowCompilerInitialInputWithoutIdentity
      return seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation)
    }

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
    expect(captured.prompt).toBe('')
    expect(captured.runId?.startsWith('broker-session-open-')).toBe(true)
    expect(captured.allowCompilerInitialInputWithoutIdentity).toBe(true)

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

  it('treats queue-capable runless startup input as session-open ready', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    const seeded = seedReusableBrokerRuntime(resolved.hostSessionId, resolved.generation)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.brokerInvocations.update(INVOCATION_ID, {
        invocationState: 'turn_active',
        updatedAt: new Date().toISOString(),
      })
    } finally {
      db.close()
    }

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
        createdAt: now,
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
