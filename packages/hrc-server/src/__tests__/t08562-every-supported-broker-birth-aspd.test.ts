/**
 * T-08562 — every supported broker birth through aspd: claude-code-tmux and
 * pi-tui-tmux (docs/aspd-headless-codex-integration.md §1.6;
 * hrc-runtime.aspd-prepared-execution-release, hrc-runtime.asp-toolchain-selection,
 * hrc-runtime.harness-broker-admission-client).
 *
 * Harness shared with T-08560 (below).
 * Real pieces: the dispatch, submission, start, ensure, attach and rotation doors,
 * the interactive dispatch handler and birth chokepoint, the real
 * `HarnessBrokerController` and durable allocators, and the Unix-socket aspd
 * double speaking the ASPC wire (T-08542/T-08556 doubles). The bundled facade is
 * a spy that throws if reached. Post-boot input turns are OBSERVED, never
 * delivered, so exactly-once is a count: a launch-carried prompt must appear once
 * in the frozen start request that reached `invocation.start`, and never at the
 * post-boot executor.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { launchAspdPreparedAttempt, prepareAspdHeadlessAttempt } from '../aspd-headless-start'

import { AspcFacadeBrokerClient } from '../agent-spaces-adapter/aspc-facade-client'
import {
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  createBrokerTmuxTuiAllocator,
} from '../broker-interactive-handlers/substrate-allocator'
import { HarnessBrokerController } from '../broker/controller'
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

const SCOPE = 'agent:t08562:project:hrc-runtime:task:T-08562'
const MARK = 'T8562-MARK reply with exactly this marker'

let fixture: HrcServerTestFixture
let server: HrcServer
let scratch: string
let aspdSocket: string
let aspd: AspdDouble
let releaseA: Release
let ledger: HostingLedger
let facadeCalls: number
let facadeSpy: ReturnType<typeof spyOn>
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

/** A stored interactive Codex intent (what an earlier `hrc run` or attach persisted). */
function interactiveIntent(): HrcRuntimeIntent {
  const base = headlessIntent()
  return {
    ...base,
    harness: { ...base.harness, interactive: true },
    execution: { preferredMode: 'interactive' },
  }
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

function piSdkIntent(): HrcRuntimeIntent {
  const base = headlessIntent()
  return {
    ...base,
    harness: { provider: 'openai', id: 'pi-sdk', interactive: false },
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
  fixture = await createHrcTestFixture('hrc-t08562-')
  scratch = await mkdtemp(join(tmpdir(), 't8562-'))
  releaseA = makeRelease(join(scratch, 'releases'), 'a')
  aspdSocket = join(scratch, 'aspd.sock')
  aspd = startAspdDouble(aspdSocket, releaseA)
  selectTerminalProducer('claude-code-tmux')
  setEnv('HRC_ASPD_SOCKET', aspdSocket)
  setEnv('HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION', 'tmux-tui')
  setEnv('HRC_HARNESS_BROKER_CMD', '/nonexistent/resolver-selected-harness-broker')
  setEnv('ASP_HOME', join(scratch, 'caller-asp-home'))
  ledger = { commands: [], killedServers: [], startCalls: [], attachCalls: 0 }
  await bootServer()
  facadeCalls = 0
  facadeSpy = spyOn(AspcFacadeBrokerClient, 'start').mockImplementation(async () => {
    facadeCalls += 1
    throw new Error('bundled facade reached')
  })
})

afterEach(async () => {
  facadeSpy.mockRestore()
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

function storedIntentJson(hostSessionId: string): string {
  return JSON.stringify(
    internal().db.sessions.getByHostSessionId(hostSessionId)?.lastAppliedIntentJson
  )
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

/** The external injector's exact summons-birth call. */
async function kickerSummons(s: HrcSessionRecord, prompt = MARK): Promise<Response> {
  return await internal().dispatchTurnForSession(s, s.lastAppliedIntentJson, prompt, {
    waitForCompletion: false,
    submissionDoor: 'invoke',
    ttlMs: 60_000,
    submissionOrigin: { principalRef: 'agent:mable', envelopeId: 'EN-T8562' },
    launchPromptOnColdBirth: true,
  })
}

function runRow(runId: string): {
  dispatched_input_id: string | null
  correlation_json: string | null
} {
  return internal()
    .db.sqlite.query<
      { dispatched_input_id: string | null; correlation_json: string | null },
      [string]
    >('SELECT dispatched_input_id, correlation_json FROM runs WHERE run_id = ?')
    .get(runId) as never
}

// ── G-B-route + G-B-D1 ────────────────────────────────────────────────────────

describe('T-08562 launch-argv drivers through aspd (G-B-route, G-B-D1)', () => {
  for (const driver of ['claude-code-tmux', 'pi-tui-tmux'] as const) {
    it(`${driver} mail summons: prompt is frozen in the producer dispatch request and never resubmitted`, async () => {
      selectTerminalProducer(driver)
      const s = await seedInteractive(SCOPE, driverIntent(driver))
      const response = await kickerSummons(s)
      expect(response.status).toBe(200)
      await settle(() => ledger.startCalls.length === 1)

      expect(facadeCalls).toBe(0)
      expect(aspd.compileCalls).toBe(1)
      expect(aspd.compileRequested[0]).toBeDefined()
      expect(aspd.compileSelectors[0]).toBeUndefined()
      expect(aspd.compileMaterializations[0]).toMatchObject({
        initialPrompt: MARK,
        omitPriming: true,
      })
      const [op] = operations(s.hostSessionId)
      expect(op?.record.route).toBe('producer-selected-execution')
      expect(op?.record.hosting).toMatchObject({
        driverKind: driver,
        presentation: 'terminal',
      })
      expect(op?.record.dispatch.routeDecision).toMatchObject({
        launchCarriedPrompt: { mode: 'replace-priming' },
        preparation: 'aspd',
        selectedBy: 'producer-selected-execution',
      })
      // The producer's canonical request preserves the allocated initial input.
      expect(
        launchPrompt(op?.record.admission.execution.dispatchRequest.startRequest)
      ).toBeUndefined()
      expect(initialInputText(op?.record.admission.execution.dispatchRequest.startRequest)).toBe(
        MARK
      )
      expect(JSON.stringify(op?.record.intent)).not.toContain('T8562-MARK')
      expect(storedIntentJson(s.hostSessionId)).not.toContain('T8562-MARK')
      // Launched from the frozen release with this driver's hosting paths.
      expect(ledger.commands[0]).toContain(join(releaseA.releaseRoot, 'harness-broker'))
      expect(ledger.commands[0]).toContain(op?.record.hosting.paths.brokerIpcSocketPath)
      expect(op?.record.hosting.paths.sessionName).toBe(`hrc-${driver}-${op?.record.runtimeId}`)
      // Delivered only through invocation.start, never by the post-boot executor.
      expect(ledger.startCalls).toHaveLength(1)
      expect(launchPrompt(ledger.startCalls[0]?.request)).toBeUndefined()
      expect(initialInputText(ledger.startCalls[0]?.request)).toBe(MARK)
      await Bun.sleep(30)
      expect(delivered).toEqual([])
      // The producer-bound initial input is persisted as the run's dispatched input.
      const run = runRow(op?.run_id as string)
      expect(run.dispatched_input_id).not.toBeNull()
    })
  }

  it('claude-code-tmux POST /v1/turns: append-to-priming, key frozen, applied intent prompt-free', async () => {
    selectTerminalProducer('claude-code-tmux')
    const s = await seedInteractive()
    const response = await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: MARK,
      idempotencyKey: 'k-turns',
      waitFor: 'accepted',
    })
    expect(response.status).toBeLessThan(300)
    await settle(() => ledger.startCalls.length === 1)
    expect(facadeCalls).toBe(0)
    expect(aspd.compileMaterializations[0]?.initialPrompt).toBe(MARK)
    expect(aspd.compileMaterializations[0]?.omitPriming).toBeUndefined()
    const [op] = operations(s.hostSessionId)
    expect(op?.record.route).toBe('producer-selected-execution')
    expect(op?.record.dispatch.routeDecision.launchCarriedPrompt).toEqual({
      mode: 'append-to-priming',
    })
    expect(op?.record.dispatchIdempotencyKey).toBe('k-turns')
    expect(launchPrompt(ledger.startCalls[0]?.request)).toBeUndefined()
    expect(initialInputText(ledger.startCalls[0]?.request)).toBe(MARK)
    expect(storedIntentJson(s.hostSessionId)).not.toContain('T8562-MARK')
    await Bun.sleep(30)
    expect(delivered).toEqual([])
  })

  it('a bare selector message is frozen into the producer request, not delivered again after boot', async () => {
    selectTerminalProducer('claude-code-tmux')
    const s = await seedInteractive()
    await internal().dispatchTurnForSession(s, s.lastAppliedIntentJson, MARK, {
      waitForCompletion: false,
    })
    await settle(() => delivered.length === 1)
    const [op] = operations(s.hostSessionId)
    expect(op?.record.route).toBe('producer-selected-execution')
    expect(op?.record.dispatch.routeDecision.launchCarriedPrompt).toBeUndefined()
    expect(
      launchPrompt(op?.record.admission.execution.dispatchRequest.startRequest)
    ).toBeUndefined()
    expect(initialInputText(op?.record.admission.execution.dispatchRequest.startRequest)).toBe(MARK)
    expect(delivered).toEqual([])
    expect(facadeCalls).toBe(0)
  })

  for (const driver of ['claude-code-tmux', 'pi-tui-tmux'] as const) {
    it(`${driver} explicit start and ensure prepare through aspd, door interactive-birth`, async () => {
      selectTerminalProducer(driver)
      const s = await session()
      const started = await fixture.postJson('/v1/runtimes/start', {
        hostSessionId: s.hostSessionId,
        intent: driverIntent(driver),
      })
      expect(started.status).toBe(200)
      const other = await session(`${SCOPE}-ensure`)
      const ensured = await fixture.postJson('/v1/runtimes/ensure', {
        hostSessionId: other.hostSessionId,
        intent: driverIntent(driver),
      })
      expect(ensured.status).toBe(200)
      for (const hostSessionId of [s.hostSessionId, other.hostSessionId]) {
        const [op] = operations(hostSessionId)
        expect(op?.record.route).toBe('producer-selected-execution')
        expect(op?.record.hosting.driverKind).toBe(driver)
        expect(op?.record.dispatch.routeDecision.selectedBy).toBe('producer-selected-execution')
      }
      expect(facadeCalls).toBe(0)
    })
  }

  it('claude-code-tmux rotation relaunch births the successor through aspd', async () => {
    selectTerminalProducer('claude-code-tmux')
    const s = await seedInteractive()
    const rotated = await internal().rotateSessionContext(s, { relaunch: true, reason: 't8562' })
    const [op] = operations(rotated.hostSessionId)
    expect(op?.record.route).toBe('producer-selected-execution')
    expect(facadeCalls).toBe(0)
  })

  it('the attached-run class is recorded for a Claude birth carrying the attach handshake, with no launch-carried prompt', async () => {
    selectTerminalProducer('claude-code-tmux')
    const s = await session()
    const start = internal().startInteractiveTmuxBrokerRuntime(
      s,
      driverIntent('claude-code-tmux'),
      'run-attached',
      {
        flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
        allowedBrokerDriver: 'claude-code-tmux',
        attachBeforeInvocationStart: { pendingStartId: 'attached-t8562' },
      }
    )
    await settle(() => operations(s.hostSessionId).length === 1)
    const [op] = operations(s.hostSessionId)
    expect(op?.record.dispatch.routeDecision.door).toBe('attached-run')
    expect(op?.record.dispatch.routeDecision.launchCarriedPrompt).toBeUndefined()
    internal().harnessBrokerController?.cancelAttachedStart?.('attached-t8562')
    await start.catch(() => undefined)
    expect(facadeCalls).toBe(0)
  })

  it('a retired codex-cli door input cannot override the declared producer execution', async () => {
    selectTerminalProducer('codex-app-server')
    const s = await session()
    await internal().startInteractiveTmuxBrokerRuntime(s, interactiveIntent(), 'run-cli-tmux', {
      flagEnvName: 'HRC_CODEX_CLI_TMUX_BROKER_ENABLED',
      allowedBrokerDriver: 'codex-cli-tmux',
    })
    const [op] = operations(s.hostSessionId)
    expect(op?.record.admission.execution.driver).toBe('codex-app-server')
    expect(op?.record.hosting.driverKind).toBe('codex-app-server')
    expect(aspd.compileCalls).toBe(1)
    expect(facadeCalls).toBe(0)
  })

  it('an unset socket refuses claude-code-tmux and pi-tui-tmux with aspd_unconfigured (T-08596)', async () => {
    setEnv('HRC_ASPD_SOCKET', undefined)
    const s = await session()
    for (const driver of ['claude-code-tmux', 'pi-tui-tmux'] as const) {
      await expect(
        internal().startInteractiveTmuxBrokerRuntime(
          s,
          driverIntent(driver),
          `run-unset-${driver}`,
          {
            flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
            allowedBrokerDriver: driver,
            coldBirthPrompt: MARK,
          }
        )
      ).rejects.toThrow('aspd-independent execution closure')
    }
    expect(aspd.compileCalls).toBe(0)
    expect(facadeCalls).toBe(0)
  })
})

// ── G-B-admission + G-B-hosting ──────────────────────────────────────────────

describe('T-08562 generic admission and hosting evidence (G-B-admission, G-B-hosting)', () => {
  it('a producer-selected execution is admitted even when the raw intent names another driver', async () => {
    selectTerminalProducer('pi-tui-tmux')
    const s = await seedInteractive()
    await kickerSummons(s)
    await settle(() => ledger.startCalls.length === 1)
    expect(aspd.compileCalls).toBe(1)
    const [op] = operations(s.hostSessionId)
    expect(op?.record.admission.execution.driver).toBe('pi-tui-tmux')
    expect(op?.record.hosting.driverKind).toBe('pi-tui-tmux')
    expect(ledger.commands).toHaveLength(1)
    expect(facadeCalls).toBe(0)
  })

  it('a declared codex execution is admitted without a local hosted-driver membership assertion', async () => {
    selectTerminalProducer('codex-app-server')
    const s = await seedInteractive(SCOPE, interactiveIntent())
    await kickerSummons(s)
    await settle(() => ledger.startCalls.length === 1)
    const [op] = operations(s.hostSessionId)
    expect(op?.record.route).toBe('producer-selected-execution')
    expect(op?.record.hosting).toMatchObject({
      driverKind: 'codex-app-server',
      presentation: 'terminal',
    })
    expect(op?.record.executionRelease.worker).not.toHaveProperty('hostedDrivers')
    expect(facadeCalls).toBe(0)
  })

  it('launch re-checks frozen execution hosting from persisted bytes: a hand-edited prepared row refuses and stays prepared', async () => {
    selectTerminalProducer('claude-code-tmux')
    const s = await seedInteractive()
    ledger.helloReleaseOverride = null
    await kickerSummons(s).catch(() => undefined)
    await settle(() => operations(s.hostSessionId)[0]?.error_code !== null)
    const [op] = operations(s.hostSessionId)
    expect(op?.status).toBe('prepared')
    ledger.helloReleaseOverride = undefined
    const record = op?.record
    record.hosting.presentation = 'none'
    internal()
      .db.sqlite.query(
        'UPDATE runtime_operations SET preparation_json = ?, error_code = NULL WHERE operation_id = ?'
      )
      .run(JSON.stringify(record), op?.operation_id as string)
    const commandsBefore = ledger.commands.length
    await expect(
      launchAspdPreparedAttempt(server as never, op?.operation_id as string, {
        settleFailure: (error) => {
          throw new Error(error.code)
        },
      })
    ).rejects.toThrow('frozen worker launch description no longer matches')
    const [after] = operations(s.hostSessionId)
    expect(after?.status).toBe('prepared')
    expect(after?.error_code).toBe('launch_description_mismatch')
    expect(ledger.commands.length).toBe(commandsBefore)
  })

  it('launch refuses a producer-selected record whose frozen driver no longer matches its admitted execution', async () => {
    selectTerminalProducer('claude-code-tmux')
    const s = await seedInteractive()
    ledger.helloReleaseOverride = null
    await kickerSummons(s).catch(() => undefined)
    await settle(() => operations(s.hostSessionId)[0]?.error_code !== null)
    const [op] = operations(s.hostSessionId)
    ledger.helloReleaseOverride = undefined
    const record = op?.record
    record.hosting.driverKind = 'pi-tui-tmux'
    internal()
      .db.sqlite.query('UPDATE runtime_operations SET preparation_json = ? WHERE operation_id = ?')
      .run(JSON.stringify(record), op?.operation_id as string)
    await expect(
      launchAspdPreparedAttempt(server as never, op?.operation_id as string, {
        settleFailure: (error) => {
          throw new Error(error.code)
        },
      })
    ).rejects.toThrow()
    expect(operations(s.hostSessionId)[0]?.error_code).toBe('launch_description_mismatch')
  })
})

// ── G-B-D2 ────────────────────────────────────────────────────────────────────

describe('T-08562 keyed resume and route/driver fence (G-B-D2)', () => {
  async function frozenClaudeKeyed(key: string): Promise<HrcSessionRecord> {
    const s = await seedInteractive()
    ledger.helloReleaseOverride = null
    const first = await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: MARK,
      idempotencyKey: key,
      waitFor: 'accepted',
    })
    expect(first.status).toBeGreaterThanOrEqual(500)
    const [prepared] = operations(s.hostSessionId)
    expect(prepared?.status).toBe('prepared')
    expect(prepared?.record.route).toBe('producer-selected-execution')
    ledger.helloReleaseOverride = undefined
    return s
  }

  it('a same-key retry resumes the frozen Claude preparation without re-preparing, prompt once', async () => {
    const s = await frozenClaudeKeyed('k-resume')
    const retry = await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: 'a different retry body',
      idempotencyKey: 'k-resume',
      waitFor: 'accepted',
    })
    expect(retry.status).toBeLessThan(300)
    await settle(() => ledger.startCalls.length === 1)
    expect(aspd.compileCalls).toBe(1)
    expect(operations(s.hostSessionId)).toHaveLength(1)
    expect(launchPrompt(ledger.startCalls[0]?.request)).toBeUndefined()
    expect(initialInputText(ledger.startCalls[0]?.request)).toBe(MARK)
    await Bun.sleep(30)
    expect(delivered).toEqual([])
  })

  for (const [label, intent] of [
    ['Codex', interactiveIntent],
    ['Pi TUI (same route, different driver)', () => driverIntent('pi-tui-tmux')],
  ] as const) {
    it(`a retry carrying ${label} does not reselect the frozen producer execution`, async () => {
      const s = await frozenClaudeKeyed(`k-fence-${label}`)
      const retry = await fixture.postJson('/v1/turns', {
        hostSessionId: s.hostSessionId,
        prompt: MARK,
        idempotencyKey: `k-fence-${label}`,
        runtimeIntent: intent(),
        waitFor: 'accepted',
      })
      expect(retry.status).toBeLessThan(300)
      expect(operations(s.hostSessionId)).toHaveLength(1)
      expect(operations(s.hostSessionId)[0]?.status).not.toBe('prepared')
      expect(ledger.startCalls).toHaveLength(1)
      expect(operations(s.hostSessionId)[0]?.record.admission.execution.driver).toBe(
        'claude-code-tmux'
      )
      expect(aspd.compileCalls).toBe(1)
    })
  }
})

// ── G-B-D3/D4, continuation, pi-sdk, join, backstop, ipc ─────────────────────

describe('T-08562 keyless doors, reprovision, continuation, pi-sdk and joins', () => {
  it('aspd stopped: a Claude summons refuses before P with no op, runtime or lease', async () => {
    aspd.stop()
    const s = await seedInteractive()
    await expect(kickerSummons(s)).rejects.toThrow()
    expect(operations(s.hostSessionId)).toEqual([])
    expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toHaveLength(0)
    expect(ledger.commands).toHaveLength(0)
    expect(facadeCalls).toBe(0)
    aspd = startAspdDouble(join(scratch, 'aspd-unused.sock'), releaseA)
  })

  it('Claude reprovision stale-marks first; an aspd refusal then leaves no new operation, runtime or lease', async () => {
    const s = await session()
    const started = (await (
      await fixture.postJson('/v1/runtimes/start', {
        hostSessionId: s.hostSessionId,
        intent: driverIntent('claude-code-tmux'),
      })
    ).json()) as HrcRuntimeSnapshot
    const commandsBefore = ledger.commands.length
    aspd.stop()
    const response = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: s.hostSessionId,
      intent: driverIntent('claude-code-tmux'),
      restartStyle: 'fresh_pty',
    })
    expect(response.status).toBe(503)
    expect(internal().db.runtimes.getByRuntimeId(started.runtimeId)?.status).not.toBe('ready')
    expect(operations(s.hostSessionId)).toHaveLength(1)
    expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toHaveLength(1)
    expect(ledger.commands.length).toBe(commandsBefore)
    aspd = startAspdDouble(join(scratch, 'aspd-unused.sock'), releaseA)
  })

  it('continuation parity: a Claude session key reaches the aspd compile exactly as selected; Pi carries none', async () => {
    const s = await session()
    const key = '00000000-0000-4000-8000-000000008562'
    const withKey = { ...s, continuation: { provider: 'anthropic', kind: 'session', key } } as never
    await internal()
      .startInteractiveTmuxBrokerRuntime(withKey, driverIntent('claude-code-tmux'), 'run-cont', {
        flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
        allowedBrokerDriver: 'claude-code-tmux',
      })
      .catch(() => undefined)
    await internal()
      .startInteractiveTmuxBrokerRuntime(withKey, driverIntent('pi-tui-tmux'), 'run-cont-pi', {
        flagEnvName: 'HRC_PI_TUI_TMUX_BROKER_ENABLED',
        allowedBrokerDriver: 'pi-tui-tmux',
      })
      .catch(() => undefined)
    expect(JSON.stringify(aspd.compileContinuations[0])).toContain(key)
    expect(aspd.compileContinuations[1]).toBeUndefined()
    expect(aspd.compileAspHomes[0]).toBe(join(scratch, 'caller-asp-home'))
  })

  it('a pi-sdk raw intent reaches the producer and cannot select the frozen execution', async () => {
    const s = await session()
    const response = await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: MARK,
      runtimeIntent: piSdkIntent(),
      waitFor: 'accepted',
    })
    expect(response.status).toBeLessThan(300)
    await settle(() => ledger.startCalls.length === 1)
    const [op] = operations(s.hostSessionId)
    expect(op?.record.admission.execution.driver).toBe('claude-code-tmux')
    expect(aspd.compileCalls).toBe(1)
    expect(facadeCalls).toBe(0)
  })

  it('a forced pi-sdk preparation refused by the producer (release_worker_driver_unavailable) leaves no operation', async () => {
    aspd.compileFailureCode = 'release_worker_driver_unavailable'
    const s = await session()
    const error = await prepareAspdHeadlessAttempt(server as never, {
      session: s,
      intent: piSdkIntent(),
      runId: 'run-pisdk-forced',
      endpoint: aspdSocket,
    }).catch((e: unknown) => e)
    expect(JSON.stringify((error as { detail?: unknown }).detail)).toContain('compile-not-ok')
    expect(JSON.stringify((error as { detail?: unknown }).detail)).toContain(
      'release_worker_driver_unavailable'
    )
    expect((error as { detail?: Record<string, unknown> }).detail?.['rejectedBy']).toBe('producer')
    expect(operations(s.hostSessionId)).toEqual([])
    expect(ledger.commands).toHaveLength(0)
  })

  // T-08712: the installed ASP selects claude-code-tmux for a prompted Claude
  // start and carries the prompt on the launch, with no broker initialInput.
  it('a prompted Claude birth whose producer launch-carries the prompt is admitted and launched with it', async () => {
    aspd.launchCarriedInitialPrompt = true
    const s = await seedInteractive()
    await kickerSummons(s, 'T8712-FIRST')
    await settle(() => ledger.startCalls.length === 1)
    expect(ledger.startCalls).toHaveLength(1)
    expect(launchPrompt(ledger.startCalls[0]?.request)).toContain('T8712-FIRST')
    expect(initialInputText(ledger.startCalls[0]?.request)).toBeUndefined()
    const [op] = operations(s.hostSessionId)
    expect(op?.record.admission.execution.driver).toBe('claude-code-tmux')
    expect(op?.error_code).toBeNull()
  })

  it('a prompted Claude preparation (hrc start -p) with a launch-carried prompt freezes an operation', async () => {
    aspd.launchCarriedInitialPrompt = true
    const s = await session()
    const operationId = await prepareAspdHeadlessAttempt(server as never, {
      session: s,
      intent: { ...driverIntent('claude-code-tmux'), initialPrompt: 'T8712-START' },
      runId: 'run-t8712-start',
      endpoint: aspdSocket,
    })
    expect(typeof operationId).toBe('string')
    expect(operations(s.hostSessionId)).toHaveLength(1)
  })

  it('an HRC admission refusal of a successful compile names the field and logs one WARN', async () => {
    aspd.planIdentityOverride = { traceId: 'trace-forged' }
    const s = await session()
    const lines: string[] = []
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk))
      return true
    }) as never)
    let error: unknown
    try {
      error = await prepareAspdHeadlessAttempt(server as never, {
        session: s,
        intent: { ...driverIntent('claude-code-tmux'), initialPrompt: 'T8712-FORCED' },
        runId: 'run-t8712-forced',
        endpoint: aspdSocket,
      }).catch((e: unknown) => e)
    } finally {
      stderrSpy.mockRestore()
    }
    const detail = (error as { detail?: Record<string, any> }).detail ?? {}
    // The injector reads compile-not-ok as a definite pre-launch rejection.
    expect(detail['code']).toBe('compile-not-ok')
    expect(detail['rejectedBy']).toBe('hrc-admission')
    expect((error as Error).message).toContain('refused by HRC admission')
    expect(detail['admissionCode']).toBe('execution-identity-mismatch')
    expect(detail['diagnostics']).toEqual([
      expect.objectContaining({
        plane: 'hrc-admission',
        field: 'plan.identity.traceId',
        actual: 'trace-forged',
      }),
    ])
    expect(String(detail['diagnostics'][0].expected)).toStartWith('trace-')
    const warn = lines.filter(
      (line) =>
        line.includes('WARN aspd.preparation.admission_rejected') &&
        line.includes('run-t8712-forced')
    )
    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain('plan.identity.traceId')
    expect(warn[0]).toContain(aspd.serving.releaseId)
    expect(operations(s.hostSessionId)).toEqual([])
  })

  it('a DM crossing a Claude summons birth joins it: one aspd birth, each prompt delivered once', async () => {
    const s = await seedInteractive()
    const first = kickerSummons(s, 'T8562-FIRST')
    const second = internal().dispatchTurnForSession(s, s.lastAppliedIntentJson, 'T8562-SECOND', {
      waitForCompletion: false,
      submissionDoor: 'enqueue',
      joinInFlightRuntimeStart: true,
    })
    await Promise.all([first, second])
    await settle(() => delivered.length === 1)
    expect(aspd.compileCalls).toBe(1)
    expect(ledger.startCalls).toHaveLength(1)
    expect(launchPrompt(ledger.startCalls[0]?.request)).toBeUndefined()
    expect(initialInputText(ledger.startCalls[0]?.request)).toBe('T8562-FIRST')
    expect(delivered.map((d) => d.prompt)).toEqual(['T8562-SECOND'])
  })

  it('a participant-registered Claude scope refuses at the chokepoint before any aspd compile', async () => {
    const s = await seedInteractive()
    const registrations = internal().db.participantRegistrations
    const spy = spyOn(registrations, 'getRegistrationByScopeRef').mockImplementation(
      (scopeRef: string) =>
        (scopeRef === s.scopeRef ? { registrationId: 'reg-t8562' } : null) as never
    )
    try {
      await expect(
        internal().startInteractiveTmuxBrokerRuntime(
          s,
          driverIntent('claude-code-tmux'),
          'run-backstop',
          {
            flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
            allowedBrokerDriver: 'claude-code-tmux',
            coldBirthPrompt: MARK,
          }
        )
      ).rejects.toThrow('participant address')
    } finally {
      spy.mockRestore()
    }
    expect(aspd.compileCalls).toBe(0)
  })

  it('durable IPC off refuses a Claude birth before preparation', async () => {
    await server.stop()
    await bootServer({ durableIpc: false })
    const s = await seedInteractive()
    const error = await internal()
      .startInteractiveTmuxBrokerRuntime(s, driverIntent('claude-code-tmux'), 'run-ipc', {
        flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
        allowedBrokerDriver: 'claude-code-tmux',
      })
      .catch((e: unknown) => e)
    expect(JSON.stringify((error as { detail?: unknown }).detail)).toContain(
      'aspd_route_requires_durable_ipc'
    )
    expect(aspd.compileCalls).toBe(0)
  })
})
