import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import {
  type HrcServerTestFixture,
  createHrcTestFixture,
} from '../../__tests__/fixtures/hrc-test-fixture'
import { seedDispatchedBrokerInvocation } from '../../__tests__/persisted-invocation.fixture'
import { type HrcServer, createHrcServer } from '../../index'
import type { HrcServerInstanceForHandlers } from '../../server-instance-context'
import { ADMISSION_STEPS } from '../admit'
import { fakeBrokerClient } from './broker-boundary.fixture'
import { DOORS, DRIVERS, type Driver, EXPECTED, expectedTrace } from './expected-admission'

let fixture: HrcServerTestFixture
let server: HrcServer
let ctx: HrcServerInstanceForHandlers
let session: HrcSessionRecord
let currentDriver: Driver = 'format1-headless'
const invocationId = 'inv-conformance'
const runtimeId = 'rt-conformance'

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
  // Ordinary delivery is fresh; participant delivery deliberately crosses the stale threshold.
  const createdAt = new Date(Date.now() - (driver === 'participant' ? 120_000 : 0)).toISOString()
  ctx.db.sqlite
    .query('UPDATE sessions SET created_at = ? WHERE host_session_id = ?')
    .run(createdAt, session.hostSessionId)
  session = { ...session, createdAt }
  ctx.db.sessions.updateIntent(session.hostSessionId, runtimeIntent(), fixture.now())
  if (driver === 'tmux-cold' || driver === 'sdk') return
  seedDispatchedBrokerInvocation(ctx.db, {
    runtimeId,
    invocationId,
    executionFormat: driver === 'v2-headless' ? 'format2' : 'format1',
  })
  ctx.db.runtimeOperations.insert({
    operationId: `op-${invocationId}`,
    runtimeId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    operationKind: 'broker_invocation',
    controller: 'harness-broker',
    startupMethod: 'test',
    status: 'started',
    routeDecisionJson: '{}',
    createdAt: fixture.now(),
    updatedAt: fixture.now(),
  })
  ctx.db.brokerInvocations.update(invocationId, {
    capabilitiesJson: JSON.stringify({
      admission: { classes: ['exclusive', 'queue', 'preempt', 'steer'] },
    }),
    updatedAt: fixture.now(),
  })
  ctx.db.runtimes.insert({
    runtimeId,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: driver === 'tmux-live' ? 'tmux' : 'headless',
    status: 'ready',
    controllerKind: 'harness-broker',
    ...(driver === 'tmux-live'
      ? {
          tmuxJson: {
            socketPath: fixture.tmuxSocketPath,
            sessionName: 'conformance',
            windowName: 'main',
            paneId: '%1',
            brokerDriver: 'codex-cli-tmux',
          },
        }
      : {}),
    activeOperationId: `op-${invocationId}`,
    activeInvocationId: invocationId,
    harness: 'codex-cli',
    provider: 'openai',
    supportsInflightInput: true,
    createdAt: fixture.now(),
    updatedAt: fixture.now(),
  })
  if (driver === 'participant') {
    ctx.db.participantRegistrations.insertRegistration({
      registrationId: 'preg-conformance',
      join: 'participant-served',
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      hostIncarnationId: 'host-conformance',
      policy: {
        addressPolicy: 'selected-scope',
        continuityPolicy: 'host-incarnation',
        lifecycleOwner: 'externally-owned',
        replaySemantics: 'full-source-replay',
      },
      createdAt: fixture.now(),
      updatedAt: fixture.now(),
    })
    ctx.db.participantRegistrations.insertAttempt({
      attemptId: 'patt-conformance',
      registrationId: 'preg-conformance',
      attachEpoch: 1,
      requestId: 'req-conformance',
      operationId: 'op-conformance',
      invocationId,
      runtimeId,
      state: 'ACTIVE',
      preparedDescriptorJson: '{}',
      adapterDispatchEnvJson: '{}',
      recoveryDisposition: 'unresolved',
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
      createdAt: fixture.now(),
      updatedAt: fixture.now(),
    })
  }
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

for (const door of ['submission', 'turns'] as const) {
  test(`${door}/invoke: admission capability agrees with broker queue class`, async () => {
    seedDriver('format1-headless')
    ctx.db.brokerInvocations.update(invocationId, {
      capabilitiesJson: JSON.stringify({ admission: { classes: ['queue'] } }),
      updatedAt: fixture.now(),
    })
    ctx.getHarnessBrokerController().active.set(runtimeId, {
      runtimeId,
      invocationId,
      client: fakeBrokerClient(ctx, runtimeId, invocationId),
      closing: false,
    })
    const response = await post(door, 'invoke')
    expect([200, 202]).toContain(response.status)
    const receipt = await response.json()
    expect(receipt.admission).toBe('admitted')
    const event = ctx.db.hrcEvents.listByKind('submission.admission')[0]
    expect((event?.payload as { effectiveDoor: string }).effectiveDoor).toBe('enqueue')
    const diagnostics = ctx.db.runtimes.getByRuntimeId(runtimeId)?.runtimeStateJson?.[
      'brokerDispatchDiagnostics'
    ] as { submissions: { admissionClass: string; door: string }[] }
    expect(diagnostics.submissions[0]?.admissionClass).toBe('queue')
    expect(diagnostics.submissions[0]?.door).toBe('invoke')
    expect(ctx.db.hrcEvents.listByKind('submission.door_downgraded')).toHaveLength(0)
    await Bun.sleep(30)
  })
}
