/**
 * T-08560 — every interactive Codex birth through aspd
 * (docs/aspd-headless-codex-integration.md §1.5, D1–D4;
 * hrc-runtime.aspd-prepared-execution-release, hrc-runtime.asp-toolchain-selection).
 *
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
  startAspdDouble,
  tmuxManagerDouble,
  workerClient,
} from './fixtures/aspd-route-doubles'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE = 'agent:t08560:project:hrc-runtime:task:T-08560'
const MARK = 'T8560-MARK reply with exactly this marker'

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
      createBrokerDurableTmuxAllocator(internal().options, deps('attach-t08560-tui'))
    ),
    headlessSubstrateAllocator: counted(
      'headless',
      createBrokerDurableHeadlessAllocator(internal().options, deps('attach-t08560'))
    ),
    tmuxTuiAllocator: createBrokerTmuxTuiAllocator(internal().options, deps('attach-t08560-v')),
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
  fixture = await createHrcTestFixture('hrc-t08560-')
  scratch = await mkdtemp(join(tmpdir(), 't8560-'))
  releaseA = makeRelease(join(scratch, 'releases'), 'a')
  aspdSocket = join(scratch, 'aspd.sock')
  aspd = startAspdDouble(aspdSocket, releaseA)
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

async function seedInteractive(scope = SCOPE): Promise<HrcSessionRecord> {
  const s = await session(scope)
  internal().db.sessions.updateIntent(
    s.hostSessionId,
    interactiveIntent(),
    new Date().toISOString()
  )
  return internal().db.sessions.getByHostSessionId(s.hostSessionId) as HrcSessionRecord
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
    submissionOrigin: { principalRef: 'agent:mable', envelopeId: 'EN-T8560' },
    launchPromptOnColdBirth: true,
  })
}

// ── G-route + G-D1 ────────────────────────────────────────────────────────────

describe('T-08560 launch-carried cold-birth prompt (D1)', () => {
  it('mail summons: replace-priming prompt frozen once in the start request, never persisted or resubmitted', async () => {
    const s = await seedInteractive()
    const response = await kickerSummons(s)
    expect(response.status).toBe(200)
    await settle(() => ledger.startCalls.length === 1)

    expect(facadeCalls).toBe(0)
    expect(aspd.compileCalls).toBe(1)
    expect(aspd.compileMaterializations[0]).toMatchObject({
      initialPrompt: MARK,
      omitPriming: true,
    })
    const [op] = operations(s.hostSessionId)
    expect(op?.record.route).toBe('interactive-codex-tui')
    expect(op?.record.dispatch.routeDecision).toMatchObject({
      door: 'interactive-birth',
      launchCarriedPrompt: { mode: 'replace-priming' },
      preparation: 'aspd',
    })
    // Frozen exactly once, in the start request only.
    expect(initialInputText(op?.record.admission.startRequest)).toBe(MARK)
    expect(JSON.stringify(op?.record.intent)).not.toContain('T8560-MARK')
    expect(storedIntentJson(s.hostSessionId)).not.toContain('T8560-MARK')
    // Delivered only through invocation.start, never by the post-boot executor.
    expect(ledger.startCalls).toHaveLength(1)
    expect(initialInputText(ledger.startCalls[0]?.request)).toBe(MARK)
    await Bun.sleep(30)
    expect(delivered).toEqual([])
    // B4 provenance: the run carries the compiled initial input identity.
    const run = internal().db.runs.getByRunId(op?.run_id as string)
    const inputId = op?.record.admission.startRequest.initialInput.inputId
    expect(run?.dispatchedInputId).toBe(inputId)
    expect(run?.brokerSubmissionId).toBe(inputId)
  })

  it('POST /v1/turns: append-to-priming, key frozen, applied intent prompt-free', async () => {
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
    expect(op?.record.dispatch.routeDecision.launchCarriedPrompt).toEqual({
      mode: 'append-to-priming',
    })
    expect(op?.record.dispatchIdempotencyKey).toBe('k-turns')
    expect(initialInputText(ledger.startCalls[0]?.request)).toBe(MARK)
    expect(storedIntentJson(s.hostSessionId)).not.toContain('T8560-MARK')
    await Bun.sleep(30)
    expect(delivered).toEqual([])
  })

  it('submission door enqueue: answers with the launch submission identity, body never submitted again', async () => {
    const s = await seedInteractive()
    const response = await fixture.postJson('/v1/submissions/enqueue', {
      target: s.hostSessionId,
      body: MARK,
      origin: { principalRef: 'agent:mable' },
    })
    expect(response.status).toBeLessThan(300)
    const body = (await response.json()) as { submissionId?: string; admission?: string }
    const [op] = operations(s.hostSessionId)
    expect(op?.record.dispatch.routeDecision).toMatchObject({
      door: 'interactive-birth',
      launchCarriedPrompt: { mode: 'append-to-priming' },
    })
    expect(body.submissionId).toBe(op?.record.admission.startRequest.initialInput.inputId)
    expect(ledger.startCalls).toHaveLength(1)
    expect(delivered).toEqual([])
    expect(facadeCalls).toBe(0)
  })

  it('DM options (enqueue, joinInFlightRuntimeStart): append-to-priming on the aspd route', async () => {
    const s = await seedInteractive()
    await internal().dispatchTurnForSession(s, s.lastAppliedIntentJson, MARK, {
      waitForCompletion: false,
      submissionDoor: 'enqueue',
      joinInFlightRuntimeStart: true,
    })
    await settle(() => ledger.startCalls.length === 1)
    const [op] = operations(s.hostSessionId)
    expect(op?.record.dispatch.routeDecision.launchCarriedPrompt).toEqual({
      mode: 'append-to-priming',
    })
    expect(initialInputText(ledger.startCalls[0]?.request)).toBe(MARK)
    await Bun.sleep(30)
    expect(delivered).toEqual([])
  })

  it('selector message (no door): bare aspd birth, prompt delivered once after boot by runtime identity', async () => {
    const s = await seedInteractive()
    await internal().dispatchTurnForSession(s, s.lastAppliedIntentJson, MARK, {
      waitForCompletion: false,
    })
    await settle(() => delivered.length === 1)
    const [op] = operations(s.hostSessionId)
    expect(op?.record.dispatch.routeDecision.door).toBe('interactive-birth')
    expect(op?.record.dispatch.routeDecision.launchCarriedPrompt).toBeUndefined()
    expect(op?.record.admission.startRequest.initialInput).toBeUndefined()
    expect(aspd.compileMaterializations[0]?.initialPrompt).toBeUndefined()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.prompt).toBe(MARK)
    expect(facadeCalls).toBe(0)
  })

  it('a refusal before boundary P reports nothing launch-carried and delivers nothing', async () => {
    aspd.stop()
    const s = await seedInteractive()
    await expect(
      (async () => {
        const response = await internal().dispatchTurnForSession(s, s.lastAppliedIntentJson, MARK, {
          waitForCompletion: true,
          submissionDoor: 'invoke',
          launchPromptOnColdBirth: true,
        })
        if (response.status >= 400) throw new Error(`refused ${response.status}`)
      })()
    ).rejects.toThrow()
    await Bun.sleep(30)
    expect(operations(s.hostSessionId)).toEqual([])
    expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toHaveLength(0)
    expect(ledger.commands).toHaveLength(0)
    expect(delivered).toEqual([])
    expect(facadeCalls).toBe(0)
    aspd = startAspdDouble(join(scratch, 'aspd-unused.sock'), releaseA)
  })
})

// ── G-route: bare doors ───────────────────────────────────────────────────────

describe('T-08560 bare interactive birth doors (G-route)', () => {
  it('explicit interactive POST /v1/runtimes/start prepares through aspd, door interactive-birth', async () => {
    const s = await session()
    const response = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: s.hostSessionId,
      intent: interactiveIntent(),
    })
    expect(response.status).toBe(200)
    const [op] = operations(s.hostSessionId)
    expect(op?.record.route).toBe('interactive-codex-tui')
    expect(op?.record.dispatch.routeDecision.door).toBe('interactive-birth')
    expect(op?.record.dispatch.routeDecision.launchCarriedPrompt).toBeUndefined()
    expect(ledger.commands[0]).toContain(join(releaseA.releaseRoot, 'harness-broker'))
    expect(facadeCalls).toBe(0)
  })

  it('POST /v1/runtimes/ensure prepares through aspd and stays unregistered in the start singleflight', async () => {
    const s = await session()
    const registrations: string[] = []
    const map = internal().runtimeStartOperations
    const set = map.set.bind(map)
    map.set = (key: string, value: Promise<HrcRuntimeSnapshot>) => {
      registrations.push(key)
      return set(key, value)
    }
    const response = await fixture.postJson('/v1/runtimes/ensure', {
      hostSessionId: s.hostSessionId,
      intent: interactiveIntent(),
    })
    map.set = set
    expect(response.status).toBe(200)
    expect(registrations).toEqual([])
    const [op] = operations(s.hostSessionId)
    expect(op?.record.dispatch.routeDecision.door).toBe('interactive-birth')
    expect(facadeCalls).toBe(0)
  })

  it('rotation relaunch births the successor session through aspd', async () => {
    const s = await seedInteractive()
    const rotated = await internal().rotateSessionContext(s, { relaunch: true, reason: 't8560' })
    const [op] = operations(rotated.hostSessionId)
    expect(op?.record.route).toBe('interactive-codex-tui')
    expect(op?.record.dispatch.routeDecision.door).toBe('interactive-birth')
    expect(facadeCalls).toBe(0)
  })

  it('attach reprovision of an unavailable runtime rebirths through aspd', async () => {
    const s = await session()
    const started = (await (
      await fixture.postJson('/v1/runtimes/start', {
        hostSessionId: s.hostSessionId,
        intent: interactiveIntent(),
      })
    ).json()) as HrcRuntimeSnapshot
    internal().db.runtimes.update(started.runtimeId, {
      status: 'terminated',
      updatedAt: new Date().toISOString(),
    })
    await fixture.postJson('/v1/runtimes/attach', { runtimeId: started.runtimeId })
    const ops = operations(s.hostSessionId)
    expect(ops).toHaveLength(2)
    expect(ops[1]?.record.dispatch.routeDecision.door).toBe('interactive-birth')
    expect(facadeCalls).toBe(0)
  })

  // T-08562 (§1.6.2): claude-code-tmux and pi-tui-tmux now prepare through aspd
  // (their success paths are T-08562's gates). T-08596: codex-cli-tmux and an
  // unset socket refuse with aspd_unconfigured; the facade is deleted.
  it('claude-code-tmux prepares through aspd on a configured node; codex-cli-tmux and an unset socket refuse with aspd_unconfigured (G-route negative)', async () => {
    const s = await session()
    await expect(
      internal().startInteractiveTmuxBrokerRuntime(s, interactiveIntent(), 'run-claude', {
        flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
        allowedBrokerDriver: 'claude-code-tmux',
        coldBirthPrompt: MARK,
      })
    ).rejects.toThrow()
    expect(aspd.compileCalls).toBe(1)
    expect(facadeCalls).toBe(0)
    await expect(
      internal().startInteractiveTmuxBrokerRuntime(s, interactiveIntent(), 'run-cli-tmux', {
        flagEnvName: 'HRC_CODEX_CLI_TMUX_BROKER_ENABLED',
        allowedBrokerDriver: 'codex-cli-tmux',
        coldBirthPrompt: MARK,
      })
    ).rejects.toThrow('aspd-independent execution closure')
    setEnv('HRC_ASPD_SOCKET', undefined)
    await expect(
      internal().startInteractiveTmuxBrokerRuntime(s, interactiveIntent(), 'run-unset', {
        flagEnvName: 'HRC_CODEX_CLI_TMUX_BROKER_ENABLED',
        allowedBrokerDriver: 'codex-app-server',
        coldBirthPrompt: MARK,
      })
    ).rejects.toThrow('aspd-independent execution closure')
    expect(facadeCalls).toBe(0)
    expect(aspd.compileCalls).toBe(1)
  })
})

// ── G-D2 ──────────────────────────────────────────────────────────────────────

describe('T-08560 keyed resume and route fence (D2)', () => {
  it('a same-key retry resumes the frozen interactive preparation without re-preparing, prompt once', async () => {
    const s = await seedInteractive()
    ledger.helloReleaseOverride = null
    const first = await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: MARK,
      idempotencyKey: 'k-resume',
      waitFor: 'accepted',
    })
    expect(first.status).toBeGreaterThanOrEqual(500)
    const [prepared] = operations(s.hostSessionId)
    expect(prepared?.status).toBe('prepared')
    expect(prepared?.error_code).toBe('worker_release_unidentified')
    expect(ledger.startCalls).toHaveLength(0)
    // The realized lease was released (hello refusal and the G1 start exit).
    expect(releases.length).toBeGreaterThan(0)
    expect(releases.every((name) => name === 'tmux')).toBe(true)

    ledger.helloReleaseOverride = undefined
    const retry = await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: 'a different retry body',
      idempotencyKey: 'k-resume',
      waitFor: 'accepted',
    })
    expect(retry.status).toBeLessThan(300)
    await settle(() => ledger.startCalls.length === 1)
    expect(aspd.compileCalls).toBe(1)
    const ops = operations(s.hostSessionId)
    expect(ops).toHaveLength(1)
    expect(ops[0]?.status).not.toBe('prepared')
    expect(initialInputText(ledger.startCalls[0]?.request)).toBe(MARK)
    await Bun.sleep(30)
    expect(delivered).toEqual([])
  })

  it('a frozen interactive preparation is never launched by a headless retry: aspd_preparation_route_changed', async () => {
    const s = await seedInteractive()
    ledger.helloReleaseOverride = null
    await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: MARK,
      idempotencyKey: 'k-fence',
      waitFor: 'accepted',
    })
    const [prepared] = operations(s.hostSessionId)
    expect(prepared?.record.route).toBe('interactive-codex-tui')
    ledger.helloReleaseOverride = undefined

    const retry = await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: MARK,
      idempotencyKey: 'k-fence',
      runtimeIntent: headlessIntent(),
      waitFor: 'accepted',
    })
    expect(retry.status).toBe(503)
    expect(JSON.stringify(await retry.json())).toContain('aspd_preparation_route_changed')
    const ops = operations(s.hostSessionId)
    expect(ops).toHaveLength(1)
    expect(ops[0]?.status).toBe('prepared')
    expect(ledger.startCalls).toHaveLength(0)
    expect(aspd.compileCalls).toBe(1)
  })

  it('a frozen headless preparation is never launched by an interactive retry: aspd_preparation_route_changed', async () => {
    const s = await session()
    ledger.helloReleaseOverride = null
    await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: MARK,
      idempotencyKey: 'k-fence-h',
      runtimeIntent: headlessIntent(),
      waitFor: 'accepted',
    })
    const [prepared] = operations(s.hostSessionId)
    expect(prepared?.record.route).toBe('headless-codex-app-server')
    expect(prepared?.status).toBe('prepared')
    ledger.helloReleaseOverride = undefined

    const retry = await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: MARK,
      idempotencyKey: 'k-fence-h',
      runtimeIntent: interactiveIntent(),
      waitFor: 'accepted',
    })
    expect(retry.status).toBe(503)
    expect(JSON.stringify(await retry.json())).toContain('aspd_preparation_route_changed')
    expect(operations(s.hostSessionId)[0]?.status).toBe('prepared')
    expect(ledger.startCalls).toHaveLength(0)
  })
})

// ── G-D3 / G-D4 ───────────────────────────────────────────────────────────────

describe('T-08560 keyless doors and reprovision ordering (D3, D4)', () => {
  it('a keyless summons refused after boundary P stays prepared and is never auto-launched, even across a restart', async () => {
    const s = await seedInteractive()
    ledger.helloReleaseOverride = null
    await kickerSummons(s).catch(() => undefined)
    await settle(() => operations(s.hostSessionId)[0]?.error_code !== null)
    const [op] = operations(s.hostSessionId)
    expect(op?.status).toBe('prepared')
    expect(op?.error_code).toBe('worker_release_unidentified')
    expect(op?.record.dispatchIdempotencyKey).toBeUndefined()
    ledger.helloReleaseOverride = undefined

    await server.stop()
    await bootServer()
    await Bun.sleep(50)
    expect(operations(s.hostSessionId)[0]?.status).toBe('prepared')
    expect(ledger.startCalls).toHaveLength(0)
  })

  it('reprovision stale-marks first; an aspd refusal then leaves no operation, runtime or lease', async () => {
    const s = await session()
    const started = (await (
      await fixture.postJson('/v1/runtimes/start', {
        hostSessionId: s.hostSessionId,
        intent: interactiveIntent(),
      })
    ).json()) as HrcRuntimeSnapshot
    const commandsBefore = ledger.commands.length
    aspd.stop()
    const response = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: s.hostSessionId,
      intent: interactiveIntent(),
      restartStyle: 'fresh_pty',
    })
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).toContain('aspd')
    const old = internal().db.runtimes.getByRuntimeId(started.runtimeId)
    expect(old?.status).not.toBe('ready')
    expect(operations(s.hostSessionId)).toHaveLength(1)
    expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toHaveLength(1)
    expect(ledger.commands.length).toBe(commandsBefore)
    expect(facadeCalls).toBe(0)
    aspd = startAspdDouble(join(scratch, 'aspd-unused.sock'), releaseA)
  })
})

// ── G-join, G-backstop, G-ipc ─────────────────────────────────────────────────

describe('T-08560 joins, backstop and durable IPC on the aspd route', () => {
  // A crossing INVOKE would wait for the launch turn's terminal (T-08012), which
  // the worker double never emits; a crossing DM joins the boot directly.
  it('a DM crossing a summons birth joins it: one aspd birth, each prompt delivered once (T-07693/T-07202)', async () => {
    const s = await seedInteractive()
    const first = kickerSummons(s, 'T8560-FIRST')
    const second = internal().dispatchTurnForSession(s, s.lastAppliedIntentJson, 'T8560-SECOND', {
      waitForCompletion: false,
      submissionDoor: 'enqueue',
      joinInFlightRuntimeStart: true,
    })
    await Promise.all([first, second])
    await settle(() => delivered.length === 1)
    expect(aspd.compileCalls).toBe(1)
    expect(operations(s.hostSessionId)).toHaveLength(1)
    expect(ledger.startCalls).toHaveLength(1)
    expect(initialInputText(ledger.startCalls[0]?.request)).toBe('T8560-FIRST')
    expect(delivered.map((d) => d.prompt)).toEqual(['T8560-SECOND'])
  })

  it('a participant-registered scope refuses at the chokepoint before any aspd compile', async () => {
    const s = await seedInteractive()
    const registrations = internal().db.participantRegistrations
    const spy = spyOn(registrations, 'getRegistrationByScopeRef').mockImplementation(
      (scopeRef: string) =>
        (scopeRef === s.scopeRef ? { registrationId: 'reg-t8560' } : null) as never
    )
    try {
      await expect(
        internal().startInteractiveTmuxBrokerRuntime(s, interactiveIntent(), 'run-backstop', {
          flagEnvName: 'HRC_CODEX_CLI_TMUX_BROKER_ENABLED',
          allowedBrokerDriver: 'codex-app-server',
          coldBirthPrompt: MARK,
        })
      ).rejects.toThrow('participant address')
      const ensured = await fixture.postJson('/v1/runtimes/ensure', {
        hostSessionId: s.hostSessionId,
        intent: interactiveIntent(),
      })
      expect(ensured.status).toBe(503)
    } finally {
      spy.mockRestore()
    }
    expect(aspd.compileCalls).toBe(0)
    expect(facadeCalls).toBe(0)
  })

  it('durable IPC off refuses every Codex interactive birth door before preparation', async () => {
    await server.stop()
    await bootServer({ durableIpc: false })
    const s = await seedInteractive()
    await expect(kickerSummons(s)).rejects.toThrow()
    const started = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: s.hostSessionId,
      intent: interactiveIntent(),
    })
    expect(started.status).toBe(503)
    expect(JSON.stringify(await started.json())).toContain('aspd_route_requires_durable_ipc')
    expect(aspd.compileCalls).toBe(0)
    expect(facadeCalls).toBe(0)
  })
})
