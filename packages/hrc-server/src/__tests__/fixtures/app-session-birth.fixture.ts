/** Shared real-server setup for T-08576 app-session birth acceptance tests. */
import { expect } from 'bun:test'
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

import {
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  createBrokerTmuxTuiAllocator,
} from '../../broker-interactive-handlers/substrate-allocator'
import { HarnessBrokerController } from '../../broker/controller'
import { createHrcServer } from '../../index'
import type { HrcServer } from '../../index'
import type { HrcServerInstanceForHandlers } from '../../server-instance-context'
import {
  type AspdDouble,
  type HostingLedger,
  type Release,
  makeRelease,
  startAspdDouble,
  tmuxManagerDouble,
  workerClient,
} from './aspd-route-doubles'

export const NOW = '2026-09-17T07:10:00.000Z'
export const APP_ID = 't08576'
export const KEY = 'birth'
export const APP_SCOPE = `app:${APP_ID}`
export const PARTIAL_LIFECYCLE_ENVELOPE_MESSAGE =
  'refusing server lifecycle mutation: partial HRC/ASP session envelope; ' +
  'run from a clean operator shell or a recognized primary scope'

export let root: string
export let socketPath: string
export let server: HrcServer
export let internal: HrcServerInstanceForHandlers & { db: HrcDatabase }
export let appHost: string
export let launchCalls: string[]
export let aspd: AspdDouble | undefined
export type AppBirthHostingLedger = HostingLedger & {
  enqueueCalls: Array<{
    request: SubmissionEnqueueRequest
    response: SubmissionResponse
  }>
  startSnapshots: Array<{
    runIds: string[]
    activeRunIds: string[]
  }>
}
export let ledger: AppBirthHostingLedger | undefined
export let release: Release | undefined
export const savedEnv = new Map<string, string | undefined>()
export let invocationStartGate:
  | {
      reached: Promise<void>
      signalReached(): void
      release: Promise<void>
      signalRelease(): void
    }
  | undefined

export const IDENTITY_KEYS = [
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

export function baseIntent(): HrcRuntimeIntent {
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

export async function setUpAppSessionBirthFixture(): Promise<void> {
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
}

export async function tearDownAppSessionBirthFixture(): Promise<void> {
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
}

export function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
  process.env[name] = value
}

export function armInvocationStartGate(): NonNullable<typeof invocationStartGate> {
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

export function brokerReadinessEvents(
  invocationId: string
): AsyncIterable<InvocationEventEnvelope> {
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

export async function bootAspdBirthServer(): Promise<void> {
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

export async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://localhost${path}`, {
    unix: socketPath,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

export function counts(): Record<string, number> {
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

export function hostEffectCounts(hostSessionId: string): Record<string, number> {
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

export function seedAppIdentity(
  intent: HrcRuntimeIntent = baseIntent(),
  appSessionKey = KEY
): string {
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

export function forbiddenIntent(
  channel: 'lockedEnv' | 'env' | 'dispatchEnv',
  key: 'AGENT_ID' | 'HRC_SESSION_REF' = 'AGENT_ID'
): HrcRuntimeIntent {
  const intent = baseIntent() as HrcRuntimeIntent & {
    placement: HrcRuntimeIntent['placement'] & Record<string, unknown>
  }
  intent.placement[channel] = { [key]: 'forged-app-identity' }
  return intent
}

export function adversarialIntent(runId = 'run-forged'): HrcRuntimeIntent {
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

export function frozenPreparations(hostSessionId: string): any[] {
  return internal.db.sqlite
    .query<{ preparation_json: string }, [string]>(
      `SELECT preparation_json FROM runtime_operations
       WHERE host_session_id = ? AND preparation_json IS NOT NULL ORDER BY created_at ASC`
    )
    .all(hostSessionId)
    .map(({ preparation_json }) => JSON.parse(preparation_json))
}

export async function settle(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await Bun.sleep(10)
}

export function dispatchedIdentityEnv(callIndex = 0): Record<string, string> {
  const dispatch = ledger?.startCalls[callIndex]?.dispatch as
    | Record<string, string>
    | { dispatchEnv?: Record<string, string> }
    | undefined
  if (dispatch === undefined) return {}
  return 'dispatchEnv' in dispatch ? (dispatch.dispatchEnv ?? {}) : dispatch
}

export function identityProjection(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    IDENTITY_KEYS.filter((key) => env[key] !== undefined).map((key) => [key, env[key]!])
  )
}

export function expectBirthAutoDispatch(input: {
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

export function commandRunId(idempotencyKey: string): string {
  return `run-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
}

export function commandBinding(sessionRef: string, lane: string): Record<string, string> {
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

export async function capturedRefusal(
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

export function seedRun(
  runId: string,
  status: 'accepted' | 'completed',
  hostSessionId = appHost
): void {
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

export function seedForeignRuntime(
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

export function writerOutcome(call: () => unknown): { threw: boolean; errorName?: string } {
  try {
    call()
    return { threw: false }
  } catch (error) {
    return { threw: true, errorName: error instanceof Error ? error.name : String(error) }
  }
}

export function makeRunningAppRun(runId: string): void {
  seedRun(runId, 'accepted')
  internal.db.runs.update(runId, { status: 'running', updatedAt: NOW })
}
