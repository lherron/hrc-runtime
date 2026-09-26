import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

/**
 * T-08385 contract: the narrow operator recovery only withdraws an exact,
 * durably-correlated accepted input after two live-idle probes. It may settle
 * that exact run but cannot overwrite a newer busy projection.
 *
 * Broker IPC is stubbed at the controller seam; server routing, persistence,
 * compare-and-set ownership updates, and lifecycle event storage are real.
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-server test t08385-accepted-run-recovery
 */

const RUNTIME_ID = 'rt-t08385'
const HOST_SESSION_ID = 'hsid-t08385'
const SCOPE_REF = 'agent:t08385'
const OPERATION_ID = 'op-t08385'
const INVOCATION_ID = 'inv-t08385'
const RUN_ID = 'run-t08385'
const SUBMISSION_ID = 'submission-t08385'

let fixture: HrcServerTestFixture
let server: HrcServer
let probeResults: Array<Record<string, unknown>>
const withdrawCalls: unknown[] = []
let onWithdraw: (() => void) | undefined

function idleProbe(): Record<string, unknown> {
  return {
    ok: true,
    response: {
      invocationId: INVOCATION_ID,
      seat: { state: 'idle' },
      brokerHeldDepth: 0,
    },
  }
}

function activeProbe(): Record<string, unknown> {
  return {
    ok: true,
    response: {
      invocationId: INVOCATION_ID,
      seat: { state: 'turn-active', turnId: 'turn-newer' },
      brokerHeldDepth: 1,
    },
  }
}

function stubController(): void {
  ;(server as any).getHarnessBrokerController = () => ({
    seatProbe: async () => probeResults.shift() ?? idleProbe(),
    withdraw: async (input: unknown) => {
      withdrawCalls.push(input)
      onWithdraw?.()
      return { ok: true, response: { outcome: 'withdrawn' } }
    },
  })
}

function seedCandidate(options: { identity?: boolean } = {}): void {
  fixture.seedSession(HOST_SESSION_ID, SCOPE_REF)
  const db = openHrcDatabase(fixture.dbPath)
  const old = new Date(Date.now() - 15 * 60_000).toISOString()
  try {
    db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'codex',
      status: 'busy',
      controllerKind: 'harness-broker',
      activeRunId: RUN_ID,
      activeOperationId: OPERATION_ID,
      activeInvocationId: INVOCATION_ID,
      continuation: { provider: 'codex', kind: 'session', key: 'cont-t08385' },
      lastActivityAt: old,
      supportsInflightInput: false,
      adopted: false,
      createdAt: old,
      updatedAt: old,
    })
    db.brokerInvocations.insert({
      invocationId: INVOCATION_ID,
      operationId: OPERATION_ID,
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({ admission: { classes: ['invoke'] } }),
      specHash: 'sha256:spec-t08385',
      startRequestHash: 'sha256:req-t08385',
      selectedProfileHash: 'sha256:profile-t08385',
      createdAt: old,
      updatedAt: old,
    })
    db.runs.insert({
      runId: RUN_ID,
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: old,
      updatedAt: old,
      operationId: OPERATION_ID,
      invocationId: INVOCATION_ID,
      ...(options.identity === false
        ? {}
        : { dispatchedInputId: SUBMISSION_ID, brokerSubmissionId: SUBMISSION_ID }),
    })
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08385-recovery-')
  server = await createHrcServer(fixture.serverOpts())
  probeResults = []
  withdrawCalls.length = 0
  onWithdraw = undefined
  stubController()
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

describe('POST /v1/runs/recover-unstarted', () => {
  it('dry-runs an exact idle candidate without changing its run or runtime', async () => {
    seedCandidate()
    probeResults.push(idleProbe())

    const res = await fixture.postJson('/v1/runs/recover-unstarted', {
      runId: RUN_ID,
      dryRun: true,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      runId: RUN_ID,
      status: 'matched',
    })
    expect(withdrawCalls).toEqual([])
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runs.getByRunId(RUN_ID)).toMatchObject({
        status: 'accepted',
        completedAt: undefined,
      })
      expect(db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
        status: 'busy',
        activeRunId: RUN_ID,
      })
    } finally {
      db.close()
    }
  })

  it('withdraws only the exact accepted submission, terminalizes it, and preserves continuation', async () => {
    seedCandidate()
    probeResults.push(idleProbe(), idleProbe())

    const res = await fixture.postJson('/v1/runs/recover-unstarted', { runId: RUN_ID, yes: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ runId: RUN_ID, status: 'recovered' })
    expect(withdrawCalls).toEqual([
      {
        runtimeId: RUNTIME_ID,
        submissionId: SUBMISSION_ID,
        reason: 'accepted_run_never_started',
      },
    ])
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runs.getByRunId(RUN_ID)).toMatchObject({
        status: 'failed',
        errorCode: 'accepted_run_never_started',
      })
      expect(db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
        status: 'ready',
        activeRunId: undefined,
        activeInvocationId: INVOCATION_ID,
        continuation: { provider: 'codex', kind: 'session', key: 'cont-t08385' },
      })
      expect(db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.reaped' })).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('fails closed when the first probe proves a real active turn', async () => {
    seedCandidate()
    probeResults.push(activeProbe())

    const res = await fixture.postJson('/v1/runs/recover-unstarted', { runId: RUN_ID, yes: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ runId: RUN_ID, status: 'skipped' })
    expect(withdrawCalls).toEqual([])
  })

  it('fails closed when the accepted run has no exact persisted submission identity', async () => {
    seedCandidate({ identity: false })
    probeResults.push(idleProbe())

    const res = await fixture.postJson('/v1/runs/recover-unstarted', { runId: RUN_ID, yes: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ runId: RUN_ID, status: 'skipped' })
    expect(withdrawCalls).toEqual([])
  })

  it('settles the old run but leaves a newer observed turn busy after withdrawal', async () => {
    seedCandidate()
    probeResults.push(idleProbe(), activeProbe())

    const res = await fixture.postJson('/v1/runs/recover-unstarted', { runId: RUN_ID, yes: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ runId: RUN_ID, status: 'projection_pending' })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runs.getByRunId(RUN_ID)).toMatchObject({
        status: 'failed',
        errorCode: 'accepted_run_never_started',
      })
      expect(db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
        status: 'busy',
        activeRunId: undefined,
      })
    } finally {
      db.close()
    }
  })

  it('leaves the runtime busy when a newer operation claims the same invocation after withdrawal', async () => {
    seedCandidate()
    probeResults.push(idleProbe(), idleProbe())
    onWithdraw = () => {
      const db = openHrcDatabase(fixture.dbPath)
      try {
        db.runtimes.update(RUNTIME_ID, {
          activeOperationId: 'op-t08385-newer',
          updatedAt: fixture.now(),
        })
      } finally {
        db.close()
      }
    }

    const res = await fixture.postJson('/v1/runs/recover-unstarted', { runId: RUN_ID, yes: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ runId: RUN_ID, status: 'projection_pending' })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
        status: 'busy',
        activeOperationId: 'op-t08385-newer',
      })
    } finally {
      db.close()
    }
  })

  it('leaves the runtime busy when the persisted invocation changes operation after withdrawal', async () => {
    seedCandidate()
    probeResults.push(idleProbe(), idleProbe())
    onWithdraw = () => {
      const db = openHrcDatabase(fixture.dbPath)
      try {
        db.brokerInvocations.update(INVOCATION_ID, {
          operationId: 'op-t08385-newer',
          updatedAt: fixture.now(),
        })
      } finally {
        db.close()
      }
    }

    const res = await fixture.postJson('/v1/runs/recover-unstarted', { runId: RUN_ID, yes: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ runId: RUN_ID, status: 'projection_pending' })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({ status: 'busy' })
      expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)).toMatchObject({
        operationId: 'op-t08385-newer',
      })
    } finally {
      db.close()
    }
  })

  it('retries only a retained exact withdrawal to perform the later ready projection', async () => {
    seedCandidate()
    probeResults.push(idleProbe(), activeProbe())
    const first = await fixture.postJson('/v1/runs/recover-unstarted', { runId: RUN_ID, yes: true })
    expect(await first.json()).toMatchObject({ status: 'projection_pending' })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.brokerInvocationEvents.appendEvent({
        invocationId: INVOCATION_ID,
        seq: 1,
        time: fixture.now(),
        type: 'submission.withdrawn',
        runtimeId: RUNTIME_ID,
        runId: RUN_ID,
        payload: {
          submissionId: SUBMISSION_ID,
          reason: 'accepted_run_never_started',
        },
        projectionStatus: 'applied',
      })
    } finally {
      db.close()
    }
    probeResults.push(idleProbe())

    const retry = await fixture.postJson('/v1/runs/recover-unstarted', { runId: RUN_ID, yes: true })

    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ runId: RUN_ID, status: 'recovered' })
    expect(withdrawCalls).toHaveLength(1)
  })
})
