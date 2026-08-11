import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, SemanticTurnHandoffStartedResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

/**
 * T-07155 stage 2 — urgent (`whenBusy: 'steer'`) delivery, HRC side.
 *
 * Gates G5, G6, G7, G8, G9, G14, G15. The invariant under test throughout: an
 * urgent order either reaches the ACTIVE turn or fails typed. It is never
 * silently downgraded into the ordinary deferred queue, because a supervisor
 * who believes a stop order landed when it did not is exactly the failure this
 * task exists to remove.
 */

const intent: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { provider: 'openai', id: 'codex-cli', interactive: false },
  execution: { preferredMode: 'headless' },
}

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07155-urgent-')
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

type Seeded = {
  scopeRef: string
  sessionRef: string
  hostSessionId: string
  runtimeId: string
  invocationId: string
  activeRunId?: string | undefined
}

async function seed(
  label: string,
  state: 'ready' | 'busy',
  options: { steerCapable?: boolean; legacy?: boolean } = {}
): Promise<Seeded> {
  const scopeRef = `agent:t07155-${label}:project:hrc-runtime:task:T-07155`
  const sessionRef = `${scopeRef}/lane:main`
  const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
  const runtimeId = `rt-t07155-${label}`
  const operationId = `op-t07155-${label}`
  const invocationId = `inv-t07155-${label}`
  const activeRunId = state === 'busy' ? `run-t07155-active-${label}` : undefined
  const now = fixture.now()

  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.updateIntent(hostSessionId, intent, now)
    db.sessions.updateContinuation(hostSessionId, { provider: 'openai', key: 'thread-t07155' }, now)
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
      // A legacy runtime predates durable broker endpoints: no invocation
      // descriptor exists for HRC to steer through.
      ...(options.legacy === true ? {} : { activeInvocationId: invocationId }),
      ...(activeRunId ? { activeRunId } : {}),
      continuation: { provider: 'openai', key: 'thread-t07155' },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    if (options.legacy === true) {
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
          operationId,
        })
      }
      return { scopeRef, sessionRef, hostSessionId, runtimeId, invocationId, activeRunId }
    }
    db.brokerInvocations.insert({
      invocationId,
      operationId,
      runtimeId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: state === 'busy' ? 'turn_active' : 'ready',
      // The negotiated signal: what the LIVE broker says it can execute. An old
      // broker process omits busyPolicies entirely.
      capabilitiesJson: JSON.stringify({
        input: {
          queue: true,
          ...(options.steerCapable === true
            ? { busyPolicies: ['reject', 'queue', 'steer'] }
            : { busyPolicies: ['reject', 'queue'] }),
        },
      }),
      specHash: `sha256:spec-t07155-${label}`,
      startRequestHash: `sha256:req-t07155-${label}`,
      selectedProfileHash: `sha256:profile-t07155-${label}`,
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

  return { scopeRef, sessionRef, hostSessionId, runtimeId, invocationId, activeRunId }
}

type DispatchCall = { policy?: { whenBusy?: string } | undefined; input: { inputId: string } }

function installBroker(
  behaviour: (request: DispatchCall) => unknown = () => ({
    ok: true,
    response: { accepted: true, disposition: 'attempted_steer' },
  })
): { calls: DispatchCall[] } {
  const calls: DispatchCall[] = []
  ;(server as unknown as Record<string, unknown>).getHarnessBrokerController = () => ({
    dispatchInput: async (request: DispatchCall) => {
      calls.push(request)
      return behaviour(request)
    },
  })
  return { calls }
}

const send = async (seeded: Seeded, body: string, whenBusy?: 'steer') =>
  await fixture.postJson('/v1/messages/turn-handoff', {
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: seeded.sessionRef },
    body,
    runtimeIntent: intent,
    ...(whenBusy === undefined ? {} : { whenBusy }),
  })

const runRows = (): Array<{ runId: string; status: string }> => {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runs.listRuns({}).map((run) => ({ runId: run.runId, status: run.status }))
  } finally {
    db.close()
  }
}

describe('T-07155 urgent delivery', () => {
  it('G5: admits an urgent order into the active turn without minting a run', async () => {
    const seeded = await seed('g5', 'busy', { steerCapable: true })
    const beforeIds = new Set(runRows().map((run) => run.runId))
    const broker = installBroker()

    const response = await send(seeded, 'STOP - do not push', 'steer')
    expect(response.status).toBe(200)
    const body = (await response.json()) as SemanticTurnHandoffStartedResponse

    // The response points at the run the order JOINED, not a run of its own.
    expect(body.runId).toBe(seeded.activeRunId as string)
    expect(body.delivery).toMatchObject({
      code: 'admitted_into_active_turn',
      delivery: 'admitted',
      mergedIntoRunId: seeded.activeRunId as string,
      deliverySemantics: 'interrupting_steer',
      ackSemantics: 'accepted_only',
    })
    // No deferred-delivery warning: nothing was deferred.
    expect(body.warnings).toBeUndefined()

    // No new LIVE run — a steered input never gets a turn of its own. The
    // T-07203 flow leaves one TERMINAL provisional row (cancelled, tagged
    // superseded_by_steer) purely for event-mapper correlation audit.
    const added = runRows().filter((run) => !beforeIds.has(run.runId))
    expect(added.every((run) => run.status === 'cancelled')).toBe(true)

    // The broker was asked for the steer policy specifically.
    expect(broker.calls).toHaveLength(1)
    expect(broker.calls[0]?.policy?.whenBusy).toBe('steer')

    // Runtime/invocation ownership pointers are untouched.
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.getByRuntimeId(seeded.runtimeId)?.activeRunId).toBe(
        seeded.activeRunId as string
      )
      expect(db.brokerInvocations.getByInvocationId(seeded.invocationId)?.runId).toBe(
        seeded.activeRunId as string
      )
    } finally {
      db.close()
    }
  })

  it('G14: a runtime whose live broker does not advertise steer fails closed, never queues', async () => {
    const seeded = await seed('g14', 'busy', { steerCapable: false })
    const before = runRows().length
    const broker = installBroker()

    const response = await send(seeded, 'STOP', 'steer')

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_unsupported')
    // The decisive assertion: nothing was handed to the broker at all, so the
    // order cannot have been parked on the deferred queue behind the turn.
    expect(broker.calls).toHaveLength(0)
    expect(runRows().length).toBe(before)
  })

  it('G15: a broker input timeout is reported as ambiguous, not as delivered or queued', async () => {
    const seeded = await seed('g15', 'busy', { steerCapable: true })
    const broker = installBroker(() => ({
      ok: false,
      error: { code: 'broker_input_timeout', message: 'broker input timed out' },
    }))

    const response = await send(seeded, 'STOP', 'steer')

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_ambiguous')
    expect(broker.calls).toHaveLength(1)
  })

  it('reports a lost race distinctly so the sender knows it did not preempt', async () => {
    const seeded = await seed('race', 'busy', { steerCapable: true })
    installBroker(() => ({
      ok: false,
      error: { code: 'broker_input_failed', message: 'expectedTurnId does not match active turn' },
    }))

    const response = await send(seeded, 'STOP', 'steer')

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_race_lost')
  })

  it('G6: a broker that refuses the steer fails typed and does not fall back to the queue', async () => {
    const seeded = await seed('g6', 'busy', { steerCapable: true })
    const broker = installBroker(() => ({
      ok: true,
      response: { accepted: false, disposition: 'rejected', reason: 'steer_not_supported' },
    }))

    const response = await send(seeded, 'STOP', 'steer')

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_unsupported')
    expect(broker.calls).toHaveLength(1)
    // One dispatch attempt, and no second attempt under the ordinary policy.
    expect(broker.calls.every((call) => call.policy?.whenBusy === 'steer')).toBe(true)
  })

  it('G8 regression fence: default delivery to a busy runtime is completely unchanged', async () => {
    const seeded = await seed('g8', 'busy', { steerCapable: true })
    const broker = installBroker(() => ({
      ok: true,
      response: { accepted: true, disposition: 'queued' },
    }))

    const response = await send(seeded, 'routine follow-up')
    expect(response.status).toBe(200)
    const body = (await response.json()) as SemanticTurnHandoffStartedResponse

    // Still the stage-1 deferred warning, still its own run, still no delivery
    // outcome — urgent delivery must not leak into the default path.
    expect(body.warnings).toEqual([
      {
        code: 'queued_behind_busy_turn',
        delivery: 'deferred',
        message: 'target is busy; delivery deferred until the active turn completes',
      },
    ])
    expect(body.delivery).toBeUndefined()
    expect(body.runId).not.toBe(seeded.activeRunId as string)
    expect(broker.calls[0]?.policy?.whenBusy).toBe('queue')
  })

  it('G9: urgent delivery combined with wait is refused as a typed conflict', async () => {
    const seeded = await seed('g9', 'busy', { steerCapable: true })

    const response = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: seeded.sessionRef },
      body: 'STOP',
      runtimeIntent: intent,
      whenBusy: 'steer',
      wait: { enabled: true },
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('urgent_wait_conflict')
  })
})

describe('T-07155 urgent delivery idempotency ledger', () => {
  const sendWithKey = async (seeded: Seeded, body: string, idempotencyKey: string) =>
    await fixture.postJson('/v1/turns', {
      hostSessionId: seeded.hostSessionId,
      prompt: body,
      whenBusy: 'steer',
      idempotencyKey,
      runtimeIntent: intent,
    })

  const contributions = () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      return db.steerContributions.listAttempting()
    } finally {
      db.close()
    }
  }

  it('G20: a replayed idempotency key returns the recorded outcome and actuates exactly once', async () => {
    const seeded = await seed('g20', 'busy', { steerCapable: true })
    const broker = installBroker()

    // /v1/turns acknowledges at the public 'accepted' stage (202).
    const first = await sendWithKey(seeded, 'STOP', 'idem-g20')
    expect(first.status).toBe(202)
    const firstBody = (await first.json()) as { delivery?: { code: string } }
    expect(firstBody.delivery?.code).toBe('admitted_into_active_turn')
    expect(broker.calls).toHaveLength(1)

    const second = await sendWithKey(seeded, 'STOP', 'idem-g20')
    expect(second.status).toBe(202)
    const secondBody = (await second.json()) as { delivery?: { code: string } }
    expect(secondBody.delivery?.code).toBe('admitted_into_active_turn')
    // The decisive assertion: the harness was NOT asked a second time.
    expect(broker.calls).toHaveLength(1)
  })

  it('G21: reusing a key for a different request is a stale-context conflict', async () => {
    const seeded = await seed('g21', 'busy', { steerCapable: true })
    installBroker()

    const first = await sendWithKey(seeded, 'STOP', 'idem-g21')
    expect(first.status).toBe(202)

    const second = await sendWithKey(seeded, 'a completely different order', 'idem-g21')
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe('stale_context')
  })

  it('G22: an ambiguous result replays as ambiguous and never re-actuates', async () => {
    const seeded = await seed('g22', 'busy', { steerCapable: true })
    const broker = installBroker(() => ({
      ok: false,
      error: { code: 'broker_input_timeout', message: 'broker input timed out' },
    }))

    const first = await sendWithKey(seeded, 'STOP', 'idem-g22')
    expect(first.status).toBe(503)
    expect(broker.calls).toHaveLength(1)

    // Retrying an ambiguous urgent order must report the ambiguity, not inject
    // it a second time — the failure daedalus rejected revision 1 over.
    const second = await sendWithKey(seeded, 'STOP', 'idem-g22')
    expect(second.status).toBe(503)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_ambiguous')
    expect(broker.calls).toHaveLength(1)
  })

  it('G22b: a write-ahead record is left attempting only across the RPC, and recovery seals it', async () => {
    const seeded = await seed('g22b', 'busy', { steerCapable: true })
    installBroker()

    await sendWithKey(seeded, 'STOP', 'idem-g22b')
    // Sealed by the happy path: nothing is left pending after a completed call.
    expect(contributions()).toHaveLength(0)

    // Simulate a daemon death mid-RPC by writing an unsealed record directly,
    // then prove startup recovery seals it rather than leaving it in limbo.
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.steerContributions.insertAttempting({
        contributionId: 'steer-orphan-g22b',
        hostSessionId: seeded.hostSessionId,
        idempotencyKey: 'idem-orphan-g22b',
        runtimeId: seeded.runtimeId,
        invocationId: seeded.invocationId,
        activeRunId: seeded.activeRunId as string,
        inputId: 'input-orphan',
        now: fixture.now(),
      })
      expect(db.steerContributions.listAttempting()).toHaveLength(1)

      const sealed = db.steerContributions.sealOrphanedAsAmbiguous(fixture.now())
      expect(sealed).toBe(1)
      expect(db.steerContributions.listAttempting()).toHaveLength(0)
      expect(db.steerContributions.getById('steer-orphan-g22b')?.state).toBe('ambiguous')
    } finally {
      db.close()
    }
  })
})

/**
 * T-07191 — the same invariant on the route users actually call. The original
 * suite proved busy steer through /v1/messages/turn-handoff; the busy-headless
 * branch of /v1/messages/dm never read whenBusy and silently downgraded urgent
 * sends into the deferred queue (reproduced live, seq 18717).
 */
describe('T-07191 urgent delivery over /v1/messages/dm', () => {
  const sendDm = async (seeded: Seeded, body: string, whenBusy?: 'steer') =>
    await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: seeded.sessionRef },
      body,
      runtimeIntent: intent,
      ...(whenBusy === undefined ? {} : { whenBusy }),
    })

  type DmBody = {
    request: { execution: { state: string; runId?: string } }
    warnings?: unknown
    delivery?: Record<string, unknown> | undefined
  }

  it('admits an urgent DM into the active turn without minting a run', async () => {
    const seeded = await seed('dm-steer', 'busy', { steerCapable: true })
    const beforeIds = new Set(runRows().map((run) => run.runId))
    const broker = installBroker()

    const response = await sendDm(seeded, 'STOP - do not push', 'steer')
    expect(response.status).toBe(200)
    const body = (await response.json()) as DmBody

    // The order joined the ACTIVE turn and the sender is told exactly that.
    expect(body.delivery).toMatchObject({
      code: 'admitted_into_active_turn',
      delivery: 'admitted',
      mergedIntoRunId: seeded.activeRunId as string,
    })
    // No deferred-delivery warning: nothing was deferred.
    expect(body.warnings).toBeUndefined()
    // Delivery of the message itself is terminal — a steered input never gets
    // a turn of its own, so any non-terminal state would park forever.
    expect(body.request.execution.state).toBe('completed')
    expect(body.request.execution.runId).toBe(seeded.activeRunId as string)
    // Only a terminal (cancelled) provisional audit row may be added — no live run.
    expect(
      runRows()
        .filter((run) => !beforeIds.has(run.runId))
        .every((run) => run.status === 'cancelled')
    ).toBe(true)
    expect(broker.calls).toHaveLength(1)
    expect(broker.calls[0]?.policy?.whenBusy).toBe('steer')
  })

  it('fails typed when the live broker cannot steer, and never queues', async () => {
    const seeded = await seed('dm-nosteer', 'busy', { steerCapable: false })
    const before = runRows().length
    const broker = installBroker()

    const response = await sendDm(seeded, 'STOP', 'steer')

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_unsupported')
    // Nothing was handed to the broker, and no run was minted: the order
    // cannot have been parked on the deferred queue behind the turn.
    expect(broker.calls).toHaveLength(0)
    expect(runRows().length).toBe(before)
  })

  it('fails typed against a busy legacy runtime with no broker endpoint', async () => {
    const seeded = await seed('dm-legacy', 'busy', { legacy: true })
    const before = runRows().length
    const broker = installBroker()

    const response = await sendDm(seeded, 'STOP', 'steer')

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_unsupported')
    expect(broker.calls).toHaveLength(0)
    expect(runRows().length).toBe(before)
  })

  it('regression fence: a default DM to a busy target still queues with the warning', async () => {
    const seeded = await seed('dm-default', 'busy', { steerCapable: true })
    const before = runRows().length
    installBroker()

    const response = await sendDm(seeded, 'routine follow-up')
    expect(response.status).toBe(200)
    const body = (await response.json()) as DmBody

    expect(body.warnings).toEqual([
      {
        code: 'queued_behind_busy_turn',
        delivery: 'deferred',
        message: 'target is busy; delivery deferred until the active turn completes',
      },
    ])
    expect(body.delivery).toBeUndefined()
    expect(body.request.execution.state).toBe('accepted')
    // The deferred path durably mints its own run — unchanged.
    expect(runRows().length).toBe(before + 1)
  })
})

/**
 * T-07214 — the best-effort default class on the HEADLESS route: fallback-
 * floor identity with today's bare DM, including the legacy busy rejection.
 */
describe('T-07214 best-effort default class (headless route)', () => {
  const sendDefaultDm = async (seeded: Seeded, body: string) =>
    await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: seeded.sessionRef },
      body,
      runtimeIntent: intent,
      whenBusy: 'steer_else_queue',
    })

  it('steers a busy steer-capable target identically to strict steer', async () => {
    const seeded = await seed('be-steer', 'busy', { steerCapable: true })
    const broker = installBroker()

    const response = await sendDefaultDm(seeded, 'default-class order')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      delivery?: Record<string, unknown>
      warnings?: unknown
    }
    expect(body.delivery).toMatchObject({
      code: 'admitted_into_active_turn',
      mergedIntoRunId: seeded.activeRunId as string,
    })
    expect(body.warnings).toBeUndefined()
    expect(broker.calls[0]?.policy?.whenBusy).toBe('steer')
  })

  it('floors to the durable queue against a busy non-steer-capable target', async () => {
    const seeded = await seed('be-floor', 'busy', { steerCapable: false })
    const broker = installBroker()

    const response = await sendDefaultDm(seeded, 'default-class routine')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      request: { execution: { state: string } }
      delivery?: unknown
      warnings?: unknown
    }
    // Byte-identical floor: durable queue, honest warning, no steer call.
    expect(body.warnings).toEqual([
      {
        code: 'queued_behind_busy_turn',
        delivery: 'deferred',
        message: 'target is busy; delivery deferred until the active turn completes',
      },
    ])
    expect(body.delivery).toBeUndefined()
    expect(body.request.execution.state).toBe('accepted')
    expect(broker.calls).toHaveLength(0)
  })

  it('keeps the legacy busy rejection: the floor is honest refusal, not a fictitious queue', async () => {
    const seeded = await seed('be-legacy', 'busy', { legacy: true })
    const broker = installBroker()

    const response = await sendDefaultDm(seeded, 'default-class to legacy')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      request: { execution: { state: string; errorCode?: string } }
      delivery?: unknown
    }
    // Identical to a bare DM against a busy legacy runtime today.
    expect(body.request.execution.state).toBe('failed')
    expect(body.delivery).toBeUndefined()
    expect(broker.calls).toHaveLength(0)
  })
})
