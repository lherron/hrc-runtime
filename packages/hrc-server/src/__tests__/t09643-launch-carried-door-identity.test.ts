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
