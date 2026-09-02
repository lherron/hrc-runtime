import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { installMailKickerAgentHome, waitUntil } from './fixtures/mail-kicker-harness.js'

/**
 * T-07693 — ONE envelope, TWO seats on the identical exact scope.
 *
 * Observed live 2026-08-29T04:20:56Z/04:20:58Z: a single `wrkc say` to
 * `agent:clod:project:agent-spaces:task:T-07688` produced rt-36b65026 and
 * rt-b1c2f234, both `busy`, both editing the one agent-spaces worktree. The
 * roster claim was NOT the hole — both runtimes hang off the SAME
 * `hsid-d65828a5`, and there is exactly one `session.created`. The breach is a
 * layer down: two wake sources each drove a turn into that one session while
 * its interactive broker was still being born.
 *
 * The chain, both links reproduced here:
 *
 *  1. THE TRIGGER. A cold interactive broker start answers with
 *     `DispatchTurnResponseBase` — no `inputId`, because the prompt rides the
 *     runtime's `initialPrompt` and there is no invocation input to name. The
 *     kicker requires one (`mail dispatch did not return a started input`), so
 *     it books a SUCCESSFUL cold birth as `drive_failed`, releases the drive
 *     slot, and never commits the presentation. The envelope stays pending. 15
 *     of 15 `inputId=missing` drives in the live log are `wakeReason:"insert"`
 *     — this is every cold ledger-tail birth, not a rare race.
 *
 *  2. THE BYPASS. The next wake (the periodic sweep) finds the envelope still
 *     pending and the seat durably busy, and dispatches through
 *     `presentIntoBusyTarget` → `dispatchTurnForSession` with NO
 *     `joinInFlightRuntimeStart`. Inside, `decideInteractiveBrokerAdmission`
 *     reads the newborn's `starting` invocation as non-dispatchable (T-05358)
 *     and answers `stale-and-reprovision`: it marks the newborn stale and mints
 *     a SECOND runtime. T-07202 added a join for exactly this collision, but
 *     placed it INSIDE `handleInteractiveTmuxBrokerDispatchTurn` — downstream
 *     of the admission, so it cannot prevent the reprovision — and made it
 *     opt-in, so the wrkq wake path never reached it.
 *
 * The fixture drives the two REAL wake sources (`runWrkqLedgerTail`, then
 * `runMailKickerSweep`) through the REAL `dispatchTurnForSession`, stubbing
 * only the tmux substrate. Deliberately NOT `installDeterministicStart`: that
 * harness replaces `dispatchTurnForSession` wholesale and always hands back an
 * `inputId`, which is precisely why the existing kicker suites agree with the
 * bug instead of catching it.
 */

const SCOPE = 'agent:kicker-double:project:hrc-runtime:task:T-07693'
const TARGET = `${SCOPE}/lane:main`
const SENDER = 'mable@hrc-runtime:T-07693'

const INTERACTIVE_INTENT: HrcRuntimeIntent = {
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
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07693-')
  ledger = new FakeWrkqLedger()
  restoreAgentHome = (await installMailKickerAgentHome(fixture.tmpDir, 'kicker-double')).restore
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  restoreAgentHome()
  await fixture.cleanup()
})

type ServerPeek = {
  db: HrcDatabase
  federationNodeId: string
  runWrkqLedgerTail: () => Promise<void>
  requestMailKickerWake: (targetSessionRef: string, reason: 'periodic') => void
  drainMailKickerTarget: (targetSessionRef: string) => Promise<void>
  mailKickerTargetOperations: Map<string, Promise<void>>
  dispatchTurnForSession: (
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: { runId: string; waitForCompletion?: boolean }
  ) => Promise<Response>
  startInteractiveTmuxBrokerRuntime: unknown
  publishPresentation: unknown
  waitForInteractiveBrokerRunCompletion: unknown
  reconcileTmuxRuntimeLiveness: unknown
  executeInteractiveBrokerInputTurn: unknown
  getHarnessBrokerController: unknown
}

function peek(instance: HrcServer): ServerPeek {
  return instance as unknown as ServerPeek
}

/** Bind the scope to this node the way a birth would. */
function homeScopeHere(instance: HrcServer): void {
  createPlacementLedgerRepository(peek(instance).db.sqlite).installActive({
    scopeRef: SCOPE,
    homeNodeId: peek(instance).federationNodeId,
    updatedAt: timestamp(),
  })
}

/**
 * The tmux substrate, stubbed at the same seam T-07202 uses — but modelling the
 * live shape that matters here: `onAccepted` fires EARLY (the live incident
 * emitted `turn.accepted` 2.4s before `turn.started`) while the boot promise
 * stays unresolved, so the runtime sits `starting` with its birth still
 * registered in `runtimeStartOperations`. That is the window the second wake
 * landed in.
 */
function installGatedBrokerStart(instance: HrcServer): {
  starts: () => number
  coldBirthPrompts: () => string[]
  brokerInputs: () => string[]
  release: () => void
  accepted: Promise<void>
} {
  const db = peek(instance).db
  let starts = 0
  const coldBirthPrompts: string[] = []
  const brokerInputs: string[] = []
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  let markAccepted!: () => void
  const accepted = new Promise<void>((resolve) => {
    markAccepted = resolve
  })
  let released = false

  peek(instance).getHarnessBrokerController = () => ({
    seatProbe: async () => ({
      ok: true as const,
      response: {
        invocationId: 'inv-t07693-1',
        seat: released
          ? { state: 'idle' as const }
          : {
              state: 'turn-active' as const,
              turnId: 'run-t07693-operator',
              policy: 'open' as const,
            },
        brokerHeldDepth: 0,
      },
    }),
  })

  peek(instance).startInteractiveTmuxBrokerRuntime = async (
    session: HrcSessionRecord,
    _intent: HrcRuntimeIntent,
    runId: string,
    options: {
      onAccepted?: (runtime: HrcRuntimeSnapshot) => void
      coldBirthPrompt?: string
      onColdBirthPromptRoute?: (rodeLaunch: boolean) => void
    }
  ): Promise<HrcRuntimeSnapshot> => {
    starts += 1
    const call = starts
    const now = timestamp()
    const runtimeId = `rt-t07693-${call}`
    const invocationId = `inv-t07693-${call}`
    if (options.coldBirthPrompt !== undefined) {
      coldBirthPrompts.push(options.coldBirthPrompt)
    }
    options.onColdBirthPromptRoute?.(options.coldBirthPrompt !== undefined)
    db.runtimes.insert({
      runtimeId,
      runtimeKind: 'harness',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'starting',
      statusChangedAt: now,
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: `op-t07693-${call}`,
      activeInvocationId: invocationId,
      activeRunId: runId,
      tmuxJson: { brokerDriver: 'claude-code-tmux' },
      createdAt: now,
      updatedAt: now,
    })
    // `starting` is a CONTROL-TRANSITION invocation state: this is what makes
    // `isBrokerRuntimeInputDispatchable` false and sends the concurrent
    // admission down stale-and-reprovision.
    db.brokerInvocations.insert({
      invocationId,
      operationId: `op-t07693-${call}`,
      runtimeId,
      runId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'claude-code-tmux',
      invocationState: 'starting',
      capabilitiesJson: JSON.stringify({ input: true }),
      specHash: `spec-${invocationId}`,
      startRequestHash: `sr-${invocationId}`,
      selectedProfileHash: `pf-${invocationId}`,
      createdAt: now,
      updatedAt: now,
    })
    db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
    const runtime = db.runtimes.getByRuntimeId(runtimeId)
    if (runtime === null) throw new Error('fixture failed to seed its runtime')
    options.onAccepted?.(runtime)
    markAccepted()
    await gate
    const readyAt = timestamp()
    db.brokerInvocations.update(invocationId, {
      invocationState: 'ready',
      updatedAt: readyAt,
    })
    return db.runtimes.updateStatus(runtimeId, 'ready', readyAt) ?? runtime
  }
  peek(instance).publishPresentation = async () => undefined
  peek(instance).waitForInteractiveBrokerRunCompletion = async () => undefined
  peek(instance).executeInteractiveBrokerInputTurn = async (
    _session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    prompt: string,
    runId: string
  ) => {
    brokerInputs.push(prompt)
    return Response.json({
      runId,
      hostSessionId: runtime.hostSessionId,
      generation: runtime.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: true,
      inputId: `input-${runId}`,
    })
  }
  // The seeded runtime has no real tmux server behind it, and the liveness
  // reconcile runs BEFORE the fence under test. Left real, it answers "broker
  // process is gone" and the dispatch dies there — passing the assertion
  // without ever reaching the code this test exists to exercise.
  peek(instance).reconcileTmuxRuntimeLiveness = async (runtime: HrcRuntimeSnapshot) => runtime

  return {
    starts: () => starts,
    coldBirthPrompts: () => coldBirthPrompts,
    brokerInputs: () => brokerInputs,
    release: () => {
      released = true
      releaseGate()
    },
    accepted,
  }
}

async function startServer(): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      // Only explicit calls drive anything: the proof is about which WAKE ran,
      // never about whichever timer happened to fire.
      hrcMailKickerSweepIntervalMs: 60_000,
      claudeCodeTmuxBrokerEnabled: true,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
    })
  )
  return server
}

describe('T-07693 — two wake sources, one exact scope, one seat', () => {
  /**
   * THE TRIGGER. A cold birth SUCCEEDS; the kicker used to book it as
   * `drive_failed` purely because the response named no `inputId`, release the
   * drive slot, and leave the envelope pending for the next wake to redeliver.
   */
  it('commits a cold birth instead of booking it as a failed drive', async () => {
    const envelope = ledger.say({
      toScopeRef: SCOPE,
      fromScopeRef: SENDER,
      roomKey: 'T-07693',
      body: 'the one envelope',
    })
    await startServer()
    const instance = server as HrcServer
    homeScopeHere(instance)
    const broker = installGatedBrokerStart(instance)

    const tail = peek(instance).runWrkqLedgerTail()
    await broker.accepted
    broker.release()
    await tail

    // The receipt is what makes the envelope stop being pending — and what
    // stops a second wake ever being needed.
    await waitUntil(
      () => (ledger.envelopes.get(envelope.id)?.presentedTo.length ?? 0) === 1,
      'the cold birth committed its presentation'
    )
    const db = peek(instance).db
    expect(db.mailDrives.listAttempts(TARGET).map((attempt) => attempt.state)).not.toContain(
      'failed'
    )
    expect(broker.coldBirthPrompts()).toHaveLength(1)
    expect(broker.coldBirthPrompts()[0]).toContain('the one envelope')
    expect(broker.brokerInputs()).toHaveLength(0)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo[0]?.inputId).toBeUndefined()
  })

  /**
   * THE FENCE. A wake that lands while the seat's broker is still being born
   * must join that birth. The second wake here comes from the OTHER side —
   * an operator/DM cold dispatch already in flight when the wrkc envelope
   * arrives — which is the shape that survives the trigger fix. Since T-07891,
   * the kicker observes the broker's active turn and holds the envelope in HRC
   * until the turn boundary; the boundary dispatch must still join the one
   * runtime born by the first wake.
   */
  it('joins an in-flight birth instead of minting a second runtime', async () => {
    await startServer()
    const instance = server as HrcServer
    homeScopeHere(instance)
    const broker = installGatedBrokerStart(instance)

    const resolved = (await (
      await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: TARGET,
        create: true,
      })
    ).json()) as { hostSessionId: string }
    const db = peek(instance).db
    const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
    if (session === null) throw new Error('fixture failed to resolve its session')

    // Delivery INTO a runtime is real broker IPC; what this test asserts is
    // WHICH runtime each guarded submission was handed, so record that and
    // stop there. T-07880 sends the cold caller prompt through this same door
    // after boot, followed here by the envelope wake.
    const joins: string[] = []
    peek(instance).executeInteractiveBrokerInputTurn = async (
      _session: HrcSessionRecord,
      runtime: HrcRuntimeSnapshot,
      _prompt: string,
      runId: string
    ) => {
      joins.push(runtime.runtimeId)
      const inputId = `input-${runId}`
      const now = timestamp()
      if (db.runs.getByRunId(runId) === null) {
        db.runs.insert({
          runId,
          hostSessionId: session.hostSessionId,
          runtimeId: runtime.runtimeId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          transport: 'tmux',
          status: 'started',
          acceptedAt: now,
          startedAt: now,
          updatedAt: now,
          dispatchedInputId: inputId,
        })
        db.runtimes.updateRunId(runtime.runtimeId, runId, now)
      }
      return Response.json({
        runId,
        hostSessionId: resolved.hostSessionId,
        generation: 1,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        status: 'started',
        supportsInFlightInput: true,
        inputId,
      })
    }

    // WAKE 1 — a cold interactive dispatch (an operator turn, or a DM). Its
    // birth registers in `runtimeStartOperations` and stays there, gated.
    const operatorTurn = peek(instance).dispatchTurnForSession(
      session,
      INTERACTIVE_INTENT,
      'operator prompt',
      { runId: 'run-t07693-operator', waitForCompletion: false }
    )
    await broker.accepted

    // WAKE 2 — the wrkc envelope, into a seat that is now durably busy with a
    // birth still in flight.
    const envelope = ledger.say({
      toScopeRef: SCOPE,
      fromScopeRef: SENDER,
      roomKey: 'T-07693',
      body: 'arrives mid-birth',
    })
    await peek(instance).runWrkqLedgerTail()

    // Release only AFTER the second wake is in. While the broker reports the
    // operator turn active, the envelope remains HRC-held: no second broker
    // input and no presentation receipt exist yet.
    await waitUntil(
      () => peek(instance).mailKickerTargetOperations.has(TARGET),
      'the envelope wake joined the in-flight seat birth'
    )
    await waitUntil(
      () => db.mailDrives.getHeldAttempt(TARGET) !== null,
      'the envelope wake was held behind the active broker turn'
    )
    expect(joins).toHaveLength(0)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(0)

    broker.release()
    await operatorTurn
    // The cold operator prompt rode the birth itself, so it does not traverse
    // the existing-runtime input seam recorded by `joins`.
    expect(joins).toHaveLength(0)

    const boundaryAt = timestamp()
    db.runs.updateStatus('run-t07693-operator', 'completed', boundaryAt)
    db.runtimes.updateRunId('rt-t07693-1', undefined, boundaryAt)

    // A periodic boundary wake is the sweep backstop's delivery edge. It
    // flushes the local batch only after the seat probe turns idle, into the
    // already-born runtime.
    peek(instance).requestMailKickerWake(TARGET, 'periodic')
    await peek(instance).drainMailKickerTarget(TARGET)
    expect(joins).toEqual(['rt-t07693-1', 'rt-t07693-1'])

    const runtimes = db.runtimes.listByHostSessionId(resolved.hostSessionId)
    expect({
      brokerStarts: broker.starts(),
      runtimeCount: runtimes.length,
      sessionCount: db.sessions.listByScopeRef(SCOPE, 'main').length,
      // The point of the fence: both submissions join the runtime the first
      // wake birthed instead of provisioning a seat of their own.
      joinedRuntimes: joins,
    }).toEqual({
      brokerStarts: 1,
      runtimeCount: 1,
      sessionCount: 1,
      joinedRuntimes: ['rt-t07693-1', 'rt-t07693-1'],
    })
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
    expect(broker.coldBirthPrompts()).toHaveLength(0)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo[0]?.inputId).toBeDefined()
  })
})
