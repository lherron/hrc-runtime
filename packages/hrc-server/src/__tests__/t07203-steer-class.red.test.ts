import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

/**
 * T-07203 (spec r7) — steer-class delivery on the INTERACTIVE broker route,
 * plus the race/replay invariants shared with the headless route.
 *
 * The invariant matrix, each row the resolution of a daedalus rejection:
 * r1: interactive success is presented_to_live_harness — never admission.
 * r2: disposition 'started' is an honest outcome with a retained, tracked run.
 * r4: no activeRun -> a NON-ACTUATING reject probe, never blind steer/queue.
 * r5: every steer-class dispatch has a ledger row before the first broker call.
 * r6: UNSUPPORTED is allowlisted; unknown failures seal AMBIGUOUS.
 */

const interactiveIntent: HrcRuntimeIntent = {
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
  fixture = await createHrcTestFixture('hrc-t07203-steer-')
  server = await createHrcServer(
    fixture.serverOpts({
      claudeCodeTmuxBrokerEnabled: true,
      headlessCodexBrokerEnabled: true,
      codexCliTmuxBrokerEnabled: false,
      otelListenerEnabled: false,
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

async function seedInteractive(
  label: string,
  state: 'ready' | 'busy',
  options: { steerCapable?: boolean } = {}
): Promise<Seeded> {
  const scopeRef = `agent:t07203-${label}:project:hrc-runtime:task:T-07203`
  const sessionRef = `${scopeRef}/lane:main`
  const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
  const runtimeId = `rt-t07203-${label}`
  const operationId = `op-t07203-${label}`
  const invocationId = `inv-t07203-${label}`
  const activeRunId = state === 'busy' ? `run-t07203-active-${label}` : undefined
  const now = fixture.now()

  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.updateIntent(hostSessionId, interactiveIntent, now)
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: state,
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: operationId,
      activeInvocationId: invocationId,
      // decideInteractiveBrokerAdmission reads the driver from tmuxJson; without
      // it the reuse branch can never match and every dispatch reprovisions.
      tmuxJson: { brokerDriver: 'claude-code-tmux' },
      ...(activeRunId ? { activeRunId } : {}),
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    db.brokerInvocations.insert({
      invocationId,
      operationId,
      runtimeId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'claude-code-tmux',
      invocationState: state === 'busy' ? 'turn_active' : 'ready',
      capabilitiesJson: JSON.stringify({
        input: {
          queue: true,
          ...(options.steerCapable === false
            ? { busyPolicies: ['reject', 'queue'] }
            : { busyPolicies: ['reject', 'queue', 'steer'] }),
        },
      }),
      specHash: `sha256:spec-t07203-${label}`,
      startRequestHash: `sha256:req-t07203-${label}`,
      selectedProfileHash: `sha256:profile-t07203-${label}`,
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
        laneRef: 'main',
        generation,
        transport: 'tmux',
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

type DispatchCall = {
  policy?: { whenBusy?: string } | undefined
  input: { inputId: string; metadata?: { runId?: string | undefined } | undefined }
}

function installBroker(
  behaviour: (request: DispatchCall, callIndex: number) => unknown = () => ({
    ok: true,
    response: { accepted: true, disposition: 'attempted_steer' },
  })
): { calls: DispatchCall[] } {
  const calls: DispatchCall[] = []
  ;(server as unknown as Record<string, unknown>).getHarnessBrokerController = () => ({
    dispatchInput: async (request: DispatchCall) => {
      calls.push(request)
      return behaviour(request, calls.length)
    },
  })
  return { calls }
}

const sendDm = async (seeded: Seeded, body: string, whenBusy?: 'steer') =>
  await fixture.postJson('/v1/messages/dm', {
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: seeded.sessionRef },
    body,
    runtimeIntent: interactiveIntent,
    ...(whenBusy === undefined ? {} : { whenBusy }),
  })

const nonTerminalRuns = (): Array<{ runId: string; status: string }> => {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runs
      .listRuns({})
      .filter((run) => run.status === 'accepted' || run.status === 'started')
      .map((run) => ({ runId: run.runId, status: run.status }))
  } finally {
    db.close()
  }
}

type DmBody = {
  request: { execution: { state: string; runId?: string } }
  warnings?: Array<{ code: string }> | undefined
  delivery?: Record<string, unknown> | undefined
}

describe('T-07203 steer-class delivery on the interactive route', () => {
  it('presents a steer into the busy live harness — never claims admission', async () => {
    const seeded = await seedInteractive('present', 'busy')
    const beforeNonTerminal = nonTerminalRuns().length
    const broker = installBroker()

    const response = await sendDm(seeded, 'STOP - reprioritize now', 'steer')
    expect(response.status).toBe(200)
    const body = (await response.json()) as DmBody

    // r1: pane-write proof only — presented, with explicit non-admission ack.
    expect(body.delivery).toMatchObject({
      code: 'presented_to_live_harness',
      delivery: 'presented',
      presentedDuringRunId: seeded.activeRunId as string,
      deliverySemantics: 'pane_presentation',
      ackSemantics: 'pane_write_only',
    })
    expect(body.warnings).toBeUndefined()
    // Terminal message anchored to the run it was presented during.
    expect(body.request.execution.state).toBe('completed')
    expect(body.request.execution.runId).toBe(seeded.activeRunId as string)
    // No live run added: the provisional row is terminal (cancelled) audit-only.
    expect(nonTerminalRuns().length).toBe(beforeNonTerminal)
    expect(broker.calls).toHaveLength(1)
    expect(broker.calls[0]?.policy?.whenBusy).toBe('steer')
  })

  it('fails typed with zero broker calls when the live broker cannot steer', async () => {
    const seeded = await seedInteractive('nosteer', 'busy', { steerCapable: false })
    const broker = installBroker()

    const response = await sendDm(seeded, 'STOP', 'steer')
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_unsupported')
    expect(broker.calls).toHaveLength(0)
  })

  it('regression fence: a default DM to a busy interactive target queues with the HONEST warning', async () => {
    const seeded = await seedInteractive('fence', 'busy')
    installBroker(() => ({
      ok: true,
      response: { accepted: true, disposition: 'queued' },
    }))

    const response = await sendDm(seeded, 'routine follow-up')
    expect(response.status).toBe(200)
    const body = (await response.json()) as DmBody
    // The interactive warning admits the harness may surface input mid-turn;
    // the headless until-turn-end wording would be a lie on this route.
    expect(body.warnings).toEqual([
      {
        code: 'queued_to_live_harness',
        delivery: 'deferred',
        message:
          'target is busy; input queued to the live harness and may surface mid-turn or after the active turn completes',
      },
    ])
    expect(body.delivery).toBeUndefined()
  })

  it('r4: an idle target gets a reject PROBE first, and a started probe is an honest outcome', async () => {
    const seeded = await seedInteractive('idleprobe', 'ready')
    const broker = installBroker((request) => {
      expect(request.policy?.whenBusy).toBe('reject')
      return { ok: true, response: { accepted: true, disposition: 'started' } }
    })

    const response = await sendDm(seeded, 'STOP', 'steer')
    expect(response.status).toBe(200)
    const body = (await response.json()) as DmBody

    expect(body.delivery).toMatchObject({ code: 'started_fresh_turn', delivery: 'started' })
    expect(broker.calls).toHaveLength(1)
    // The retained run is live and owns the runtime pointers.
    const runId = body.request.execution.runId as string
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.getByRuntimeId(seeded.runtimeId)?.activeRunId).toBe(runId)
      expect(db.runs.getByRunId(runId)?.status).toBe('accepted')
    } finally {
      db.close()
    }
  })

  it('r4: the idle-to-busy race resolves identity via the probe refusal and steers the resolved run', async () => {
    const seeded = await seedInteractive('idlerace', 'ready')
    const concurrentRunId = 'run-t07203-concurrent'
    const broker = installBroker((request, callIndex) => {
      if (callIndex === 1) {
        expect(request.policy?.whenBusy).toBe('reject')
        // Simulate the concurrent dispatcher: it wrote its run row and the
        // runtime/invocation pointers BEFORE its own broker call, so they are
        // readable by the time our probe refusal returns.
        const db = openHrcDatabase(fixture.dbPath)
        const now = fixture.now()
        try {
          db.runs.insert({
            runId: concurrentRunId,
            hostSessionId: seeded.hostSessionId,
            runtimeId: seeded.runtimeId,
            scopeRef: seeded.scopeRef,
            laneRef: 'main',
            generation: 1,
            transport: 'tmux',
            status: 'started',
            acceptedAt: now,
            startedAt: now,
            updatedAt: now,
            invocationId: seeded.invocationId,
          })
          db.runtimes.update(seeded.runtimeId, {
            activeRunId: concurrentRunId,
            status: 'busy',
            statusChangedAt: now,
          })
        } finally {
          db.close()
        }
        return {
          ok: false,
          error: { code: 'broker_input_failed', message: 'input rejected: busy_rejected' },
        }
      }
      expect(request.policy?.whenBusy).toBe('steer')
      return { ok: true, response: { accepted: true, disposition: 'attempted_steer' } }
    })

    const response = await sendDm(seeded, 'STOP', 'steer')
    expect(response.status).toBe(200)
    const body = (await response.json()) as DmBody
    expect(body.delivery).toMatchObject({
      code: 'presented_to_live_harness',
      presentedDuringRunId: concurrentRunId,
    })
    expect(broker.calls).toHaveLength(2)
  })

  it('T-07676 turnover fence: a run that ended inside the probe window remains race_lost', async () => {
    const seeded = await seedInteractive('doublerace', 'ready')
    const broker = installBroker(() => ({
      ok: false,
      error: { code: 'broker_input_failed', message: 'input rejected: busy_rejected' },
    }))

    const response = await sendDm(seeded, 'STOP', 'steer')
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('urgent_delivery_race_lost')
    expect(body.error.message).toContain('began and ended around the steer request')
    expect(broker.calls).toHaveLength(1)
  })

  it('T-07676: commits one non-actuated refusal for an unchanged active run', async () => {
    const seeded = await seedInteractive('steady-refusal', 'ready')
    const broker = installBroker((request) => {
      const activeRunId = request.input.metadata?.runId
      if (activeRunId === undefined) throw new Error('probe carried no provisional run identity')

      // Production repro: while the reject probe is in flight, broker event
      // projection makes that same provisioned run the runtime's active run.
      // The broker then returns its provably non-actuated busy refusal.
      const db = openHrcDatabase(fixture.dbPath)
      const now = fixture.now()
      try {
        db.runs.update(activeRunId, {
          status: 'started',
          startedAt: now,
          updatedAt: now,
        })
        db.runtimes.update(seeded.runtimeId, {
          activeRunId,
          status: 'busy',
          statusChangedAt: now,
          updatedAt: now,
        })
        db.brokerInvocations.update(seeded.invocationId, {
          invocationState: 'turn_active',
          runId: activeRunId,
          updatedAt: now,
        })
      } finally {
        db.close()
      }
      return {
        ok: false,
        error: { code: 'broker_input_failed', message: 'input rejected: busy_rejected' },
      }
    })

    const first = await sendDm(seeded, 'STOP', 'steer')
    expect(first.status).toBe(409)
    expect((await first.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'urgent_delivery_refused' },
    })

    const db = openHrcDatabase(fixture.dbPath)
    let activeRunId: string
    try {
      activeRunId = db.runtimes.getByRuntimeId(seeded.runtimeId)?.activeRunId ?? ''
      expect(activeRunId).not.toBe('')
      expect(db.runs.getByRunId(activeRunId)?.status).toBe('started')
      expect(
        db.steerContributions.findRefusalForActiveRun(
          seeded.hostSessionId,
          seeded.runtimeId,
          activeRunId
        )?.state
      ).toBe('refused')
    } finally {
      db.close()
    }

    // A later wake against the same run observes the committed refusal and
    // does not probe or steer the broker again. Run turnover remains the key
    // that permits a future attempt.
    const second = await sendDm(seeded, 'STOP again', 'steer')
    expect(second.status).toBe(409)
    expect((await second.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'urgent_delivery_refused' },
    })
    expect(broker.calls).toHaveLength(1)
  })

  it('r6: a post-paste actuator failure seals AMBIGUOUS, never a non-actuated refusal', async () => {
    const seeded = await seedInteractive('paste', 'busy')
    const broker = installBroker(() => ({
      ok: true,
      response: {
        accepted: false,
        disposition: 'rejected',
        reason: 'Error: tmux send-keys Enter failed after paste',
      },
    }))

    const response = await sendDm(seeded, 'STOP', 'steer')
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_ambiguous')
    expect(broker.calls).toHaveLength(1)
  })

  it('r6: allowlisted pre-actuation refusals still seal UNSUPPORTED', async () => {
    const seeded = await seedInteractive('allowlist', 'busy')
    installBroker(() => ({
      ok: true,
      response: { accepted: false, disposition: 'rejected', reason: 'steer_not_supported' },
    }))

    const response = await sendDm(seeded, 'STOP', 'steer')
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_unsupported')
  })
})

describe('T-07203 steer-class replay authority (r5)', () => {
  const headlessIntent: HrcRuntimeIntent = {
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

  async function seedHeadlessIdle(label: string): Promise<Seeded> {
    const scopeRef = `agent:t07203-${label}:project:hrc-runtime:task:T-07203`
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const runtimeId = `rt-t07203-${label}`
    const operationId = `op-t07203-${label}`
    const invocationId = `inv-t07203-${label}`
    const now = fixture.now()
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.sessions.updateIntent(hostSessionId, headlessIntent, now)
      db.sessions.updateContinuation(
        hostSessionId,
        { provider: 'openai', key: 'thread-t07203' },
        now
      )
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: invocationId,
        continuation: { provider: 'openai', key: 'thread-t07203' },
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
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({
          input: { queue: true, busyPolicies: ['reject', 'queue', 'steer'] },
        }),
        specHash: `sha256:spec-t07203-${label}`,
        startRequestHash: `sha256:req-t07203-${label}`,
        selectedProfileHash: `sha256:profile-t07203-${label}`,
        createdAt: now,
        updatedAt: now,
      })
    } finally {
      db.close()
    }
    return { scopeRef, sessionRef, hostSessionId, runtimeId, invocationId }
  }

  it('r5 verbatim: a retried key after an idle-probe start REPLAYS started_fresh instead of re-actuating', async () => {
    const seeded = await seedHeadlessIdle('replay')
    const calls: DispatchCall[] = []
    ;(server as unknown as Record<string, unknown>).getHarnessBrokerController = () => ({
      dispatchInput: async (request: DispatchCall) => {
        calls.push(request)
        return { ok: true, response: { accepted: true, disposition: 'started' } }
      },
    })

    const send = async () =>
      await fixture.postJson('/v1/turns', {
        hostSessionId: seeded.hostSessionId,
        prompt: 'STOP',
        whenBusy: 'steer',
        idempotencyKey: 'idem-t07203-replay',
        runtimeIntent: headlessIntent,
      })

    const first = await send()
    expect(first.status).toBe(202)
    const firstBody = (await first.json()) as { runId: string; delivery?: { code: string } }
    expect(firstBody.delivery?.code).toBe('started_fresh_turn')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.policy?.whenBusy).toBe('reject')

    const second = await send()
    expect(second.status).toBe(202)
    const secondBody = (await second.json()) as { runId: string; delivery?: { code: string } }
    // The decisive assertions: same run, same outcome, NO second actuation.
    expect(secondBody.delivery?.code).toBe('started_fresh_turn')
    expect(secondBody.runId).toBe(firstBody.runId)
    expect(calls).toHaveLength(1)
  })
})

/**
 * T-07214 — steer_else_queue: the best-effort DEFAULT delivery class.
 * Fallback-floor identity: only the steer-capable-busy cells differ from a
 * bare DM; every other cell is byte-identical to the deferred floor, and
 * AMBIGUOUS never falls back (no possibly-actuated order delivered twice).
 */
describe('T-07214 best-effort default class (interactive route)', () => {
  const sendDefault = async (seeded: Seeded, body: string) =>
    await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: seeded.sessionRef },
      body,
      runtimeIntent: interactiveIntent,
      whenBusy: 'steer_else_queue',
    })

  it('steers a busy steer-capable target identically to strict steer', async () => {
    const seeded = await seedInteractive('be-steer', 'busy')
    const broker = installBroker()

    const response = await sendDefault(seeded, 'default-class order')
    expect(response.status).toBe(200)
    const body = (await response.json()) as DmBody
    expect(body.delivery).toMatchObject({
      code: 'presented_to_live_harness',
      presentedDuringRunId: seeded.activeRunId as string,
    })
    expect(body.warnings).toBeUndefined()
    expect(broker.calls[0]?.policy?.whenBusy).toBe('steer')
  })

  it('floors to the ordinary queue against a busy NON-steer-capable target', async () => {
    const seeded = await seedInteractive('be-floor', 'busy', { steerCapable: false })
    const broker = installBroker(() => ({
      ok: true,
      response: { accepted: true, disposition: 'queued' },
    }))

    const response = await sendDefault(seeded, 'default-class routine')
    expect(response.status).toBe(200)
    const body = (await response.json()) as DmBody
    // Byte-identical floor: honest route warning, no typed error, no steer call.
    expect(body.warnings).toEqual([
      {
        code: 'queued_to_live_harness',
        delivery: 'deferred',
        message:
          'target is busy; input queued to the live harness and may surface mid-turn or after the active turn completes',
      },
    ])
    expect(body.delivery).toBeUndefined()
    expect(broker.calls.every((call) => call.policy?.whenBusy !== 'steer')).toBe(true)
  })

  it('double-race floors with a queued_fallback audit seal, never a typed error', async () => {
    const seeded = await seedInteractive('be-race', 'ready')
    const broker = installBroker((_request, callIndex) =>
      callIndex === 1
        ? {
            ok: false,
            error: { code: 'broker_input_failed', message: 'input rejected: busy_rejected' },
          }
        : { ok: true, response: { accepted: true, disposition: 'queued' } }
    )

    const response = await sendDefault(seeded, 'default-class raced')
    expect(response.status).toBe(200)
    expect(broker.calls[0]?.policy?.whenBusy).toBe('reject')
    // The write-ahead row must be sealed (queued_fallback), never left open.
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.steerContributions.listAttempting()).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('AMBIGUOUS never falls back: a possibly-actuated default-class order fails typed', async () => {
    const seeded = await seedInteractive('be-ambig', 'busy')
    const broker = installBroker(() => ({
      ok: true,
      response: {
        accepted: false,
        disposition: 'rejected',
        reason: 'Error: tmux send-keys Enter failed after paste',
      },
    }))

    const response = await sendDefault(seeded, 'default-class possibly-actuated')
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_ambiguous')
    // Exactly one steer attempt; the floor was NOT taken.
    expect(broker.calls).toHaveLength(1)
  })

  it('is rejected typed on the turn-handoff surface', async () => {
    const seeded = await seedInteractive('be-handoff', 'ready')
    const response = await fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: seeded.sessionRef },
      body: 'nope',
      runtimeIntent: interactiveIntent,
      whenBusy: 'steer_else_queue',
    })
    expect(response.status).toBe(400)
  })

  it('is rejected typed when combined with wait', async () => {
    const seeded = await seedInteractive('be-wait', 'ready')
    const response = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: seeded.sessionRef },
      body: 'nope',
      runtimeIntent: interactiveIntent,
      whenBusy: 'steer_else_queue',
      wait: { enabled: true },
    })
    expect(response.status).toBe(400)
  })
})
