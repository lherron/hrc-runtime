import { describe, expect, it } from 'bun:test'

import type { DispatchTurnResponse, HrcRuntimeIntent, HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { isRuntimeUnavailableStatus } from '../server-util'
import { createHrcchatMinimalFixture } from './fixtures/hrcchat-minimal.fixture'

const INTENT: HrcRuntimeIntent = {
  placement: { kind: 'inline' },
  harness: { provider: 'openai', id: 'codex-cli', interactive: false },
  execution: { preferredMode: 'headless' },
}

type GuardDeps = {
  createTmuxManager(options: { socketPath: string }): {
    listSessionNames(): Promise<string[]>
    inspectPaneProcess(
      paneId: string
    ): Promise<{ command: string; pid: number; dead: boolean } | null>
  }
  isLiveProcess(pid: number): boolean
  reattach(
    runtime: HrcRuntimeSnapshot
  ): Promise<{ state: 'reattached' | 'unavailable' | 'rejected-outside-runtime-root' }>
  log(level: string, message: string, fields: Record<string, unknown>): void
}

type MutableServer = {
  db: ReturnType<typeof openHrcDatabase>
  reattachLiveSemanticDmSubstrate?: (
    runtime: HrcRuntimeSnapshot,
    deps?: Partial<GuardDeps>
  ) => Promise<boolean>
  dispatchTurnForSession: (
    session: { hostSessionId: string; generation: number },
    intent: HrcRuntimeIntent,
    prompt: string,
    options: { runId?: string }
  ) => Promise<Response>
}

describe('T-07047 semantic DM duplicate-mint guard', () => {
  const ctx = createHrcchatMinimalFixture()

  async function seedCrashedLeasedRuntime(label: string): Promise<{
    scopeRef: string
    sessionRef: string
    hostSessionId: string
    runtimeId: string
    sessionName: string
    paneId: string
  }> {
    const scopeRef = `agent:cody:project:hrc-runtime:task:T-07047-${label}`
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await ctx.fixture.resolveSession(scopeRef)
    const runtimeId = `rt-t07047-${label}`
    const sessionName = `hrc-t07047-${label}`
    const paneId = `%t07047-${label}`
    const now = ctx.fixture.now()
    const db = openHrcDatabase(ctx.fixture.dbPath)
    try {
      db.sessions.updateIntent(hostSessionId, INTENT, now)
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        controllerKind: 'harness-broker',
        status: 'crashed',
        supportsInflightInput: true,
        adopted: false,
        runtimeStateJson: {
          schemaVersion: 'runtime-state/v1',
          kind: 'harness-broker',
          broker: {
            endpoint: {
              kind: 'unix-jsonrpc-ndjson',
              socketPath: `${ctx.fixture.runtimeRoot}/${runtimeId}.sock`,
              attachTokenRef: {
                kind: 'file',
                path: `${ctx.fixture.runtimeRoot}/${runtimeId}.token`,
                redacted: true,
              },
              protocolVersion: 'harness-broker/0.2',
            },
            substrate: {
              kind: 'leased-tmux',
              tmuxSocketPath: `${ctx.fixture.runtimeRoot}/${runtimeId}.tmux.sock`,
              sessionName,
              brokerWindow: {
                sessionId: '$t07047',
                windowId: '@t07047',
                paneId,
              },
              generation,
              eventLedgerPath: `${ctx.fixture.runtimeRoot}/${runtimeId}.events.ndjson`,
            },
            presentation: { kind: 'none' },
          },
        },
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      })
    } finally {
      db.close()
    }
    return { scopeRef, sessionRef, hostSessionId, runtimeId, sessionName, paneId }
  }

  function installMintingDispatchStub(
    server: MutableServer,
    originalRuntimeId: string
  ): () => void {
    const original = server.dispatchTurnForSession
    server.dispatchTurnForSession = async (session, _intent, _prompt, options) => {
      const originalRuntime = server.db.runtimes.getByRuntimeId(originalRuntimeId)
      let selectedRuntimeId = originalRuntimeId
      if (originalRuntime && isRuntimeUnavailableStatus(originalRuntime.status)) {
        selectedRuntimeId = `${originalRuntimeId}-minted`
        const now = ctx.fixture.now()
        server.db.runtimes.insert({
          runtimeId: selectedRuntimeId,
          hostSessionId: session.hostSessionId,
          scopeRef: originalRuntime.scopeRef,
          laneRef: originalRuntime.laneRef,
          generation: session.generation,
          transport: 'headless',
          harness: 'codex-cli',
          provider: 'openai',
          controllerKind: 'harness-broker',
          status: 'ready',
          supportsInflightInput: true,
          adopted: false,
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        })
      }
      return Response.json({
        runId: options.runId ?? 'run-t07047',
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: selectedRuntimeId,
        transport: 'headless',
        status: 'started',
        supportsInFlightInput: true,
      } satisfies DispatchTurnResponse)
    }
    return () => {
      server.dispatchTurnForSession = original
    }
  }

  async function sendDm(sessionRef: string): Promise<Response> {
    return await ctx.fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'reuse the live substrate',
      createIfMissing: false,
    })
  }

  it('reattaches a crashed latest runtime with live recorded substrate and mints no row', async () => {
    const seeded = await seedCrashedLeasedRuntime('reattach')
    const server = ctx.server as unknown as MutableServer
    const originalGuard = server.reattachLiveSemanticDmSubstrate
    const reattachCalls: string[] = []
    const probeCalls: string[] = []
    const logs: Array<{ message: string; fields: Record<string, unknown> }> = []
    server.reattachLiveSemanticDmSubstrate = async (runtime) => {
      if (!originalGuard) return false
      return await originalGuard.call(server, runtime, {
        createTmuxManager: ({ socketPath }) => ({
          listSessionNames: async () => {
            probeCalls.push(socketPath)
            return [seeded.sessionName]
          },
          inspectPaneProcess: async (paneId) => {
            probeCalls.push(paneId)
            return { command: 'harness-broker', pid: 47047, dead: false }
          },
        }),
        isLiveProcess: () => true,
        reattach: async (runtimeToReattach) => {
          reattachCalls.push(runtimeToReattach.runtimeId)
          server.db.runtimes.update(runtimeToReattach.runtimeId, {
            status: 'ready',
            updatedAt: ctx.fixture.now(),
          })
          return { state: 'reattached' }
        },
        log: (_level, message, fields) => logs.push({ message, fields }),
      })
    }
    const restoreDispatch = installMintingDispatchStub(server, seeded.runtimeId)

    try {
      const response = await sendDm(seeded.sessionRef)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { execution?: { runtimeId?: string } }
      expect(body.execution?.runtimeId).toBe(seeded.runtimeId)
    } finally {
      restoreDispatch()
      server.reattachLiveSemanticDmSubstrate = originalGuard
    }

    expect(probeCalls).toEqual([
      `${ctx.fixture.runtimeRoot}/${seeded.runtimeId}.tmux.sock`,
      seeded.paneId,
    ])
    expect(reattachCalls).toEqual([seeded.runtimeId])
    expect(server.db.runtimes.listByHostSessionId(seeded.hostSessionId)).toHaveLength(1)
    expect(logs).toContainEqual({
      message: 'dm.mint_averted_live_substrate',
      fields: { runtimeId: seeded.runtimeId, scopeRef: seeded.scopeRef },
    })
  })

  it('falls through to the existing mint when clean reattach is unavailable', async () => {
    const seeded = await seedCrashedLeasedRuntime('fallthrough')
    const server = ctx.server as unknown as MutableServer
    const originalGuard = server.reattachLiveSemanticDmSubstrate
    let reattachAttempts = 0
    server.reattachLiveSemanticDmSubstrate = async (runtime) => {
      if (!originalGuard) return false
      return await originalGuard.call(server, runtime, {
        createTmuxManager: () => ({
          listSessionNames: async () => [seeded.sessionName],
          inspectPaneProcess: async () => ({ command: 'harness-broker', pid: 47048, dead: false }),
        }),
        isLiveProcess: () => true,
        reattach: async () => {
          reattachAttempts += 1
          return { state: 'unavailable' }
        },
        log: () => undefined,
      })
    }
    const restoreDispatch = installMintingDispatchStub(server, seeded.runtimeId)

    try {
      const response = await sendDm(seeded.sessionRef)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { execution?: { runtimeId?: string } }
      expect(body.execution?.runtimeId).toBe(`${seeded.runtimeId}-minted`)
    } finally {
      restoreDispatch()
      server.reattachLiveSemanticDmSubstrate = originalGuard
    }

    expect(reattachAttempts).toBe(1)
    expect(server.db.runtimes.listByHostSessionId(seeded.hostSessionId)).toHaveLength(2)
  })
})
