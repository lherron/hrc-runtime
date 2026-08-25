import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'

import type { HrcTargetView, ListMessagesResponse, SemanticDmResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { createHrcchatMinimalFixture } from './fixtures/hrcchat-minimal.fixture'

describe('hrcchat minimal server routes', () => {
  const ctx = createHrcchatMinimalFixture()

  it('bounds headless selector capture to the requested tail window', async () => {
    const scopeRef = 'agent:capture-tail:project:hrc-runtime'
    const sessionRef = `${scopeRef}/lane:default`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)
    const runtimeId = `rt-capture-tail-${Date.now()}`
    const runId = `run-capture-tail-${Date.now()}`
    const timestamp = ctx.fixture.now()
    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'headless',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'busy',
        supportsInflightInput: false,
        adopted: false,
        activeRunId: runId,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      db.runs.insert({
        runId,
        hostSessionId,
        runtimeId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'headless',
        status: 'running',
        acceptedAt: timestamp,
        startedAt: timestamp,
        updatedAt: timestamp,
      })
      for (const [chunkSeq, text] of ['old line\n', 'middle line\n', 'tail line'].entries()) {
        db.runtimeBuffers.append({
          runtimeId,
          runId,
          chunkSeq,
          text,
          createdAt: new Date(Date.parse(timestamp) + chunkSeq).toISOString(),
        })
      }
    } finally {
      db.close()
    }

    const serverDb = (ctx.server as any).db as ReturnType<typeof openHrcDatabase>
    const fullRead = serverDb.runtimeBuffers.listByRuntimeId.bind(serverDb.runtimeBuffers)
    serverDb.runtimeBuffers.listByRuntimeId = () => {
      throw new Error('unbounded runtime buffer capture is forbidden')
    }
    try {
      const response = await ctx.fixture.postJson('/v1/capture/by-selector', {
        selector: { sessionRef },
        lines: 2,
      })
      expect(response.status).toBe(200)
      expect((await response.json()).text).toBe('middle line\ntail line')
    } finally {
      serverDb.runtimeBuffers.listByRuntimeId = fullRead
    }
  })

  it('lists targets and normalizes legacy default lanes to main', async () => {
    await ctx.fixture.resolveSession('agent:cody:project:agent-spaces')

    const res = await ctx.fixture.fetchSocket('/v1/targets')
    expect(res.status).toBe(200)

    const targets = (await res.json()) as HrcTargetView[]
    expect(targets).toHaveLength(1)
    expect(targets[0]?.sessionRef).toBe('agent:cody:project:agent-spaces/lane:main')
    expect(targets[0]?.laneRef).toBe('main')
    expect(targets[0]?.state).toBe('summoned')
  })

  it('preserves same-session concrete candidates through target-list dedupe', async () => {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-05460'
    const timestamp = ctx.fixture.now()
    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      for (const generation of [1, 2]) {
        const hostSessionId = `hsid-ambiguity-${generation}`
        const runtimeId = `rt-ambiguity-${generation}`
        db.sessions.insert({
          hostSessionId,
          scopeRef,
          laneRef: 'main',
          generation,
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
          ancestorScopeRefs: [],
        })
        db.runtimes.insert({
          runtimeId,
          hostSessionId,
          scopeRef,
          laneRef: 'main',
          generation,
          transport: 'tmux',
          harness: 'codex-cli',
          provider: 'openai',
          status: 'ready',
          supportsInflightInput: false,
          adopted: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastActivityAt: timestamp,
        })
      }
    } finally {
      db.close()
    }

    const res = await ctx.fixture.fetchSocket('/v1/targets?projectId=hrc-runtime')
    expect(res.status).toBe(200)

    const targets = (await res.json()) as HrcTargetView[]
    expect(targets).toHaveLength(1)
    expect(targets[0]?.sessionRef).toBe(`${scopeRef}/lane:main`)
    expect(targets[0]?.activeHostSessionId).toBe('hsid-ambiguity-2')
    expect(targets[0]?.runtime?.runtimeId).toBe('rt-ambiguity-2')
    expect(
      targets[0]?.ambiguityCandidates?.map((candidate) => candidate.runtime?.runtimeId)
    ).toEqual(['rt-ambiguity-1', 'rt-ambiguity-2'])
  })

  it('looks up a single target by sessionRef with main/default aliasing', async () => {
    await ctx.fixture.resolveSession('agent:clod:project:agent-spaces')

    const res = await ctx.fixture.fetchSocket(
      '/v1/targets/by-session-ref?sessionRef=agent%3Aclod%3Aproject%3Aagent-spaces%2Flane%3Amain'
    )
    expect(res.status).toBe(200)

    const target = (await res.json()) as HrcTargetView
    expect(target.sessionRef).toBe('agent:clod:project:agent-spaces/lane:main')
    expect(target.scopeRef).toBe('agent:clod:project:agent-spaces')
  })

  it('appends durable dm records and returns them through messages/query', async () => {
    const dmRes = await ctx.fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:clod:project:agent-spaces/lane:main' },
      body: 'ping from cody',
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    expect(dm.request.kind).toBe('dm')
    expect(dm.request.phase).toBe('request')
    expect(dm.request.to).toEqual({
      kind: 'session',
      sessionRef: 'agent:clod:project:agent-spaces/lane:main',
    })

    const listRes = await ctx.fixture.postJson('/v1/messages/query', {
      participant: { kind: 'session', sessionRef: 'agent:clod:project:agent-spaces/lane:main' },
    })
    expect(listRes.status).toBe(200)

    const listed = (await listRes.json()) as ListMessagesResponse
    expect(listed.messages).toHaveLength(1)
    expect(listed.messages[0]?.messageId).toBe(dm.request.messageId)
    expect(listed.messages[0]?.body).toBe('ping from cody')

    const exactRes = await ctx.fixture.postJson('/v1/messages/query', {
      messageId: dm.request.messageId,
      limit: 1,
    })
    expect(exactRes.status).toBe(200)
    const exact = (await exactRes.json()) as ListMessagesResponse
    expect(exact.messages.map((message) => message.messageId)).toEqual([dm.request.messageId])
  })

  it('rejects responseFormat on non-session semantic DMs before message persistence', async () => {
    const dmRes = await ctx.fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'entity', entity: 'system' },
      body: 'this is not a turn-capable target',
      responseFormat: {
        kind: 'json_schema',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    })

    expect(dmRes.status).toBe(400)
    const errorBody = (await dmRes.json()) as {
      error?: { code?: string; message?: string; detail?: Record<string, unknown> }
    }
    expect(errorBody.error?.code).toBe('malformed_request')
    expect(errorBody.error?.message).toContain('responseFormat requires a session turn target')
    expect(errorBody.error?.detail).toMatchObject({
      field: 'responseFormat',
      route: 'semantic-dm',
      reason: 'responseFormat requires a session turn target',
    })

    const listRes = await ctx.fixture.postJson('/v1/messages/query', {
      participant: { kind: 'entity', entity: 'system' },
    })
    expect(listRes.status).toBe(200)

    const listed = (await listRes.json()) as ListMessagesResponse
    expect(listed.messages).toHaveLength(0)
  })

  it('rejects freshContext on semantic DM instead of silently dropping it', async () => {
    const dmRes = await ctx.fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: {
        kind: 'session',
        sessionRef: 'agent:dm-fresh-rejected:project:agent-spaces/lane:main',
      },
      body: 'must not silently reuse context',
      freshContext: true,
    })

    expect(dmRes.status).toBe(400)
    const errorBody = (await dmRes.json()) as {
      error?: { code?: string; message?: string; detail?: Record<string, unknown> }
    }
    expect(errorBody.error?.code).toBe('malformed_request')
    expect(errorBody.error?.message).toContain('only supported by /v1/messages/turn-handoff')
    expect(errorBody.error?.detail).toMatchObject({
      field: 'freshContext',
      route: 'semantic-dm',
    })
  })

  it('threads responseFormat on session-target semantic DMs to semantic turn dispatch', async () => {
    const scopeRef = 'agent:cody:project:agent-spaces:task:T-05142'
    const sessionRef = `${scopeRef}/lane:main`
    await ctx.fixture.resolveSession(scopeRef)

    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    }
    let capturedResponseFormat: unknown
    const originalExecuteSemanticTurn = (ctx.server as any).executeSemanticTurn
    ;(ctx.server as any).executeSemanticTurn = async (_session: unknown, body: any) => {
      capturedResponseFormat = body.responseFormat
      return {}
    }

    try {
      const dmRes = await ctx.fixture.postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef },
        body: 'dispatch this as a structured turn',
        responseFormat: { kind: 'json_schema', schema },
      })
      expect(dmRes.status).toBe(200)
    } finally {
      ;(ctx.server as any).executeSemanticTurn = originalExecuteSemanticTurn
    }

    expect(capturedResponseFormat).toEqual({ kind: 'json_schema', schema })
  })

  it('persists message-to-session correlation for dm records before any runtime exists', async () => {
    const scopeRef = 'agent:cody:project:agent-spaces:task:T-01293'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)

    const dmRes = await ctx.fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'correlate this message before summon',
      createIfMissing: false,
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    const messageId = dm.request.messageId

    // Re-open the store to model a later hrc monitor process resolving msg:<messageId>
    // after the originating hrcchat dm process has exited.
    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      const persisted = db.messages.getById(messageId)
      expect(persisted).not.toBeUndefined()
      expect(persisted?.execution.sessionRef).toBe(sessionRef)
      expect(persisted?.execution.hostSessionId).toBe(hostSessionId)
      expect(persisted?.execution.generation).toBe(generation)
      expect(persisted?.execution.runtimeId).toBeUndefined()
      expect(persisted?.execution.runId).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('persists dm correlation against the latest generation when continuity still points at an older generation', async () => {
    const scopeRef = 'agent:clod:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const now = ctx.fixture.now()

    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      db.sessions.insert({
        hostSessionId: 'hsid-dm-correlation-gen-1',
        scopeRef,
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.sessions.insert({
        hostSessionId: 'hsid-dm-correlation-gen-4',
        scopeRef,
        laneRef: 'default',
        generation: 4,
        status: 'active',
        priorHostSessionId: 'hsid-dm-correlation-gen-1',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.continuities.upsert({
        scopeRef,
        laneRef: 'default',
        activeHostSessionId: 'hsid-dm-correlation-gen-1',
        updatedAt: now,
      })
    } finally {
      db.close()
    }

    const dmRes = await ctx.fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'correlate against current generation',
      createIfMissing: false,
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    const verifyDb = openHrcDatabase(ctx.fixture.dbPath)
    try {
      const persisted = verifyDb.messages.getById(dm.request.messageId)
      expect(persisted).not.toBeUndefined()
      expect(persisted?.execution.sessionRef).toBe(sessionRef)
      expect(persisted?.execution.hostSessionId).toBe('hsid-dm-correlation-gen-4')
      expect(persisted?.execution.generation).toBe(4)
      expect(persisted?.execution.runtimeId).toBeUndefined()
      expect(persisted?.execution.runId).toBeUndefined()
    } finally {
      verifyDb.close()
    }
  })

  it('fails closed for openai nonInteractive dm when the broker is not admitted', async () => {
    await ctx.restartServer({ headlessCodexBrokerEnabled: false })
    const fakeCodex = await ctx.installFakeCodex('fake-codex-dm-fallback')

    const dmRes = await ctx.fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:clod:project:agent-spaces/lane:main' },
      body: 'fallback to headless transport',
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
          preferredMode: 'nonInteractive',
        },
        launch: {
          pathPrepend: [fakeCodex.binDir],
        },
      },
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    expect(dm.execution).toBeUndefined()
    expect(dm.request.execution.state).toBe('failed')
    expect(dm.request.execution.errorMessage).toContain('headless legacy execution is unavailable')

    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      expect(db.runtimes.listByHostSessionId(String(dm.request.execution.hostSessionId))).toEqual(
        []
      )
    } finally {
      db.close()
    }

    const execLog = await readFile(fakeCodex.logPath, 'utf-8').catch(() => '')
    expect(execLog).not.toContain('app-ctx.server:')
  })

  it('T-05161: dm to a Codex.app-owned scope persists the message but never summons or spawns', async () => {
    // Codex.app owns scope refs whose task segment is `codex-<uuid7>`. A DM to
    // such an address must be persisted (Cody-in-codex.app live-polls the DM
    // list) but must NOT create an hrc session or spawn a local codex-cli.
    const codexScopeRef =
      'agent:cody:project:agent-loop:task:codex-019efeb5-2db3-7d62-8382-2bcb8ca9be1c'
    const codexSessionRef = `${codexScopeRef}/lane:main`

    const dmRes = await ctx.fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: codexSessionRef },
      body: 'reply addressed to a codex.app session',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: { provider: 'openai', interactive: false },
        execution: { preferredMode: 'nonInteractive' },
      },
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    // Message kept, no dispatch, no error.
    expect(dm.request.messageId).toBeDefined()
    expect(dm.execution).toBeUndefined()
    expect(dm.request.execution.state).toBe('not_applicable')
    expect(dm.request.execution.hostSessionId).toBeUndefined()

    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      // No session summoned for the codex.app scope.
      expect(db.continuities.getByKey(codexScopeRef, 'main')).toBeNull()
      // The message row is persisted and findable.
      const persisted = db.messages.getById(dm.request.messageId)
      expect(persisted?.body).toBe('reply addressed to a codex.app session')

      // Control: an identical DM to a normal scope DOES summon a session row.
      const normalScopeRef = 'agent:cody:project:agent-loop:task:T-05161'
      const normalRes = await ctx.fixture.postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: `${normalScopeRef}/lane:main` },
        body: 'reply to a normal scope',
        runtimeIntent: {
          placement: {
            agentRoot: '/tmp/agent',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            dryRun: true,
          },
          harness: { provider: 'openai', interactive: false },
          execution: { preferredMode: 'nonInteractive' },
        },
      })
      expect(normalRes.status).toBe(200)
      // A normal scope gets a continuity/session (summoned) — dispatch may then
      // fail downstream, but the summon itself is what differs from codex.app.
      expect(db.continuities.getByKey(normalScopeRef, 'main')).not.toBeNull()
    } finally {
      db.close()
    }
  })
})
