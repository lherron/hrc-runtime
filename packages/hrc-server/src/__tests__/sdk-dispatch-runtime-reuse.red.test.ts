import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { type HrcServer, createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

const sdkIntent = {
  placement: {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: {
    provider: 'anthropic',
    interactive: false,
    id: 'agent-sdk',
  },
}

function seedSdkRuntime(input: {
  hostSessionId: string
  runtimeId: string
  status: 'ready' | 'busy' | 'terminated' | 'dead' | 'stale'
  activeRunId?: string | undefined
}): void {
  const db = openHrcDatabase(fixture.dbPath)
  const session = db.sessions.getByHostSessionId(input.hostSessionId)
  if (!session) throw new Error(`missing test session ${input.hostSessionId}`)
  const now = fixture.now()

  try {
    db.runtimes.insert({
      runtimeId: input.runtimeId,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'sdk',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: input.status,
      supportsInflightInput: true,
      adopted: false,
      activeRunId: input.activeRunId,
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

function seedSdkRun(input: {
  hostSessionId: string
  runtimeId: string
  runId: string
  status: 'started' | 'completed'
}): void {
  const db = openHrcDatabase(fixture.dbPath)
  const session = db.sessions.getByHostSessionId(input.hostSessionId)
  if (!session) throw new Error(`missing test session ${input.hostSessionId}`)
  const now = fixture.now()

  try {
    db.runs.insert({
      runId: input.runId,
      hostSessionId: session.hostSessionId,
      runtimeId: input.runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'sdk',
      status: input.status,
      acceptedAt: now,
      startedAt: now,
      ...(input.status === 'completed' ? { completedAt: now } : {}),
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

function readSessionState(hostSessionId: string) {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return {
      session: db.sessions.getByHostSessionId(hostSessionId),
      runtimes: db.runtimes.listByHostSessionId(hostSessionId),
      runs: db.runs.listRuns({ hostSessionId, limit: 100 }),
      events: db.hrcEvents.listFromHrcSeq(1, { hostSessionId }),
      runtimeCreated: db.hrcEvents.listByKind('runtime.created', { hostSessionId }),
    }
  } finally {
    db.close()
  }
}

async function dispatch(hostSessionId: string, prompt: string): Promise<Response> {
  return fixture.postJson('/v1/turns', {
    hostSessionId,
    prompt,
    runtimeIntent: sdkIntent,
    waitForCompletion: true,
  })
}

describe('SDK dispatch runtime reuse', () => {
  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-sdk-runtime-reuse-')
    server = await createHrcServer(
      fixture.serverOpts({
        headlessCodexBrokerEnabled: false,
        claudeCodeTmuxBrokerEnabled: false,
        codexCliTmuxBrokerEnabled: false,
      })
    )

    // SDK execution is deliberately hard-failed during the broker cutover. This
    // task changes the still-owned SDK placement function, so bypass only that
    // terminal guard and exercise the real dry-run SDK handler beneath it.
    ;(server as unknown as { failSdkHarnessPath: () => undefined }).failSdkHarnessPath = () =>
      undefined
  })

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = undefined
    }
    await fixture.cleanup()
  })

  it('reuses one ready SDK runtime across sequential turns, then creates fresh when only unavailable rows remain', async () => {
    const { hostSessionId } = await fixture.resolveSession(
      'agent:room-coordinator:project:taskboard:task:T-05967'
    )

    const first = await dispatch(hostSessionId, 'first SDK turn')
    const firstBody = (await first.json()) as { runtimeId: string; runId: string }
    const second = await dispatch(hostSessionId, 'second SDK turn')
    const secondBody = (await second.json()) as { runtimeId: string; runId: string }
    const afterSequential = readSessionState(hostSessionId)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      for (const runtime of afterSequential.runtimes) {
        db.runtimes.updateStatus(runtime.runtimeId, 'terminated', fixture.now())
      }
    } finally {
      db.close()
    }

    const third = await dispatch(hostSessionId, 'turn after termination')
    const thirdBody = (await third.json()) as { runtimeId: string; runId: string }
    const afterUnavailable = readSessionState(hostSessionId)

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200])
    expect(secondBody.runtimeId).toBe(firstBody.runtimeId)
    expect(secondBody.runId).not.toBe(firstBody.runId)
    expect(afterSequential.runtimes).toHaveLength(1)
    expect(afterSequential.runs).toHaveLength(2)
    expect(afterSequential.runtimeCreated).toHaveLength(1)
    expect(thirdBody.runtimeId).not.toBe(firstBody.runtimeId)
    expect(afterUnavailable.runtimes).toHaveLength(2)
    expect(afterUnavailable.runs).toHaveLength(3)
    expect(afterUnavailable.runtimeCreated).toHaveLength(2)
  })

  it('rejects a matching active SDK runtime before inserting rows or events and preserves continuation', async () => {
    const { hostSessionId } = await fixture.resolveSession('sdk-reuse-busy')
    const runtimeId = 'rt-sdk-busy-existing'
    const runId = 'run-sdk-busy-existing'
    seedSdkRuntime({ hostSessionId, runtimeId, status: 'busy', activeRunId: runId })
    seedSdkRun({ hostSessionId, runtimeId, runId, status: 'started' })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.sessions.updateContinuation(
        hostSessionId,
        { provider: 'anthropic', key: 'continuation-must-survive' },
        fixture.now()
      )
    } finally {
      db.close()
    }
    const before = readSessionState(hostSessionId)

    const response = await dispatch(hostSessionId, 'must reject while prior run is active')
    const body = (await response.json()) as { error?: { code?: string } }
    const after = readSessionState(hostSessionId)

    expect(response.status).toBe(409)
    expect(body.error?.code).toBe(HrcErrorCode.RUNTIME_BUSY)
    expect(after.runtimes).toEqual(before.runtimes)
    expect(after.runs).toEqual(before.runs)
    expect(after.events).toEqual(before.events)
    expect(after.session?.continuation).toEqual(before.session?.continuation)
  })

  it('rejects duplicate ready ownership without insertion but reuses a completed-run dangling pointer', async () => {
    const duplicate = await fixture.resolveSession('sdk-reuse-duplicate-ready')
    seedSdkRuntime({
      hostSessionId: duplicate.hostSessionId,
      runtimeId: 'rt-sdk-ready-1',
      status: 'ready',
    })
    seedSdkRuntime({
      hostSessionId: duplicate.hostSessionId,
      runtimeId: 'rt-sdk-ready-2',
      status: 'ready',
    })
    const duplicateBefore = readSessionState(duplicate.hostSessionId)

    const rejected = await dispatch(duplicate.hostSessionId, 'duplicate owner must reject')
    const rejectedBody = (await rejected.json()) as { error?: { code?: string } }
    const duplicateAfter = readSessionState(duplicate.hostSessionId)

    expect(rejected.status).toBe(409)
    expect(rejectedBody.error?.code).toBe(HrcErrorCode.RUNTIME_BUSY)
    expect(duplicateAfter.runtimes).toEqual(duplicateBefore.runtimes)
    expect(duplicateAfter.runs).toEqual(duplicateBefore.runs)
    expect(duplicateAfter.events).toEqual(duplicateBefore.events)

    const dangling = await fixture.resolveSession('sdk-reuse-completed-dangling-pointer')
    const danglingRuntimeId = 'rt-sdk-ready-completed-pointer'
    const completedRunId = 'run-sdk-completed-pointer'
    seedSdkRuntime({
      hostSessionId: dangling.hostSessionId,
      runtimeId: danglingRuntimeId,
      status: 'ready',
      activeRunId: completedRunId,
    })
    seedSdkRun({
      hostSessionId: dangling.hostSessionId,
      runtimeId: danglingRuntimeId,
      runId: completedRunId,
      status: 'completed',
    })

    const accepted = await dispatch(dangling.hostSessionId, 'completed pointer is reusable')
    const acceptedBody = (await accepted.json()) as { runtimeId: string }
    const danglingAfter = readSessionState(dangling.hostSessionId)

    expect(accepted.status).toBe(200)
    expect(acceptedBody.runtimeId).toBe(danglingRuntimeId)
    expect(danglingAfter.runtimes).toHaveLength(1)
    expect(danglingAfter.runs).toHaveLength(2)
    expect(danglingAfter.runtimeCreated).toHaveLength(0)
  })
})
