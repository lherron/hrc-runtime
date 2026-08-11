import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, SemanticDmResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE_REF = 'agent:t07202-cold:project:hrc-runtime:task:T-07202'
const SESSION_REF = `${SCOPE_REF}/lane:default`

const intent: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
  execution: { preferredMode: 'interactive' },
}

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('h72-')
  server = await createHrcServer(
    fixture.serverOpts({
      claudeCodeTmuxBrokerEnabled: true,
      otelListenerEnabled: false,
    })
  )
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

async function waitForPersistedMessages(expected: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      if (db.messages.query({}).length >= expected) return
    } finally {
      db.close()
    }
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for ${expected} persisted messages`)
}

describe('T-07202 semantic-DM cold-provision single-flight', () => {
  it('converges three crossing DMs onto one interactive broker runtime', async () => {
    const resolved = await fixture.resolveSession(SCOPE_REF)
    const beforeDb = openHrcDatabase(fixture.dbPath)
    try {
      expect(beforeDb.runtimes.listByHostSessionId(resolved.hostSessionId)).toHaveLength(0)
    } finally {
      beforeDb.close()
    }

    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    let firstStartEntered!: () => void
    const firstStart = new Promise<void>((resolve) => {
      firstStartEntered = resolve
    })
    let startCalls = 0
    const startPrompts: string[] = []
    const reusedPrompts: Array<{ prompt: string; runtimeId: string }> = []
    ;(server as any).startInteractiveTmuxBrokerRuntime = async (
      _session: unknown,
      turnIntent: HrcRuntimeIntent,
      _runId: string,
      options: { onAccepted?: (runtime: HrcRuntimeSnapshot) => void }
    ) => {
      startCalls += 1
      startPrompts.push(turnIntent.initialPrompt ?? '')
      firstStartEntered()
      const call = startCalls
      await startGate

      const db = openHrcDatabase(fixture.dbPath)
      const now = fixture.now()
      const runtimeId = `rt-t07202-${call}`
      try {
        db.runtimes.insert({
          runtimeId,
          hostSessionId: resolved.hostSessionId,
          scopeRef: SCOPE_REF,
          laneRef: 'default',
          generation: resolved.generation,
          transport: 'tmux',
          harness: 'claude-code',
          provider: 'anthropic',
          status: 'ready',
          supportsInflightInput: true,
          adopted: false,
          controllerKind: 'harness-broker',
          activeOperationId: `op-t07202-${call}`,
          activeInvocationId: `inv-t07202-${call}`,
          createdAt: now,
          updatedAt: now,
        })
        const runtime = db.runtimes.getByRuntimeId(runtimeId)
        expect(runtime).toBeDefined()
        options.onAccepted?.(runtime!)
        return runtime!
      } finally {
        db.close()
      }
    }
    ;(server as any).spawnBrokerHeadlessViewer = async () => undefined
    ;(server as any).executeInteractiveBrokerInputTurn = async (
      session: { hostSessionId: string; generation: number },
      runtime: HrcRuntimeSnapshot,
      prompt: string,
      runId: string
    ) => {
      reusedPrompts.push({ prompt, runtimeId: runtime.runtimeId })
      return Response.json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        status: 'started',
        supportsInFlightInput: true,
      })
    }

    const send = (index: number) =>
      fixture.postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: SESSION_REF },
        body: `crossing DM ${index}`,
        runtimeIntent: intent,
      })

    const requests = [send(1)]
    await firstStart
    requests.push(send(2), send(3))
    await waitForPersistedMessages(3)
    await Bun.sleep(20)

    const startsWhileAllRequestsWereInFlight = startCalls
    releaseStart()
    const responses = await Promise.all(requests)
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    const bodies = (await Promise.all(
      responses.map(async (response) => (await response.json()) as SemanticDmResponse)
    )) as SemanticDmResponse[]

    const afterDb = openHrcDatabase(fixture.dbPath)
    try {
      const runtimes = afterDb.runtimes.listByHostSessionId(resolved.hostSessionId)
      const runtimeIds = bodies.map((body) => body.request.execution.runtimeId)
      expect({
        startsWhileAllRequestsWereInFlight,
        runtimeCount: runtimes.length,
        distinctResponseRuntimeIds: new Set(runtimeIds).size,
        initialPrompts: startPrompts,
        reusedPrompts,
      }).toEqual({
        startsWhileAllRequestsWereInFlight: 1,
        runtimeCount: 1,
        distinctResponseRuntimeIds: 1,
        initialPrompts: [expect.stringContaining('crossing DM 1')],
        reusedPrompts: [
          { prompt: expect.stringContaining('crossing DM 2'), runtimeId: runtimes[0]!.runtimeId },
          { prompt: expect.stringContaining('crossing DM 3'), runtimeId: runtimes[0]!.runtimeId },
        ],
      })
    } finally {
      afterDb.close()
    }
  })
})
