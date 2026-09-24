/** T-08555 — producer-selected execution at start and dispatch doors. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

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

const SCOPE = 'agent:t08555:project:hrc-runtime:task:T-08555'
let fixture: HrcServerTestFixture
let server: HrcServer
let scratch: string
let aspd: AspdDouble
let releaseA: Release
let ledger: HostingLedger
let observedReuse: string[]
let callerAspHome: string
const savedEnv: Record<string, string | undefined> = {}

type Internal = {
  db: HrcDatabase
  options: { runtimeRoot: string }
  harnessBrokerController?: HarnessBrokerController
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
function interactiveIntent(): HrcRuntimeIntent {
  const base = headlessIntent()
  return {
    ...base,
    harness: { ...base.harness, interactive: true },
    execution: { preferredMode: 'interactive' },
  }
}
function terminalProducer() {
  return producerResult({
    selection: {
      harness: 'agent-harness',
      modelProvider: 'openai-codex',
      model: 'gpt-5.5',
      presentation: true,
    },
    execution: {
      recipeId: 'fixture-t08555-terminal',
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
async function session(scope = SCOPE): Promise<HrcSessionRecord> {
  const resolved = await fixture.resolveSession(scope)
  const record = internal().db.sessions.getByHostSessionId(resolved.hostSessionId)
  if (!record) throw new Error('session missing')
  return record
}
function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
async function bootServer(redirect: boolean): Promise<void> {
  server = await createHrcServer(
    fixture.serverOpts({
      headlessCodexBrokerEnabled: true,
      codexCliTmuxBrokerEnabled: redirect,
      otelListenerEnabled: false,
    })
  )
  const tmuxManagerFactory = tmuxManagerDouble(ledger)
  internal().harnessBrokerController = new HarnessBrokerController({
    db: internal().db,
    brokerUnixClientFactory: async () =>
      workerClient(ledger, [releaseA], ledger.commands.at(-1)) as never,
    tmuxAllocator: createBrokerDurableTmuxAllocator(internal().options, {
      tmuxManagerFactory: tmuxManagerFactory as never,
      generateAttachToken: () => 'attach-token-t08555-terminal',
    }),
    headlessSubstrateAllocator: createBrokerDurableHeadlessAllocator(internal().options, {
      tmuxManagerFactory: tmuxManagerFactory as never,
      generateAttachToken: () => 'attach-token-t08555',
    }),
    tmuxTuiAllocator: createBrokerTmuxTuiAllocator(internal().options, {
      tmuxManagerFactory: tmuxManagerFactory as never,
      generateAttachToken: () => 'attach-token-t08555-tui',
    }),
    now: () => new Date().toISOString(),
  } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])
  observedReuse = []
  const target = server as unknown as Record<string, unknown>
  target['executeInteractiveBrokerInputTurn'] = async (
    _session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot
  ) => {
    observedReuse.push(runtime.runtimeId)
    return Response.json({ runtimeId: runtime.runtimeId, status: 'accepted' })
  }
  target['reconcileTmuxRuntimeLiveness'] = async (runtime: HrcRuntimeSnapshot) => runtime
}
async function reboot(redirect: boolean): Promise<void> {
  await server.stop()
  await bootServer(redirect)
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08555-')
  scratch = await mkdtemp(join(tmpdir(), 't8555-'))
  releaseA = makeRelease(join(scratch, 'releases'), 'a')
  const socket = join(scratch, 'aspd.sock')
  aspd = startAspdDouble(socket, releaseA)
  setEnv('HRC_ASPD_SOCKET', socket)
  setEnv('HRC_HARNESS_BROKER_CMD', '/nonexistent/resolver-selected-harness-broker')
  callerAspHome = join(scratch, 'caller-asp-home')
  setEnv('ASP_HOME', callerAspHome)
  ledger = { commands: [], killedServers: [], startCalls: [], attachCalls: 0 }
  await bootServer(false)
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
async function turn(hostSessionId: string, runtimeIntent: unknown, extra = {}) {
  return await fixture.postJson('/v1/turns', {
    hostSessionId,
    prompt: 'x',
    runtimeIntent,
    waitFor: 'accepted',
    ...extra,
  })
}
async function start(hostSessionId: string, intent: HrcRuntimeIntent) {
  return await fixture.postJson('/v1/runtimes/start', { hostSessionId, intent })
}
function preparations(hostSessionId: string): Array<any> {
  return internal()
    .db.sqlite.query<{ preparation_json: string | null }, [string]>(
      'SELECT preparation_json FROM runtime_operations WHERE host_session_id = ? ORDER BY created_at ASC'
    )
    .all(hostSessionId)
    .map((row) => JSON.parse(row.preparation_json ?? '{}'))
}
function seed(s: HrcSessionRecord, runtimeId: string, harness = 'codex-cli'): HrcRuntimeSnapshot {
  const now = new Date().toISOString()
  internal().db.runtimes.insert({
    runtimeId,
    hostSessionId: s.hostSessionId,
    scopeRef: s.scopeRef,
    laneRef: s.laneRef,
    generation: s.generation,
    transport: 'tmux',
    harness,
    provider: 'openai',
    status: 'ready',
    controllerKind: 'harness-broker',
    supportsInflightInput: true,
    adopted: false,
    activeInvocationId: `inv-${runtimeId}`,
    runtimeStateJson: {
      broker: {
        endpoint: { kind: 'unix-jsonrpc-ndjson', socketPath: '/tmp/t08555.sock' },
        substrate: { kind: 'external' },
        presentation: { kind: 'terminal' },
      },
      tmux: { brokerDriver: 'codex-app-server' },
    },
    createdAt: now,
    updatedAt: now,
  } as never)
  internal().db.brokerInvocations.insert({
    invocationId: `inv-${runtimeId}`,
    operationId: `op-${runtimeId}`,
    runtimeId,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    invocationState: 'ready',
    capabilitiesJson: JSON.stringify({ inputQueue: { mode: 'fifo' } }),
    specHash: 'sha256:t08555-spec',
    startRequestHash: 'sha256:t08555-request',
    selectedProfileHash: 'sha256:t08555-profile',
    createdAt: now,
    updatedAt: now,
  } as never)
  return internal().db.runtimes.getByRuntimeId(runtimeId) as HrcRuntimeSnapshot
}

describe('T-08555 producer-selected start and dispatch', () => {
  it('preserves omitted request selection at dispatch and freezes the producer default', async () => {
    const s = await session()
    const response = await turn(s.hostSessionId, headlessIntent())
    expect(response.status).toBeLessThan(300)
    expect(aspd.compileCalls).toBe(1)
    expect(aspd.compileRequested).toEqual([{}])
    expect(aspd.compileAspHomes).toEqual([callerAspHome])
    const [record] = preparations(s.hostSessionId)
    expect(record.route).toBe('producer-selected-execution')
    expect(record.admission.plan.selection).toMatchObject({
      harness: 'agent-harness',
      presentation: false,
    })
    expect(record.hosting.presentation).toBe('none')
    expect(record.dispatch.routeDecision).toMatchObject({
      preparation: 'aspd',
      selectedBy: 'producer-selected-execution',
      aspHome: callerAspHome,
    })
    expect(record.dispatch.routeDecision).not.toHaveProperty('operatorPresentationSource')
  })
  it('accepts producer-declared terminal execution despite an interactive raw request', async () => {
    aspd.producerResult = terminalProducer()
    const s = await session()
    const response = await start(s.hostSessionId, interactiveIntent())
    expect(response.status).toBe(200)
    const [record] = preparations(s.hostSessionId)
    expect(record.admission.execution).toMatchObject({
      driver: 'codex-app-server',
      hosting: { executionTransport: 'pty', terminalRequired: true, terminalHost: 'tmux' },
    })
    expect(record.hosting).toMatchObject({
      driverKind: 'codex-app-server',
      presentation: 'terminal',
    })
    expect(aspd.compileSelectors).toEqual([undefined])
    expect(ledger.commands.at(-1)).toContain(join(releaseA.releaseRoot, 'harness-broker'))
  })
  it('does not let redirect configuration alter the producer default', async () => {
    await reboot(true)
    const dispatchSession = await session(`${SCOPE}-dispatch`)
    const startSession = await session(`${SCOPE}-start`)
    expect((await turn(dispatchSession.hostSessionId, headlessIntent())).status).toBeLessThan(300)
    expect((await start(startSession.hostSessionId, headlessIntent())).status).toBe(200)
    expect(aspd.compileCalls).toBe(2)
    for (const hostSessionId of [dispatchSession.hostSessionId, startSession.hostSessionId]) {
      const [record] = preparations(hostSessionId)
      expect(record.admission.execution.driver).toBe('codex-app-server')
      expect(record.hosting.presentation).toBe('none')
      expect(record.dispatch.routeDecision.selectedBy).toBe('producer-selected-execution')
    }
  })
  it('dispatch reuses a persisted terminal realization without compiling or reselecting', async () => {
    const s = await session()
    const persisted = seed(s, 'rt-t08555-reuse')
    const response = await turn(s.hostSessionId, headlessIntent())
    expect(response.status).toBeLessThan(300)
    expect(observedReuse).toEqual([persisted.runtimeId])
    expect(aspd.compileCalls).toBe(0)
    expect(preparations(s.hostSessionId)).toEqual([])
  })
  it('start reuses a persisted terminal realization without compiling or reselecting', async () => {
    const s = await session()
    const persisted = seed(s, 'rt-t08555-start-reuse')
    const response = await start(s.hostSessionId, headlessIntent())
    expect(response.status).toBe(200)
    expect(((await response.json()) as { runtimeId: string }).runtimeId).toBe(persisted.runtimeId)
    expect(aspd.compileCalls).toBe(0)
  })
  it('does not locally reject a persisted realization because its historical harness label differs', async () => {
    const s = await session()
    const persisted = seed(s, 'rt-t08555-foreign-label', 'agent-harness')
    const response = await start(s.hostSessionId, headlessIntent())
    expect(response.status).toBe(200)
    expect(((await response.json()) as { runtimeId: string }).runtimeId).toBe(persisted.runtimeId)
    expect(aspd.compileCalls).toBe(0)
  })
  it('keeps high-risk policy refusal before a producer compile or persisted-runtime reuse', async () => {
    const s = await session()
    const persisted = seed(s, 'rt-t08555-high-risk')
    const response = await turn(s.hostSessionId, {
      ...headlessIntent(),
      execution: {
        preferredMode: 'headless',
        actuatorSplit: {
          schemaVersion: 'hrc.actuator-split-policy/v1',
          mode: 'high-risk',
          workflowRef: 'wrkf:t08555',
          laneClass: 'verifier',
          codeMutation: 'forbidden',
          productionCodePaths: ['packages'],
        },
      },
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.text()).toContain('high-risk-route-requires-headless-codex-broker')
    expect(aspd.compileCalls).toBe(0)
    expect(observedReuse).toEqual([])
    expect(internal().db.runtimes.getByRuntimeId(persisted.runtimeId)?.status).toBe('ready')
  })
})
