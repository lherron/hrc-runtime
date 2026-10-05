import { afterEach, beforeEach, expect, test } from 'bun:test'

import { writeFile } from 'node:fs/promises'

import type { HrcRuntimeIntent, HrcSessionRecord, SuffixStartRuntimeRequest } from 'hrc-core'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import {
  type HrcServerTestFixture,
  createHrcTestFixture,
} from '../../__tests__/fixtures/hrc-test-fixture'
import { seedDispatchedBrokerInvocation } from '../../__tests__/persisted-invocation.fixture'
import { type HrcServer, createHrcServer } from '../../index'
import { suffixStartRequestHash } from '../../roster-claim'
import type { HrcServerInstanceForHandlers } from '../../server-instance-context'
import { parsePrepareAttachedRunRequest } from '../../server-parsers'
import { ADMISSION_STEPS } from '../admit'
import { fakeBrokerClient } from './broker-boundary.fixture'
import {
  CONFORMANCE_INVOCATION_ID as invocationId,
  rejectedDispatchReceipt,
  CONFORMANCE_RUNTIME_ID as runtimeId,
  seedAdmissionDriver,
} from './driver-graph.fixture'
import { DOORS, DRIVERS, type Driver, EXPECTED, expectedTrace } from './expected-admission'
import { registerInvokeQueueConformance } from './invoke-queue-conformance.fixture'

let fixture: HrcServerTestFixture
let server: HrcServer
let ctx: HrcServerInstanceForHandlers
let session: HrcSessionRecord
let currentDriver: Driver = 'format1-headless'

beforeEach(async () => {
  currentDriver = 'format1-headless'
  fixture = await createHrcTestFixture('admission-conformance-')
  await writeFile(
    `${fixture.stateRoot}/federation.json`,
    JSON.stringify({ nodeId: 'conformance-node', gate: { mode: 'enforce' } }),
    { mode: 0o600 }
  )
  fixture.seedSession(
    'hsid-conformance',
    'agent:cody:project:hrc-runtime:task:admission-conformance'
  )
  server = await createHrcServer(
    fixture.serverOpts({ staleGenerationEnabled: true, staleGenerationThresholdSec: 60 })
  )
  ctx = server as unknown as HrcServerInstanceForHandlers
  const found = ctx.db.sessions.getByHostSessionId('hsid-conformance')
  if (found === null) throw new Error('missing session')
  session = found
  ctx.db.continuities.upsert({
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    activeHostSessionId: session.hostSessionId,
    updatedAt: fixture.now(),
  })
})

afterEach(async () => {
  await Promise.allSettled([...ctx.runtimeStartOperations.values()])
  await server.stop()
  await fixture.cleanup()
})

function runtimeIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', id: 'codex-cli', interactive: currentDriver === 'tmux-live' },
    execution: { preferredMode: currentDriver === 'tmux-live' ? 'interactive' : 'headless' },
  }
}

function seedDriver(driver: Driver) {
  currentDriver = driver
  session = seedAdmissionDriver(ctx, fixture, session, driver, runtimeIntent())
}

function post(door: 'submission' | 'turns', intent: string, patch: object = {}) {
  const base =
    door === 'turns'
      ? {
          hostSessionId: session.hostSessionId,
          prompt: 'conformance',
          runtimeIntent: runtimeIntent(),
          waitFor: 'accepted',
        }
      : {
          target: `${session.scopeRef}/lane:${session.laneRef}`,
          body: 'conformance',
          origin: { principalRef: 'human:lance' },
          ...(intent === 'steer' ? {} : { runtimeIntent: runtimeIntent() }),
        }
  return fixture.postJson(door === 'turns' ? '/v1/turns' : `/v1/submissions/${intent}`, {
    ...base,
    ...patch,
  })
}

function snapshot() {
  return {
    session: ctx.db.sessions.getByHostSessionId(session.hostSessionId),
    runtime: ctx.db.runtimes.getByRuntimeId(runtimeId),
    invocation: ctx.db.brokerInvocations.getByInvocationId(invocationId),
    runs: ctx.db.sqlite
      .query('SELECT * FROM runs WHERE host_session_id = ?')
      .all(session.hostSessionId),
  }
}

function admission(outcome: string, count = 1) {
  const events = ctx.db.hrcEvents.listByKind('submission.admission')
  expect(events).toHaveLength(count)
  const payload = events.at(-1)?.payload as {
    trace: { step: string; outcome: string }[]
    outcome: string
  }
  expect(payload.outcome).toBe(outcome)
  expect(payload.trace.map((entry) => entry.step)).toEqual([...ADMISSION_STEPS])
  return payload
}
for (const driver of DRIVERS) {
  for (const door of ['submission', 'turns'] as const) {
    for (const intent of DOORS[door]) {
      const cell = `${door}/${intent} × ${driver}`
      test(`${cell}: drain refuses before any mutation`, async () => {
        seedDriver(driver)
        await ctx.turnAdmissionGate.close({ operationId: 'conformance-close' })
        const before = snapshot()
        expect((await post(door, intent)).status).toBe(503)
        expect(snapshot()).toEqual(before)
        expect(admission('refused').trace.map((entry) => entry.outcome)).toEqual(
          expectedTrace(driver, 'drain')
        )
      })
      test(`${cell}: retired refuses before any mutation`, async () => {
        seedDriver(driver)
        const ledger = createPlacementLedgerRepository(ctx.db.sqlite)
        ledger.installActive({
          scopeRef: session.scopeRef,
          homeNodeId: 'conformance-node',
          updatedAt: fixture.now(),
        })
        ledger.retire({
          scopeRef: session.scopeRef,
          expectedHomeNodeId: 'conformance-node',
          reason: 'conformance',
          retiredAt: fixture.now(),
        })
        // The real retirement guard consults the ledger only on a configured node.
        const before = snapshot()
        expect((await post(door, intent)).status).toBe(409)
        expect(snapshot()).toEqual(before)
        expect(admission('refused').trace.map((entry) => entry.outcome)).toEqual(
          expectedTrace(driver, 'retired')
        )
      })
      test(`${cell}: replay rereads format and creates no work`, async () => {
        seedDriver(driver)
        const now = fixture.now()
        ctx.db.runs.insert({
          runId: 'run-replay',
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          transport: 'headless',
          status: 'accepted',
          acceptedAt: now,
          updatedAt: now,
          dispatchIdempotencyKey: 'same-key',
          executionFormat: 'format1',
          brokerSubmissionId: 'sub-replay',
          ...(driver !== 'tmux-cold' && driver !== 'sdk' ? { runtimeId, invocationId } : {}),
        })
        const before = snapshot()
        // Matching replays on submission doors require an identified broker receipt.
        const patch = { idempotencyKey: 'same-key', executionFormat: 'format2' }
        expect((await post(door, intent, patch)).status).toBe(503)
        expect(snapshot()).toEqual(before)
        expect(admission('refused').trace.map((entry) => entry.outcome)).toEqual(
          expectedTrace(driver, 'format-replay-refusal')
        )
        const response = await post(door, intent, {
          idempotencyKey: 'same-key',
          executionFormat: 'format1',
        })
        expect(response.status).toBe(202)
        expect((await response.json()).replayed).toBe(true)
        expect(snapshot()).toEqual(before)
        const trace = admission('replayed', 2).trace
        expect(trace.map((entry) => entry.outcome)).toEqual(expectedTrace(driver, 'replay'))
      })
    }
  }
}
for (const intent of DOORS.submission) {
  test(`submission/${intent}: participant freshContext preserves E0`, async () => {
    seedDriver('participant')
    const before = snapshot()
    expect((await post('submission', intent, { freshContext: true })).status).toBe(503)
    expect(snapshot()).toEqual(before)
    admission('refused')
  })
  test(`submission/${intent}: format mismatch plus freshContext preserves E0`, async () => {
    seedDriver('format1-headless')
    const before = snapshot()
    expect(
      (
        await post('submission', intent, {
          executionFormat: 'format2',
          idempotencyKey: 'format-mismatch',
          freshContext: true,
        })
      ).status
    ).toBe(503)
    expect(snapshot()).toEqual(before)
    admission('refused')
  })
}
test('nonoperator preempt plus freshContext preserves E0', async () => {
  seedDriver('format1-headless')
  const before = snapshot()
  const response = await post('submission', 'preempt', {
    freshContext: true,
    origin: { principalRef: 'agent:cody' },
  })
  expect((await response.json()).reason).toBe('authority-denied')
  expect(snapshot()).toEqual(before)
  admission('refused')
})
test('D5 freshContext is explicitly inapplicable at the wire boundary', async () => {
  expect(EXPECTED.turns.freshContext).toBe('not on the wire contract; parser rejects unknown field')
  expect((await post('turns', 'invoke', { freshContext: true })).status).toBe(422)
  expect(ctx.db.hrcEvents.listByKind('submission.admission')).toHaveLength(0)
})
for (const driver of ['format1-headless', 'tmux-live', 'participant'] as const) {
  for (const door of ['submission', 'turns'] as const) {
    for (const intent of DOORS[door]) {
      test(`${door}/${intent} × ${driver}: real route accepts and records one trace`, async () => {
        seedDriver(driver)
        const controller = ctx.getHarnessBrokerController()
        controller.active.set(runtimeId, {
          runtimeId,
          invocationId,
          client: fakeBrokerClient(ctx, runtimeId, invocationId),
          closing: false,
        })
        // The fixture owns no real tmux pane. These are the terminal IO boundary only.
        ctx.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
        ctx.publishPresentation = async () => {}
        const response = await post(door, intent)
        const receipt = await response.json()
        expect([200, 202]).toContain(response.status)
        expect(receipt.admission).toBe('admitted')
        const trace = admission('routed').trace
        expect(trace.map((entry) => entry.outcome)).toEqual(expectedTrace(driver, 'accepted'))
        expect(ctx.db.sessions.getByHostSessionId(session.hostSessionId)?.generation).toBe(1)
        // A participant is exempt even when its wall-clock generation is stale.
        if (driver === 'participant') expect(trace[7]?.outcome).toBe('skipped:not-applicable')
        // Await the provider events so cleanup cannot race the fake's delayed write.
        await Bun.sleep(30)
      })
    }
  }
}
for (const driver of ['format1-headless', 'v2-headless', 'tmux-live', 'participant'] as const) {
  for (const door of ['submission', 'turns'] as const) {
    for (const intent of DOORS[door]) {
      if (!EXPECTED[door].proof.includes(intent as 'invoke')) continue
      test(`${door}/${intent} × ${driver}: carried ownership mismatch preserves E0`, async () => {
        seedDriver(driver)
        const before = snapshot()
        expect(
          (await post(door, intent, { establishedBrokerInvocationId: 'wrong-invocation' })).status
        ).toBe(503)
        expect(snapshot()).toEqual(before)
        expect(admission('refused').trace[4]?.outcome).toBe('refused')
      })
    }
  }
}
test('preempt without capability refuses before freshContext rotation', async () => {
  seedDriver('format1-headless')
  ctx.db.brokerInvocations.update(invocationId, {
    capabilitiesJson: JSON.stringify({ admission: { classes: ['queue'] } }),
    updatedAt: fixture.now(),
  })
  const before = snapshot()
  const response = await post('submission', 'preempt', { freshContext: true })
  expect((await response.json()).reason).toBe('unsupported:preempt')
  expect(snapshot()).toEqual(before)
  expect(admission('refused').trace[5]?.outcome).toBe('refused')
})
registerInvokeQueueConformance({ context: () => ctx, getFixture: () => fixture, seedDriver, post })

function postPhase2(door: 'turns-by-selector' | 'dm' | 'prepare-attached', patch: object = {}) {
  const ref = `${session.scopeRef}/lane:${session.laneRef}`
  if (door === 'dm')
    return fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: ref },
      body: 'phase2 conformance',
      runtimeIntent: runtimeIntent(),
      ...patch,
    })
  if (door === 'prepare-attached')
    return fixture.postJson('/v1/runs/prepare-attached', {
      hostSessionId: session.hostSessionId,
      intent: runtimeIntent(),
      prompt: 'phase2 conformance',
      ...patch,
    })
  return fixture.postJson('/v1/turns/by-selector', {
    selector: { sessionRef: ref },
    prompt: 'phase2 conformance',
    runtimeIntent: runtimeIntent(),
    ...patch,
  })
}
for (const driver of DRIVERS) {
  for (const door of ['turns-by-selector', 'dm', 'prepare-attached'] as const) {
    test(`${door} × ${driver}: drain refuses before message or route mutation`, async () => {
      seedDriver(driver)
      await ctx.turnAdmissionGate.close({ operationId: 'phase2-close' })
      const before = snapshot()
      const messages = ctx.db.sqlite.query('SELECT * FROM messages').all()
      expect((await postPhase2(door)).status).toBe(503)
      expect(snapshot()).toEqual(before)
      expect(ctx.db.sqlite.query('SELECT * FROM messages').all()).toEqual(messages)
      expect(admission('refused').trace.map((entry) => entry.outcome)).toEqual(
        expectedTrace(driver, 'drain')
      )
    })
  }
}
for (const driver of DRIVERS) {
  for (const door of ['turns-by-selector', 'dm', 'prepare-attached'] as const) {
    test(`${door} × ${driver}: retired refuses before rotation or message write`, async () => {
      seedDriver(driver)
      const ledger = createPlacementLedgerRepository(ctx.db.sqlite)
      ledger.installActive({
        scopeRef: session.scopeRef,
        homeNodeId: 'conformance-node',
        updatedAt: fixture.now(),
      })
      ledger.retire({
        scopeRef: session.scopeRef,
        expectedHomeNodeId: 'conformance-node',
        reason: 'phase2 conformance',
        retiredAt: fixture.now(),
      })
      const before = snapshot()
      const messages = ctx.db.sqlite.query('SELECT * FROM messages').all()
      expect((await postPhase2(door)).status).toBe(409)
      expect(snapshot()).toEqual(before)
      expect(ctx.db.sqlite.query('SELECT * FROM messages').all()).toEqual(messages)
      expect(admission('refused').trace.map((entry) => entry.outcome)).toEqual(
        expectedTrace(driver, 'retired')
      )
    })
  }
}
for (const door of ['turns-by-selector', 'dm', 'prepare-attached'] as const) {
  test(`${door}: frozen format mismatch refuses before stale rotation`, async () => {
    seedDriver('v2-headless')
    const createdAt = new Date(Date.now() - 120_000).toISOString()
    ctx.db.sqlite
      .query('UPDATE sessions SET created_at=? WHERE host_session_id=?')
      .run(createdAt, session.hostSessionId)
    const before = snapshot()
    expect((await postPhase2(door)).status).toBe(503)
    expect(snapshot()).toEqual(before)
    const trace = admission('refused').trace
    expect(trace[6]?.outcome).toBe('refused')
    expect(trace[7]?.outcome).toBe('not-reached')
  })
}
test('D11 freshContext is inapplicable: its parser has no such request field', () => {
  expect(EXPECTED['prepare-attached'].freshContext).toBe(
    'not on the wire contract; prepare-attached has no freshContext field'
  )
  const parsed = parsePrepareAttachedRunRequest({
    hostSessionId: session.hostSessionId,
    intent: runtimeIntent(),
    prompt: 'probe',
    freshContext: true,
  })
  expect(Object.hasOwn(parsed, 'freshContext')).toBe(false)
})
for (const driver of ['format1-headless', 'v2-headless', 'tmux-live', 'participant'] as const) {
  test(`turns-by-selector × ${driver}: carried mismatch preserves E0`, async () => {
    seedDriver(driver)
    const before = snapshot()
    expect(
      (await postPhase2('turns-by-selector', { establishedBrokerInvocationId: 'wrong' })).status
    ).toBe(503)
    expect(snapshot()).toEqual(before)
    expect(admission('refused').trace[4]?.outcome).toBe('refused')
  })
}
test('D8 freshContext preserves the broader existing rejection', async () => {
  seedDriver('participant')
  const before = snapshot()
  expect(EXPECTED.dm.freshContext).toBe(
    'not accepted by this door; semantic DM rejects freshContext before target lookup'
  )
  expect((await postPhase2('dm', { freshContext: true })).status).toBe(400)
  expect(snapshot()).toEqual(before)
  expect(ctx.db.hrcEvents.listByKind('submission.admission')).toHaveLength(0)
})
for (const driver of ['format1-headless', 'tmux-live', 'participant'] as const) {
  for (const door of ['turns-by-selector', 'dm', 'prepare-attached'] as const) {
    if (door === 'prepare-attached' && driver === 'format1-headless') continue // Headless has no attach surface; admission guards above still apply.
    test(`${door} × ${driver}: delivery uses the leased plan`, async () => {
      seedDriver(driver)
      if (door === 'prepare-attached' && driver === 'participant')
        ctx.db.runtimes.update(runtimeId, {
          transport: 'tmux',
          tmuxJson: {
            socketPath: fixture.tmuxSocketPath,
            sessionName: 'conformance',
            windowName: 'main',
            paneId: '%1',
            brokerDriver: 'codex-cli-tmux',
          },
        })
      ctx.getHarnessBrokerController().active.set(runtimeId, {
        runtimeId,
        invocationId,
        client: fakeBrokerClient(ctx, runtimeId, invocationId),
        closing: false,
      })
      ctx.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
      ctx.publishPresentation = async () => {}
      const response = await postPhase2(door)
      expect(response.status).toBe(200)
      await response.json()
      expect(admission('routed').trace[5]?.outcome).toBe('passed')
      expect(ctx.db.sessions.getByHostSessionId(session.hostSessionId)?.generation).toBe(1)
      if (driver === 'participant')
        expect(admission('routed').trace[7]?.outcome).toBe('skipped:not-applicable')
      await Bun.sleep(30)
    })
  }
}

for (const door of ['submission', 'turns'] as const) {
  for (const replay of [false, true]) {
    test(`${door}: terminal observation releases the drain lease (replay=${replay})`, async () => {
      seedDriver('tmux-live')
      let complete!: () => void
      const completion = new Promise<void>((resolve) => {
        complete = resolve
      })
      ctx.getHarnessBrokerController().active.set(runtimeId, {
        runtimeId,
        invocationId,
        client: fakeBrokerClient(ctx, runtimeId, invocationId, completion),
        closing: false,
      })
      ctx.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
      ctx.publishPresentation = async () => {}
      const patch = { idempotencyKey: 'terminal-drain-key' }
      if (replay) expect((await post(door, 'invoke', patch)).status).toBe(202)
      let responseSettled = false
      const pending = post(door, 'invoke', {
        ...patch,
        ...(door === 'turns' ? { waitFor: 'terminal' } : { wait: true }),
      }).then((response) => {
        responseSettled = true
        return response
      })
      const deadline = Date.now() + 3000
      while (
        !ctx.db.runs.listRuns().some((run) => run.status === 'running') ||
        ctx.rawBrokerSubscribers.size === 0
      ) {
        if (Date.now() > deadline)
          throw new Error('terminal observer did not attach to running submission')
        await Bun.sleep(10)
      }
      const closing = ctx.turnAdmissionGate.close({ operationId: 'terminal-observation-drain' })
      const drained = await Promise.race([
        closing.then(() => true),
        Bun.sleep(500).then(() => false),
      ])
      const responsePendingAtDrain = !responseSettled
      const eventsAtDrain = ctx.db.hrcEvents.listByKind('submission.admission')
      complete()
      const response = await pending
      await closing
      expect(drained).toBe(true)
      expect(responsePendingAtDrain).toBe(true)
      expect(eventsAtDrain).toHaveLength(replay ? 2 : 1)
      expect(eventsAtDrain.at(-1)?.payload).toMatchObject({
        outcome: replay ? 'replayed' : 'routed',
      })
      expect(response.status).toBe(200)
      expect((await response.json()).stage).toBe('terminal')
    })
  }
}

for (const claim of ['exact', 'suffix'] as const) {
  test(`runtime-start-prompt: draining ${claim} claim allocates nothing`, async () => {
    await ctx.turnAdmissionGate.close({ operationId: 'phase3-claim-drain' })
    const config = ctx.options.federationConfig
    if (config === undefined) throw new Error('missing fixture federation config')
    config.gate.mode = 'off'
    const idempotencyKey = `phase3-${claim}-claim`
    const scope = session.scopeRef
    createPlacementLedgerRepository(ctx.db.sqlite).installActive({
      scopeRef: scope,
      homeNodeId: 'conformance-node',
      updatedAt: fixture.now(),
    })
    if (claim === 'exact') {
      await expect(
        ctx.startExactScopeRuntime({
          sessionRef: `${scope}/lane:main`,
          conflictPolicy: 'reject',
          summonIntent: 'implicit',
          runtimeIntent: { ...runtimeIntent(), initialPrompt: 'phase3 claim admission' },
          idempotencyKey,
        })
      ).rejects.toMatchObject({ code: 'server_draining' })
    } else {
      const response = await fixture.postJson('/v1/runtimes/start', {
        baseSessionRef: `${scope}/lane:main`,
        conflictPolicy: 'suffix',
        runtimeIntent: { ...runtimeIntent(), initialPrompt: 'phase3 claim admission' },
        idempotencyKey,
      })
      expect(response.status).toBe(503)
    }
    expect(ctx.db.rosterClaims.getByIdempotencyKey(idempotencyKey)).toBeNull()
    expect(admission('refused').trace[0]?.outcome).toBe('refused')
  })
}

for (const cell of ['drain', 'retired'] as const) {
  test(`literal-flush: ${cell} keeps the pasted buffer and delivery state`, async () => {
    seedDriver('tmux-live')
    const ref = `${session.scopeRef}/lane:${session.laneRef}`
    const paste = await fixture.postJson('/v1/literal-input/by-selector', {
      selector: { sessionRef: ref },
      text: 'phase3 pasted body',
      enter: false,
    })
    expect(paste.status).toBe(200)
    expect(ctx.db.hrcEvents.listByKind('submission.admission')).toHaveLength(0)
    if (cell === 'drain') await ctx.turnAdmissionGate.close({ operationId: 'phase3-flush' })
    else {
      const ledger = createPlacementLedgerRepository(ctx.db.sqlite)
      ledger.installActive({
        scopeRef: session.scopeRef,
        homeNodeId: 'conformance-node',
        updatedAt: fixture.now(),
      })
      ledger.retire({
        scopeRef: session.scopeRef,
        expectedHomeNodeId: 'conformance-node',
        reason: 'phase3 retired',
        retiredAt: fixture.now(),
      })
    }
    const before = snapshot()
    const buffered = ctx.pendingBrokerLiteralInputs.get(runtimeId)
    const flush = await fixture.postJson('/v1/literal-input/by-selector', {
      selector: { sessionRef: ref },
      text: '',
      enter: true,
    })
    expect(flush.status).toBe(cell === 'drain' ? 503 : 409)
    expect(snapshot()).toEqual(before)
    expect(ctx.pendingBrokerLiteralInputs.get(runtimeId)).toEqual(buffered)
    expect(admission('refused').trace.map((entry) => entry.outcome)).toEqual(
      expectedTrace('tmux-live', cell)
    )
  })
}

for (const driver of DRIVERS) {
  test(`turn-handoff × ${driver}: drain refuses before message persistence`, async () => {
    seedDriver(driver)
    await ctx.turnAdmissionGate.close({ operationId: 'phase3-handoff' })
    const before = snapshot()
    const messages = ctx.db.sqlite.query('SELECT * FROM messages').all()
    const response = await fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: `${session.scopeRef}/lane:${session.laneRef}` },
      body: 'phase3 handoff',
      runtimeIntent: runtimeIntent(),
    })
    expect(response.status).toBe(503)
    expect(snapshot()).toEqual(before)
    expect(ctx.db.sqlite.query('SELECT * FROM messages').all()).toEqual(messages)
    expect(admission('refused').trace.map((entry) => entry.outcome)).toEqual(
      expectedTrace(driver, 'drain')
    )
  })
}
test('turn-handoff: participant freshContext refuses before message or rotation', async () => {
  seedDriver('participant')
  const before = snapshot()
  const messages = ctx.db.sqlite.query('SELECT * FROM messages').all()
  const response = await fixture.postJson('/v1/messages/turn-handoff', {
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: `${session.scopeRef}/lane:${session.laneRef}` },
    body: 'phase3 participant',
    runtimeIntent: runtimeIntent(),
    freshContext: true,
  })
  expect(response.status).toBe(503)
  expect(snapshot()).toEqual(before)
  expect(ctx.db.sqlite.query('SELECT * FROM messages').all()).toEqual(messages)
  expect(admission('refused').trace[3]?.outcome).toBe('refused')
})

test('runtime-start-prompt: matching claim-key replay retains a second accepted input run', async () => {
  seedDriver('format1-headless')
  const config = ctx.options.federationConfig
  if (config === undefined) throw new Error('missing fixture config')
  config.gate.mode = 'off'
  ctx.publishPresentation = async () => {}
  ctx.getHarnessBrokerController().active.set(runtimeId, {
    runtimeId,
    invocationId,
    client: fakeBrokerClient(ctx, runtimeId, invocationId),
    closing: false,
  })
  const request: SuffixStartRuntimeRequest = {
    baseSessionRef: `${session.scopeRef}/lane:${session.laneRef}`,
    conflictPolicy: 'suffix',
    idempotencyKey: 'phase3-replayed-claim',
    runtimeIntent: { ...runtimeIntent(), initialPrompt: 'phase3 replay body' },
  }
  ctx.db.rosterClaims.insert({
    idempotencyKey: request.idempotencyKey,
    requestHash: suffixStartRequestHash(request),
    baseScope: session.scopeRef,
    claimedScope: session.scopeRef,
    successorHostSessionId: session.hostSessionId,
    createdAt: fixture.now(),
  })
  const first = await fixture.postJson('/v1/runtimes/start', request)
  expect(first.status).toBe(200)
  const runs = ctx.db.sqlite.query('SELECT run_id FROM runs').all()
  expect(runs).toHaveLength(1)
  const second = await fixture.postJson('/v1/runtimes/start', request)
  expect(second.status).toBe(200)
  expect((await second.json()).claim.replayed).toBe(true)
  // EN-23834: claim keys identify claims, not inputs; replay re-runs START by design.
  const replayRuns = ctx.db.sqlite.query('SELECT run_id FROM runs').all()
  expect(replayRuns).toHaveLength(2)
  expect(replayRuns).toEqual(expect.arrayContaining(runs))
  expect(new Set(replayRuns.map((row) => (row as { run_id: string }).run_id)).size).toBe(2)
  expect(admission('routed', 2).trace[2]?.outcome).toBe('skipped:not-carried')
})

function postPhase3(
  door: 'literal-flush' | 'turn-handoff' | 'runtime-start-prompt',
  patch: object = {}
) {
  const ref = `${session.scopeRef}/lane:${session.laneRef}`
  if (door === 'literal-flush')
    return fixture.postJson('/v1/literal-input/by-selector', {
      selector: { sessionRef: ref },
      text: 'phase3 conformance',
      enter: true,
      ...patch,
    })
  if (door === 'runtime-start-prompt')
    return fixture.postJson('/v1/runtimes/start', {
      hostSessionId: session.hostSessionId,
      intent: { ...runtimeIntent(), initialPrompt: 'phase3 conformance' },
      ...patch,
    })
  return fixture.postJson('/v1/messages/turn-handoff', {
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: ref },
    body: 'phase3 conformance',
    runtimeIntent: runtimeIntent(),
    ...patch,
  })
}
function participantTmuxSurface() {
  ctx.db.runtimes.update(runtimeId, {
    transport: 'tmux',
    tmuxJson: {
      socketPath: fixture.tmuxSocketPath,
      sessionName: 'conformance',
      windowName: 'main',
      paneId: '%1',
      brokerDriver: 'codex-cli-tmux',
    },
  })
}
for (const driver of DRIVERS) {
  test(`runtime-start-prompt × ${driver}: drain refuses before START mutation`, async () => {
    seedDriver(driver)
    await ctx.turnAdmissionGate.close({ operationId: 'phase3-start-drain' })
    const before = snapshot()
    expect((await postPhase3('runtime-start-prompt')).status).toBe(503)
    expect(snapshot()).toEqual(before)
    expect(admission('refused').trace.map((entry) => entry.outcome)).toEqual(
      expectedTrace(driver, 'drain')
    )
  })
  for (const door of ['turn-handoff', 'runtime-start-prompt'] as const) {
    test(`${door} × ${driver}: retired refuses before body write or START mutation`, async () => {
      seedDriver(driver)
      const ledger = createPlacementLedgerRepository(ctx.db.sqlite)
      ledger.installActive({
        scopeRef: session.scopeRef,
        homeNodeId: 'conformance-node',
        updatedAt: fixture.now(),
      })
      ledger.retire({
        scopeRef: session.scopeRef,
        expectedHomeNodeId: 'conformance-node',
        reason: 'phase3 conformance',
        retiredAt: fixture.now(),
      })
      const before = snapshot()
      const messages = ctx.db.sqlite.query('SELECT * FROM messages').all()
      expect((await postPhase3(door)).status).toBe(409)
      expect(snapshot()).toEqual(before)
      expect(ctx.db.sqlite.query('SELECT * FROM messages').all()).toEqual(messages)
      expect(admission('refused').trace.map((entry) => entry.outcome)).toEqual(
        expectedTrace(driver, 'retired')
      )
    })
  }
}
for (const door of ['literal-flush', 'turn-handoff', 'runtime-start-prompt'] as const) {
  for (const driver of ['tmux-live', 'participant'] as const) {
    if (door === 'runtime-start-prompt' && driver === 'participant') continue
    test(`${door} × ${driver}: delivery preserves identity and records one admission`, async () => {
      seedDriver(driver)
      if (driver === 'participant') participantTmuxSurface()
      ctx.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
      ctx.publishPresentation = async () => {}
      ctx.getHarnessBrokerController().active.set(runtimeId, {
        runtimeId,
        invocationId,
        client: fakeBrokerClient(ctx, runtimeId, invocationId),
        closing: false,
      })
      const response = await postPhase3(door)
      expect(response.status).toBe(200)
      expect(admission('routed').trace.map((entry) => entry.outcome)).toEqual(
        expectedTrace(driver, 'accepted')
      )
      if (door === 'runtime-start-prompt') {
        const diagnostics = ctx.db.runtimes.getByRuntimeId(runtimeId)?.runtimeStateJson?.[
          'brokerDispatchDiagnostics'
        ] as { submissions: { admissionClass: string; door: string }[] }
        expect(diagnostics.submissions[0]).toMatchObject({
          door: 'enqueue',
          admissionClass: 'queue',
        })
      }
      expect(ctx.db.sessions.getByHostSessionId(session.hostSessionId)?.generation).toBe(1)
      const runs = ctx.db.runs.listRuns()
      expect(runs).toHaveLength(1)
      expect(runs[0]?.runtimeId).toBe(runtimeId)
      await Bun.sleep(30)
      expect(ctx.db.runs.getByRunId(runs[0]?.runId ?? '')?.status).toBe('completed')
    })
  }
}
for (const door of ['literal-flush', 'turn-handoff', 'runtime-start-prompt'] as const) {
  test(`${door}: drain completes while its delivered turn is still running`, async () => {
    seedDriver('tmux-live')
    let complete: () => void = () => undefined
    const completion = new Promise<void>((resolve) => {
      complete = resolve
    })
    ctx.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
    ctx.publishPresentation = async () => {}
    ctx.getHarnessBrokerController().active.set(runtimeId, {
      runtimeId,
      invocationId,
      client: fakeBrokerClient(ctx, runtimeId, invocationId, completion),
      closing: false,
    })
    let settled = false
    const pending = postPhase3(door).then((response) => {
      settled = true
      return response
    })
    while (ctx.db.runs.listRuns()[0]?.status !== 'running') await Bun.sleep(5)
    const closing = ctx.turnAdmissionGate.close({ operationId: 'phase3-delivered-drain' })
    const closed = await Promise.race([closing.then(() => true), Bun.sleep(500).then(() => false)])
    const settledAtClose = settled
    const events = ctx.db.hrcEvents.listByKind('submission.admission')
    complete()
    const response = await pending
    await closing
    expect(closed).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ outcome: 'routed' })
    if (door === 'runtime-start-prompt') expect(settledAtClose).toBe(false)
    expect(response.status).toBe(200)
    const run = ctx.db.runs.listRuns()[0]
    while (ctx.db.runs.getByRunId(run?.runId ?? '')?.status !== 'completed') await Bun.sleep(5)
  })
}

test('runtime-start-prompt: participant reservation is a pre-effect refusal', async () => {
  seedDriver('participant')
  const before = snapshot()
  const response = await postPhase3('runtime-start-prompt')
  expect(response.status).toBe(503)
  expect((await response.json()).error.detail.reason).toBe('participant_address_reserved')
  expect(snapshot()).toEqual(before)
  expect(admission('refused').trace[3]?.outcome).toBe('refused')
})
test('turn-handoff: cold unknown target refuses drain before session allocation', async () => {
  await ctx.turnAdmissionGate.close({ operationId: 'phase3-cold-handoff' })
  const sessions = ctx.db.sqlite.query('SELECT * FROM sessions').all()
  const messages = ctx.db.sqlite.query('SELECT * FROM messages').all()
  const response = await fixture.postJson('/v1/messages/turn-handoff', {
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: 'agent:cody:project:hrc-runtime:task:phase3-new/lane:main' },
    body: 'phase3 cold',
    runtimeIntent: runtimeIntent(),
  })
  expect(response.status).toBe(503)
  expect(ctx.db.sqlite.query('SELECT * FROM sessions').all()).toEqual(sessions)
  expect(ctx.db.sqlite.query('SELECT * FROM messages').all()).toEqual(messages)
  expect(admission('refused').trace[0]?.outcome).toBe('refused')
})

for (const door of ['literal-flush', 'turn-handoff'] as const) {
  test(`${door}: participant linkage wins over a newer decoy runtime`, async () => {
    seedDriver('participant')
    participantTmuxSurface()
    const actual = ctx.db.runtimes.getByRuntimeId(runtimeId)
    if (actual === null) throw new Error('missing participant runtime')
    seedDispatchedBrokerInvocation(ctx.db, {
      runtimeId: 'rt-decoy',
      invocationId: 'inv-decoy',
      executionFormat: 'format2',
    })
    ctx.db.runtimes.insert({
      ...actual,
      runtimeId: 'rt-decoy',
      activeInvocationId: 'inv-decoy',
      activeOperationId: undefined,
      createdAt: new Date(Date.now() + 1000).toISOString(),
      updatedAt: fixture.now(),
    })
    ctx.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
    ctx.publishPresentation = async () => {}
    ctx.getHarnessBrokerController().active.set(runtimeId, {
      runtimeId,
      invocationId,
      client: fakeBrokerClient(ctx, runtimeId, invocationId),
      closing: false,
    })
    const response = await postPhase3(door)
    expect(response.status).toBe(200)
    expect(ctx.db.runs.listRuns()[0]?.runtimeId).toBe(runtimeId)
    expect(admission('routed').trace[7]?.outcome).toBe('skipped:not-applicable')
    await Bun.sleep(30)
  })
}

for (const door of ['literal-flush', 'turn-handoff'] as const) {
  test(`${door}: linked live input needs no persisted birth intent`, async () => {
    seedDriver(door === 'literal-flush' ? 'tmux-live' : 'participant')
    if (door === 'turn-handoff') participantTmuxSurface()
    ctx.db.sqlite
      .query('UPDATE sessions SET last_applied_intent_json = NULL WHERE host_session_id = ?')
      .run(session.hostSessionId)
    ctx.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
    ctx.publishPresentation = async () => {}
    ctx.getHarnessBrokerController().active.set(runtimeId, {
      runtimeId,
      invocationId,
      client: fakeBrokerClient(ctx, runtimeId, invocationId),
      closing: false,
    })
    expect((await postPhase3(door, { runtimeIntent: undefined })).status).toBe(200)
    expect(admission('routed').trace[6]?.outcome).toBe('passed')
    expect(ctx.db.runs.listRuns()[0]?.runtimeId).toBe(runtimeId)
    await Bun.sleep(30)
  })
}

for (const door of ['literal-flush', 'turn-handoff', 'runtime-start-prompt'] as const) {
  test(`${door}: positive dispatch rejection is rejected_unlanded`, async () => {
    seedDriver('tmux-live')
    ctx.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
    ctx.publishPresentation = async () => {}
    ctx.executeInteractiveBrokerInputTurn = rejectedDispatchReceipt(ctx, fixture.now())
    expect((await postPhase3(door)).status).toBe(200)
    expect(admission('routed')).toMatchObject({ routeOutcome: 'rejected_unlanded' })
  })
}

for (const door of ['literal-flush', 'turn-handoff', 'runtime-start-prompt'] as const) {
  test(`${door}: unfenced response throw stays possible_write and later landing completes`, async () => {
    seedDriver('tmux-live')
    let complete: () => void = () => undefined
    const completion = new Promise<void>((resolve) => {
      complete = resolve
    })
    ctx.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
    ctx.publishPresentation = async () => {}
    ctx.getHarnessBrokerController().active.set(runtimeId, {
      runtimeId,
      invocationId,
      client: fakeBrokerClient(ctx, runtimeId, invocationId, completion),
      closing: false,
    })
    const execute = ctx.executeInteractiveBrokerInputTurn.bind(ctx)
    ctx.executeInteractiveBrokerInputTurn = async (...args) => {
      await execute(...args)
      throw new Error('phase3 unfenced response projection lost')
    }
    const response = await postPhase3(door)
    expect(response.status).toBe(500)
    expect(
      admission('possible_write').trace.every(
        (entry) => entry.outcome === 'passed' || entry.outcome.startsWith('skipped:')
      )
    ).toBe(true)
    const run = ctx.db.runs.listRuns()[0]
    expect(run).toBeDefined()
    expect(['accepted', 'running']).toContain(run?.status)
    expect(run?.brokerInputFenceReason).toBeUndefined()
    complete()
    while (ctx.db.runs.getByRunId(run?.runId ?? '')?.status !== 'completed') await Bun.sleep(5)
    expect(ctx.db.runs.getByRunId(run?.runId ?? '')?.brokerInputFenceReason).toBeUndefined()
    expect(ctx.db.hrcEvents.listByKind('submission.admission')).toHaveLength(1)
  })
}
