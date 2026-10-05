/**
 * T-09643 -- a submission door answering a cold, argv-carried birth reports the
 * broker's identity for the launch turn, never an identity-less receipt.
 *
 * Harness copied from T-08562 (real doors, dispatch handler, HarnessBrokerController
 * and the Unix-socket aspd double) with the double in its real claude-code-tmux
 * launch-carried shape (`launchCarriedInitialPrompt`). The broker's attribution
 * of the launch turn is applied through the real BrokerEventMapper.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import {
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  createBrokerTmuxTuiAllocator,
} from '../broker-interactive-handlers/substrate-allocator'
import { HarnessBrokerController } from '../broker/controller'
import { BrokerEventMapper } from '../broker/event-mapper'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import {
  type AspdDouble,
  type HostingLedger,
  type Release,
  makeRelease,
  producerResult,
  startAspdDouble,
  tmuxManagerDouble,
  workerClient,
} from './fixtures/aspd-route-doubles'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE = 'agent:t09643:project:hrc-runtime:task:T-09643'
const MARK = 'T9643-MARK reply with exactly this marker'

let fixture: HrcServerTestFixture
let server: HrcServer
let scratch: string
let aspdSocket: string
let aspd: AspdDouble
let releaseA: Release
let ledger: HostingLedger
let delivered: Array<{ transport: string; runtimeId: string; prompt: string }>
let releases: string[]
const savedEnv: Record<string, string | undefined> = {}

type Internal = {
  db: HrcDatabase
  options: { runtimeRoot: string }
  harnessBrokerController?: HarnessBrokerController
  runtimeStartOperations: Map<string, Promise<HrcRuntimeSnapshot>>
  startInteractiveTmuxBrokerRuntime(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    runId: string,
    options: Record<string, unknown>
  ): Promise<HrcRuntimeSnapshot>
  dispatchTurnForSession(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent | undefined,
    prompt: string,
    options: Record<string, unknown>
  ): Promise<Response>
  rotateSessionContext(
    session: HrcSessionRecord,
    options: { relaunch: boolean; reason?: string }
  ): Promise<{ hostSessionId: string }>
}

function internal(): Internal {
  return server as unknown as Internal
}

function headlessIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', id: 'codex-cli', interactive: false },
    execution: { preferredMode: 'headless' },
  } as HrcRuntimeIntent
}

type Driver = 'claude-code-tmux' | 'pi-tui-tmux'
type ProducerDriver = Driver | 'codex-app-server'

function terminalProducer(driver: ProducerDriver) {
  const selection =
    driver === 'claude-code-tmux'
      ? { harness: 'claude-code', modelProvider: 'anthropic', model: 'claude-test' }
      : driver === 'pi-tui-tmux'
        ? { harness: 'pi', modelProvider: 'openai', model: 'pi-test' }
        : { harness: 'agent-harness', modelProvider: 'openai-codex', model: 'gpt-5.5' }
  return producerResult({
    selection: { ...selection, presentation: true },
    execution: {
      recipeId: `fixture-${driver}`,
      driver,
      hosting: {
        executionTransport: 'pty',
        terminalRequired: true,
        terminalHost: 'tmux',
        processExecution: 'broker-process',
      },
      presentationFulfillment: 'attachable',
      presentationSurface: { transport: 'terminal', terminalHost: 'tmux' },
    },
  })
}

function selectTerminalProducer(driver: ProducerDriver): void {
  aspd.producerResult = terminalProducer(driver)
}

/** A stored interactive Claude Code or Pi TUI intent. */
function driverIntent(driver: Driver): HrcRuntimeIntent {
  const base = headlessIntent()
  return {
    ...base,
    harness:
      driver === 'claude-code-tmux'
        ? { provider: 'anthropic', id: 'claude-code', interactive: true }
        : { provider: 'openai', id: 'pi-cli', interactive: true },
    execution: { preferredMode: 'interactive' },
  } as HrcRuntimeIntent
}

async function session(scope = SCOPE): Promise<HrcSessionRecord> {
  const resolved = await fixture.resolveSession(scope)
  const record = internal().db.sessions.getByHostSessionId(resolved.hostSessionId)
  if (record === null) throw new Error('session missing')
  return record
}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function bootServer(overrides: { durableIpc?: boolean } = {}): Promise<void> {
  server = await createHrcServer(
    fixture.serverOpts({
      headlessCodexBrokerEnabled: true,
      codexCliTmuxBrokerEnabled: false,
      claudeCodeTmuxBrokerEnabled: true,
      brokerDurableIpcEnabled: overrides.durableIpc ?? true,
      otelListenerEnabled: false,
    })
  )
  const tmuxManagerFactory = tmuxManagerDouble(ledger)
  const deps = (token: string) => ({
    tmuxManagerFactory: tmuxManagerFactory as never,
    generateAttachToken: () => token,
  })
  releases = []
  const counted = <T extends { release?: (a: never) => Promise<void> }>(
    name: string,
    allocator: T
  ): T => {
    const release = allocator.release
    return release === undefined
      ? allocator
      : {
          ...allocator,
          release: async (allocation: never) => {
            releases.push(name)
            await release(allocation)
          },
        }
  }
  internal().harnessBrokerController = new HarnessBrokerController({
    db: internal().db,
    brokerUnixClientFactory: async () =>
      workerClient(ledger, [releaseA], ledger.commands.at(-1)) as never,
    tmuxAllocator: counted(
      'tmux',
      createBrokerDurableTmuxAllocator(internal().options, deps('attach-t08562-tui'))
    ),
    headlessSubstrateAllocator: counted(
      'headless',
      createBrokerDurableHeadlessAllocator(internal().options, deps('attach-t08562'))
    ),
    tmuxTuiAllocator: createBrokerTmuxTuiAllocator(internal().options, deps('attach-t08562-v')),
    now: () => new Date().toISOString(),
  } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])

  delivered = []
  const target = server as unknown as Record<string, unknown>
  const record =
    (transport: string) =>
    async (_s: HrcSessionRecord, runtime: HrcRuntimeSnapshot, prompt: string, runId: string) => {
      delivered.push({ transport, runtimeId: runtime.runtimeId, prompt })
      return Response.json({
        runId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        transport: runtime.transport,
        status: 'started',
        supportsInFlightInput: true,
      })
    }
  target['reconcileTmuxRuntimeLiveness'] = async (runtime: HrcRuntimeSnapshot) => runtime
  target['executeInteractiveBrokerInputTurn'] = record('tmux')
  target['executeHeadlessBrokerInputTurn'] = record('headless')
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t09643-')
  scratch = await mkdtemp(join(tmpdir(), 't9643-'))
  releaseA = makeRelease(join(scratch, 'releases'), 'a')
  aspdSocket = join(scratch, 'aspd.sock')
  aspd = startAspdDouble(aspdSocket, releaseA)
  selectTerminalProducer('claude-code-tmux')
  setEnv('HRC_ASPD_SOCKET', aspdSocket)
  setEnv('HRC_HARNESS_BROKER_CMD', '/nonexistent/resolver-selected-harness-broker')
  setEnv('ASP_HOME', join(scratch, 'caller-asp-home'))
  ledger = { commands: [], killedServers: [], startCalls: [], attachCalls: 0 }
  await bootServer()
})

afterEach(async () => {
  aspd.stop()
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    delete savedEnv[name]
  }
  await server.stop()
  await fixture.cleanup()
  await rm(scratch, { recursive: true, force: true })
})

type OperationRow = {
  operation_id: string
  status: string
  error_code: string | null
  run_id: string | null
  preparation_json: string
}

function operations(hostSessionId: string): Array<OperationRow & { record: any }> {
  return internal()
    .db.sqlite.query<OperationRow, [string]>(
      `SELECT operation_id, status, error_code, run_id, preparation_json FROM runtime_operations
        WHERE host_session_id = ? AND preparation_json IS NOT NULL ORDER BY created_at ASC`
    )
    .all(hostSessionId)
    .map((row) => ({ ...row, record: JSON.parse(row.preparation_json) }))
}

async function seedInteractive(
  scope = SCOPE,
  intent: HrcRuntimeIntent = driverIntent('claude-code-tmux')
): Promise<HrcSessionRecord> {
  const s = await session(scope)
  internal().db.sessions.updateIntent(s.hostSessionId, intent, new Date().toISOString())
  return internal().db.sessions.getByHostSessionId(s.hostSessionId) as HrcSessionRecord
}

function launchPrompt(request: any): string | undefined {
  return request?.spec?.launch?.initialPrompt
}

function initialInputText(request: any): string | undefined {
  return request?.initialInput?.content?.[0]?.text
}

async function settle(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(10)
}

/** The broker's real attribution of the argv launch turn, through the real mapper. */
function observeLaunchTurn(invocationId: string): string {
  const db = internal().db
  db.brokerInvocations.update(invocationId, {
    capabilitiesJson: JSON.stringify({ bracketMintingMode: 'harness-evidence' }),
    updatedAt: new Date().toISOString(),
  })
  const mapper = new BrokerEventMapper({ db, now: () => new Date().toISOString() })
  const submissionId = `human_submission_${invocationId}_1`
  const turnId = `turn_${invocationId}_1`
  const envelope = (seq: number, type: InvocationEventEnvelope['type'], payload: object) =>
    ({
      invocationId,
      seq,
      time: new Date().toISOString(),
      type,
      payload,
    }) as InvocationEventEnvelope
  mapper.apply(envelope(9001, 'turn.started', { turnId, source: 'hook-observed' }))
  mapper.apply(envelope(9002, 'submission.executed', { submissionId, turnId }))
  return submissionId
}

// T-09643: the installed ASP launch-carries a claude-code-tmux first turn in
// argv, so the frozen start request has no broker initialInput and the broker
// names that turn only when it is observed (human_submission_<inv>_<n>). A
// submission door answering a cold birth must wait for that identity -- the
// body is already on the launch, so answering "no admission identity" reports a
// write that happened as unavailable (EN-19240, EN-19259).
describe('T-09643 launch-carried cold birth answers the door with the broker identity', () => {
  function coldDoorRequest(door: 'enqueue' | 'invoke', key: string) {
    return {
      target: `${SCOPE}/lane:main`,
      body: MARK,
      origin: { principalRef: 'agent:mable', envelopeId: `EN-T9643-${door}` },
      idempotencyKey: key,
      runtimeIntent: driverIntent('claude-code-tmux'),
      ttlMs: 60_000,
      wait: false,
      ...(door === 'invoke' ? { coldBirth: { promptMode: 'replace-priming' as const } } : {}),
    }
  }

  for (const door of ['enqueue', 'invoke'] as const) {
    it(`${door}: 2xx with submissionId equal to the broker's human_submission id`, async () => {
      aspd.launchCarriedInitialPrompt = true
      await seedInteractive()
      const pending = fixture.postJson(
        `/v1/submissions/${door}`,
        coldDoorRequest(door, `t9643-${door}`)
      )
      await settle(() => ledger.startCalls.length === 1)
      const request = ledger.startCalls[0]?.request
      expect(launchPrompt(request)).toContain('T9643-MARK')
      expect(initialInputText(request)).toBeUndefined()
      const invocationId = String(request?.spec.invocationId)
      // The door must still be waiting: the identity does not exist yet.
      await Bun.sleep(50)
      const submissionId = observeLaunchTurn(invocationId)

      const response = await pending
      const body = (await response.json()) as Record<string, unknown>
      expect(response.status).toBeLessThan(300)
      expect(body['submissionId']).toBe(submissionId)
      expect(body['admission']).toBe('admitted')
      expect(delivered).toEqual([])
    })
  }

  it('a bounded wait that expires is an explicit error, never an identity-less success', async () => {
    aspd.launchCarriedInitialPrompt = true
    ;(
      server as unknown as { launchCarriedSubmissionWaitMs: number }
    ).launchCarriedSubmissionWaitMs = 150
    await seedInteractive()
    const response = await fixture.postJson(
      '/v1/submissions/enqueue',
      coldDoorRequest('enqueue', 't9643-timeout')
    )
    const body = (await response.json()) as {
      submissionId?: unknown
      error?: { code?: string; message?: string; detail?: Record<string, unknown> }
    }
    expect(response.status).toBe(503)
    expect(body.submissionId).toBeUndefined()
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.message).toBe('launch-carried submission identity timed out')
    expect(body.error?.detail?.['waitMs']).toBe(150)
  })

  it('a run that ends before the broker names its launch turn is an explicit error', async () => {
    aspd.launchCarriedInitialPrompt = true
    const s = await seedInteractive()
    const pending = fixture.postJson(
      '/v1/submissions/enqueue',
      coldDoorRequest('enqueue', 't9643-ended')
    )
    await settle(() => ledger.startCalls.length === 1)
    await settle(() => operations(s.hostSessionId)[0]?.run_id != null)
    const runId = operations(s.hostSessionId)[0]?.run_id as string
    await settle(() => internal().db.runs.getByRunId(runId) !== null)
    const endedAt = new Date().toISOString()
    internal().db.runs.markCompleted(runId, {
      status: 'failed',
      completedAt: endedAt,
      updatedAt: endedAt,
      errorMessage: 'seat died before its first turn',
    })
    const response = await pending
    const body = (await response.json()) as {
      submissionId?: unknown
      error?: { message?: string }
    }
    expect(response.status).toBe(503)
    expect(body.submissionId).toBeUndefined()
    expect(body.error?.message).toBe('launch-carried run ended without broker submission identity')
  })
})

describe('T-10232 phase 2 cold launch and admitted queue continuation', () => {
  it('D6 cold selector body rides the launch rather than a second input', async () => {
    aspd.launchCarriedInitialPrompt = true
    const s = await seedInteractive()
    const pending = fixture.postJson('/v1/turns/by-selector', {
      selector: { sessionRef: `${SCOPE}/lane:main` },
      prompt: MARK,
      runtimeIntent: driverIntent('claude-code-tmux'),
    })
    await settle(() => ledger.startCalls.length === 1)
    const request = ledger.startCalls[0]?.request
    expect(launchPrompt(request)).toContain('T9643-MARK')
    observeLaunchTurn(String(request?.spec.invocationId))
    expect((await pending).status).toBe(200)
    expect(delivered).toEqual([])
    const events = internal().db.hrcEvents.listByKind('submission.admission')
    expect(events).toHaveLength(1)
    expect(events[0]?.hostSessionId).toBe(s.hostSessionId)
    expect(events[0]?.payload).toMatchObject({
      door: 'turns-by-selector',
      intent: 'enqueue',
      outcome: 'routed',
    })
  })

  it('D11 legacy no-aspd cold arm refuses because its compiler fallback is retired', async () => {
    const s = await seedInteractive()
    setEnv('HRC_ASPD_SOCKET', undefined)
    const response = await fixture.postJson('/v1/runs/prepare-attached', {
      hostSessionId: s.hostSessionId,
      intent: driverIntent('claude-code-tmux'),
      prompt: MARK,
    })
    const body = await response.json()
    expect(response.status).toBe(503)
    expect(body.error.detail.code).toBe('aspd_unconfigured')
    expect(ledger.startCalls).toEqual([])
    expect(delivered).toEqual([])
    const event = internal().db.hrcEvents.listByKind('submission.admission').at(-1)
    expect(event?.payload).toMatchObject({
      door: 'prepare-attached',
      intent: 'invoke',
      effectiveDoor: 'invoke',
      outcome: 'possible_write',
      trace: [
        { step: 'drain-lease', outcome: 'passed' },
        { step: 'retired-persona', outcome: 'passed' },
        { step: 'fence', outcome: 'skipped:not-carried' },
        { step: 'participant-resolution', outcome: 'skipped:not-applicable' },
        { step: 'ownership-proof', outcome: 'skipped:not-carried' },
        { step: 'capability-authority', outcome: 'passed' },
        { step: 'execution-presentation', outcome: 'passed' },
        { step: 'rotation', outcome: 'passed' },
        { step: 'launch-carry-observation', outcome: 'passed' },
      ],
    })
  })

  for (const legacy of [false, true]) {
    it(`D14 cold enqueue, daemon restart, drain carries body at launch (legacy=${legacy})`, async () => {
      aspd.producerResult = producerResult()
      const s = await session()
      internal().db.sessions.updateIntent(
        s.hostSessionId,
        headlessIntent(),
        new Date().toISOString()
      )
      let rejectBoot!: (error: Error) => void
      const boot = new Promise<HrcRuntimeSnapshot>((_resolve, reject) => {
        rejectBoot = reject
      })
      internal().runtimeStartOperations.set(s.hostSessionId, boot)
      const pending = fixture.postJson('/v1/turns/by-selector', {
        selector: { sessionRef: `${SCOPE}/lane:main` },
        prompt: MARK,
        runtimeIntent: headlessIntent(),
      })
      await settle(() =>
        internal()
          .db.runs.listQueuedByHostSessionId(s.hostSessionId)
          .some((run) => run.status === 'queued')
      )
      const queued = internal()
        .db.runs.listQueuedByHostSessionId(s.hostSessionId)
        .find((run) => run.status === 'queued')
      expect(queued).toBeDefined()
      if (queued === undefined) throw new Error('door did not persist queue')
      const correlation = JSON.parse(internal().db.runs.getCorrelationJson(queued.runId) ?? '{}')
      expect(correlation.admittedIntent).toBe('enqueue')
      expect(correlation.prompt).toBe(MARK)
      if (legacy) {
        correlation.admittedIntent = undefined
        internal().db.runs.setCorrelationJson(queued.runId, JSON.stringify(correlation))
      }
      rejectBoot(new Error('simulated boot lost before daemon restart'))
      expect((await pending).status).toBe(500) // Simulated boot error is the unchanged uncertain HTTP shape.
      internal().runtimeStartOperations.delete(s.hostSessionId)
      await server.stop()
      await bootServer()
      const ctx = server as unknown as HrcServerInstanceForHandlers
      expect(ctx.db.runs.getByRunId(queued.runId)?.status).toBe('queued')
      await ctx.drainDurableHeadlessTurnInputs(s.hostSessionId)
      const launch = ledger.startCalls.at(-1)?.request
      expect(initialInputText(launch)).toContain('T9643-MARK')
      expect(delivered).toEqual([])
      expect(ctx.db.runs.getByRunId(queued.runId)?.status).toBe('accepted')
      expect(ctx.db.runs.getByRunId(queued.runId)?.acceptedAt).toBe(queued.acceptedAt)
      expect(ctx.db.runs.getByRunId(queued.runId)?.dispatchIdempotencyKey).toBe(
        queued.dispatchIdempotencyKey
      )
      expect(ctx.db.runs.getByRunId(queued.runId)?.invocationId).toBe(launch?.spec.invocationId)
      // Only the original door admission was recorded; drain did not re-admit.
      expect(ctx.db.hrcEvents.listByKind('submission.admission')).toHaveLength(1)
      expect(ctx.queuedTurnInputDrains.size).toBe(0)
    }, 30_000)
  }
  it('D14 cold continuation coalesces atomically under the drain lease until acceptance', async () => {
    aspd.producerResult = producerResult()
    const s = await session()
    const ctx = server as unknown as HrcServerInstanceForHandlers
    ctx.db.sessions.updateIntent(s.hostSessionId, headlessIntent(), new Date().toISOString())
    for (const [position, runId] of ['run-queued-member', 'run-queued-owner'].entries()) {
      const message = ctx.insertAndNotifyMessage({
        messageId: `msg-queue-${position}`,
        kind: 'dm',
        phase: 'request',
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: `${SCOPE}/lane:main` },
        body: `${MARK}-${position}`,
        execution: { state: 'accepted', runId },
      })
      ctx.enqueueDurableHeadlessTurnInput(s, message.body, runId, {
        source: 'semantic_dm',
        sourceMessageId: message.messageId,
        admittedIntent: 'enqueue',
      })
    }
    const draining = ctx.drainDurableHeadlessTurnInputs(s.hostSessionId)
    expect(ctx.turnAdmissionGate.snapshot().activeAdmissions).toBe(1)
    let closed = false
    const closing = ctx.turnAdmissionGate.close({ operationId: 'queue-lease-test' }).then(() => {
      closed = true
    })
    expect(closed).toBe(false)
    await draining
    await closing
    expect(ctx.db.runs.getByRunId('run-queued-member')).toMatchObject({
      status: 'coalesced',
      coalescedIntoRunId: 'run-queued-owner',
      coalescedPosition: 0,
    })
    expect(ctx.db.messages.getById('msg-queue-0')?.execution).toMatchObject({
      state: 'coalesced',
      coalescedIntoRunId: 'run-queued-owner',
    })
    expect(ctx.db.runs.getByRunId('run-queued-owner')?.status).toBe('accepted')
    expect(ledger.startCalls).toHaveLength(1)
    expect(initialInputText(ledger.startCalls[0]?.request)).toContain(`${MARK}-0`)
    expect(initialInputText(ledger.startCalls[0]?.request)).toContain(`${MARK}-1`)
    expect(closed).toBe(true)
    expect(ctx.db.hrcEvents.listByKind('submission.admission')).toHaveLength(0)
    expect(ctx.db.messages.getById('msg-queue-1')?.execution.state).toBe('started')
    expect(delivered).toEqual([])
  })
})

describe('T-10232 phase 3 START launch carry', () => {
  it('D10 body rides the cold launch and completion observation releases admission', async () => {
    aspd.launchCarriedInitialPrompt = true
    const s = await seedInteractive()
    let settled = false
    const pending = fixture
      .postJson('/v1/runtimes/start', {
        hostSessionId: s.hostSessionId,
        intent: { ...driverIntent('claude-code-tmux'), initialPrompt: MARK },
      })
      .then((response) => {
        settled = true
        return response
      })
    await settle(() => ledger.startCalls.length === 1)
    const request = ledger.startCalls[0]?.request
    expect(launchPrompt(request)).toContain('T9643-MARK')
    expect(initialInputText(request)).toBeUndefined()
    const invocationId = String(request?.spec.invocationId)
    expect(internal().db.hrcEvents.listByKind('submission.admission')).toHaveLength(0)
    observeLaunchTurn(invocationId)
    await settle(() => internal().db.hrcEvents.listByKind('submission.admission').length === 1)
    const event = internal().db.hrcEvents.listByKind('submission.admission')[0]
    expect(event?.payload).toMatchObject({
      door: 'runtime-start-prompt',
      intent: 'enqueue',
      outcome: 'routed',
    })
    expect(settled).toBe(false)
    const ctx = server as unknown as HrcServerInstanceForHandlers
    await ctx.turnAdmissionGate.close({ operationId: 'd10-cold-receipt' })
    expect(settled).toBe(false)
    expect(delivered).toEqual([])
    const run = internal().db.runs.listRuns()[0]
    expect(run?.runId).toBe(event?.runId)
    const mapper = new BrokerEventMapper({ db: internal().db, now: () => new Date().toISOString() })
    mapper.apply({
      invocationId,
      seq: 9003,
      time: new Date().toISOString(),
      type: 'turn.completed',
      payload: { turnId: `turn_${invocationId}_1`, status: 'completed' },
    } as InvocationEventEnvelope)
    expect(internal().db.runs.getByRunId(run?.runId ?? '')?.status).toBe('completed')
    expect((await pending).status).toBe(200)
    expect(internal().db.runs.listRuns()).toHaveLength(1)
    expect(ledger.startCalls).toHaveLength(1)
  })
})
