import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type {
  HrcRuntimeIntent,
  SemanticDmResponse,
  SemanticTurnHandoffStartedResponse,
} from 'hrc-core'
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

async function seedHeadlessBroker(
  state: 'ready' | 'busy',
  options: { queueCapable?: boolean } = {}
): Promise<SeededBroker> {
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
      capabilitiesJson: JSON.stringify({
        input: { queue: options.queueCapable === true },
        finalResponse: { jsonSchema: true, perTurn: true },
      }),
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

async function sendDm(
  seeded: SeededBroker,
  body: string,
  responseFormat?: { kind: 'json_schema'; schema: Record<string, unknown> }
): Promise<SemanticDmResponse> {
  const response = await fixture.postJson('/v1/messages/dm', {
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: seeded.sessionRef },
    body,
    runtimeIntent: intent,
    ...(responseFormat === undefined ? {} : { responseFormat }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as SemanticDmResponse
}

function completeRunAndNotify(seeded: SeededBroker, runId: string): void {
  const completedAt = fixture.now()
  const db = openHrcDatabase(fixture.dbPath)
  let terminalEvent: ReturnType<typeof appendHrcEvent>
  try {
    db.runs.markCompleted(runId, {
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
      runId,
      runtimeId: seeded.runtimeId,
      transport: 'headless',
      payload: { success: true, transport: 'headless' },
    })
  } finally {
    db.close()
  }
  ;(server as any).notifyEvent(terminalEvent)
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
    expect(dm.warnings).toEqual([
      {
        code: 'queued_behind_busy_turn',
        delivery: 'deferred',
        message: 'target is busy; delivery deferred until the active turn completes',
      },
    ])
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

  it('coalesces an uncut default-format DM run under its highest-seq owner', async () => {
    const seeded = await seedHeadlessBroker('busy')
    const recorder = installDispatchRecorder(seeded.invocationId, seeded.runtimeId)
    const bodies = Array.from(
      { length: 50 },
      (_, index) => `queued instruction ${String(index + 1).padStart(2, '0')} ${'x'.repeat(1_500)}`
    )
    const messages: SemanticDmResponse[] = []
    for (const body of bodies) messages.push(await sendDm(seeded, body))

    completeRunAndNotify(seeded, seeded.activeRunId!)
    await waitForCondition(() => recorder.calls.length === 1, 'coalesced queued DM dispatch')

    const prompt = String(recorder.calls[0].input.content[0]?.text)
    let priorHeaderIndex = -1
    for (const message of messages) {
      const headerIndex = prompt.indexOf(`[DM #${message.request.messageSeq}`)
      expect(headerIndex).toBeGreaterThan(priorHeaderIndex)
      priorHeaderIndex = headerIndex
    }
    expect(prompt).toContain('truncated; hrcchat show')
    expect(prompt).toEndWith('[queued delivery snapshot remainder count=0]')
    expect(recorder.calls[0].input.metadata.runId).toBe(messages.at(-1)!.request.execution.runId)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      const ownerRunId = messages.at(-1)!.request.execution.runId!
      const ownerCorrelation = JSON.parse(db.runs.getCorrelationJson(ownerRunId) ?? '{}') as {
        sourceMessageId?: string
      }
      expect(ownerCorrelation.sourceMessageId).toBe(messages.at(-1)!.request.messageId)
      expect(db.runs.listQueuedByHostSessionId(seeded.hostSessionId)).toHaveLength(0)
      messages.slice(0, -1).forEach((message, position) => {
        const stored = db.messages.getById(message.request.messageId)
        const run = db.runs.getByRunId(message.request.execution.runId!)
        expect(stored?.execution).toMatchObject({
          state: 'coalesced',
          coalescedIntoRunId: ownerRunId,
          coalescedPosition: position,
        })
        expect(run).toMatchObject({
          status: 'coalesced',
          coalescedIntoRunId: ownerRunId,
          coalescedPosition: position,
        })
      })
      expect(db.messages.getById(messages.at(-1)!.request.messageId)?.execution.state).toBe(
        'started'
      )
      expect(db.runs.getByRunId(ownerRunId)?.status).toBe('accepted')
    } finally {
      db.close()
    }

    await (server as any).drainDurableHeadlessTurnInputs(seeded.hostSessionId)
    expect(recorder.calls).toHaveLength(1)
  })

  it('partitions boot and non-default response-format barriers without content previews', async () => {
    const seeded = await seedHeadlessBroker('busy')
    const recorder = installDispatchRecorder(seeded.invocationId, seeded.runtimeId)
    const work = await sendDm(seeded, 'WORK BODY UNIQUE')

    const bootRunId = 'run-t06408-boot-barrier'
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const session = db.sessions.getByHostSessionId(seeded.hostSessionId)!
      ;(server as any).enqueueDurableHeadlessTurnInput(session, 'BOOT BODY UNIQUE', bootRunId, {
        source: 'boot',
      })
    } finally {
      db.close()
    }

    const structured = await sendDm(seeded, 'STRUCTURED BODY UNIQUE', {
      kind: 'json_schema',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    })
    const pause = await sendDm(seeded, 'PAUSE BODY UNIQUE')
    const queueDb = openHrcDatabase(fixture.dbPath)
    const structuredQueueSeq = queueDb.runs.getByRunId(
      structured.request.execution.runId!
    )!.queuedInputSeq
    const pauseQueueSeq = queueDb.runs.getByRunId(pause.request.execution.runId!)!.queuedInputSeq
    queueDb.close()

    completeRunAndNotify(seeded, seeded.activeRunId!)
    await waitForCondition(() => recorder.calls.length === 1, 'work partition')
    const workPrompt = String(recorder.calls[0].input.content[0]?.text)
    expect(workPrompt).toContain('WORK BODY UNIQUE')
    expect(workPrompt).not.toContain('BOOT BODY UNIQUE')
    expect(workPrompt).not.toContain('STRUCTURED BODY UNIQUE')
    expect(workPrompt).not.toContain('PAUSE BODY UNIQUE')
    expect(workPrompt).toContain('remainder count=3')
    expect(workPrompt).toContain(`seq=${structuredQueueSeq} sender=human`)
    expect(workPrompt).toContain(`seq=${pauseQueueSeq} sender=human`)
    const late = await sendDm(seeded, 'LATE BODY UNIQUE')

    completeRunAndNotify(seeded, work.request.execution.runId!)
    await waitForCondition(() => recorder.calls.length === 2, 'boot partition')
    const bootPrompt = String(recorder.calls[1].input.content[0]?.text)
    expect(bootPrompt).toContain('BOOT BODY UNIQUE')
    expect(bootPrompt).not.toContain('STRUCTURED BODY UNIQUE')
    expect(bootPrompt).not.toContain('PAUSE BODY UNIQUE')
    expect(bootPrompt).not.toContain('LATE BODY UNIQUE')
    expect(bootPrompt).toContain('remainder count=2')

    completeRunAndNotify(seeded, bootRunId)
    await waitForCondition(() => recorder.calls.length === 3, 'structured partition')
    const structuredCall = recorder.calls[2]
    const structuredPrompt = String(structuredCall.input.content[0]?.text)
    expect(structuredPrompt).toContain('STRUCTURED BODY UNIQUE')
    expect(structuredPrompt).not.toContain('PAUSE BODY UNIQUE')
    expect(structuredPrompt).not.toContain('LATE BODY UNIQUE')
    expect(structuredPrompt).toContain('remainder count=1')
    expect(structuredCall.input.responseFormat).toEqual({
      kind: 'json_schema',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    })

    completeRunAndNotify(seeded, structured.request.execution.runId!)
    await waitForCondition(() => recorder.calls.length === 4, 'pause partition')
    const pausePrompt = String(recorder.calls[3].input.content[0]?.text)
    expect(pausePrompt).toContain('PAUSE BODY UNIQUE')
    expect(pausePrompt).not.toContain('LATE BODY UNIQUE')
    expect(pausePrompt).toEndWith('[queued delivery snapshot remainder count=0]')

    completeRunAndNotify(seeded, pause.request.execution.runId!)
    await waitForCondition(() => recorder.calls.length === 5, 'next-snapshot late partition')
    const latePrompt = String(recorder.calls[4].input.content[0]?.text)
    expect(latePrompt).toContain('LATE BODY UNIQUE')
    expect(latePrompt).toEndWith('[queued delivery snapshot remainder count=0]')
    expect(recorder.calls.map((call) => call.input.metadata.runId)).toEqual([
      work.request.execution.runId,
      bootRunId,
      structured.request.execution.runId,
      pause.request.execution.runId,
      late.request.execution.runId,
    ])
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
    expect(dm.warnings).toBeUndefined()
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

  it('marks a semantic turn handoff as deferred when broker admission queues it', async () => {
    const seeded = await seedHeadlessBroker('busy', { queueCapable: true })
    const recorder = installDispatchRecorder(seeded.invocationId, seeded.runtimeId)

    const response = await fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: seeded.sessionRef },
      body: 'urgent supervisor steer',
      runtimeIntent: intent,
    })
    expect(response.status).toBe(200)
    const handoff = (await response.json()) as SemanticTurnHandoffStartedResponse

    expect(handoff.warnings).toEqual([
      {
        code: 'queued_behind_busy_turn',
        delivery: 'deferred',
        message: 'target is busy; delivery deferred until the active turn completes',
      },
    ])
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].policy).toEqual({ whenBusy: 'queue' })
  })
})
