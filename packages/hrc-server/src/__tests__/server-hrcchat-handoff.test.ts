import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'

import type { ListMessagesResponse, SemanticTurnHandoffStartedResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { TmuxManager } from '../tmux'
import { createHrcchatMinimalFixture } from './fixtures/hrcchat-minimal.fixture'

describe('hrcchat minimal server routes', () => {
  const ctx = createHrcchatMinimalFixture()

  it('semantic turn handoff fails closed when headless codex would use legacy exec', async () => {
    await ctx.restartServer({ headlessCodexBrokerEnabled: false })
    const fakeCodex = await ctx.installFakeCodex('fake-codex-turn-handoff')
    const sessionRef = 'agent:handoff:project:agent-spaces/lane:main'

    const handoffRes = await ctx.fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'handoff to detached turn',
      runtimeIntent: {
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
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
        launch: {
          pathPrepend: [fakeCodex.binDir],
        },
      },
    })
    expect(handoffRes.status).toBe(503)
    const errorBody = (await handoffRes.json()) as {
      error?: { code?: string; message?: string }
    }
    expect(errorBody.error?.code).toBe('runtime_unavailable')
    expect(errorBody.error?.message).toContain('headless legacy execution is unavailable')

    const requestListRes = await ctx.fixture.postJson('/v1/messages/query', {
      phases: ['request'],
    })
    expect(requestListRes.status).toBe(200)
    const requestList = (await requestListRes.json()) as ListMessagesResponse
    const request = requestList.messages.find(
      (message) => message.body === 'handoff to detached turn'
    )
    expect(request?.execution.state).toBe('failed')
    expect(request?.execution.errorMessage).toContain('headless legacy execution is unavailable')
  })

  it('semantic turn handoff stales live non-broker tmux instead of literal delivery', async () => {
    await ctx.restartServer({ headlessCodexBrokerEnabled: false })
    const tmux = new TmuxManager(ctx.fixture.tmuxSocketPath)
    await tmux.initialize()
    const fakeCodex = await ctx.installFakeCodex('fake-codex-turn-handoff-live-tmux')

    const scopeRef = 'agent:handoff-live-tmux:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)
    const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')
    const runtimeId = `rt-handoff-live-tmux-${Date.now()}`
    const timestamp = ctx.fixture.now()

    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        tmuxJson: pane,
        supportsInflightInput: false,
        adopted: false,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const handoffRes = await ctx.fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'must be sent literally',
      runtimeIntent: {
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
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
        launch: {
          pathPrepend: [fakeCodex.binDir],
        },
      },
    })
    expect(handoffRes.status).toBe(503)
    const errorBody = (await handoffRes.json()) as {
      error?: { code?: string; message?: string }
    }
    expect(errorBody.error?.code).toBe('runtime_unavailable')
    expect(errorBody.error?.message).toContain('headless legacy execution is unavailable')

    const captured = await tmux.capture(pane.paneId)
    expect(captured).not.toContain('must be sent literally')

    const verifyDb = openHrcDatabase(ctx.fixture.dbPath)
    try {
      expect(verifyDb.runtimes.getByRuntimeId(runtimeId)?.status).toBe('stale')
    } finally {
      verifyDb.close()
    }

    const codexLog = await readFile(fakeCodex.logPath, 'utf8').catch(() => '')
    expect(codexLog).not.toContain('app-ctx.server:')
  })

  it('semantic turn handoff dispatches through live broker tmux runtimes', async () => {
    const scopeRef = 'agent:handoff-live-broker:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)
    const runtimeId = `rt-handoff-live-broker-${Date.now()}`
    const operationId = `op-handoff-live-broker-${Date.now()}`
    const invocationId = `inv-handoff-live-broker-${Date.now()}`
    const timestamp = ctx.fixture.now()

    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: invocationId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastActivityAt: timestamp,
      })
      db.brokerInvocations.insert({
        invocationId,
        operationId,
        runtimeId,
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-cli-tmux',
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({}),
        specHash: 'sha256:spec-handoff-live-broker',
        startRequestHash: 'sha256:req-handoff-live-broker',
        selectedProfileHash: 'sha256:prof-handoff-live-broker',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const dispatchedInputs: any[] = []
    const brokerSubmissionId = 'submission-handoff-live-broker'
    ;(ctx.server as any).getHarnessBrokerController = () => ({
      enqueue: async (request: any) => {
        dispatchedInputs.push(request)
        return {
          ok: true,
          response: { submissionId: brokerSubmissionId, admission: 'admitted' },
        }
      },
    })

    const handoffRes = await ctx.fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'must go through broker input',
      runtimeIntent: {
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
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
      },
    })
    expect(handoffRes.status).toBe(200)
    const handoff = (await handoffRes.json()) as SemanticTurnHandoffStartedResponse
    expect(handoff.runtimeId).toBe(runtimeId)
    expect(dispatchedInputs).toHaveLength(1)
    expect(dispatchedInputs[0].runtimeId).toBe(runtimeId)
    expect(dispatchedInputs[0].body).toContain('must go through broker input')

    const verifyDb = openHrcDatabase(ctx.fixture.dbPath)
    try {
      const run = verifyDb.runs.getByRunId(handoff.runId)
      const invocation = verifyDb.brokerInvocations.getByInvocationId(invocationId)
      const request = verifyDb.messages.getById(handoff.messageId)
      expect(run?.runtimeId).toBe(runtimeId)
      expect(run?.invocationId).toBe(invocationId)
      expect(run?.dispatchedInputId).toBe(brokerSubmissionId)
      expect(invocation?.invocationId).toBe(invocationId)
      expect(request?.execution).toMatchObject({
        state: 'started',
        mode: 'interactive',
        runtimeId,
        runId: handoff.runId,
        transport: 'tmux',
      })
    } finally {
      verifyDb.close()
    }
  })

  it('semantic turn handoff freshContext rotates a live broker before dispatch', async () => {
    const scopeRef = 'agent:handoff-fresh-live-broker:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)
    const runtimeId = `rt-handoff-fresh-live-broker-${Date.now()}`
    const operationId = `op-handoff-fresh-live-broker-${Date.now()}`
    const invocationId = `inv-handoff-fresh-live-broker-${Date.now()}`
    const timestamp = ctx.fixture.now()

    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      db.sessions.updateContinuation(
        hostSessionId,
        { provider: 'openai', key: 'thread-prior-conversation' },
        timestamp
      )
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: invocationId,
        continuation: { provider: 'openai', key: 'thread-prior-conversation' },
        createdAt: timestamp,
        updatedAt: timestamp,
        lastActivityAt: timestamp,
      })
      db.brokerInvocations.insert({
        invocationId,
        operationId,
        runtimeId,
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-cli-tmux',
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({}),
        specHash: 'sha256:spec-handoff-fresh-live-broker',
        startRequestHash: 'sha256:req-handoff-fresh-live-broker',
        selectedProfileHash: 'sha256:prof-handoff-fresh-live-broker',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const reusedInputs: unknown[] = []
    ;(ctx.server as any).getHarnessBrokerController = () => ({
      dispatchInput: async (request: unknown) => {
        reusedInputs.push(request)
        return { ok: true, response: { accepted: true } }
      },
    })

    const freshDispatches: Array<{
      hostSessionId: string
      generation: number
      continuation: unknown
    }> = []
    ;(ctx.server as any).dispatchTurnForSession = async (
      session: { hostSessionId: string; generation: number; continuation?: unknown },
      _intent: unknown,
      _prompt: string,
      options: { runId: string }
    ) => {
      freshDispatches.push({
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        continuation: session.continuation,
      })
      return Response.json({
        status: 'started',
        hostSessionId: session.hostSessionId,
        runtimeId: 'rt-fresh-context-dispatch',
        runId: options.runId,
        generation: session.generation,
        transport: 'headless',
      })
    }

    const handoffRes = await ctx.fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'the prior conversation must not be visible',
      freshContext: true,
      runtimeIntent: {
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
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
      },
    })
    expect(handoffRes.status).toBe(200)
    const handoff = (await handoffRes.json()) as SemanticTurnHandoffStartedResponse

    expect(reusedInputs).toHaveLength(0)
    expect(freshDispatches).toEqual([
      {
        hostSessionId: handoff.hostSessionId,
        generation: generation + 1,
        continuation: undefined,
      },
    ])
    expect(handoff.hostSessionId).not.toBe(hostSessionId)
    expect(handoff.generation).toBe(generation + 1)
    expect(handoff.runtimeId).toBe('rt-fresh-context-dispatch')

    const verifyDb = openHrcDatabase(ctx.fixture.dbPath)
    try {
      expect(verifyDb.runtimes.getByRuntimeId(runtimeId)?.status).toBe('terminated')
      expect(verifyDb.sessions.getByHostSessionId(hostSessionId)?.status).toBe('archived')
      expect(
        verifyDb.sessions.getByHostSessionId(handoff.hostSessionId)?.continuation
      ).toBeUndefined()
    } finally {
      verifyDb.close()
    }
  })

  it('semantic turn handoff does not synthesize completion for broker tmux reply DMs', async () => {
    const scopeRef = 'agent:handoff-live-broker-reply:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)
    const runtimeId = `rt-handoff-live-broker-reply-${Date.now()}`
    const operationId = `op-handoff-live-broker-reply-${Date.now()}`
    const invocationId = `inv-handoff-live-broker-reply-${Date.now()}`
    const timestamp = ctx.fixture.now()

    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: invocationId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastActivityAt: timestamp,
      })
      db.brokerInvocations.insert({
        invocationId,
        operationId,
        runtimeId,
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-cli-tmux',
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({}),
        specHash: 'sha256:spec-handoff-live-broker-reply',
        startRequestHash: 'sha256:req-handoff-live-broker-reply',
        selectedProfileHash: 'sha256:prof-handoff-live-broker-reply',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }
    ;(ctx.server as any).getHarnessBrokerController = () => ({
      enqueue: async () => ({
        ok: true,
        response: { submissionId: 'submission-handoff-live-broker-reply', admission: 'admitted' },
      }),
    })

    const handoffRes = await ctx.fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'broker reply should wait for broker completion',
      runtimeIntent: {
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
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
      },
    })
    expect(handoffRes.status).toBe(200)
    const handoff = (await handoffRes.json()) as SemanticTurnHandoffStartedResponse

    const replyRes = await ctx.fixture.postJson('/v1/messages/dm', {
      from: { kind: 'session', sessionRef },
      to: { kind: 'entity', entity: 'human' },
      body: 'broker reply body',
      replyToMessageId: handoff.messageId,
    })
    expect(replyRes.status).toBe(200)

    const verifyDb = openHrcDatabase(ctx.fixture.dbPath)
    try {
      const run = verifyDb.runs.getByRunId(handoff.runId)
      const completed = verifyDb.hrcEvents.listByRun(handoff.runId, {
        eventKind: 'turn.completed',
      })
      const responseList = verifyDb.messages.query({
        thread: { rootMessageId: handoff.messageId },
        phases: ['response'],
      })

      expect(run?.status).toBe('accepted')
      expect(run?.completedAt).toBeUndefined()
      expect(completed).toHaveLength(0)
      expect(responseList).toHaveLength(1)
      expect(responseList[0]?.execution).toMatchObject({
        state: 'completed',
        mode: 'interactive',
        runtimeId,
        runId: handoff.runId,
        transport: 'tmux',
      })
    } finally {
      verifyDb.close()
    }
  })
})
