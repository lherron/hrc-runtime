import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, SemanticDmResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { appendHrcEvent } from '../hrc-event-helper'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const intent: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: {
    provider: 'openai',
    id: 'codex-cli',
    interactive: false,
  },
  execution: { preferredMode: 'headless' },
}

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t06408-input-delivery-')
  server = await createHrcServer(
    fixture.serverOpts({
      headlessCodexBrokerEnabled: true,
      claudeCodeTmuxBrokerEnabled: false,
      codexCliTmuxBrokerEnabled: false,
    })
  )
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

type SeededBroker = {
  scopeRef: string
  sessionRef: string
  hostSessionId: string
  generation: number
  runtimeId: string
  invocationId: string
  activeRunId?: string | undefined
}

async function seedHeadlessBroker(state: 'ready' | 'busy'): Promise<SeededBroker> {
  const scopeRef = `agent:t06408-${state}:project:hrc-runtime:task:T-06408`
  const sessionRef = `${scopeRef}/lane:main`
  const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
  const runtimeId = `rt-t06408-${state}`
  const operationId = `op-t06408-${state}`
  const invocationId = `inv-t06408-${state}`
  const activeRunId = state === 'busy' ? `run-t06408-active-${state}` : undefined
  const now = fixture.now()

  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.updateIntent(hostSessionId, intent, now)
    db.sessions.updateContinuation(hostSessionId, { provider: 'openai', key: 'thread-t06408' }, now)
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: state,
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: operationId,
      activeInvocationId: invocationId,
      ...(activeRunId ? { activeRunId } : {}),
      continuation: { provider: 'openai', key: 'thread-t06408' },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    db.brokerInvocations.insert({
      invocationId,
      operationId,
      runtimeId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: state === 'busy' ? 'turn_active' : 'ready',
      capabilitiesJson: JSON.stringify({ input: { queue: false } }),
      specHash: `sha256:spec-t06408-${state}`,
      startRequestHash: `sha256:req-t06408-${state}`,
      selectedProfileHash: `sha256:profile-t06408-${state}`,
      ...(activeRunId ? { runId: activeRunId } : {}),
      createdAt: now,
      updatedAt: now,
    })
    if (activeRunId) {
      db.runs.insert({
        runId: activeRunId,
        hostSessionId,
        runtimeId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'headless',
        status: 'started',
        acceptedAt: now,
        startedAt: now,
        updatedAt: now,
        invocationId,
        operationId,
      })
    }
  } finally {
    db.close()
  }

  return {
    scopeRef,
    sessionRef,
    hostSessionId,
    generation,
    runtimeId,
    invocationId,
    activeRunId,
  }
}

function installDispatchRecorder(invocationId: string, runtimeId: string): { calls: any[] } {
  const calls: any[] = []
  ;(server as any).getHarnessBrokerController = () => ({
    dispatchInput: async (request: any) => {
      calls.push(request)
      const db = openHrcDatabase(fixture.dbPath)
      try {
        const runId = String(request.input.metadata?.runId)
        const seq = db.brokerInvocationEvents.maxBrokerSeq(invocationId) + 1
        db.brokerInvocationEvents.appendEvent({
          invocationId,
          seq,
          time: fixture.now(),
          type: 'user.message',
          runtimeId,
          runId,
          payload: { content: request.input.content },
        })
      } finally {
        db.close()
      }
      return { ok: true, response: { accepted: true } }
    },
  })
  return { calls }
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${description}`)
}

describe('T-06408 durable turn-input delivery', () => {
  it('queues a mid-turn DM for a non-inflight Codex runtime and drains it exactly once', async () => {
    const seeded = await seedHeadlessBroker('busy')
    const recorder = installDispatchRecorder(seeded.invocationId, seeded.runtimeId)
    const body = 'deliver this DM after the active turn'

    const dmResponse = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: seeded.sessionRef },
      body,
      runtimeIntent: intent,
    })
    expect(dmResponse.status).toBe(200)
    const dm = (await dmResponse.json()) as SemanticDmResponse

    // Accepted means HRC owns durable delivery. A busy non-inflight runtime is
    // not a delivery failure and must not receive the input before turn end.
    expect(dm.request.execution.state).toBe('accepted')
    expect(dm.request.execution.errorCode).toBeUndefined()
    expect(recorder.calls).toHaveLength(0)

    const completedAt = fixture.now()
    const db = openHrcDatabase(fixture.dbPath)
    let terminalEvent: ReturnType<typeof appendHrcEvent>
    try {
      db.runs.markCompleted(seeded.activeRunId!, {
        status: 'completed',
        completedAt,
        updatedAt: completedAt,
      })
      db.runtimes.updateRunId(seeded.runtimeId, undefined, completedAt)
      db.runtimes.update(seeded.runtimeId, {
        status: 'ready',
        updatedAt: completedAt,
        lastActivityAt: completedAt,
      })
      db.brokerInvocations.update(seeded.invocationId, {
        invocationState: 'ready',
        updatedAt: completedAt,
      })
      terminalEvent = appendHrcEvent(db, 'turn.completed', {
        ts: completedAt,
        hostSessionId: seeded.hostSessionId,
        scopeRef: seeded.scopeRef,
        laneRef: 'default',
        generation: seeded.generation,
        runId: seeded.activeRunId,
        runtimeId: seeded.runtimeId,
        transport: 'headless',
        payload: { success: true, transport: 'headless' },
      })
    } finally {
      db.close()
    }
    ;(server as any).notifyEvent(terminalEvent)
    ;(server as any).notifyEvent(terminalEvent)
    await waitForCondition(() => recorder.calls.length === 1, 'queued DM dispatch')
    await Bun.sleep(100)

    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].input.content[0]?.text).toContain(body)

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      const userMessages = verifyDb.brokerInvocationEvents
        .listByInvocationId(seeded.invocationId)
        .filter((event) => event.type === 'user.message')
      expect(userMessages).toHaveLength(1)
      expect(JSON.parse(userMessages[0]!.brokerEventJson)).toEqual({
        content: recorder.calls[0].input.content,
      })

      const persisted = verifyDb.messages.getById(dm.request.messageId)
      expect(persisted?.execution.state).toBe('started')
      expect(persisted?.execution.runId).toBeString()
      expect(persisted?.execution.runId).not.toBe(seeded.activeRunId)
    } finally {
      verifyDb.close()
    }
  })

  it('keeps the idle DM path immediate and records one broker user.message', async () => {
    const seeded = await seedHeadlessBroker('ready')
    const recorder = installDispatchRecorder(seeded.invocationId, seeded.runtimeId)
    const body = 'idle delivery remains immediate'

    const dmResponse = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: seeded.sessionRef },
      body,
      runtimeIntent: intent,
    })
    expect(dmResponse.status).toBe(200)
    const dm = (await dmResponse.json()) as SemanticDmResponse

    expect(dm.request.execution.state).toBe('started')
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].input.content[0]?.text).toContain(body)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      const userMessages = db.brokerInvocationEvents
        .listByInvocationId(seeded.invocationId)
        .filter((event) => event.type === 'user.message')
      expect(userMessages).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})
