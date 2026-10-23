import { describe, expect, it } from 'bun:test'

import type { HrcTargetView } from 'hrc-core'
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

  it('lists only the continuity current generation for a session', async () => {
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
        })
        db.continuities.upsert({
          scopeRef,
          laneRef: 'main',
          activeHostSessionId: hostSessionId,
          updatedAt: timestamp,
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
    expect(targets[0]?.ambiguityCandidates).toBeUndefined()
    expect(targets[0]?.identity).toEqual({
      kind: 'project-task',
      agentId: 'cody',
      projectId: 'hrc-runtime',
      taskId: 'T-05460',
    })
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
})
