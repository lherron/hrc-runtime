/**
 * T-08556 — `hrc run` on the aspd-prepared interactive Codex TUI
 * (docs/aspd-headless-codex-integration.md §1.4,
 * hrc-runtime.aspd-prepared-execution-release). Shares the T-08542 doubles.
 *
 * Real pieces: the attached-run door (`/v1/runs/prepare-attached` and
 * `/v1/runs/resume-attached`), the start and dispatch doors, the real
 * `HarnessBrokerController` with its attach-before-start gate, the real durable
 * interactive, headless and tmux-tui substrate allocators, and a Unix-socket
 * aspd double speaking the ASPC wire. Doubles: the tmux manager (records the
 * exact broker command) and the worker client, whose hello follows the release of
 * the executable actually launched. Input turns are OBSERVED, never delivered, so
 * the exactly-once property is a count of what reached the executors.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { AspcFacadeBrokerClient } from '../agent-spaces-adapter/aspc-facade-client'
import { aspdInteractiveBrokerEndpoint } from '../aspd-headless-start'
import {
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  createBrokerObserverPaneAllocator,
  createBrokerTmuxTuiAllocator,
} from '../broker-interactive-handlers/substrate-allocator'
import { HarnessBrokerController } from '../broker/controller'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { recordStartBirth } from '../presentation-operator'
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

const SCOPE = 'agent:t08556:project:hrc-runtime:task:T-08556'

let fixture: HrcServerTestFixture
let server: HrcServer
let scratch: string
let aspd: AspdDouble
let releaseA: Release
let ledger: HostingLedger
let facadeCalls: number
let facadeSpy: ReturnType<typeof spyOn>
let delivered: Array<{ transport: string; runtimeId: string; prompt: string }>
/** Lease releases per allocator, and a switch that makes the worker connect fail. */
let releases: string[]
let connectThrows: Error | undefined
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
}

function internal(): Internal {
  return server as unknown as Internal
}

function baseIntent(): HrcRuntimeIntent {
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

/** What `hrc run` sends: `buildManagedRunIntent`. */
function runIntent(): HrcRuntimeIntent {
  // The CLI sends no selection; the attached-door parser adds
  // `selection.presentation: true`. ASP's declared result still decides which
  // presentation lease is allocated.
  return baseIntent()
}

function terminalProducerResult() {
  return producerResult({
    selection: {
      harness: 'agent-harness',
      modelProvider: 'openai-codex',
      model: 'gpt-5.5',
      presentation: true,
    },
    execution: {
      recipeId: 'fixture-attached-terminal',
      driver: 'codex-app-server',
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

function headlessProducerResult(attachable: boolean) {
  return producerResult({
    selection: {
      harness: 'agent-harness',
      modelProvider: 'openai-codex',
      model: 'gpt-5.5',
      presentation: attachable,
    },
    execution: {
      recipeId: attachable ? 'fixture-headless-attachable' : 'fixture-headless-none',
      driver: 'codex-app-server',
      hosting: {
        executionTransport: 'jsonrpc-stdio',
        terminalRequired: false,
        processExecution: 'broker-process',
      },
      presentationFulfillment: 'attachable',
      ...(attachable
        ? {
            presentationSurface: {
              transport: 'websocket-unix' as const,
              terminalHost: 'tmux' as const,
            },
          }
        : {}),
    },
  })
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
  connectThrows = undefined
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
    brokerUnixClientFactory: async () => {
      if (connectThrows !== undefined) throw connectThrows
      return workerClient(ledger, [releaseA], ledger.commands.at(-1)) as never
    },
    tmuxAllocator: counted(
      'tmux',
      createBrokerDurableTmuxAllocator(internal().options, deps('attach-t08556-tui'))
    ),
    headlessSubstrateAllocator: counted(
      'headless',
      createBrokerDurableHeadlessAllocator(internal().options, deps('attach-t08556'))
    ),
    tmuxTuiAllocator: createBrokerTmuxTuiAllocator(internal().options, deps('attach-t08556-v')),
    observerPaneAllocator: createBrokerObserverPaneAllocator(
      internal().options,
      deps('attach-t08556-o')
    ),
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
  // The doubled substrates have no real tmux server; pane liveness is not under test.
  target['reconcileTmuxRuntimeLiveness'] = async (runtime: HrcRuntimeSnapshot) => runtime
  target['executeInteractiveBrokerInputTurn'] = record('tmux')
  target['executeHeadlessBrokerInputTurn'] = record('headless')
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08556-')
  scratch = await mkdtemp(join(tmpdir(), 't8556-'))
  releaseA = makeRelease(join(scratch, 'releases'), 'a')
  const aspdSocket = join(scratch, 'aspd.sock')
  aspd = startAspdDouble(aspdSocket, releaseA)
  aspd.producerResult = terminalProducerResult()
  setEnv('HRC_ASPD_SOCKET', aspdSocket)
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

type PrepareBody = {
  status: 'prepared' | 'started'
  pendingStartId?: string
  runtimeId?: string
  attach: { bindingFence: { runtimeId: string } }
}

/** The CLI's attached run: prepare, (attach), resume when prepared. */
async function attachedRun(
  hostSessionId: string,
  extra: { prompt?: string; restartStyle?: 'reuse_pty' | 'fresh_pty' } = {}
): Promise<{ prepared: PrepareBody; runtimeId: string }> {
  const response = await fixture.postJson('/v1/runs/prepare-attached', {
    hostSessionId,
    intent: runIntent(),
    ...extra,
  })
  const prepared = (await response.json()) as PrepareBody & { error?: unknown }
  if (response.status !== 200) {
    throw Object.assign(new Error('prepare-attached refused'), {
      status: response.status,
      body: prepared,
    })
  }
  if (prepared.status === 'prepared') {
    const resumed = await fixture.postJson('/v1/runs/resume-attached', {
      pendingStartId: prepared.pendingStartId,
    })
    expect(resumed.status).toBe(200)
  }
  return { prepared, runtimeId: prepared.attach.bindingFence.runtimeId }
}

async function refusedAttachedRun(hostSessionId: string, extra: { prompt?: string } = {}) {
  const response = await fixture.postJson('/v1/runs/prepare-attached', {
    hostSessionId,
    intent: runIntent(),
    ...extra,
  })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

function preparations(hostSessionId: string) {
  return internal()
    .db.sqlite.query<{ preparation_json: string | null }, [string]>(
      `SELECT preparation_json FROM runtime_operations
        WHERE host_session_id = ? AND preparation_json IS NOT NULL ORDER BY created_at ASC`
    )
    .all(hostSessionId)
    .map((row) => JSON.parse(row.preparation_json ?? '{}'))
}

function runtimes(hostSessionId: string) {
  return internal().db.runtimes.listByHostSessionId(hostSessionId)
}

async function startHeadless(hostSessionId: string, operator?: 'none' | 'tmux-tui') {
  const savedProducerResult = aspd.producerResult
  aspd.producerResult = headlessProducerResult(operator !== 'none')
  const intent = baseIntent()
  try {
    const response = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId,
      intent: operator ? { ...intent, presentation: { operator } } : intent,
    })
    expect(response.status).toBe(200)
    return (await response.json()) as HrcRuntimeSnapshot
  } finally {
    aspd.producerResult = savedProducerResult
  }
}

// ── Route key ─────────────────────────────────────────────────────────────────

describe('T-08556 route key', () => {
  it('the configured endpoint is generic; an unset socket selects none', () => {
    const env = { HRC_ASPD_SOCKET: '/tmp/aspd.sock' }
    for (const driver of ['codex-app-server', 'claude-code-tmux', 'pi-tui-tmux'] as const) {
      expect(aspdInteractiveBrokerEndpoint({ allowedBrokerDriver: driver }, env)).toBe(
        '/tmp/aspd.sock'
      )
      expect(aspdInteractiveBrokerEndpoint({ allowedBrokerDriver: driver }, {})).toBeUndefined()
    }
    expect(aspdInteractiveBrokerEndpoint({ allowedBrokerDriver: 'codex-cli-tmux' }, env)).toBe(
      '/tmp/aspd.sock'
    )
  })
})

// ── Cold birth ────────────────────────────────────────────────────────────────

describe('T-08556 attached-run cold birth', () => {
  it('the attached door always compiles with presentation=true, overriding profile/catalog defaults', async () => {
    const s = await session()
    await attachedRun(s.hostSessionId)
    expect(aspd.compileRequested.at(-1)).toMatchObject({ presentation: true })
  })

  it('the attached door overrides an explicit selection.presentation=false', async () => {
    const s = await session()
    const response = await fixture.postJson('/v1/runs/prepare-attached', {
      hostSessionId: s.hostSessionId,
      intent: { ...runIntent(), selection: { presentation: false } },
    })
    expect(response.status).toBe(200)
    expect(aspd.compileRequested.at(-1)).toMatchObject({ presentation: true })
  })

  it('prepares the producer-selected terminal execution and launches its frozen worker after attach', async () => {
    const s = await session()
    const { prepared, runtimeId } = await attachedRun(s.hostSessionId)

    expect(prepared.status).toBe('prepared')
    expect(facadeCalls).toBe(0)
    expect(aspd.compileCalls).toBe(1)
    const [record] = preparations(s.hostSessionId)
    expect(record.route).toBe('producer-selected-execution')
    expect(record.hosting.presentation).toBe('terminal')
    expect(record.hosting.argv).not.toContain('--experimental-observer-socket')
    expect(record.dispatch.routeDecision).toMatchObject({
      preparation: 'aspd',
      selectedBy: 'producer-selected-execution',
      aspHome: join(scratch, 'caller-asp-home'),
    })
    expect(record.admission.execution.dispatchRequest.startRequest.initialInput).toBeUndefined()
    // The broker window runs the frozen release executable, never the resolver.
    expect(ledger.commands).toHaveLength(1)
    expect(ledger.commands[0]).toContain(join(releaseA.releaseRoot, 'harness-broker'))
    expect(ledger.commands[0]).not.toContain('/nonexistent/')
    expect(ledger.startCalls).toHaveLength(1)

    const runtime = internal().db.runtimes.getByRuntimeId(runtimeId) as HrcRuntimeSnapshot
    expect(runtime.transport).toBe('tmux')
    const state = runtime.runtimeStateJson as Record<string, any>
    expect(state['executionRelease']).toMatchObject({ source: 'aspd' })
    expect(delivered).toHaveLength(0)
  })

  // T-08708 AC4: the live door reports the aspd connect, compile and HRC
  // admission it actually ran as their own rows, before the broker start whose
  // existing measurement is preserved (it spans the compile; nothing is split).
  it('reports the live aspd connect, compile and admission as sibling phases', async () => {
    const s = await session()
    const response = await fixture.postJson('/v1/runs/prepare-attached', {
      hostSessionId: s.hostSessionId,
      intent: runIntent(),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      pendingStartId: string
      diagnostics: {
        phases: Array<Record<string, any>>
        execution?: Record<string, unknown>
        releases: Record<string, unknown>
      }
    }
    // The admitted execution, as the compile froze it; never re-resolved.
    expect(body.diagnostics.execution).toMatchObject({
      recipeId: 'fixture-attached-terminal',
      driver: 'codex-app-server',
    })
    // The aspd that compiled and the execution release it admitted. The test
    // server is unmanaged (no release manifest), so no HRC release is claimed.
    expect(body.diagnostics.releases).toEqual({
      aspd: { releaseId: releaseA.releaseId, sourceCommit: releaseA.sourceCommit },
      execution: { releaseId: releaseA.releaseId, sourceCommit: releaseA.sourceCommit },
    })
    const phases = body.diagnostics.phases
    expect(phases.map((phase) => phase.id)).toEqual([
      'compile',
      'admission',
      'save-preparation',
      'broker-start',
      'broker-ready',
    ])
    const byId = (id: string) => phases.find((phase) => phase.id === id)!
    const compile = byId('compile')
    expect(compile).toMatchObject({ status: 'ok' })
    expect(compile.children.map((phase: { id: string }) => phase.id)).toEqual([
      'aspd-connect',
      'other',
    ])
    expect(byId('admission')).toMatchObject({ status: 'ok' })
    expect(byId('broker-start')).toMatchObject({ status: 'ok' })
    expect(byId('broker-start').children).toBeUndefined()
    for (const phase of [compile, byId('admission'), compile.children[0], byId('broker-start')]) {
      expect(typeof phase.ms).toBe('number')
    }
    const resumed = await fixture.postJson('/v1/runs/resume-attached', {
      pendingStartId: body.pendingStartId,
    })
    expect(resumed.status).toBe(200)
  })

  it('names the running HRC release only from its captured atomic manifest', async () => {
    const captured = (server as unknown as { capturedRelease: unknown }).capturedRelease
    Object.defineProperty(server, 'capturedRelease', {
      configurable: true,
      value: {
        mode: 'atomic',
        releaseId: 'hrc-t08708-release',
        hrcBuild: { sourceCommit: 'c'.repeat(40) },
      },
    })
    try {
      const s = await session()
      const { prepared } = await attachedRun(s.hostSessionId)
      expect(
        (prepared as unknown as { diagnostics: { releases: unknown } }).diagnostics.releases
      ).toMatchObject({
        hrc: { releaseId: 'hrc-t08708-release', sourceCommit: 'c'.repeat(40) },
        aspd: { releaseId: releaseA.releaseId },
      })
    } finally {
      Object.defineProperty(server, 'capturedRelease', { configurable: true, value: captured })
    }
  })

  it('an HRC admission refusal keeps the failing admission row and its duration', async () => {
    aspd.planIdentityOverride = { traceId: 'trace-forged' }
    const s = await session()
    const refused = await refusedAttachedRun(s.hostSessionId)
    expect(refused.status).toBe(503)
    const detail = refused.body.error.detail
    expect(detail.code).toBe('admission-rejected')
    expect(detail.failingPhase).toBe('admission')
    expect(
      detail.phases.map((phase: { id: string; status: string }) => [phase.id, phase.status])
    ).toEqual([
      ['compile', 'ok'],
      ['admission', 'error'],
      ['save-preparation', 'ok'],
      ['broker-start', 'error'],
      ['broker-ready', 'not-reached'],
    ])
    expect(typeof detail.phases[2].ms).toBe('number')
    expect(ledger.commands).toHaveLength(0)
  })

  it('-p is delivered exactly once, into the runtime the start produced, after it exists', async () => {
    const s = await session()
    const { runtimeId } = await attachedRun(s.hostSessionId, { prompt: 'MARK-once' })
    await Bun.sleep(20)
    expect(aspd.compileCalls).toBe(1)
    expect(delivered).toEqual([{ transport: 'tmux', runtimeId, prompt: 'MARK-once' }])
    expect(ledger.startCalls).toHaveLength(1)
    expect(
      preparations(s.hostSessionId)[0].admission.execution.dispatchRequest.startRequest.initialInput
    ).toBeUndefined()
  })

  it('aspd unavailable refuses before any hosting effect, with no facade fallback', async () => {
    aspd.stop()
    const s = await session()
    const refused = await refusedAttachedRun(s.hostSessionId)
    expect(refused.status).toBe(503)
    expect(JSON.stringify(refused.body)).toContain('aspd')
    expect(facadeCalls).toBe(0)
    expect(ledger.commands).toHaveLength(0)
    expect(runtimes(s.hostSessionId)).toHaveLength(0)
    aspd = startAspdDouble(join(scratch, 'aspd-unused.sock'), releaseA)
  })

  it('does not apply a local durable-interactive feature gate to a producer-selected result', async () => {
    await server.stop()
    await bootServer({ durableIpc: false })
    const s = await session()
    const started = await attachedRun(s.hostSessionId)
    expect(started.prepared.status).toBe('prepared')
    expect(aspd.compileCalls).toBe(1)
    expect(facadeCalls).toBe(0)
  })

  it('a non-attached door hosts the same producer-selected execution (facade not reached)', async () => {
    const s = await session()
    const runtime = await internal().startInteractiveTmuxBrokerRuntime(
      s,
      runIntent(),
      'run-cold-attach',
      {
        flagEnvName: 'HRC_CODEX_CLI_TMUX_BROKER_ENABLED',
        allowedBrokerDriver: 'codex-app-server',
      }
    )
    expect(facadeCalls).toBe(0)
    expect(aspd.compileCalls).toBe(1)
    const [record] = preparations(s.hostSessionId)
    expect(record.route).toBe('producer-selected-execution')
    expect(record.dispatch.routeDecision.door).toBe('interactive-birth')
    expect(runtime.transport).toBe('tmux')
  })

  it('a node without an aspd endpoint refuses the attached-run birth with aspd_unconfigured (T-08596)', async () => {
    setEnv('HRC_ASPD_SOCKET', undefined)
    const s = await session()
    const refused = await refusedAttachedRun(s.hostSessionId)
    expect(refused.status).toBeGreaterThanOrEqual(500)
    // T-08596: the pre-change facade path is deleted; nothing is spawned and
    // aspd is never consulted.
    expect(facadeCalls).toBe(0)
    expect(aspd.compileCalls).toBe(0)
    expect(JSON.stringify(refused.body)).toContain('aspd_unconfigured')
  })
})

// ── Established runtimes (rules 2–3) ──────────────────────────────────────────

describe('T-08556 attached run against an established runtime', () => {
  it('a live aspd interactive runtime is reused: no compile, same runtime, -p once', async () => {
    const s = await session()
    const first = await attachedRun(s.hostSessionId)
    const again = await attachedRun(s.hostSessionId, { prompt: 'warm' })
    await Bun.sleep(20)
    expect(again.prepared.status).toBe('started')
    expect(again.runtimeId).toBe(first.runtimeId)
    expect(aspd.compileCalls).toBe(1)
    expect(ledger.commands).toHaveLength(1)
    expect(delivered).toEqual([{ transport: 'tmux', runtimeId: first.runtimeId, prompt: 'warm' }])
  })

  it('a live app-server viewer is attached and receives -p headless, never replaced', async () => {
    const s = await session()
    const viewer = await startHeadless(s.hostSessionId)
    const compiles = aspd.compileCalls
    const before = runtimes(s.hostSessionId).map((r) => [r.runtimeId, r.status])

    const run = await attachedRun(s.hostSessionId, { prompt: 'into-viewer' })
    await Bun.sleep(20)
    expect(run.prepared.status).toBe('started')
    expect(run.runtimeId).toBe(viewer.runtimeId)
    expect(aspd.compileCalls).toBe(compiles)
    expect(runtimes(s.hostSessionId).map((r) => [r.runtimeId, r.status])).toEqual(before)
    expect(delivered).toEqual([
      { transport: 'headless', runtimeId: viewer.runtimeId, prompt: 'into-viewer' },
    ])
  })

  it('a live no-viewer runtime is refused presentation_conflict, untouched', async () => {
    const s = await session()
    await startHeadless(s.hostSessionId, 'none')
    const before = runtimes(s.hostSessionId).map((runtime) => runtime.runtimeId)
    const compiles = aspd.compileCalls

    const refused = await refusedAttachedRun(s.hostSessionId, { prompt: 'nope' })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({
      error: {
        code: 'stale_context',
        detail: {
          field: 'presentation',
          requested: true,
          realized: false,
          replacementRequired: true,
        },
      },
    })
    expect(runtimes(s.hostSessionId).map((runtime) => runtime.runtimeId)).toEqual(before)
    expect(aspd.compileCalls).toBe(compiles)
    expect(delivered).toHaveLength(0)
  })

  it('a transitional headless codex runtime is refused, untouched', async () => {
    const s = await session()
    const viewer = await startHeadless(s.hostSessionId)
    const invocationId = internal().db.runtimes.getByRuntimeId(viewer.runtimeId)
      ?.activeInvocationId as string
    expect(invocationId).toBeDefined()
    internal().db.brokerInvocations.update(invocationId, {
      invocationState: 'stopping',
      updatedAt: new Date().toISOString(),
    })
    const before = runtimes(s.hostSessionId).map((runtime) => runtime.runtimeId)

    const refused = await refusedAttachedRun(s.hostSessionId)
    expect(refused.status).toBe(503)
    expect(JSON.stringify(refused.body)).toContain('attached_run_runtime_transitional')
    expect(runtimes(s.hostSessionId).map((runtime) => runtime.runtimeId)).toEqual(before)
  })

  it('a realized attachable runtime is reused despite historical harness fields', async () => {
    const s = await session()
    const viewer = await startHeadless(s.hostSessionId)
    internal().db.sqlite.run(`UPDATE runtimes SET harness = 'agent-harness' WHERE runtime_id = ?`, [
      viewer.runtimeId,
    ])
    const before = runtimes(s.hostSessionId).map((runtime) => runtime.runtimeId)

    const attached = await attachedRun(s.hostSessionId)
    expect(attached.runtimeId).toBe(viewer.runtimeId)
    expect(runtimes(s.hostSessionId).map((runtime) => runtime.runtimeId)).toEqual(before)
  })
})

// ── Crossing starts (F1) ──────────────────────────────────────────────────────

describe('T-08556 attached run crossing a registered start', () => {
  it('a start in flight is joined, never duplicated, with and without -p', async () => {
    const s = await session()
    for (const prompt of [undefined, 'crossing']) {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      // An ordinary `hrc start` birth of the default viewer, held open.
      const heldStart = (async () => {
        await gate
        return await startHeadless(s.hostSessionId)
      })()
      internal().runtimeStartOperations.set(s.hostSessionId, heldStart)

      const commandsBefore = ledger.commands.length
      const compilesBefore = aspd.compileCalls
      const run = attachedRun(s.hostSessionId, prompt ? { prompt } : {})
      await Bun.sleep(20)
      // The door waits on the registered start: no preparation, no hosting effect.
      expect(ledger.commands).toHaveLength(commandsBefore)
      expect(aspd.compileCalls).toBe(compilesBefore)
      internal().runtimeStartOperations.delete(s.hostSessionId)
      release()
      const joined = await heldStart
      const result = await run
      await Bun.sleep(20)

      expect(result.runtimeId).toBe(joined.runtimeId)
      expect(result.prepared.status).toBe('started')
      expect(
        preparations(s.hostSessionId).filter((p) => p.route === 'producer-selected-execution')
      ).toHaveLength(1)
      const live = runtimes(s.hostSessionId).filter(
        (r) => r.status !== 'terminated' && r.status !== 'stale'
      )
      expect(live.filter((r) => r.transport === 'tmux')).toHaveLength(0)
    }
    expect(delivered.map((d) => d.prompt)).toEqual(['crossing'])
  })

  it('a joined no-viewer birth is refused, never replaced', async () => {
    const s = await session()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const heldStart = (async () => {
      await gate
      return await startHeadless(s.hostSessionId, 'none')
    })()
    internal().runtimeStartOperations.set(s.hostSessionId, heldStart)
    const run = refusedAttachedRun(s.hostSessionId, { prompt: 'nope' })
    await Bun.sleep(20)
    internal().runtimeStartOperations.delete(s.hostSessionId)
    release()
    await heldStart
    const refused = await run
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({
      error: {
        code: 'stale_context',
        detail: {
          field: 'presentation',
          requested: true,
          realized: false,
          replacementRequired: true,
        },
      },
    })
    expect(runtimes(s.hostSessionId).filter((r) => r.transport === 'tmux')).toHaveLength(0)
    expect(delivered).toHaveLength(0)
  })

  it('a dispatch crossing the door birth joins it rather than starting another runtime', async () => {
    const s = await session()
    const prepare = await fixture.postJson('/v1/runs/prepare-attached', {
      hostSessionId: s.hostSessionId,
      intent: runIntent(),
    })
    const prepared = (await prepare.json()) as PrepareBody
    expect(prepared.status).toBe('prepared')
    const inFlight = internal().runtimeStartOperations.get(s.hostSessionId)
    expect(inFlight).toBeDefined()

    const crossing = fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: 'crossing-dispatch',
      runtimeIntent: runIntent(),
      waitFor: 'accepted',
    })
    await Bun.sleep(20)
    const resumed = await fixture.postJson('/v1/runs/resume-attached', {
      pendingStartId: prepared.pendingStartId,
    })
    expect(resumed.status).toBe(200)
    expect((await crossing).status).toBeLessThan(300)
    await Bun.sleep(20)

    expect(aspd.compileCalls).toBe(1)
    expect(ledger.commands).toHaveLength(1)
    expect(facadeCalls).toBe(0)
    expect(delivered).toEqual([
      {
        transport: 'headless',
        runtimeId: prepared.runtimeId as string,
        prompt: 'crossing-dispatch',
      },
    ])
  })

  it('a foreign recorded birth refuses at once, without awaiting its boot (F3)', async () => {
    const s = await session()
    const never = new Promise<HrcRuntimeSnapshot>(() => undefined)
    recordStartBirth(never, { transport: 'tmux', provider: 'anthropic', harness: 'claude-code' })
    internal().runtimeStartOperations.set(s.hostSessionId, never)
    const refused = await refusedAttachedRun(s.hostSessionId, { prompt: 'nope' })
    internal().runtimeStartOperations.delete(s.hostSessionId)
    expect(refused.status).toBe(503)
    expect(JSON.stringify(refused.body)).toContain('start_in_flight_harness_mismatch')
    expect(aspd.compileCalls).toBe(0)
    expect(delivered).toHaveLength(0)
  })

  it('a joined tmux newborn is joined only when interactive admission reuses it (F3)', async () => {
    const s = await session()
    const born = await attachedRun(s.hostSessionId)
    const newborn = internal().db.runtimes.getByRuntimeId(born.runtimeId) as HrcRuntimeSnapshot
    internal().db.brokerInvocations.update(newborn.activeInvocationId as string, {
      invocationState: 'stopping',
      updatedAt: new Date().toISOString(),
    })
    const held = Promise.resolve(newborn)
    recordStartBirth(held, { transport: 'tmux', provider: 'openai', harness: 'codex-cli' })
    internal().runtimeStartOperations.set(s.hostSessionId, held)
    const compiles = aspd.compileCalls
    const refused = await refusedAttachedRun(s.hostSessionId, { prompt: 'nope' })
    internal().runtimeStartOperations.delete(s.hostSessionId)

    expect(refused.status).toBe(503)
    expect(JSON.stringify(refused.body)).toContain('attached_run_runtime_transitional')
    expect(aspd.compileCalls).toBe(compiles)
    expect(internal().db.runtimes.getByRuntimeId(born.runtimeId)?.status).toBe(newborn.status)
    expect(delivered).toHaveLength(0)
  })
})

describe('T-08556 prompt fenced to the selected runtime (F4)', () => {
  it('-p reaches the selected runtime by identity even if the session moves before delivery', async () => {
    const s = await session()
    const first = await attachedRun(s.hostSessionId)
    // Between selection and delivery, an unregistered door stale-marks the
    // selected runtime and a newer tmux runtime appears for the session.
    const target = server as unknown as Record<string, any>
    const publish = target['publishPresentation'].bind(server)
    target['publishPresentation'] = async (runtime: HrcRuntimeSnapshot, opts: unknown) => {
      if (runtime.runtimeId === first.runtimeId) {
        const now = new Date(Date.now() + 1000).toISOString()
        internal().db.runtimes.insert({
          ...(internal().db.runtimes.getByRuntimeId(first.runtimeId) as HrcRuntimeSnapshot),
          runtimeId: 'rt-t08556-interloper',
          activeInvocationId: undefined,
          createdAt: now,
          updatedAt: now,
        } as never)
      }
      return await publish(runtime, opts)
    }
    await attachedRun(s.hostSessionId, { prompt: 'fenced' })
    await Bun.sleep(20)
    expect(delivered).toEqual([{ transport: 'tmux', runtimeId: first.runtimeId, prompt: 'fenced' }])
  })
})

// ── G1: a never-started lease is released; a started one never is ────────────

describe('T-08556 G1 never-started lease cleanup', () => {
  function operationOf(hostSessionId: string) {
    return internal()
      .db.sqlite.query<
        { status: string; error_code: string | null; runtime_id: string; preparation_json: string },
        [string]
      >(
        `SELECT status, error_code, runtime_id, preparation_json FROM runtime_operations
          WHERE host_session_id = ? AND preparation_json IS NOT NULL ORDER BY created_at DESC LIMIT 1`
      )
      .get(hostSessionId)
  }

  it('a cancelled attach releases the lease it realized; nothing was started', async () => {
    const s = await session()
    const response = await fixture.postJson('/v1/runs/prepare-attached', {
      hostSessionId: s.hostSessionId,
      intent: runIntent(),
    })
    const prepared = (await response.json()) as PrepareBody
    expect(prepared.status).toBe('prepared')
    expect(releases).toEqual([])

    // What the resume deadline does when the CLI never resumes.
    internal().harnessBrokerController?.cancelAttachedStart(
      prepared.pendingStartId as string,
      'attached run resume deadline expired'
    )
    for (let i = 0; i < 50 && releases.length === 0; i++) await Bun.sleep(10)

    expect(releases).toEqual(['tmux'])
    expect(ledger.startCalls).toHaveLength(0)
    // The release killed this runtime's lease server (the fixture persists no run
    // row for a no-prompt start, so row settlement is proven by the live rig).
    const op = operationOf(s.hostSessionId)
    const leaseKey = (op?.runtime_id as string).slice(3, 11)
    expect(ledger.killedServers.some((sock) => sock.includes(leaseKey))).toBe(true)
  })

  it('a pre-start failure after allocation releases the lease', async () => {
    const s = await session()
    connectThrows = new Error('worker socket never came up')
    const refused = await refusedAttachedRun(s.hostSessionId)
    expect(refused.status).toBeGreaterThanOrEqual(500)
    expect(ledger.commands).toHaveLength(1)
    expect(releases).toEqual(['tmux'])
    expect(ledger.startCalls).toHaveLength(0)
  })

  it('a start whose invocation.start was sent is never released, and stays uncertain', async () => {
    const s = await session()
    ledger.startThrows = new Error('lost start reply')
    const response = await fixture.postJson('/v1/runs/prepare-attached', {
      hostSessionId: s.hostSessionId,
      intent: runIntent(),
    })
    const prepared = (await response.json()) as PrepareBody
    expect(prepared.status).toBe('prepared')
    await fixture.postJson('/v1/runs/resume-attached', { pendingStartId: prepared.pendingStartId })
    for (let i = 0; i < 50 && operationOf(s.hostSessionId)?.status !== 'failed'; i++)
      await Bun.sleep(10)

    expect(ledger.startCalls).toHaveLength(1)
    expect(releases).toEqual([])
    const op = operationOf(s.hostSessionId)
    expect(JSON.parse(op?.preparation_json as string).startOutcome).toBe('uncertain')
  })

  it('a launch that lost its frozen operation to another launch never releases that lease', async () => {
    const s = await session()
    // After launch validation and before the start graph, another launch of the
    // same frozen attempt commits it: this lease path now belongs to that launch.
    ledger.onFirstHostingEffect = () => {
      const row = internal()
        .db.sqlite.query<{ operation_id: string }, [string]>(
          `SELECT operation_id FROM runtime_operations WHERE host_session_id = ? AND status = 'prepared'`
        )
        .get(s.hostSessionId)
      internal().db.runtimeOperations.update(row?.operation_id as string, {
        status: 'starting',
        updatedAt: new Date().toISOString(),
      })
    }
    const refused = await refusedAttachedRun(s.hostSessionId)
    expect(refused.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(refused.body)).toContain('aspd_preparation_not_prepared')
    expect(releases).toEqual([])
    expect(ledger.startCalls).toHaveLength(0)
  })
})
