/**
 * T-08576 R-B birth-boundary reds observable through the base HTTP/store surfaces.
 *
 * The future binding/grant helpers are intentionally not imported: a missing-export failure is
 * not a behavioral red. Real server composition and SQLite are used; only the broker dispatch
 * seam is replaced where the assertion requires proving that refusal happened before launch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type {
  InvocationEventEnvelope,
  SubmissionEnqueueRequest,
  SubmissionResponse,
} from 'spaces-harness-broker-protocol'

import { evaluateServerLifecycleAuthorization } from '../../../hrc-cli/src/cli-runtime/shutdown-intent'
import {
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  createBrokerTmuxTuiAllocator,
} from '../broker-interactive-handlers/substrate-allocator'
import { HarnessBrokerController } from '../broker/controller'
import { BrokerEventMapper } from '../broker/event-mapper'
import { buildDispatchInvocation } from '../dispatch-invocation'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'
import { finalizeRuntimeTermination } from '../server-misc'
import { launchCarriedInvokeCorrelationJson } from '../server-types'
import { markRuntimeDead } from '../startup-reconcile/runtime-mutations'
import { dispatchTurnForSession } from '../turn-dispatch-handlers'
import {
  type AspdDouble,
  type HostingLedger,
  type Release,
  makeRelease,
  startAspdDouble,
  tmuxManagerDouble,
  workerClient,
} from './fixtures/aspd-route-doubles'

const NOW = '2026-09-17T07:10:00.000Z'
const APP_ID = 't08576'
const KEY = 'birth'
const APP_SCOPE = `app:${APP_ID}`
const PARTIAL_LIFECYCLE_ENVELOPE_MESSAGE =
  'refusing server lifecycle mutation: partial HRC/ASP session envelope; ' +
  'run from a clean operator shell or a recognized primary scope'

let root: string
let socketPath: string
let server: HrcServer
let internal: HrcServerInstanceForHandlers & { db: HrcDatabase }
let appHost: string
let launchCalls: string[]
let aspd: AspdDouble | undefined
type AppBirthHostingLedger = HostingLedger & {
  enqueueCalls: Array<{
    request: SubmissionEnqueueRequest
    response: SubmissionResponse
  }>
  startSnapshots: Array<{
    runIds: string[]
    activeRunIds: string[]
  }>
}
let ledger: AppBirthHostingLedger | undefined
let release: Release | undefined
const savedEnv = new Map<string, string | undefined>()
let invocationStartGate:
  | {
      reached: Promise<void>
      signalReached(): void
      release: Promise<void>
      signalRelease(): void
    }
  | undefined

const IDENTITY_KEYS = [
  'AGENT_ID',
  'AGENT_ACTOR',
  'WRKQ_ACTOR',
  'ASP_AGENT_ID',
  'AGENT_SCOPE_REF',
  'AGENT_LANE_REF',
  'AGENT_LANE',
  'AGENT_SESSION_REF',
  'HRC_SESSION_REF',
  'ASP_SCOPE_REF',
  'ASP_HANDLE',
  'AGENT_PROJECT',
  'ASP_DEFAULT_TASK',
  'AGENT_HOST_SESSION_ID',
  'HRC_HOST_SESSION_ID',
  'AGENT_RUN_ID',
  'HRC_RUN_ID',
  'AGENT_GENERATION',
  'HRC_GENERATION',
] as const

function baseIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/t08576-agent',
      projectRoot: '/tmp/t08576-project',
      cwd: '/tmp/t08576-project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    // Keep the request aligned with the shared fixture's OpenAI-labelled plan
    // so the post-birth dispatch exercises reuse instead of provider-mismatch
    // reprovisioning; route identity is asserted from the selected handler seam.
    harness: { provider: 'openai', id: 'pi-cli', interactive: true },
  }
}

beforeEach(async () => {
  Reflect.deleteProperty(process.env, 'HRC_ALLOW_HARNESS_SHIM')
  root = await mkdtemp(join(tmpdir(), 't08576-birth-'))
  const runtimeRoot = join(root, 'run')
  const stateRoot = join(root, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  server = await createHrcServer({
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath: join(runtimeRoot, 'server.lock'),
    spoolDir: join(runtimeRoot, 'spool'),
    dbPath: join(stateRoot, 'state.sqlite'),
    tmuxSocketPath: join(runtimeRoot, 'tmux.sock'),
    commandRunTargets: {
      t08576: { launchMode: 'exec', argv: ['/bin/true'] },
    },
  })
  internal = server as unknown as typeof internal
  launchCalls = []
  ;(internal as any).ensureRuntimeForSession = async (session: {
    hostSessionId: string
    scopeRef: string
    laneRef: string
    generation: number
  }) => {
    const runtimeId = `rt-${randomUUID()}`
    launchCalls.push(`${session.hostSessionId}:ensure`)
    internal.db.runtimes.insert({
      runtimeId,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return internal.db.runtimes.getByRuntimeId(runtimeId)
  }
  ;(internal as any).dispatchTurnForSession = async (
    session: { hostSessionId: string },
    _intent: unknown,
    _prompt: string,
    options: { runId?: string }
  ) => {
    launchCalls.push(`${session.hostSessionId}:${options.runId ?? ''}`)
    return new Response(
      JSON.stringify({
        runId: options.runId,
        hostSessionId: session.hostSessionId,
        generation: 1,
        runtimeId: 'rt-launch-seam',
        transport: 'headless',
        status: 'started',
        supportsInFlightInput: false,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
})

afterEach(async () => {
  await server.stop()
  aspd?.stop()
  aspd = undefined
  for (const [name, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  savedEnv.clear()
  invocationStartGate = undefined
  await rm(root, { recursive: true, force: true })
})

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
  process.env[name] = value
}

function armInvocationStartGate(): NonNullable<typeof invocationStartGate> {
  let signalReached!: () => void
  let signalRelease!: () => void
  const gate = {
    reached: new Promise<void>((resolve) => {
      signalReached = resolve
    }),
    signalReached: () => signalReached(),
    release: new Promise<void>((resolve) => {
      signalRelease = resolve
    }),
    signalRelease: () => signalRelease(),
  }
  invocationStartGate = gate
  return gate
}

function brokerReadinessEvents(invocationId: string): AsyncIterable<InvocationEventEnvelope> {
  const now = new Date().toISOString()
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        invocationId,
        seq: 1,
        time: now,
        type: 'invocation.ready',
        payload: { state: 'ready' },
      } as InvocationEventEnvelope
    },
  }
}

async function bootAspdBirthServer(): Promise<void> {
  await server.stop()
  release = makeRelease(join(root, 'releases'), 't08576')
  const aspdSocket = join(root, 'aspd.sock')
  aspd = startAspdDouble(aspdSocket, release)
  aspd.hostedDrivers = ['claude-code-tmux', 'codex-app-server', 'pi-tui-tmux']
  setEnv('HRC_ASPD_SOCKET', aspdSocket)
  setEnv('HRC_HARNESS_BROKER_CMD', '/nonexistent/t08576-broker')
  setEnv('ASP_HOME', join(root, 'asp-home'))
  const runtimeRoot = join(root, 'run')
  const stateRoot = join(root, 'state')
  server = await createHrcServer({
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath: join(runtimeRoot, 'server.lock'),
    spoolDir: join(runtimeRoot, 'spool'),
    dbPath: join(stateRoot, 'state.sqlite'),
    tmuxSocketPath: join(runtimeRoot, 'tmux.sock'),
    headlessCodexBrokerEnabled: true,
    claudeCodeTmuxBrokerEnabled: true,
    brokerDurableIpcEnabled: true,
    otelListenerEnabled: false,
    commandRunTargets: {
      t08576: { launchMode: 'exec', argv: ['/bin/true'] },
    },
  })
  internal = server as unknown as typeof internal
  ;(internal as any).reconcileTmuxRuntimeLiveness = async (runtime: HrcRuntimeSnapshot) => runtime
  ;(internal as any).tmux = {
    inspectSession: async () => ({ sessionId: '$1' }),
    terminate: async () => {},
  }
  ledger = {
    commands: [],
    killedServers: [],
    startCalls: [],
    attachCalls: 0,
    enqueueCalls: [],
    startSnapshots: [],
  }
  const tmuxManagerFactory = tmuxManagerDouble(ledger)
  const options = (internal as unknown as { options: { runtimeRoot: string } }).options
  const deps = (token: string) => ({
    tmuxManagerFactory: tmuxManagerFactory as never,
    generateAttachToken: () => token,
  })
  ;(
    internal as unknown as { harnessBrokerController?: HarnessBrokerController }
  ).harnessBrokerController = new HarnessBrokerController({
    db: internal.db,
    brokerUnixClientFactory: async () => {
      const client = workerClient(ledger!, [release!], ledger!.commands.at(-1))
      const start = client.startInvocationFromRequest.bind(client)
      return {
        ...client,
        health: async () => ({
          status: 'ok' as const,
          activeInvocations: ledger!.startCalls.length,
          drivers: [],
        }),
        enqueue: async (request: SubmissionEnqueueRequest): Promise<SubmissionResponse> => {
          const response = {
            submissionId: `submission-t08576-${ledger!.enqueueCalls.length + 1}`,
            admission: 'admitted' as const,
          }
          ledger!.enqueueCalls.push({ request, response })
          return response
        },
        startInvocationFromRequest: async (...args: Parameters<typeof start>) => {
          ledger!.startSnapshots.push({
            runIds: internal.db.runs.listRuns({ limit: 1_000 }).map((run) => run.runId),
            activeRunIds: internal.db.runtimes
              .listAvailable()
              .map((runtime) => runtime.activeRunId)
              .filter((runId): runId is string => runId !== undefined),
          })
          const gate = invocationStartGate
          if (gate !== undefined) {
            gate.signalReached()
            await gate.release
            invocationStartGate = undefined
          }
          const started = await start(...args)
          return {
            ...started,
            events: brokerReadinessEvents(String(started.invocationId)),
          }
        },
      } as never
    },
    tmuxAllocator: createBrokerDurableTmuxAllocator(options, deps('attach-t08576-tmux')),
    headlessSubstrateAllocator: createBrokerDurableHeadlessAllocator(
      options,
      deps('attach-t08576-headless')
    ),
    tmuxTuiAllocator: createBrokerTmuxTuiAllocator(options, deps('attach-t08576-viewer')),
    now: () => new Date().toISOString(),
  } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://localhost${path}`, {
    unix: socketPath,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

function counts(): Record<string, number> {
  const tables = [
    'sessions',
    'continuities',
    'session_index',
    'app_managed_sessions',
    'runtimes',
    'runs',
    'runtime_operations',
    'broker_invocations',
    'local_bridges',
    'surface_bindings',
    'active_input_deliveries',
    'hrc_events',
  ]
  const existing = new Set(
    internal.db.sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(({ name }) => name)
  )
  return Object.fromEntries(
    tables
      .filter((table) => existing.has(table))
      .map((table) => [
        table,
        internal.db.sqlite
          .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
          .get()?.count ?? 0,
      ])
  )
}

function hostEffectCounts(hostSessionId: string): Record<string, number> {
  const scalar = (sql: string): number =>
    internal.db.sqlite.query<{ count: number }, [string]>(sql).get(hostSessionId)?.count ?? 0
  return {
    sessions: scalar('SELECT COUNT(*) AS count FROM sessions WHERE host_session_id = ?'),
    continuities: scalar(
      'SELECT COUNT(*) AS count FROM continuities WHERE active_host_session_id = ?'
    ),
    sessionIndex: scalar('SELECT COUNT(*) AS count FROM session_index WHERE host_session_id = ?'),
    managed: scalar(
      'SELECT COUNT(*) AS count FROM app_managed_sessions WHERE active_host_session_id = ?'
    ),
    runtimes: scalar('SELECT COUNT(*) AS count FROM runtimes WHERE host_session_id = ?'),
    runs: scalar('SELECT COUNT(*) AS count FROM runs WHERE host_session_id = ?'),
    operations: scalar(
      'SELECT COUNT(*) AS count FROM runtime_operations WHERE host_session_id = ?'
    ),
    brokerInvocations: scalar(
      `SELECT COUNT(*) AS count FROM broker_invocations bi
       JOIN runtime_operations ro ON ro.operation_id = bi.operation_id
       WHERE ro.host_session_id = ?`
    ),
    bridges: scalar('SELECT COUNT(*) AS count FROM local_bridges WHERE host_session_id = ?'),
    surfaceBindings: scalar(
      `SELECT COUNT(*) AS count FROM surface_bindings sb
       JOIN runtimes r ON r.runtime_id = sb.runtime_id
       WHERE r.host_session_id = ?`
    ),
    activeInputDeliveries: scalar(
      `SELECT COUNT(*) AS count FROM active_input_deliveries aid
       JOIN runtimes r ON r.runtime_id = aid.runtime_id
       WHERE r.host_session_id = ?`
    ),
    events: scalar('SELECT COUNT(*) AS count FROM hrc_events WHERE host_session_id = ?'),
  }
}

function seedAppIdentity(intent: HrcRuntimeIntent = baseIntent(), appSessionKey = KEY): string {
  const seededHost = `hsid-${randomUUID()}`
  if (appSessionKey === KEY) appHost = seededHost
  internal.db.sessions.insert({
    hostSessionId: seededHost,
    scopeRef: APP_SCOPE,
    laneRef: appSessionKey,
    generation: 1,
    status: 'active',
    lastAppliedIntentJson: intent,
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  internal.db.sqlite.run(
    'INSERT INTO continuities (scope_ref, lane_ref, active_host_session_id, updated_at) VALUES (?, ?, ?, ?)',
    [APP_SCOPE, appSessionKey, seededHost, NOW]
  )
  internal.db.appManagedSessions.create({
    appId: APP_ID,
    appSessionKey,
    kind: 'harness',
    activeHostSessionId: seededHost,
    generation: 1,
    status: 'active',
    lastAppliedSpec: { kind: 'harness', runtimeIntent: intent },
    createdAt: NOW,
    updatedAt: NOW,
  })
  return seededHost
}

function forbiddenIntent(
  channel: 'lockedEnv' | 'env' | 'dispatchEnv',
  key: 'AGENT_ID' | 'HRC_SESSION_REF' = 'AGENT_ID'
): HrcRuntimeIntent {
  const intent = baseIntent() as HrcRuntimeIntent & {
    placement: HrcRuntimeIntent['placement'] & Record<string, unknown>
  }
  intent.placement[channel] = { [key]: 'forged-app-identity' }
  return intent
}

function adversarialIntent(runId = 'run-forged'): HrcRuntimeIntent {
  const env = Object.fromEntries(IDENTITY_KEYS.map((key) => [key, `forged-${key}`]))
  return {
    ...baseIntent(),
    placement: {
      ...baseIntent().placement,
      correlation: {
        sessionRef: {
          scopeRef: 'agent:cody:project:hrc-runtime:task:T-08576',
          laneRef: 'lane:forged',
        },
        hostSessionId: 'hsid-forged',
        generation: 99,
        runId,
      },
    },
    launch: { env, unsetEnv: [...IDENTITY_KEYS] },
  } as HrcRuntimeIntent
}

function frozenPreparations(hostSessionId: string): any[] {
  return internal.db.sqlite
    .query<{ preparation_json: string }, [string]>(
      `SELECT preparation_json FROM runtime_operations
       WHERE host_session_id = ? AND preparation_json IS NOT NULL ORDER BY created_at ASC`
    )
    .all(hostSessionId)
    .map(({ preparation_json }) => JSON.parse(preparation_json))
}

async function settle(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await Bun.sleep(10)
}

function dispatchedIdentityEnv(callIndex = 0): Record<string, string> {
  const dispatch = ledger?.startCalls[callIndex]?.dispatch as
    | Record<string, string>
    | { dispatchEnv?: Record<string, string> }
    | undefined
  if (dispatch === undefined) return {}
  return 'dispatchEnv' in dispatch ? (dispatch.dispatchEnv ?? {}) : dispatch
}

function identityProjection(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    IDENTITY_KEYS.filter((key) => env[key] !== undefined).map((key) => [key, env[key]!])
  )
}

function expectBirthAutoDispatch(input: {
  hostSessionId: string
  runtimeId: string
  body: string
  callIndex?: number
}): void {
  const callIndex = input.callIndex ?? 0
  const start = ledger?.startCalls[callIndex]
  const enqueue = ledger?.enqueueCalls[callIndex]
  const run = internal.db.sqlite
    .query<
      {
        host_session_id: string
        runtime_id: string | null
        generation: number
      },
      [string, string]
    >(
      `SELECT host_session_id, runtime_id, generation
         FROM runs WHERE host_session_id = ? AND runtime_id = ?`
    )
    .get(input.hostSessionId, input.runtimeId)

  expect({
    birthCount: ledger?.startCalls.length,
    runtimes: internal.db.runtimes.listByHostSessionId(input.hostSessionId).map((runtime) => ({
      runtimeId: runtime.runtimeId,
      status: runtime.status,
      activeInvocationId: runtime.activeInvocationId,
      activeRunId: runtime.activeRunId,
      controllerKind: runtime.controllerKind,
      transport: runtime.transport,
      provider: runtime.provider,
      brokerDriver: runtime.brokerDriver,
      tmuxJson: runtime.tmuxJson,
      invocationState:
        runtime.activeInvocationId === undefined
          ? undefined
          : internal.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
              ?.invocationState,
    })),
    request: enqueue?.request,
    response: enqueue?.response,
    bornInvocationId: start === undefined ? undefined : String(start.request.spec.invocationId),
    run,
  }).toEqual({
    birthCount: callIndex + 1,
    runtimes: [
      expect.objectContaining({
        runtimeId: input.runtimeId,
        status: 'ready',
        activeInvocationId: expect.any(String),
      }),
    ],
    request: expect.objectContaining({
      invocationId: start === undefined ? undefined : String(start.request.spec.invocationId),
      body: input.body,
    }),
    response: {
      submissionId: `submission-t08576-${callIndex + 1}`,
      admission: 'admitted',
    },
    bornInvocationId: expect.any(String),
    run: {
      host_session_id: input.hostSessionId,
      runtime_id: input.runtimeId,
      generation: 1,
    },
  })
}

function commandRunId(idempotencyKey: string): string {
  return `run-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
}

function commandBinding(sessionRef: string, lane: string): Record<string, string> {
  return {
    WRKF_TASK_ID: 'T-08576',
    WRKF_ACTION_RUN_ID: `action-${lane}`,
    WRKF_RUN_ID: `workflow-${lane}`,
    WRKF_ACTION: 'validate',
    WRKF_ROLE: 'smokey',
    ASP_PROJECT: 'hrc-runtime',
    HRC_SESSION_REF: sessionRef,
    HRC_LANE: lane,
  }
}

async function capturedRefusal(
  call: () => unknown | Promise<unknown>
): Promise<Record<string, unknown>> {
  try {
    await call()
    return { returned: true }
  } catch (error) {
    const value = error as { code?: string; detail?: Record<string, unknown> }
    return { code: value.code, ...value.detail }
  }
}

function seedRun(runId: string, status: 'accepted' | 'completed', hostSessionId = appHost): void {
  internal.db.runs.insert({
    runId,
    hostSessionId,
    scopeRef: hostSessionId === appHost ? APP_SCOPE : 'agent:foreign:project:hrc-runtime',
    laneRef: hostSessionId === appHost ? KEY : 'main',
    generation: 1,
    transport: 'headless',
    status,
    acceptedAt: NOW,
    ...(status === 'completed' ? { completedAt: NOW } : {}),
    updatedAt: NOW,
  })
}

function seedForeignRuntime(
  options: {
    runtimeId?: string
    hostSessionId?: string
    laneRef?: string
    activeRunId?: string
  } = {}
): HrcRuntimeSnapshot {
  const foreignHost = options.hostSessionId ?? `hsid-${randomUUID()}`
  const runtimeId = options.runtimeId ?? `rt-${randomUUID()}`
  const laneRef = options.laneRef ?? 'main'
  internal.db.sessions.insert({
    hostSessionId: foreignHost,
    scopeRef: 'agent:foreign:project:hrc-runtime',
    laneRef,
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  internal.db.runtimes.insert({
    runtimeId,
    hostSessionId: foreignHost,
    scopeRef: 'agent:foreign:project:hrc-runtime',
    laneRef,
    generation: 1,
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    ...(options.activeRunId !== undefined ? { activeRunId: options.activeRunId } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  })
  return internal.db.runtimes.getByRuntimeId(runtimeId)!
}

function writerOutcome(call: () => unknown): { threw: boolean; errorName?: string } {
  try {
    call()
    return { threw: false }
  } catch (error) {
    return { threw: true, errorName: error instanceof Error ? error.name : String(error) }
  }
}

function makeRunningAppRun(runId: string): void {
  seedRun(runId, 'accepted')
  internal.db.runs.update(runId, { status: 'running', updatedAt: NOW })
}

describe('T-08576 app-session birth identity boundary', () => {
  // Rev-8 inventory context for future sessions:
  // - R-B7(f2) is not reachable through the app route exercised here: both requested fixture
  //   variants are observed at the handler seam as interactive-tmux-broker + enqueue (f1).
  // - R-B7(g8)'s app/app and app/command collisions are pinned by (i)/(m); its generic run-insert
  //   arm is the tokenless reserved-id case in store.app-session-scope.test.ts.
  // - R-B7(t) P9 is in app-session-create-atomic, P10 in the X crossing matrix, P12 in the
  //   strict-grammar controls, and P14 in app-session-read-surfaces' allowed interrupt control.
  it('R-B1/R-B2/R-B4 binds ensure birth correlation, launch env, persisted intent and frozen preparation', async () => {
    await bootAspdBirthServer()
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: adversarialIntent() },
    })
    expect({ status: response.status, error: response.body.error }).toEqual({
      status: 200,
      error: undefined,
    })
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)

    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
    const hostSessionId = managed?.activeHostSessionId as string
    const expectedCorrelation = { hostSessionId, generation: 1 }
    const persisted = internal.db.sessions.getByHostSessionId(hostSessionId)?.lastAppliedIntentJson
    const frozen = frozenPreparations(hostSessionId)[0]
    expect(persisted?.placement.correlation).toEqual(expectedCorrelation)
    expect(frozen?.intent?.placement?.correlation).toEqual(expectedCorrelation)
    expect(frozen?.admission?.startRequest).toEqual(ledger?.startCalls[0]?.request)
    expect(identityProjection(dispatchedIdentityEnv())).toEqual({
      AGENT_HOST_SESSION_ID: hostSessionId,
      HRC_HOST_SESSION_ID: hostSessionId,
      AGENT_GENERATION: '1',
      HRC_GENERATION: '1',
    })
    expectBirthAutoDispatch({
      hostSessionId,
      runtimeId: response.body.runtimeId,
      body: '',
    })
  })

  it('R-B5 agent aspd birth preserves its compile correlation and dispatch identity', async () => {
    await bootAspdBirthServer()
    const resolved = await post('/v1/sessions/resolve', {
      sessionRef: 'agent:smokey:project:hrc-runtime:task:T-08576/lane:b5',
      create: true,
      summonIntent: 'explicit_local',
    })
    expect(resolved.status).toBe(200)
    const intent = baseIntent()
    ;(intent.placement as Record<string, unknown>).correlation = {
      sessionRef: {
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-08576',
        laneRef: 'lane:b5',
      },
      hostSessionId: resolved.body.hostSessionId,
      generation: 1,
      runId: 'run-agent-b5',
    }
    const started = await post('/v1/runtimes/ensure', {
      hostSessionId: resolved.body.hostSessionId,
      intent,
    })
    expect(started.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)
    const frozen = frozenPreparations(resolved.body.hostSessionId)[0]
    expect(frozen?.intent?.placement?.correlation).toEqual(intent.placement.correlation)
    expect(identityProjection(dispatchedIdentityEnv())).toMatchObject({
      HRC_SESSION_REF: 'agent:smokey:project:hrc-runtime:task:T-08576/lane:b5',
      HRC_HOST_SESSION_ID: resolved.body.hostSessionId,
      HRC_GENERATION: '1',
    })
  })

  it('R-B5 T-08574 preview keeps app correlation unbuildable and agent correlation unchanged', async () => {
    const previewIntent = {
      ...baseIntent(),
      harness: { provider: 'anthropic' as const, id: 'claude-code', interactive: true },
    }
    const appPreview = buildDispatchInvocation({
      ...previewIntent,
      placement: {
        ...previewIntent.placement,
        correlation: { sessionRef: { scopeRef: 'app:t08576', laneRef: 'lane:preview' } },
      },
    } as HrcRuntimeIntent)
    await expect(appPreview).rejects.toThrow()

    const agentIntent = {
      ...previewIntent,
      placement: {
        ...previewIntent.placement,
        correlation: {
          sessionRef: {
            scopeRef: 'agent:smokey:project:hrc-runtime:task:T-08576',
            laneRef: 'lane:preview',
          },
          hostSessionId: 'hsid-preview',
          generation: 7,
          runId: 'run-preview',
        },
      },
    } as HrcRuntimeIntent
    const preview = await buildDispatchInvocation(agentIntent)
    expect(identityProjection(preview.env)).toMatchObject({
      AGENT_SESSION_REF: 'agent:smokey:project:hrc-runtime:task:T-08576/lane:preview',
      HRC_SESSION_REF: 'agent:smokey:project:hrc-runtime:task:T-08576/lane:preview',
      AGENT_HOST_SESSION_ID: 'hsid-preview',
      HRC_HOST_SESSION_ID: 'hsid-preview',
      AGENT_GENERATION: '7',
      HRC_GENERATION: '7',
      AGENT_RUN_ID: 'run-preview',
      HRC_RUN_ID: 'run-preview',
    })
  })

  it('R-B6 refuses the actual composed grantless app birth envelope', async () => {
    await bootAspdBirthServer()
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
    })
    expect(response.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)

    const hostSessionId = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
      ?.activeHostSessionId as string
    const env = dispatchedIdentityEnv()
    expect(identityProjection(env)).toEqual({
      AGENT_HOST_SESSION_ID: hostSessionId,
      HRC_HOST_SESSION_ID: hostSessionId,
      AGENT_GENERATION: '1',
      HRC_GENERATION: '1',
    })
    const authorization = evaluateServerLifecycleAuthorization(env, 'must not authorize')
    expect(authorization).toEqual({
      allowed: false,
      message: PARTIAL_LIFECYCLE_ENVELOPE_MESSAGE,
    })
    expect((authorization as { callerKind?: string }).callerKind).not.toBe('operator')
    expectBirthAutoDispatch({
      hostSessionId,
      runtimeId: response.body.runtimeId,
      body: '',
    })
  })

  it('R-B6 refuses the actual composed granted app birth envelope', async () => {
    await bootAspdBirthServer()
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
      initialPrompt: 'capture granted lifecycle envelope',
    })
    expect(response.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)

    const hostSessionId = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
      ?.activeHostSessionId as string
    const env = dispatchedIdentityEnv()
    const runId = env.HRC_RUN_ID
    expect(identityProjection(env)).toEqual({
      AGENT_HOST_SESSION_ID: hostSessionId,
      HRC_HOST_SESSION_ID: hostSessionId,
      AGENT_RUN_ID: runId,
      HRC_RUN_ID: runId,
      AGENT_GENERATION: '1',
      HRC_GENERATION: '1',
    })
    expect(runId).toMatch(/^run-/)
    expect(internal.db.runs.getByRunId(runId)).toMatchObject({
      hostSessionId,
      generation: 1,
      runtimeId: response.body.runtimeId,
    })
    const authorization = evaluateServerLifecycleAuthorization(env, 'must not authorize')
    expect(authorization).toEqual({
      allowed: false,
      message: PARTIAL_LIFECYCLE_ENVELOPE_MESSAGE,
    })
    expect((authorization as { callerKind?: string }).callerKind).not.toBe('operator')
  })

  for (const channel of ['lockedEnv', 'env', 'dispatchEnv'] as const) {
    it(`R-B3 refuses placement.${channel} identity keys before creating any row`, async () => {
      const before = counts()
      const response = await post('/v1/app-sessions/ensure', {
        selector: { appId: APP_ID, appSessionKey: `entry-${channel}` },
        spec: { kind: 'harness', runtimeIntent: forbiddenIntent(channel) },
      })

      expect({
        status: response.status,
        reason: response.body.error?.detail?.reason,
        field: response.body.error?.detail?.field,
        keys: response.body.error?.detail?.keys,
        effects: counts(),
        launchCalls,
      }).toEqual({
        status: 422,
        reason: 'app-session-identity-env-forbidden',
        field: 'spec.runtimeIntent',
        keys: ['AGENT_ID'],
        effects: before,
        launchCalls: [],
      })
    })
  }

  it('R-B3 validates an entire apply request before writing its valid prefix', async () => {
    const before = counts()
    const response = await post('/v1/app-sessions/apply', {
      appId: APP_ID,
      sessions: [
        { appSessionKey: 'valid-prefix', spec: { kind: 'harness', runtimeIntent: baseIntent() } },
        {
          appSessionKey: 'forbidden-tail',
          spec: { kind: 'harness', runtimeIntent: forbiddenIntent('dispatchEnv') },
        },
      ],
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      field: response.body.error?.detail?.field,
      keys: response.body.error?.detail?.keys,
      effects: counts(),
      launchCalls,
    }).toEqual({
      status: 422,
      reason: 'app-session-identity-env-forbidden',
      field: 'spec.runtimeIntent',
      keys: ['AGENT_ID'],
      effects: before,
      launchCalls: [],
    })
  })

  it('R-B3 refuses forbidden identity env on an existing ensure before any effect', async () => {
    seedAppIdentity()
    const before = counts()
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: forbiddenIntent('env') },
      forceRestart: true,
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      field: response.body.error?.detail?.field,
      keys: response.body.error?.detail?.keys,
      effects: counts(),
      launchCalls,
    }).toEqual({
      status: 422,
      reason: 'app-session-identity-env-forbidden',
      field: 'spec.runtimeIntent',
      keys: ['AGENT_ID'],
      effects: before,
      launchCalls: [],
    })
  })

  it('R-B3 refuses a turns runtimeIntent identity override before birth', async () => {
    seedAppIdentity()
    const before = counts()
    const response = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must not launch',
      runtimeIntent: forbiddenIntent('dispatchEnv'),
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      field: response.body.error?.detail?.field,
      keys: response.body.error?.detail?.keys,
      effects: counts(),
      launchCalls,
    }).toEqual({
      status: 422,
      reason: 'app-session-identity-env-forbidden',
      field: 'runtimeIntent',
      keys: ['AGENT_ID'],
      effects: before,
      launchCalls: [],
    })
  })

  it('R-B3 refuses a clear-context relaunch spec before invalidation or rotation', async () => {
    seedAppIdentity()
    const before = counts()
    const beforeManaged = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
    const response = await post('/v1/app-sessions/clear-context', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      relaunch: true,
      spec: { kind: 'harness', runtimeIntent: forbiddenIntent('lockedEnv') },
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      field: response.body.error?.detail?.field,
      keys: response.body.error?.detail?.keys,
      effects: counts(),
      managed: internal.db.appManagedSessions.findByKey(APP_ID, KEY),
      launchCalls,
    }).toEqual({
      status: 422,
      reason: 'app-session-identity-env-forbidden',
      field: 'spec.runtimeIntent',
      keys: ['AGENT_ID'],
      effects: before,
      managed: beforeManaged,
      launchCalls: [],
    })
  })

  it('R-B3b rejects a stored forbidden intent at birth while preserving the identity', async () => {
    seedAppIdentity(forbiddenIntent('lockedEnv', 'HRC_SESSION_REF'))
    const before = counts()
    const beforeSession = internal.db.sessions.getByHostSessionId(appHost)
    const response = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must not launch',
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      field: response.body.error?.detail?.field,
      keys: response.body.error?.detail?.keys,
      effects: counts(),
      session: internal.db.sessions.getByHostSessionId(appHost),
      managedStatus: internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.status,
      launchCalls,
    }).toEqual({
      status: 422,
      reason: 'app-session-identity-env-forbidden',
      field: 'stored-or-supplied intent',
      keys: ['HRC_SESSION_REF'],
      effects: before,
      session: beforeSession,
      managedStatus: 'active',
      launchCalls: [],
    })
  })

  for (const status of ['completed', 'accepted'] as const) {
    it(`R-B7(${status === 'completed' ? 'c' : 'd'}) refuses a reused ${status} run id before launch`, async () => {
      seedAppIdentity()
      const runId = `run-t08576-${status}`
      seedRun(runId, status)
      const before = counts()
      const response = await post('/v1/app-sessions/turns', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        prompt: 'must not launch',
        runId,
      })

      expect({
        status: response.status,
        code: response.body.error?.code,
        reason: response.body.error?.detail?.reason,
        effects: counts(),
        launchCalls,
      }).toEqual({
        status: 409,
        code: 'run_mismatch',
        reason: 'app-session-run-id-reused',
        effects: before,
        launchCalls: [],
      })
    })
  }

  it('R-B7(a) forceRestart ignores a supplied historical correlation run id', async () => {
    await bootAspdBirthServer()
    const historicalRunId = 'run-t08576-a-historical'
    seedAppIdentity(adversarialIntent(historicalRunId))
    seedRun(historicalRunId, 'completed')
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: adversarialIntent(historicalRunId) },
      forceRestart: true,
    })
    expect(response.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)
    expect(frozenPreparations(appHost)[0]?.intent?.placement?.correlation).toEqual({
      hostSessionId: appHost,
      generation: 1,
    })
    expect(dispatchedIdentityEnv()).not.toHaveProperty('HRC_RUN_ID')
    expect(dispatchedIdentityEnv()).not.toHaveProperty('AGENT_RUN_ID')
    expectBirthAutoDispatch({
      hostSessionId: appHost,
      runtimeId: response.body.runtimeId,
      body: '',
    })
  })

  it('R-B7(b) clear-context relaunch ignores a stored historical correlation run id', async () => {
    await bootAspdBirthServer()
    const historicalRunId = 'run-t08576-b-historical'
    seedAppIdentity(adversarialIntent(historicalRunId))
    seedRun(historicalRunId, 'completed')
    const response = await post('/v1/app-sessions/clear-context', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      relaunch: true,
    })
    expect(response.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)
    const currentHost = internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.activeHostSessionId
    expect(frozenPreparations(currentHost as string)[0]?.intent?.placement?.correlation).toEqual({
      hostSessionId: currentHost,
      generation: 2,
    })
    expect(dispatchedIdentityEnv()).not.toHaveProperty('HRC_RUN_ID')
    expect(dispatchedIdentityEnv()).not.toHaveProperty('AGENT_RUN_ID')
  })

  it('R-B7(e) direct dispatch backstop refuses an existing app run before effects', async () => {
    await bootAspdBirthServer()
    seedAppIdentity()
    const runId = 'run-t08576-direct-existing'
    seedRun(runId, 'completed')
    const before = counts()
    const session = internal.db.sessions.getByHostSessionId(appHost)!
    const refusal = await capturedRefusal(() =>
      dispatchTurnForSession.call(internal, session, session.lastAppliedIntentJson, 'must refuse', {
        runId,
        ensureInteractiveRuntime: true,
      })
    )
    expect({ refusal, effects: counts(), starts: ledger?.startCalls.length }).toEqual({
      refusal: expect.objectContaining({
        code: 'run_mismatch',
        reason: 'app-session-run-id-reused',
      }),
      effects: before,
      starts: 0,
    })
  })

  for (const mode of ['interactive', 'headless'] as const) {
    it(`R-B7(f1) enqueue-delivered cold ${mode}-requested turn keeps the birth grantless`, async () => {
      await bootAspdBirthServer()
      const routes: string[] = []
      const target = internal as any
      const interactiveHandler = target.handleInteractiveTmuxBrokerDispatchTurn.bind(target)
      target.handleInteractiveTmuxBrokerDispatchTurn = async (...args: unknown[]) => {
        routes.push('interactive-tmux-broker')
        return await interactiveHandler(...args)
      }
      const headlessHandler = target.handleHeadlessBrokerDispatchTurn.bind(target)
      target.handleHeadlessBrokerDispatchTurn = async (...args: unknown[]) => {
        routes.push('headless-broker')
        return await headlessHandler(...args)
      }
      const intent = {
        ...baseIntent(),
        harness: {
          provider: 'openai' as const,
          id: mode === 'interactive' ? 'pi-cli' : 'codex-cli',
          interactive: mode === 'interactive',
        },
        execution: { preferredMode: mode },
      } as HrcRuntimeIntent
      seedAppIdentity(intent)
      const runId = `run-t08576-f-${mode}`
      expect(internal.db.runs.getByRunId(runId)).toBeNull()
      const response = await post('/v1/app-sessions/turns', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        prompt: `cold ${mode}`,
        runId,
      })
      expect(response.status).toBe(200)
      await settle(() => (ledger?.startCalls.length ?? 0) === 1)
      const row = internal.db.runs.getByRunId(runId)
      expect(row?.invocationId).toBeDefined()
      const inputId = row?.dispatchedInputId ?? row?.brokerSubmissionId
      expect(inputId).toBeDefined()
      new BrokerEventMapper({ db: internal.db, now: () => NOW }).apply({
        invocationId: row!.invocationId!,
        seq: 2,
        time: NOW,
        type: 'turn.started',
        turnId: `turn-${mode}`,
        inputId: inputId!,
        payload: { turnId: `turn-${mode}`, inputId: inputId! },
      } as InvocationEventEnvelope)
      const runtime = internal.db.runtimes.getByRuntimeId(response.body.runtimeId)
      expect({
        birthCount: ledger?.startCalls.length,
        enqueueCount: ledger?.enqueueCalls.length,
        routes,
        correlation: frozenPreparations(appHost)[0]?.intent?.placement?.correlation,
        env: identityProjection(dispatchedIdentityEnv()),
        targetNamedAtChokepoint: ledger?.startSnapshots[0]?.runIds.includes(runId),
        handleNamedAtChokepoint: ledger?.startSnapshots[0]?.activeRunIds.includes(runId),
        enqueue: ledger?.enqueueCalls[0]?.request,
        row: row && {
          hostSessionId: row.hostSessionId,
          generation: row.generation,
          runtimeId: row.runtimeId,
          operationId: row.operationId,
        },
        runtimeHandle: runtime?.activeRunId,
      }).toEqual({
        birthCount: 1,
        enqueueCount: 1,
        // Both fixture variants currently route through the interactive handler;
        // the label is input intent, never evidence of the selected route.
        routes: ['interactive-tmux-broker'],
        correlation: { hostSessionId: appHost, generation: 1 },
        env: {
          AGENT_HOST_SESSION_ID: appHost,
          HRC_HOST_SESSION_ID: appHost,
          AGENT_GENERATION: '1',
          HRC_GENERATION: '1',
        },
        targetNamedAtChokepoint: false,
        handleNamedAtChokepoint: false,
        enqueue: expect.objectContaining({
          invocationId: String(ledger?.startCalls[0]?.request.spec.invocationId),
          body: `cold ${mode}`,
        }),
        row: {
          hostSessionId: appHost,
          generation: 1,
          runtimeId: response.body.runtimeId,
          operationId: expect.any(String),
        },
        runtimeHandle: runId,
      })
    })
  }

  it('R-B7(g1/g2) initialPrompt birth is granted while promptless ensure is grantless', async () => {
    await bootAspdBirthServer()
    const prompted = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: 'prompted' },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
      initialPrompt: 'grant this start',
    })
    expect(prompted.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)
    const promptedEnv = dispatchedIdentityEnv()
    const promptedRunId = promptedEnv.HRC_RUN_ID
    expect(promptedRunId).toMatch(/^run-/)
    expect(promptedEnv.AGENT_RUN_ID).toBe(promptedRunId)
    const promptedHost = internal.db.appManagedSessions.findByKey(APP_ID, 'prompted')
      ?.activeHostSessionId as string
    const promptedRow = internal.db.runs.getByRunId(promptedRunId)
    const promptedRuntime = internal.db.runtimes.getByRuntimeId(prompted.body.runtimeId)
    expect(promptedRow).toMatchObject({
      hostSessionId: promptedHost,
      generation: 1,
      runtimeId: prompted.body.runtimeId,
      operationId: promptedRuntime?.activeOperationId,
    })
    expect(frozenPreparations(promptedHost)[0]?.intent?.placement?.correlation).toEqual({
      hostSessionId: promptedHost,
      generation: 1,
      runId: promptedRunId,
    })
    expectBirthAutoDispatch({
      hostSessionId: promptedHost,
      runtimeId: prompted.body.runtimeId,
      body: 'grant this start',
    })

    const priorCalls = ledger?.startCalls.length ?? 0
    const promptless = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: 'promptless' },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
    })
    expect(promptless.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === priorCalls + 1)
    const promptlessHost = internal.db.appManagedSessions.findByKey(APP_ID, 'promptless')
      ?.activeHostSessionId as string
    expect({
      birthCount: ledger?.startCalls.length,
      correlation: frozenPreparations(promptlessHost)[0]?.intent?.placement?.correlation,
      env: identityProjection(dispatchedIdentityEnv(priorCalls)),
    }).toEqual({
      birthCount: 2,
      correlation: { hostSessionId: promptlessHost, generation: 1 },
      env: {
        AGENT_HOST_SESSION_ID: promptlessHost,
        HRC_HOST_SESSION_ID: promptlessHost,
        AGENT_GENERATION: '1',
        HRC_GENERATION: '1',
      },
    })
    expectBirthAutoDispatch({
      hostSessionId: promptlessHost,
      runtimeId: promptless.body.runtimeId,
      body: '',
      callIndex: priorCalls,
    })
  })

  it('R-B7(g3) existing live ensure dispatches on the born invocation without another birth', async () => {
    await bootAspdBirthServer()
    const created = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
    })
    expect(created.status).toBe(200)
    const hostSessionId = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
      ?.activeHostSessionId as string
    const bornInvocationId = String(ledger?.startCalls[0]?.request.spec.invocationId)
    const priorRuns = new Set(internal.db.runs.listRuns({ hostSessionId }).map((run) => run.runId))

    const ensured = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
      initialPrompt: 'reuse the live birth',
    })
    expect(ensured.status).toBe(200)
    const newRuns = internal.db.runs
      .listRuns({ hostSessionId })
      .filter((run) => !priorRuns.has(run.runId))

    expect({
      birthCount: ledger?.startCalls.length,
      enqueueCount: ledger?.enqueueCalls.length,
      lastEnqueue: ledger?.enqueueCalls.at(-1)?.request,
      newRuns: newRuns.map((run) => ({
        runId: run.runId,
        hostSessionId: run.hostSessionId,
        generation: run.generation,
        runtimeId: run.runtimeId,
      })),
    }).toEqual({
      birthCount: 1,
      enqueueCount: 2,
      lastEnqueue: expect.objectContaining({
        invocationId: bornInvocationId,
        body: 'reuse the live birth',
      }),
      newRuns: [
        {
          runId: expect.any(String),
          hostSessionId,
          generation: 1,
          runtimeId: created.body.runtimeId,
        },
      ],
    })
  })

  it('R-B7(g4) forceRestart with an initial turn uses a fresh granted id', async () => {
    await bootAspdBirthServer()
    const historicalRunId = 'run-t08576-g4-historical'
    seedAppIdentity(adversarialIntent(historicalRunId))
    seedRun(historicalRunId, 'completed')
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: adversarialIntent(historicalRunId) },
      forceRestart: true,
      initialPrompt: 'fresh granted restart',
    })
    expect(response.status).toBe(200)
    const env = dispatchedIdentityEnv()
    const runId = env.HRC_RUN_ID
    expect({
      birthCount: ledger?.startCalls.length,
      runId,
      agentRunId: env.AGENT_RUN_ID,
      differsFromHistorical: runId !== historicalRunId,
      correlation: frozenPreparations(appHost)[0]?.intent?.placement?.correlation,
      row: internal.db.runs.getByRunId(runId),
    }).toEqual({
      birthCount: 1,
      runId: expect.stringMatching(/^run-/),
      agentRunId: runId,
      differsFromHistorical: true,
      correlation: { hostSessionId: appHost, generation: 1, runId },
      row: expect.objectContaining({
        hostSessionId: appHost,
        generation: 1,
        runtimeId: response.body.runtimeId,
      }),
    })
  })

  it('R-B7(g5) apply create with an initial turn grants its single birth', async () => {
    await bootAspdBirthServer()
    const intent = { ...baseIntent(), initialPrompt: 'apply-carried initial turn' }
    const response = await post('/v1/app-sessions/apply', {
      appId: APP_ID,
      sessions: [
        { appSessionKey: 'apply-prompted', spec: { kind: 'harness', runtimeIntent: intent } },
      ],
    })
    expect(response.status).toBe(200)
    const hostSessionId = internal.db.appManagedSessions.findByKey(APP_ID, 'apply-prompted')
      ?.activeHostSessionId as string
    const env = dispatchedIdentityEnv()
    const runId = env.HRC_RUN_ID
    const row = internal.db.runs.getByRunId(runId)
    expect({
      birthCount: ledger?.startCalls.length,
      env: identityProjection(env),
      correlation: frozenPreparations(hostSessionId)[0]?.intent?.placement?.correlation,
      row,
    }).toEqual({
      birthCount: 1,
      env: {
        AGENT_HOST_SESSION_ID: hostSessionId,
        HRC_HOST_SESSION_ID: hostSessionId,
        AGENT_RUN_ID: runId,
        HRC_RUN_ID: runId,
        AGENT_GENERATION: '1',
        HRC_GENERATION: '1',
      },
      correlation: { hostSessionId, generation: 1, runId },
      row: expect.objectContaining({ hostSessionId, generation: 1, runtimeId: expect.any(String) }),
    })
  })

  it('R-B7(g6) clear-context relaunch follows the stored initial-turn predicate', async () => {
    await bootAspdBirthServer()
    seedAppIdentity({ ...baseIntent(), initialPrompt: 'stored relaunch turn' })
    const responsePending = post('/v1/app-sessions/clear-context', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      relaunch: true,
    })
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)
    const invocationId = String(ledger?.startCalls[0]?.request.spec.invocationId)
    const birthRun = internal.db.runs
      .listRuns({ limit: 10 })
      .find((run) => run.invocationId === invocationId)
    expect(birthRun).toBeDefined()
    // The shared ASP compile double predates launch-carried route-decision metadata. The real
    // controller persists this marker before broker events arrive; add only that missing fixture
    // fact so the real mapper and wait ledger can settle the already-created HRC run.
    internal.db.runs.setCorrelationJson(
      String(birthRun?.runId),
      launchCarriedInvokeCorrelationJson()
    )
    internal.db.brokerInvocations.update(invocationId, {
      capabilitiesJson: JSON.stringify({ bracketMintingMode: 'harness-evidence' }),
      updatedAt: NOW,
    })
    const mapper = new BrokerEventMapper({ db: internal.db, now: () => NOW })
    mapper.apply({
      invocationId,
      seq: 2,
      time: NOW,
      type: 'turn.started',
      turnId: 'turn-g6',
      payload: { turnId: 'turn-g6', source: 'hook-observed' },
    } as InvocationEventEnvelope)
    mapper.apply({
      invocationId,
      seq: 3,
      time: NOW,
      type: 'submission.executed',
      turnId: 'turn-g6',
      payload: { submissionId: 'submission-g6', turnId: 'turn-g6' },
    } as InvocationEventEnvelope)
    mapper.apply({
      invocationId,
      seq: 4,
      time: NOW,
      type: 'turn.completed',
      turnId: 'turn-g6',
      payload: { turnId: 'turn-g6', status: 'completed' },
    } as InvocationEventEnvelope)
    expect(internal.db.runs.getByRunId(String(birthRun?.runId))?.brokerSubmissionId).toBe(
      'submission-g6'
    )
    const response = await responsePending
    expect(response.status).toBe(200)
    const successor = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
      ?.activeHostSessionId as string
    const env = dispatchedIdentityEnv()
    const runId = env.HRC_RUN_ID
    expect({
      birthCount: ledger?.startCalls.length,
      env: identityProjection(env),
      correlation: frozenPreparations(successor)[0]?.intent?.placement?.correlation,
      row: internal.db.runs.getByRunId(runId),
    }).toEqual({
      birthCount: 1,
      env: {
        AGENT_HOST_SESSION_ID: successor,
        HRC_HOST_SESSION_ID: successor,
        AGENT_RUN_ID: runId,
        HRC_RUN_ID: runId,
        AGENT_GENERATION: '2',
        HRC_GENERATION: '2',
      },
      correlation: { hostSessionId: successor, generation: 2, runId },
      row: expect.objectContaining({ hostSessionId: successor, generation: 2 }),
    })
  })

  it('R-B7(g7) [green-phase grant seam] refuses an ungranted app compile identity before graph writes', async () => {
    const hostSessionId = seedAppIdentity(baseIntent(), 'g7')
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)
    if (session === null) throw new Error('R-B7(g7) fixture session missing')
    const effectsBefore = hostEffectCounts(hostSessionId)
    const identity = await import('../app-session-identity')
    const assertStartGraph = Reflect.get(identity, 'assertAppStartGraphRunIdentity') as
      | ((db: HrcDatabase, target: typeof session, runId: string) => void)
      | undefined
    const refusal = await capturedRefusal(() =>
      assertStartGraph?.(internal.db, session, 'run-t08576-g7-ungranted')
    )
    expect({
      exportPresent: typeof assertStartGraph,
      refusal,
      effects: hostEffectCounts(hostSessionId),
    }).toEqual({
      exportPresent: 'function',
      refusal: {
        code: 'stale_context',
        reason: 'app-birth-run-grant-invalid',
        runId: 'run-t08576-g7-ungranted',
      },
      effects: effectsBefore,
    })
  })

  it('R-B7(s1-s5) [green-phase ALS seam] carries only a live grant and never authorizes a foreign tuple', async () => {
    const hostSessionId = seedAppIdentity(baseIntent(), 'als')
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)
    if (session === null) throw new Error('R-B7(s) fixture session missing')
    const identity = await import('../app-session-identity')
    const withOwner = Reflect.get(identity, 'withAppIdentityOwner') as
      | ((
          db: HrcDatabase,
          selector: { appId: string; appSessionKey: string },
          run: () => Promise<void>
        ) => Promise<void>)
      | undefined
    const issueGrant = Reflect.get(identity, 'issueAppBirthRunGrant') as
      | ((db: HrcDatabase, target: typeof session, runId: string) => { token: string } | undefined)
      | undefined
    const currentToken = Reflect.get(identity, 'currentAppBirthRunReservationToken') as
      | ((db: HrcDatabase, runId: string) => string | undefined)
      | undefined
    const runId = 'run-t08576-als'
    let token = ''
    let wrongIdToken: string | undefined
    let sealedCallback:
      | (() => { token: string | undefined; write: ReturnType<typeof writerOutcome> })
      | undefined
    let releasedCallback:
      | (() => { token: string | undefined; write: ReturnType<typeof writerOutcome> })
      | undefined
    let beforeSealForeign: ReturnType<typeof writerOutcome> | undefined

    expect({
      withOwner: typeof withOwner,
      issueGrant: typeof issueGrant,
      currentToken: typeof currentToken,
    }).toEqual({
      withOwner: 'function',
      issueGrant: 'function',
      currentToken: 'function',
    })
    await withOwner?.(internal.db, { appId: APP_ID, appSessionKey: 'als' }, async () => {
      token = issueGrant?.(internal.db, session, runId)?.token ?? ''
      wrongIdToken = currentToken?.(internal.db, 'run-t08576-als-other')
      internal.db.runtimes.insert({
        runtimeId: 'rt-t08576-als-bound',
        hostSessionId,
        scopeRef: APP_SCOPE,
        laneRef: 'als',
        generation: 1,
        transport: 'tmux',
        harness: 'pi-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        activeRunId: runId,
        activeOperationId: 'op-t08576-als-bound',
        createdAt: NOW,
        updatedAt: NOW,
      })
      beforeSealForeign = writerOutcome(() =>
        internal.db.runtimes.insert({
          runtimeId: 'rt-t08576-als-before-seal-foreign',
          hostSessionId,
          scopeRef: APP_SCOPE,
          laneRef: 'als',
          generation: 1,
          transport: 'tmux',
          harness: 'pi-cli',
          provider: 'openai',
          status: 'ready',
          supportsInflightInput: false,
          adopted: false,
          activeRunId: runId,
          activeOperationId: 'op-t08576-als-before-seal-foreign',
          createdAt: NOW,
          updatedAt: NOW,
        })
      )
      internal.db.runs.insert({
        runId,
        hostSessionId,
        runtimeId: 'rt-t08576-als-bound',
        operationId: 'op-t08576-als-bound',
        scopeRef: APP_SCOPE,
        laneRef: 'als',
        generation: 1,
        transport: 'tmux',
        status: 'running',
        acceptedAt: NOW,
        startedAt: NOW,
        updatedAt: NOW,
      })
      const foreignWrite = (suffix: string) =>
        writerOutcome(() =>
          internal.db.runtimes.insert({
            runtimeId: `rt-t08576-als-${suffix}`,
            hostSessionId,
            scopeRef: APP_SCOPE,
            laneRef: 'als',
            generation: 1,
            transport: 'tmux',
            harness: 'pi-cli',
            provider: 'openai',
            status: 'ready',
            supportsInflightInput: false,
            adopted: false,
            activeRunId: runId,
            activeOperationId: `op-t08576-als-${suffix}`,
            createdAt: NOW,
            updatedAt: NOW,
          })
        )
      sealedCallback = () => ({
        token: currentToken?.(internal.db, runId),
        write: foreignWrite('sealed'),
      })
      releasedCallback = () => ({
        token: currentToken?.(internal.db, runId),
        write: foreignWrite('released'),
      })
      await Promise.resolve()
      expect(sealedCallback()).toEqual({
        token: undefined,
        write: { threw: true, errorName: 'RunIdOwnershipError' },
      })
    })

    expect({
      tokenIssued: token.length > 0,
      wrongIdToken,
      beforeSealForeign,
      released: releasedCallback?.(),
      outside: currentToken?.(internal.db, runId),
      owner: internal.db.runtimes.getByRuntimeId('rt-t08576-als-bound')?.activeRunId,
    }).toEqual({
      tokenIssued: true,
      wrongIdToken: undefined,
      beforeSealForeign: { threw: true, errorName: 'RunIdOwnershipError' },
      released: { token: undefined, write: { threw: true, errorName: 'RunIdOwnershipError' } },
      outside: undefined,
      owner: runId,
    })
  })

  it('R-B7(r1-r5) [green-phase predicate/log seam] real mapper claims only the persisted birth tuple and preserves refused projections', async () => {
    await bootAspdBirthServer()
    const ensured = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
      initialPrompt: 'mapper-owned birth',
    })
    expect(ensured.status).toBe(200)
    const runId = dispatchedIdentityEnv().HRC_RUN_ID
    const run = internal.db.runs.getByRunId(runId)
    const hostSessionId = String(run?.hostSessionId)
    const runtimeId = String(run?.runtimeId)
    const operationId = String(run?.operationId)
    const invocationId = String(run?.invocationId)
    const logs: Array<{ level: string; event: string; details?: Record<string, unknown> }> = []
    const mapper = new BrokerEventMapper({
      db: internal.db,
      now: () => NOW,
      serverLog: (level, event, details) => logs.push({ level, event, details }),
    })
    const envelope = (targetInvocationId: string, seq: number): InvocationEventEnvelope =>
      ({
        invocationId: targetInvocationId,
        seq,
        time: NOW,
        type: 'turn.started',
        payload: {},
      }) as InvocationEventEnvelope
    const insertInvocation = (
      targetInvocationId: string,
      targetRuntimeId: string,
      targetOperationId: string,
      targetRunId: string
    ) =>
      internal.db.brokerInvocations.insert({
        invocationId: targetInvocationId,
        operationId: targetOperationId,
        runtimeId: targetRuntimeId,
        runId: targetRunId,
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: 'pi-cli',
        invocationState: 'ready',
        capabilitiesJson: '{}',
        specHash: `sha256:${targetInvocationId}:spec`,
        startRequestHash: `sha256:${targetInvocationId}:request`,
        selectedProfileHash: `sha256:${targetInvocationId}:profile`,
        createdAt: NOW,
        updatedAt: NOW,
      })
    const insertAppRuntime = (targetRuntimeId: string, targetOperationId: string) =>
      internal.db.runtimes.insert({
        runtimeId: targetRuntimeId,
        hostSessionId,
        scopeRef: APP_SCOPE,
        laneRef: KEY,
        generation: 1,
        transport: 'tmux',
        harness: 'pi-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        activeOperationId: targetOperationId,
        createdAt: NOW,
        updatedAt: NOW,
      })

    const legitimate = mapper.apply(envelope(invocationId, 2))
    const staleRuntimeId = 'rt-t08576-r-stale'
    const staleOperationId = 'op-t08576-r-stale'
    const staleInvocationId = 'inv-t08576-r-stale'
    insertAppRuntime(staleRuntimeId, staleOperationId)
    insertInvocation(staleInvocationId, staleRuntimeId, staleOperationId, runId)
    const stale = mapper.apply(envelope(staleInvocationId, 1))

    const foreign = seedForeignRuntime({ runtimeId: 'rt-t08576-r-foreign' })
    internal.db.runtimes.update(foreign.runtimeId, {
      activeOperationId: 'op-t08576-r-foreign',
      updatedAt: NOW,
    })
    insertInvocation('inv-t08576-r-foreign', foreign.runtimeId, 'op-t08576-r-foreign', runId)
    const crossHost = mapper.apply(envelope('inv-t08576-r-foreign', 1))

    internal.db.runtimes.updateRunId(runtimeId, undefined, NOW)
    insertInvocation('inv-t08576-r-replay', runtimeId, operationId, runId)
    const replay = mapper.apply(envelope('inv-t08576-r-replay', 1))

    const agentRunId = 'run-t08576-r-agent'
    const agent = seedForeignRuntime({ runtimeId: 'rt-t08576-r-agent' })
    internal.db.runtimes.update(agent.runtimeId, {
      activeOperationId: 'op-t08576-r-agent',
      updatedAt: NOW,
    })
    internal.db.runs.insert({
      runId: agentRunId,
      hostSessionId: agent.hostSessionId,
      runtimeId: agent.runtimeId,
      operationId: 'op-t08576-r-agent',
      scopeRef: agent.scopeRef,
      laneRef: agent.laneRef,
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: NOW,
      updatedAt: NOW,
    })
    insertInvocation('inv-t08576-r-agent', agent.runtimeId, 'op-t08576-r-agent', agentRunId)
    const agentProjection = mapper.apply(envelope('inv-t08576-r-agent', 1))

    expect({
      legitimate: {
        idempotent: legitimate.idempotent,
        runStatus: internal.db.runs.getByRunId(runId)?.status,
      },
      stale: {
        idempotent: stale.idempotent,
        brokerEvent: stale.brokerEvent.type,
        invocationState:
          internal.db.brokerInvocations.getByInvocationId(staleInvocationId)?.invocationState,
        activeRunId: internal.db.runtimes.getByRuntimeId(staleRuntimeId)?.activeRunId,
      },
      crossHost: {
        idempotent: crossHost.idempotent,
        brokerEvent: crossHost.brokerEvent.type,
        activeRunId: internal.db.runtimes.getByRuntimeId(foreign.runtimeId)?.activeRunId,
      },
      replay: {
        idempotent: replay.idempotent,
        activeRunId: internal.db.runtimes.getByRuntimeId(runtimeId)?.activeRunId,
      },
      agent: {
        idempotent: agentProjection.idempotent,
        activeRunId: internal.db.runtimes.getByRuntimeId(agent.runtimeId)?.activeRunId,
      },
      refusedLogs: logs
        .filter((entry) => entry.event === 'broker.run_handle_refused')
        .map((entry) => entry.details?.runtimeId),
    }).toEqual({
      legitimate: { idempotent: false, runStatus: 'running' },
      stale: {
        idempotent: false,
        brokerEvent: 'turn.started',
        invocationState: 'turn_active',
        activeRunId: undefined,
      },
      crossHost: {
        idempotent: false,
        brokerEvent: 'turn.started',
        activeRunId: undefined,
      },
      replay: { idempotent: false, activeRunId: runId },
      agent: { idempotent: false, activeRunId: agentRunId },
      refusedLogs: [staleRuntimeId, foreign.runtimeId],
    })
  })

  it('R-B7(i) concurrent app selectors cannot both dispatch the same caller run id', async () => {
    await bootAspdBirthServer()
    const oneHost = seedAppIdentity(baseIntent(), 'one')
    const twoHost = seedAppIdentity(baseIntent(), 'two')
    const twoEffectsBefore = hostEffectCounts(twoHost)
    const runId = 'run-t08576-concurrent'
    const gate = armInvocationStartGate()
    const oneTurn = post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: 'one' },
      prompt: 'one',
      runId,
    })
    const firstRace = await Promise.race([
      gate.reached.then(() => 'birth-reached' as const),
      oneTurn.then(() => 'first-settled' as const),
    ])
    let twoSettled = false
    const twoTurn = post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: 'two' },
      prompt: 'two',
      runId,
    }).finally(() => {
      twoSettled = true
    })
    await Bun.sleep(20)
    const loserSettledBeforeWinnerRelease = twoSettled
    gate.signalRelease()
    const [one, two] = await Promise.all([oneTurn, twoTurn])

    const outcomes = [
      { key: 'one', hostSessionId: oneHost, response: one },
      { key: 'two', hostSessionId: twoHost, response: two },
    ]
    const winner = outcomes.find(({ response }) => response.status === 200)
    const loser = outcomes.find(({ response }) => response.status === 409)
    const runRows = internal.db.sqlite
      .query<{ host_session_id: string; generation: number }, [string]>(
        'SELECT host_session_id, generation FROM runs WHERE run_id = ?'
      )
      .all(runId)
    const handles = internal.db.sqlite
      .query<{ host_session_id: string; generation: number }, [string]>(
        'SELECT host_session_id, generation FROM runtimes WHERE active_run_id = ? ORDER BY runtime_id'
      )
      .all(runId)

    expect({
      firstRace,
      loserSettledBeforeWinnerRelease,
      statuses: outcomes.map(({ response }) => response.status).sort((a, b) => a - b),
      loserCode: loser?.response.body.error?.code,
      loserReason: loser?.response.body.error?.detail?.reason,
      loserHost: loser?.hostSessionId,
      aspdStarts: ledger?.startCalls.length,
      runRows,
      runOwnedByWinner:
        runRows.length === 1 &&
        runRows[0]?.host_session_id === winner?.hostSessionId &&
        runRows[0]?.generation ===
          internal.db.sessions.getByHostSessionId(winner?.hostSessionId ?? '')?.generation,
      winnerHost: winner?.hostSessionId,
      winnerGeneration: winner
        ? internal.db.sessions.getByHostSessionId(winner.hostSessionId)?.generation
        : undefined,
      handles,
      allHandlesBelongToWinner: handles.every(
        (handle) =>
          handle.host_session_id === winner?.hostSessionId &&
          handle.generation ===
            internal.db.sessions.getByHostSessionId(winner?.hostSessionId ?? '')?.generation
      ),
      loserEffects: hostEffectCounts(twoHost),
    }).toEqual({
      firstRace: 'birth-reached',
      loserSettledBeforeWinnerRelease: true,
      statuses: [200, 409],
      loserCode: 'run_mismatch',
      loserReason: 'app-session-run-id-reused',
      loserHost: twoHost,
      aspdStarts: 1,
      runRows: [{ host_session_id: oneHost, generation: 1 }],
      runOwnedByWinner: true,
      winnerHost: oneHost,
      winnerGeneration: 1,
      handles: expect.any(Array),
      allHandlesBelongToWinner: true,
      loserEffects: twoEffectsBefore,
    })
  })

  it('R-B7(j) broker reuse performs no birth and the later persisted id is refused', async () => {
    seedAppIdentity()
    internal.db.runtimes.insert({
      runtimeId: 'rt-t08576-reuse',
      hostSessionId: appHost,
      scopeRef: APP_SCOPE,
      laneRef: KEY,
      generation: 1,
      transport: 'headless',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const runId = 'run-t08576-reuse'
    const first = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'reuse live broker',
      runId,
    })
    expect(first.status).toBe(200)
    expect(launchCalls).toEqual([`${appHost}:${runId}`])
    seedRun(runId, 'completed')
    launchCalls = []
    const second = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must now refuse',
      runId,
    })
    expect(second).toMatchObject({
      status: 409,
      body: { error: { code: 'run_mismatch', detail: { reason: 'app-session-run-id-reused' } } },
    })
    expect(launchCalls).toEqual([])
  })

  it('R-B7(k) agent pre-accepted run admission stays unchanged', async () => {
    const hostSessionId = `hsid-${randomUUID()}`
    const scopeRef = 'agent:smokey:project:hrc-runtime:task:T-08576'
    internal.db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef: 'agent-control',
      generation: 1,
      status: 'active',
      lastAppliedIntentJson: {
        ...baseIntent(),
        harness: { provider: 'anthropic', id: 'claude-code', interactive: false },
        execution: { preferredMode: 'headless' },
      },
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
    const runId = 'run-t08576-agent-preaccepted'
    internal.db.runs.insert({
      runId,
      hostSessionId,
      scopeRef,
      laneRef: 'agent-control',
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: NOW,
      updatedAt: NOW,
    })
    internal.db.runtimes.insert({
      runtimeId: 'rt-t08576-agent-control',
      hostSessionId,
      scopeRef,
      laneRef: 'agent-control',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
    ;(internal as unknown as Record<string, unknown>).executeHeadlessBrokerInputTurn = async () =>
      Response.json({ runId, hostSessionId, runtimeId: 'rt-t08576-agent-control' })
    ;(internal as unknown as Record<string, unknown>).startHeadlessBrokerRuntime = async () =>
      internal.db.runtimes.getByRuntimeId('rt-t08576-agent-control')
    ;(internal as unknown as Record<string, unknown>).startInteractiveTmuxBrokerRuntime =
      async () => internal.db.runtimes.getByRuntimeId('rt-t08576-agent-control')
    ;(internal as unknown as Record<string, unknown>).executeInteractiveBrokerInputTurn =
      async () => Response.json({ runId, hostSessionId, runtimeId: 'rt-t08576-agent-control' })
    const headlessIntent = {
      ...baseIntent(),
      harness: { provider: 'anthropic' as const, id: 'claude-code', interactive: false },
      execution: { preferredMode: 'headless' as const },
    }
    const response = await dispatchTurnForSession.call(
      internal,
      internal.db.sessions.getByHostSessionId(hostSessionId)!,
      headlessIntent,
      'agent control',
      { runId, ensureInteractiveRuntime: true }
    )
    expect(response.status).toBe(200)
    expect(internal.db.runs.getByRunId(runId)?.hostSessionId).toBe(hostSessionId)
  })

  it('R-B7(m) app reservation first refuses a crossing command run with zero command effects', async () => {
    await bootAspdBirthServer()
    seedAppIdentity()
    const idempotencyKey = 't08576-command-crossing-m'
    const runId = commandRunId(idempotencyKey)
    const gate = armInvocationStartGate()
    const appTurn = post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'hold app birth',
      runId,
    })
    const first = await Promise.race([
      gate.reached.then(() => 'birth-reached' as const),
      appTurn.then((response) => ({ response })),
    ])
    expect(first).toBe('birth-reached')
    const beforeCommand = counts()
    const commandSessionRef = 'agent:smokey:project:hrc-runtime:task:T-08576/lane:command-m'
    const command = await post('/v1/command-runs/launch', {
      configuredTargetId: 't08576',
      idempotencyKey,
      sessionRef: commandSessionRef,
      binding: commandBinding(commandSessionRef, 'command-m'),
    })
    expect({ command, effects: counts() }).toEqual({
      command: {
        status: 409,
        body: {
          error: expect.objectContaining({
            code: 'run_mismatch',
            detail: expect.objectContaining({ reason: 'run-id-reserved', runId }),
          }),
        },
      },
      effects: beforeCommand,
    })

    gate.signalRelease()
    expect((await appTurn).status).toBe(200)
    const winner = internal.db.runs.getByRunId(runId)
    expect(winner).toMatchObject({
      hostSessionId: appHost,
      generation: 1,
      runtimeId: expect.any(String),
      operationId: expect.any(String),
    })
    expect(
      internal.db.sqlite
        .query<{ count: number }, [string, string]>(
          'SELECT COUNT(*) AS count FROM runtimes WHERE active_run_id = ? AND host_session_id <> ?'
        )
        .get(runId, appHost)?.count
    ).toBe(0)
  })

  it('R-B7(n1) an existing command runtime handle blocks app reservation before app effects', async () => {
    seedAppIdentity()
    const commandHost = `hsid-${randomUUID()}`
    const commandScope = 'agent:smokey:project:hrc-runtime:task:T-08576'
    const runId = commandRunId('t08576-command-crossing-n1')
    internal.db.sessions.insert({
      hostSessionId: commandHost,
      scopeRef: commandScope,
      laneRef: 'command-n1',
      generation: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
    internal.db.runtimes.insert({
      runtimeId: 'rt-t08576-command-n1',
      runtimeKind: 'command',
      hostSessionId: commandHost,
      scopeRef: commandScope,
      laneRef: 'command-n1',
      generation: 1,
      transport: 'tmux',
      harness: 'custom',
      provider: 'custom',
      status: 'busy',
      commandSpec: { launchMode: 'exec', argv: ['/bin/true'] },
      supportsInflightInput: false,
      adopted: false,
      activeRunId: runId,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const before = counts()
    const response = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must see command handle',
      runId,
    })
    expect({ response, effects: counts(), launches: launchCalls }).toEqual({
      response: {
        status: 409,
        body: {
          error: expect.objectContaining({
            code: 'run_mismatch',
            detail: expect.objectContaining({ reason: 'app-session-run-id-reused', runId }),
          }),
        },
      },
      effects: before,
      launches: [],
    })
    internal.db.runs.insert({
      runId,
      hostSessionId: commandHost,
      runtimeId: 'rt-t08576-command-n1',
      scopeRef: commandScope,
      laneRef: 'command-n1',
      generation: 1,
      transport: 'tmux',
      status: 'completed',
      acceptedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    })
    expect(internal.db.runs.getByRunId(runId)?.hostSessionId).toBe(commandHost)
  })

  it('R-B7(n2/n3) command precheck first cannot write a reserved app run handle', async () => {
    await bootAspdBirthServer()
    seedAppIdentity()
    const idempotencyKey = 't08576-command-crossing-n2'
    const runId = commandRunId(idempotencyKey)
    const target = server as unknown as {
      resolveOrCreateCommandRunSession(sessionRef: string): Promise<unknown>
    }
    const resolveCommandSession = target.resolveOrCreateCommandRunSession.bind(target)
    let signalCommandResolved!: () => void
    let signalResumeCommand!: () => void
    const commandResolved = new Promise<void>((resolve) => {
      signalCommandResolved = resolve
    })
    const resumeCommand = new Promise<void>((resolve) => {
      signalResumeCommand = resolve
    })
    target.resolveOrCreateCommandRunSession = async (sessionRef: string) => {
      const session = await resolveCommandSession(sessionRef)
      signalCommandResolved()
      await resumeCommand
      return session
    }
    const commandSessionRef = 'agent:smokey:project:hrc-runtime:task:T-08576/lane:command-n2'
    const commandRun = post('/v1/command-runs/launch', {
      configuredTargetId: 't08576',
      idempotencyKey,
      sessionRef: commandSessionRef,
      binding: commandBinding(commandSessionRef, 'command-n2'),
    })
    const commandFirst = await Promise.race([
      commandResolved.then(() => 'command-resolved' as const),
      commandRun.then((response) => ({ response })),
    ])
    expect(commandFirst).toBe('command-resolved')

    const birthGate = armInvocationStartGate()
    const appTurn = post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'reserve while command waits',
      runId,
    })
    const first = await Promise.race([
      birthGate.reached.then(() => 'birth-reached' as const),
      appTurn.then((response) => ({ response })),
    ])
    if (first !== 'birth-reached') signalResumeCommand()
    expect(first).toBe('birth-reached')

    signalResumeCommand()
    const command = await commandRun
    expect(command).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'run_mismatch',
          detail: { reason: 'run-id-reserved', runId },
        },
      },
    })
    expect(
      internal.db.sqlite
        .query<{ count: number }, [string, string]>(
          'SELECT COUNT(*) AS count FROM runtimes WHERE active_run_id = ? AND host_session_id <> ?'
        )
        .get(runId, appHost)?.count
    ).toBe(0)

    birthGate.signalRelease()
    expect((await appTurn).status).toBe(200)
    const handleHosts = internal.db.sqlite
      .query<{ host_session_id: string }, [string]>(
        'SELECT host_session_id FROM runtimes WHERE active_run_id = ? ORDER BY host_session_id'
      )
      .all(runId)
      .map(({ host_session_id }) => host_session_id)
    expect(handleHosts.every((host) => host === appHost)).toBe(true)
    expect(internal.db.runs.getByRunId(runId)).toMatchObject({
      hostSessionId: appHost,
      generation: 1,
      runtimeId: expect.any(String),
      operationId: expect.any(String),
    })
  })

  it('R-B7(o) refuses a completed command-run id owned by a foreign agent host', async () => {
    seedAppIdentity()
    const foreignHost = `hsid-${randomUUID()}`
    internal.db.sessions.insert({
      hostSessionId: foreignHost,
      scopeRef: 'agent:foreign:project:hrc-runtime',
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
    const runId = 'run-command-t08576-existing'
    seedRun(runId, 'completed', foreignHost)
    const before = counts()
    const response = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must not claim command id',
      runId,
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      effects: counts(),
    }).toEqual({
      status: 409,
      reason: 'app-session-run-id-reused',
      effects: before,
    })
    expect(launchCalls).toEqual([])
  })

  it('R-B7(q) real insert/update refusals protect a live app run from direct finalization', () => {
    seedAppIdentity()
    const runId = 'run-t08576-live-direct'
    makeRunningAppRun(runId)

    const insertRuntimeId = 'rt-t08576-foreign-insert'
    const insertOutcome = writerOutcome(() =>
      seedForeignRuntime({ runtimeId: insertRuntimeId, laneRef: 'insert', activeRunId: runId })
    )
    const foreign = seedForeignRuntime({
      runtimeId: 'rt-t08576-foreign-update',
      laneRef: 'update',
    })
    const updateOutcome = writerOutcome(() =>
      internal.db.runtimes.update(foreign.runtimeId, { activeRunId: runId, updatedAt: NOW })
    )
    const beforeFinalize = internal.db.runtimes.getByRuntimeId(foreign.runtimeId)!

    finalizeRuntimeTermination(internal.db, beforeFinalize, '2026-09-17T07:11:00.000Z')

    expect({
      insertOutcome,
      insertAttemptState:
        internal.db.runtimes.getByRuntimeId(insertRuntimeId)?.status ?? ('absent' as const),
      updateOutcome,
      activeRunIdBeforeFinalize: beforeFinalize.activeRunId,
      finalizedRuntimeStatus: internal.db.runtimes.getByRuntimeId(foreign.runtimeId)?.status,
      appRunStatus: internal.db.runs.getByRunId(runId)?.status,
    }).toEqual({
      insertOutcome: { threw: true, errorName: 'RunIdOwnershipError' },
      insertAttemptState: 'absent',
      updateOutcome: { threw: true, errorName: 'RunIdOwnershipError' },
      activeRunIdBeforeFinalize: undefined,
      finalizedRuntimeStatus: 'terminated',
      appRunStatus: 'running',
    })
  })

  it('R-B7(q) real updateRunId refusal protects a live app run from HTTP termination', async () => {
    seedAppIdentity()
    const runId = 'run-t08576-live-http'
    makeRunningAppRun(runId)
    const foreign = seedForeignRuntime({
      runtimeId: 'rt-t08576-foreign-update-run-id',
      laneRef: 'update-run-id',
    })
    const updateRunIdOutcome = writerOutcome(() =>
      internal.db.runtimes.updateRunId(foreign.runtimeId, runId, NOW)
    )
    const activeRunIdBeforeTerminate = internal.db.runtimes.getByRuntimeId(
      foreign.runtimeId
    )?.activeRunId

    const response = await post('/v1/terminate', { runtimeId: foreign.runtimeId })

    expect({
      updateRunIdOutcome,
      activeRunIdBeforeTerminate,
      responseStatus: response.status,
      terminatedRuntimeStatus: internal.db.runtimes.getByRuntimeId(foreign.runtimeId)?.status,
      appRunStatus: internal.db.runs.getByRunId(runId)?.status,
    }).toEqual({
      updateRunIdOutcome: { threw: true, errorName: 'RunIdOwnershipError' },
      activeRunIdBeforeTerminate: undefined,
      responseStatus: 200,
      terminatedRuntimeStatus: 'terminated',
      appRunStatus: 'running',
    })
  })

  it('R-B7(q) refused foreign handle survives startup-reconcile mutation without failing the app run', () => {
    seedAppIdentity()
    const runId = 'run-t08576-live-startup'
    makeRunningAppRun(runId)
    const foreign = seedForeignRuntime({
      runtimeId: 'rt-t08576-foreign-startup',
      laneRef: 'startup',
    })
    const updateOutcome = writerOutcome(() =>
      internal.db.runtimes.update(foreign.runtimeId, { activeRunId: runId, updatedAt: NOW })
    )
    const beforeMutation = internal.db.runtimes.getByRuntimeId(foreign.runtimeId)!
    const session = internal.db.sessions.getByHostSessionId(foreign.hostSessionId)!

    markRuntimeDead(internal.db, session, beforeMutation, 'runtime', {
      reason: 't08576-startup-reconcile',
    })

    expect({
      updateOutcome,
      activeRunIdBeforeMutation: beforeMutation.activeRunId,
      reconciledRuntimeStatus: internal.db.runtimes.getByRuntimeId(foreign.runtimeId)?.status,
      appRunStatus: internal.db.runs.getByRunId(runId)?.status,
    }).toEqual({
      updateOutcome: { threw: true, errorName: 'RunIdOwnershipError' },
      activeRunIdBeforeMutation: undefined,
      reconciledRuntimeStatus: 'dead',
      appRunStatus: 'running',
    })
  })

  it('R-B7(q) controls allow own-host app and ordinary agent run handles', () => {
    seedAppIdentity()
    const appRunId = 'run-t08576-own-host-control'
    const appRuntimeId = 'rt-t08576-own-host-control'
    const appOperationId = 'op-t08576-own-host-control'
    internal.db.runtimes.insert({
      runtimeId: appRuntimeId,
      hostSessionId: appHost,
      scopeRef: APP_SCOPE,
      laneRef: KEY,
      generation: 1,
      transport: 'headless',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      activeOperationId: appOperationId,
      createdAt: NOW,
      updatedAt: NOW,
    })
    internal.db.runs.insert({
      runId: appRunId,
      hostSessionId: appHost,
      runtimeId: appRuntimeId,
      operationId: appOperationId,
      scopeRef: APP_SCOPE,
      laneRef: KEY,
      generation: 1,
      transport: 'headless',
      status: 'running',
      acceptedAt: NOW,
      startedAt: NOW,
      updatedAt: NOW,
    })
    internal.db.runtimes.updateRunId(appRuntimeId, appRunId, NOW)
    const differentRuntime = writerOutcome(() =>
      internal.db.runtimes.insert({
        runtimeId: 'rt-t08576-own-host-different-runtime',
        hostSessionId: appHost,
        scopeRef: APP_SCOPE,
        laneRef: KEY,
        generation: 1,
        transport: 'headless',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        activeRunId: appRunId,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const agentRuntime = seedForeignRuntime({
      runtimeId: 'rt-t08576-agent-control-q',
      laneRef: 'agent-control-q',
    })
    const agentRunId = 'run-t08576-agent-control-q'
    internal.db.runs.insert({
      runId: agentRunId,
      hostSessionId: agentRuntime.hostSessionId,
      scopeRef: agentRuntime.scopeRef,
      laneRef: agentRuntime.laneRef,
      generation: 1,
      transport: 'headless',
      status: 'running',
      acceptedAt: NOW,
      startedAt: NOW,
      updatedAt: NOW,
    })
    internal.db.runtimes.updateRunId(agentRuntime.runtimeId, agentRunId, NOW)

    expect({
      appHandle: internal.db.runtimes.getByRuntimeId(appRuntimeId)?.activeRunId,
      appRunStatus: internal.db.runs.getByRunId(appRunId)?.status,
      differentRuntime,
      differentRuntimePersisted: internal.db.runtimes.getByRuntimeId(
        'rt-t08576-own-host-different-runtime'
      ),
      agentHandle: internal.db.runtimes.getByRuntimeId(agentRuntime.runtimeId)?.activeRunId,
      agentRunStatus: internal.db.runs.getByRunId(agentRunId)?.status,
    }).toEqual({
      appHandle: appRunId,
      appRunStatus: 'running',
      differentRuntime: { threw: true, errorName: 'RunIdOwnershipError' },
      differentRuntimePersisted: null,
      agentHandle: agentRunId,
      agentRunStatus: 'running',
    })
  })
})
