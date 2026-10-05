import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  type HrcServerTestFixture,
  createHrcTestFixture,
} from '../../__tests__/fixtures/hrc-test-fixture'
import { type HrcServer, createHrcServer } from '../../index'
import type { HrcServerInstanceForHandlers } from '../../server-instance-context'
import { continueAdmittedTurn } from '../continue'
let fixture: HrcServerTestFixture
let server: HrcServer
let ctx: HrcServerInstanceForHandlers
beforeEach(async () => {
  fixture = await createHrcTestFixture('seal-continuation-')
  fixture.seedSession('hs-cont', 'agent:cody:project:hrc-runtime:task:seal-continuation')
  server = await createHrcServer(fixture.serverOpts())
  ctx = server as unknown as HrcServerInstanceForHandlers
})
afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})
function queued() {
  const session = ctx.db.sessions.getByHostSessionId('hs-cont')!
  ctx.enqueueDurableHeadlessTurnInput(session, 'body', 'run-cont', { source: 'boot' })
  return ctx.db.runs.snapshotQueuedByHostSessionId('hs-cont', 'snap-cont', fixture.now())[0]!
}
test('queued continuation holds a drain lease through its receipt, without re-admitting or claiming early', async () => {
  const run = queued()
  let release!: () => void
  const receipt = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  ctx.executeAdmittedTurn = async (plan) => {
    expect(plan.session.hostSessionId).toBe('hs-cont')
    expect(plan.options.runId).toBe(run.runId)
    expect(ctx.db.runs.getByRunId(run.runId)?.status).toBe('queued')
    entered()
    await receipt
    return Response.json({})
  }
  const pending = continueAdmittedTurn(ctx, {
    kind: 'queued-snapshot',
    runId: run.runId,
    snapshotId: run.queueSnapshotId!,
    prompt: 'body',
    intent: undefined,
    options: { runId: run.runId },
  })
  await ready
  const before = ctx.turnAdmissionGate.snapshot()
  expect(before.activeAdmissions).toBe(1)
  release()
  await pending
  expect(ctx.turnAdmissionGate.snapshot().activeAdmissions).toBe(0)
  expect(
    ctx.db.sqlite
      .query("SELECT COUNT(*) AS n FROM hrc_events WHERE event_kind = 'submission.admission'")
      .get()
  ).toEqual({ n: 0 })
})
test('continuation rejects wrong durable marker, snapshot and completed owner before delivery', async () => {
  const run = queued()
  let writes = 0
  ctx.executeAdmittedTurn = async () => {
    writes++
    return Response.json({})
  }
  const source = {
    kind: 'queued-snapshot' as const,
    runId: run.runId,
    snapshotId: 'snap-cont',
    prompt: 'body',
    intent: undefined,
    options: {},
  }
  await expect(continueAdmittedTurn(ctx, { ...source, snapshotId: 'wrong' })).rejects.toThrow()
  ctx.db.runs.setCorrelationJson(run.runId, JSON.stringify({ kind: 'wrong', prompt: 'body' }))
  await expect(continueAdmittedTurn(ctx, source)).rejects.toThrow()
  ctx.db.runs.setCorrelationJson(
    run.runId,
    JSON.stringify({ kind: 'durable_headless_turn_input', prompt: 'body' })
  )
  ctx.db.runs.update(run.runId, { status: 'completed', updatedAt: fixture.now() })
  await expect(continueAdmittedTurn(ctx, source)).rejects.toThrow()
  expect(writes).toBe(0)
})
function seedRuntime() {
  const session = ctx.db.sessions.getByHostSessionId('hs-cont')!
  ctx.db.runtimes.insert({
    runtimeId: 'rt-cont',
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'headless',
    status: 'ready',
    controllerKind: 'harness-broker',
    activeInvocationId: 'inv-cont',
    supportsInflightInput: true,
    createdAt: fixture.now(),
    updatedAt: fixture.now(),
  })
  return ctx.db.runtimes.getByRuntimeId('rt-cont')!
}
test('physical input refuses a queued owner until its selected-runtime claim', async () => {
  const run = queued()
  const runtime = seedRuntime()
  const physical = ctx.executeHeadlessBrokerInputTurn
  ctx.executeAdmittedTurn = (plan, _intent, prompt, options) =>
    physical.call(ctx, plan, runtime, prompt, run.runId, options)
  await expect(
    continueAdmittedTurn(ctx, {
      kind: 'queued-snapshot',
      runId: run.runId,
      snapshotId: run.queueSnapshotId!,
      prompt: 'body',
      intent: undefined,
      options: {},
    })
  ).rejects.toThrow('preaccepted broker input is not dispatchable')
  expect(ctx.db.runs.getByRunId(run.runId)?.status).toBe('queued')
  expect(ctx.db.hrcEvents.listByKind('turn.user_prompt')).toHaveLength(0)
})
test('accepted cold recovery preserves its durable input and options while the gate is closed', async () => {
  const runtime = seedRuntime()
  const session = ctx.db.sessions.getByHostSessionId('hs-cont')!
  ctx.db.runs.insert({
    runId: 'run-cold',
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'headless',
    status: 'accepted',
    acceptedAt: fixture.now(),
    updatedAt: fixture.now(),
  })
  ctx.db.runs.setCorrelationJson(
    'run-cold',
    JSON.stringify({
      kind: 'durable_cold_boot_turn_input',
      prompt: 'durable body',
      responseFormat: { kind: 'text' },
      dispatch: { submissionDoor: 'enqueue', dispatchIdempotencyKey: 'original-key' },
    })
  )
  await ctx.turnAdmissionGate.close({ operationId: 'continuation-close' })
  ctx.executeHeadlessBrokerInputTurn = async (plan, target, prompt, runId, options) => {
    expect(ctx.turnAdmissionGate.snapshot()).toMatchObject({ state: 'closed', activeAdmissions: 1 })
    expect(target.runtimeId).toBe(runtime.runtimeId)
    expect(plan.options.runId).toBe('run-cold')
    expect(runId).toBe('run-cold')
    expect(prompt).toBe('durable body')
    expect(options).toMatchObject({
      submissionDoor: 'enqueue',
      dispatchIdempotencyKey: 'original-key',
      waitForCompletion: false,
      responseFormat: { kind: 'text' },
    })
    return Response.json({ runId })
  }
  await continueAdmittedTurn(ctx, {
    kind: 'accepted-cold-boot',
    runId: 'run-cold',
    runtimeId: runtime.runtimeId,
  })
  expect(ctx.turnAdmissionGate.snapshot().activeAdmissions).toBe(0)
  expect(ctx.db.hrcEvents.listByKind('submission.admission')).toHaveLength(0)
  await expect(
    continueAdmittedTurn(ctx, {
      kind: 'accepted-cold-boot',
      runId: 'run-cold',
      runtimeId: 'wrong-runtime',
    })
  ).rejects.toThrow()
})
