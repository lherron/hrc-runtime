import { describe, expect, it } from 'bun:test'

import type { SemanticTurnHandoffStartedResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { appendHrcEvent } from '../hrc-event-helper'
import { TmuxManager } from '../tmux'
import { setTmuxPanePrompt } from './fixtures/hrc-test-fixture'
import { createHrcchatMinimalFixture } from './fixtures/hrcchat-minimal.fixture'

describe('hrcchat minimal server routes', () => {
  const ctx = createHrcchatMinimalFixture()

  it('semantic turn handoff persists the response after a daemon restart (T-04025 durable finalizer recovery)', async () => {
    const scopeRef = 'agent:handoff-durable-recovery:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)
    const runtimeId = `rt-handoff-durable-recovery-${Date.now()}`
    const operationId = `op-handoff-durable-recovery-${Date.now()}`
    const invocationId = `inv-handoff-durable-recovery-${Date.now()}`
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
        specHash: 'sha256:spec-handoff-durable-recovery',
        startRequestHash: 'sha256:req-handoff-durable-recovery',
        selectedProfileHash: 'sha256:prof-handoff-durable-recovery',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }
    ;(ctx.server as any).getHarnessBrokerController = () => ({
      dispatchInput: async () => ({ ok: true, response: { accepted: true } }),
    })

    const handoffRes = await ctx.fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'response must survive a daemon restart',
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

    // The daemon that dispatched the turn restarts mid-turn: the replacement
    // instance starts with an empty in-memory turnResponseFinalizers map.
    await ctx.restartServer({})

    // The durable broker finishes the turn after the restart: buffered output
    // plus a projected turn.completed lifecycle event through notifyEvent.
    const completionDb = openHrcDatabase(ctx.fixture.dbPath)
    let completedEvent: ReturnType<typeof appendHrcEvent>
    try {
      // The test ctx.fixture has no live broker socket, so startup reconciliation
      // fails the in-flight run. In production the durable broker is preserved
      // (controllerKind + socket presence) and the run stays running — restore
      // that state so the completion models the preserved-broker reality.
      completionDb.runs.update(handoff.runId, {
        status: 'running',
        updatedAt: ctx.fixture.now(),
      })
      completionDb.runtimeBuffers.append({
        runtimeId,
        runId: handoff.runId,
        chunkSeq: 0,
        text: 'durable response body',
        createdAt: ctx.fixture.now(),
      })
      completedEvent = appendHrcEvent(completionDb, 'turn.completed', {
        ts: ctx.fixture.now(),
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation,
        runId: handoff.runId,
        runtimeId,
        transport: 'tmux',
        payload: { success: true, transport: 'tmux', source: 'broker' },
      })
    } finally {
      completionDb.close()
    }
    ;(ctx.server as any).notifyEvent(completedEvent)

    const verifyDb = openHrcDatabase(ctx.fixture.dbPath)
    try {
      const responses = verifyDb.messages.query({
        thread: { rootMessageId: handoff.messageId },
        phases: ['response'],
      })
      expect(responses).toHaveLength(1)
      expect(responses[0]?.body).toBe('durable response body')
      expect(responses[0]?.execution).toMatchObject({
        state: 'completed',
        runId: handoff.runId,
        transport: 'tmux',
      })
      const request = verifyDb.messages.getById(handoff.messageId)
      expect(request?.execution.state).toBe('completed')

      // Replayed/duplicate completion events must not double-insert.
      ;(ctx.server as any).notifyEvent(completedEvent)
      const responsesAfterReplay = verifyDb.messages.query({
        thread: { rootMessageId: handoff.messageId },
        phases: ['response'],
      })
      expect(responsesAfterReplay).toHaveLength(1)
    } finally {
      verifyDb.close()
    }
  })

  it('turn completion does not synthesize a response for non-handoff requests after restart', async () => {
    const scopeRef = 'agent:dm-no-recover:project:agent-spaces'
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)
    const runId = `run-dm-no-recover-${Date.now()}`

    const db = openHrcDatabase(ctx.fixture.dbPath)
    let requestMessageId: string
    try {
      // A DM-path request: same durable shape as a handoff request but without
      // the semanticTurnHandoff metadata marker.
      const record = db.messages.insert({
        messageId: `msg-dm-no-recover-${Date.now()}`,
        kind: 'dm',
        phase: 'request',
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: `${scopeRef}/lane:main` },
        body: 'dm request answered by an explicit reply DM',
        execution: { state: 'started', mode: 'interactive', runId },
      })
      requestMessageId = record.messageId
    } finally {
      db.close()
    }

    await ctx.restartServer({})

    const completionDb = openHrcDatabase(ctx.fixture.dbPath)
    let completedEvent: ReturnType<typeof appendHrcEvent>
    try {
      completedEvent = appendHrcEvent(completionDb, 'turn.completed', {
        ts: ctx.fixture.now(),
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation,
        runId,
        transport: 'tmux',
        payload: { success: true, transport: 'tmux', source: 'broker' },
      })
    } finally {
      completionDb.close()
    }
    ;(ctx.server as any).notifyEvent(completedEvent)

    const verifyDb = openHrcDatabase(ctx.fixture.dbPath)
    try {
      const responses = verifyDb.messages.query({
        thread: { rootMessageId: requestMessageId },
        phases: ['response'],
      })
      expect(responses).toHaveLength(0)
    } finally {
      verifyDb.close()
    }
  })

  it('stales live non-broker tmux dm targets instead of injecting reply hints', async () => {
    const tmux = new TmuxManager(ctx.fixture.tmuxSocketPath)
    await tmux.initialize()

    const scopeRef = 'agent:clod:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)
    const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')
    const runtimeId = `rt-live-dm-${Date.now()}`
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
        harness: 'claude-code',
        provider: 'anthropic',
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

    const dmRes = await ctx.fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'preserve markdown literally',
    })
    expect(dmRes.status).toBe(200)

    await dmRes.json()

    let captured = ''
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Bun.sleep(100)
      captured = await tmux.capture(pane.paneId)
      if (captured.includes('reply_cmd if reply requested:')) {
        break
      }
    }

    const compactCapture = captured.replaceAll('\n', '')

    expect(captured).not.toContain('reply_cmd if reply requested:')
    expect(compactCapture).not.toContain('hrcchat dm human --reply-to')

    const verifyDb = openHrcDatabase(ctx.fixture.dbPath)
    try {
      expect(verifyDb.runtimes.getByRuntimeId(runtimeId)?.status).toBe('stale')
    } finally {
      verifyDb.close()
    }
  })

  it('stales live non-broker tmux lane targets instead of injecting reply hints', async () => {
    const tmux = new TmuxManager(ctx.fixture.tmuxSocketPath)
    await tmux.initialize()

    const recipientScopeRef = 'agent:cody:project:agent-spaces:task:T-09999'
    const recipientSessionRef = `${recipientScopeRef}/lane:main`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(recipientScopeRef)
    const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')
    const runtimeId = `rt-live-dm-reply-lane-${Date.now()}`
    const timestamp = ctx.fixture.now()

    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef: recipientScopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
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

    const dmRes = await ctx.fixture.postJson('/v1/messages/dm', {
      from: {
        kind: 'session',
        sessionRef: 'agent:clod:project:agent-spaces:task:T-01128/lane:repair',
      },
      to: { kind: 'session', sessionRef: recipientSessionRef },
      body: 'preserve the sender lane',
    })
    expect(dmRes.status).toBe(200)

    await dmRes.json()

    let captured = ''
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Bun.sleep(100)
      captured = await tmux.capture(pane.paneId)
      if (captured.includes('reply_cmd if reply requested:')) {
        break
      }
    }

    const compactCapture = captured.replaceAll('\n', '')

    expect(compactCapture).not.toContain('hrcchat dm clod@agent-spaces:T-01128~repair')

    const verifyDb = openHrcDatabase(ctx.fixture.dbPath)
    try {
      expect(verifyDb.runtimes.getByRuntimeId(runtimeId)?.status).toBe('stale')
    } finally {
      verifyDb.close()
    }
  })

  it('appends semantic turn.user_prompt for Codex tmux literal sends', async () => {
    const tmux = new TmuxManager(ctx.fixture.tmuxSocketPath)
    await tmux.initialize()

    const scopeRef = 'agent:larry:project:agent-spaces:task:T-01156-codex-literal'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)
    const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')
    await setTmuxPanePrompt(tmux, pane.paneId, 'hrc-test> ', 'HRC_CODEX_LITERAL_PROMPT_READY')
    const runtimeId = `rt-codex-literal-${Date.now()}`
    const launchId = `launch-codex-literal-${Date.now()}`
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
        launchId,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const res = await ctx.fixture.postJson('/v1/literal-input/by-selector', {
      selector: { sessionRef },
      text: 'What is 3+4?',
      enter: true,
    })
    expect(res.status).toBe(200)

    let captured = ''
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Bun.sleep(50)
      captured = await tmux.capture(pane.paneId)
      if (captured.includes('What is 3+4?')) {
        break
      }
    }
    expect(captured).toContain('What is 3+4?')

    const verifyDb = openHrcDatabase(ctx.fixture.dbPath)
    try {
      const turnPrompts = verifyDb.hrcEvents.listByScope(scopeRef, {
        eventKind: 'turn.user_prompt',
      })
      expect(turnPrompts).toHaveLength(1)
      expect(turnPrompts[0]?.launchId).toBe(launchId)
      expect(turnPrompts[0]?.transport).toBe('tmux')
      expect(turnPrompts[0]?.payload).toEqual({
        type: 'message_end',
        message: {
          role: 'user',
          content: 'What is 3+4?',
        },
      })
    } finally {
      verifyDb.close()
    }
  })

  it('routes split literal sends for broker tmux runtimes through broker input', async () => {
    const scopeRef = 'agent:literal-live-broker:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)
    const runtimeId = `rt-literal-live-broker-${Date.now()}`
    const operationId = `op-literal-live-broker-${Date.now()}`
    const invocationId = `inv-literal-live-broker-${Date.now()}`
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
        harness: 'claude-code',
        provider: 'anthropic',
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
        brokerDriver: 'claude-code-tmux',
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({}),
        specHash: 'sha256:spec-literal-live-broker',
        startRequestHash: 'sha256:req-literal-live-broker',
        selectedProfileHash: 'sha256:prof-literal-live-broker',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const dispatchedInputs: any[] = []
    ;(ctx.server as any).getHarnessBrokerController = () => ({
      dispatchInput: async (request: any) => {
        dispatchedInputs.push(request)
        return { ok: true, response: { accepted: true } }
      },
    })

    const pasteRes = await ctx.fixture.postJson('/v1/literal-input/by-selector', {
      selector: { sessionRef },
      text: 'What is 2+2?',
      enter: false,
    })
    expect(pasteRes.status).toBe(200)
    expect(dispatchedInputs).toHaveLength(0)

    const enterRes = await ctx.fixture.postJson('/v1/literal-input/by-selector', {
      selector: { sessionRef },
      text: '',
      enter: true,
    })
    expect(enterRes.status).toBe(200)
    const enterBody = await enterRes.json()
    expect(enterBody.runtimeId).toBe(runtimeId)
    expect(enterBody.runId).toStartWith('run-')
    expect(enterBody.status).toBe('started')

    expect(dispatchedInputs).toHaveLength(1)
    expect(dispatchedInputs[0]).toMatchObject({
      runtimeId,
      input: {
        kind: 'user',
        metadata: { runId: enterBody.runId },
      },
    })
    expect(dispatchedInputs[0].input.inputId).toStartWith('input-')
    expect(dispatchedInputs[0].input.content[0].text).toBe('What is 2+2?')

    const verifyDb = openHrcDatabase(ctx.fixture.dbPath)
    try {
      const run = verifyDb.runs.getByRunId(enterBody.runId)
      const invocation = verifyDb.brokerInvocations.getByInvocationId(invocationId)
      expect(run?.runtimeId).toBe(runtimeId)
      expect(run?.invocationId).toBe(invocationId)
      expect(run?.dispatchedInputId).toBe(dispatchedInputs[0].input.inputId)
      expect(invocation?.runId).toBe(enterBody.runId)

      const literalEvents = verifyDb.hrcEvents.listByScope(scopeRef, {
        eventKind: 'target.literal-input',
      })
      expect(literalEvents).toHaveLength(2)
      expect(literalEvents[0]?.runId).toBeUndefined()
      expect(literalEvents[0]?.payload).toMatchObject({
        delivery: 'broker-buffered-literal',
        enter: false,
      })
      expect(literalEvents[1]?.runId).toBe(enterBody.runId)
      expect(literalEvents[1]?.payload).toMatchObject({
        delivery: 'broker-dispatch-input',
        enter: true,
      })
    } finally {
      verifyDb.close()
    }
  })
})
