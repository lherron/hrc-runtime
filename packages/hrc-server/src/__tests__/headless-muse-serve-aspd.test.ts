/**
 * Headless muse-serve births through aspd (route `headless-muse-serve`):
 * the summon gate admits the muse harness, and the headless broker birth
 * prepares, freezes, and launches a muse-serve worker from the frozen
 * execution release with presentation none. The observer viewer has no
 * aspd-route hosting yet, so an observer request stays off this route.
 *
 * Harness shared with T-08562: real dispatch/birth chokepoint, real
 * HarnessBrokerController and durable allocators, Unix-socket aspd double.
 * The bundled facade is a spy that throws if reached.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { aspdHeadlessBrokerEndpoint, prepareAspdHeadlessAttempt } from '../aspd-headless-start'

import { AspcFacadeBrokerClient } from '../agent-spaces-adapter/aspc-facade-client'
import {
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  createBrokerObserverPaneAllocator,
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

const SCOPE = 'agent:museheadless:project:hrc-runtime:task:primary'
const MARK = 'MUSE-HEADLESS-MARK reply with exactly this marker'
const HOSTED = ['codex-app-server', 'muse-serve']

let fixture: HrcServerTestFixture
let server: HrcServer
let scratch: string
let aspdSocket: string
let aspd: AspdDouble
let releaseA: Release
let ledger: HostingLedger
let facadeCalls: number
let facadeSpy: ReturnType<typeof spyOn>
const savedEnv: Record<string, string | undefined> = {}

type Internal = {
  db: HrcDatabase
  options: { runtimeRoot: string }
  harnessBrokerController?: HarnessBrokerController
  dispatchTurnForSession(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent | undefined,
    prompt: string,
    options: Record<string, unknown>
  ): Promise<Response>
}

function internal(): Internal {
  return server as unknown as Internal
}

function museIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'meta', id: 'muse-cli', interactive: false },
    execution: { preferredMode: 'headless' },
  } as HrcRuntimeIntent
}

function codexIntent(): HrcRuntimeIntent {
  const base = museIntent()
  return {
    ...base,
    harness: { provider: 'openai', id: 'codex-cli', interactive: false },
  } as HrcRuntimeIntent
}

async function session(scope = SCOPE): Promise<HrcSessionRecord> {
  const resolved = await fixture.resolveSession(scope)
  const record = internal().db.sessions.getByHostSessionId(resolved.hostSessionId)
  if (record === null) throw new Error('session missing')
  return record
}

async function seedMuse(scope = SCOPE): Promise<HrcSessionRecord> {
  const s = await session(scope)
  internal().db.sessions.updateIntent(s.hostSessionId, museIntent(), new Date().toISOString())
  return internal().db.sessions.getByHostSessionId(s.hostSessionId) as HrcSessionRecord
}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function bootServer(): Promise<void> {
  server = await createHrcServer(
    fixture.serverOpts({
      headlessCodexBrokerEnabled: true,
      headlessMuseBrokerEnabled: true,
      brokerDurableIpcEnabled: true,
      otelListenerEnabled: false,
    })
  )
  const tmuxManagerFactory = tmuxManagerDouble(ledger)
  const deps = (token: string) => ({
    tmuxManagerFactory: tmuxManagerFactory as never,
    generateAttachToken: () => token,
  })
  internal().harnessBrokerController = new HarnessBrokerController({
    db: internal().db,
    brokerUnixClientFactory: async () =>
      workerClient(ledger, [releaseA], ledger.commands.at(-1)) as never,
    tmuxAllocator: createBrokerDurableTmuxAllocator(internal().options, deps('attach-muse-h')),
    headlessSubstrateAllocator: createBrokerDurableHeadlessAllocator(
      internal().options,
      deps('attach-muse-h')
    ),
    tmuxTuiAllocator: createBrokerTmuxTuiAllocator(internal().options, deps('attach-muse-h-v')),
    observerPaneAllocator: createBrokerObserverPaneAllocator(
      internal().options,
      deps('attach-muse-h-o')
    ),
    now: () => new Date().toISOString(),
  } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-muse-headless-')
  scratch = await mkdtemp(join(tmpdir(), 'muse-headless-'))
  releaseA = makeRelease(join(scratch, 'releases'), 'a')
  aspdSocket = join(scratch, 'aspd.sock')
  aspd = startAspdDouble(aspdSocket, releaseA)
  aspd.hostedDrivers = HOSTED
  setEnv('HRC_ASPD_SOCKET', aspdSocket)
  setEnv('HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION', undefined)
  // Mirror the max3 node default that caught the live seat: the observer
  // viewer has no aspd-route hosting, so the route hosts it as none.
  setEnv('HRC_MUSE_SERVE_OPERATOR_PRESENTATION', 'observer')
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

function operations(hostSessionId: string): Array<{ operation_id: string; record: any }> {
  return internal()
    .db.sqlite.query<{ operation_id: string; preparation_json: string }, [string]>(
      `SELECT operation_id, preparation_json FROM runtime_operations
        WHERE host_session_id = ? AND preparation_json IS NOT NULL ORDER BY created_at ASC`
    )
    .all(hostSessionId)
    .map((row) => ({ operation_id: row.operation_id, record: JSON.parse(row.preparation_json) }))
}

async function settle(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(10)
}

/** The mail kicker's exact summons-birth call (hrc-mail-kicker drive/delivery.ts). */
async function kickerSummons(s: HrcSessionRecord, prompt = MARK): Promise<Response> {
  return await internal().dispatchTurnForSession(s, s.lastAppliedIntentJson, prompt, {
    waitForCompletion: false,
    submissionDoor: 'invoke',
    ttlMs: 60_000,
    submissionOrigin: { principalRef: 'agent:mable', envelopeId: 'EN-MUSE-HEADLESS' },
    launchPromptOnColdBirth: true,
  })
}

describe('headless muse-serve route selection', () => {
  it('admits a headless muse intent on a configured node', () => {
    expect(aspdHeadlessBrokerEndpoint(museIntent(), { HRC_ASPD_SOCKET: aspdSocket })).toBe(
      aspdSocket
    )
  })

  it('keeps admitting headless codex-app-server', () => {
    expect(aspdHeadlessBrokerEndpoint(codexIntent(), { HRC_ASPD_SOCKET: aspdSocket })).toBe(
      aspdSocket
    )
  })

  it('admits observer muse requests, and refuses interactive intents and unconfigured nodes', () => {
    const observer = {
      ...museIntent(),
      presentation: { operator: 'observer' },
    } as HrcRuntimeIntent
    expect(aspdHeadlessBrokerEndpoint(observer, { HRC_ASPD_SOCKET: aspdSocket })).toBe(aspdSocket)
    expect(
      aspdHeadlessBrokerEndpoint(museIntent(), {
        HRC_ASPD_SOCKET: aspdSocket,
        HRC_MUSE_SERVE_OPERATOR_PRESENTATION: 'observer',
      })
    ).toBe(aspdSocket)
    const interactive = {
      ...museIntent(),
      harness: { provider: 'meta', id: 'muse-cli', interactive: true },
    } as HrcRuntimeIntent
    expect(aspdHeadlessBrokerEndpoint(interactive, { HRC_ASPD_SOCKET: aspdSocket })).toBeUndefined()
    expect(aspdHeadlessBrokerEndpoint(museIntent(), {})).toBeUndefined()
  })
})

describe('headless muse-serve birth through aspd', () => {
  it('mail summons prepares route headless-muse-serve with the observer viewer and launches the frozen worker', async () => {
    const s = await seedMuse()
    const response = await kickerSummons(s)
    expect(response.status).toBe(200)
    await settle(() => ledger.startCalls.length === 1)

    expect(facadeCalls).toBe(0)
    expect(aspd.compileCalls).toBe(1)
    expect(aspd.compileSelectors[0]).toEqual({ brokerDriver: 'muse-serve' })
    const [op] = operations(s.hostSessionId)
    expect(op?.record.route).toBe('headless-muse-serve')
    expect(op?.record.hosting).toMatchObject({
      driverKind: 'muse-serve',
      presentation: 'observer',
    })
    expect(op?.record.executionRelease.worker.hostedDrivers).toEqual(HOSTED)
    expect(op?.record.dispatch.routeDecision).toMatchObject({
      preparation: 'aspd',
      flag: 'HRC_HEADLESS_MUSE_BROKER_ENABLED',
      selectedBy: 'aspdHeadlessBrokerEndpoint',
      operatorPresentation: 'observer',
    })
    // Launched from the frozen release with the observer socket on the worker
    // command and the frozen paths.
    expect(ledger.commands[0]).toContain(join(releaseA.releaseRoot, 'harness-broker'))
    expect(ledger.commands[0]).toContain(op?.record.hosting.paths.brokerIpcSocketPath)
    expect(op?.record.hosting.paths.sessionName).toContain('muse-serve')
    expect(op?.record.hosting.paths.observerSocketPath).toContain('observer.sock')
    expect(ledger.commands[0]).toContain(op?.record.hosting.paths.observerSocketPath)
    expect(ledger.commands[0]).toContain('--experimental-observer-socket')
    expect(ledger.startCalls).toHaveLength(1)
  })

  it('hostedDrivers lacking muse-serve refuses aspd_worker_hosting_unproven with no hosting effect', async () => {
    aspd.hostedDrivers = ['codex-app-server']
    const s = await seedMuse()
    const error = await prepareAspdHeadlessAttempt(server as never, {
      session: s,
      intent: museIntent(),
      runId: 'run-muse-unproven',
      endpoint: aspdSocket,
    }).catch((e: unknown) => e)
    expect(JSON.stringify((error as { detail?: unknown }).detail)).toContain(
      'aspd_worker_hosting_unproven'
    )
    expect(operations(s.hostSessionId)).toEqual([])
    expect(ledger.commands).toHaveLength(0)
    expect(ledger.startCalls).toHaveLength(0)
    expect(facadeCalls).toBe(0)
  })
})
