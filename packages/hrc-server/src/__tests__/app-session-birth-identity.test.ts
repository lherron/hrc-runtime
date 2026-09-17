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

import { evaluateServerLifecycleAuthorization } from '../../../hrc-cli/src/cli-runtime/shutdown-intent'
import {
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  createBrokerTmuxTuiAllocator,
} from '../broker-interactive-handlers/substrate-allocator'
import { HarnessBrokerController } from '../broker/controller'
import { buildDispatchInvocation } from '../dispatch-invocation'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'
import { finalizeRuntimeTermination } from '../server-misc'
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

let root: string
let socketPath: string
let server: HrcServer
let internal: HrcServerInstanceForHandlers & { db: HrcDatabase }
let appHost: string
let launchCalls: string[]
let aspd: AspdDouble | undefined
let ledger: HostingLedger | undefined
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
    harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
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
  ledger = { commands: [], killedServers: [], startCalls: [], attachCalls: 0 }
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
        startInvocationFromRequest: async (...args: Parameters<typeof start>) => {
          const gate = invocationStartGate
          if (gate !== undefined) {
            gate.signalReached()
            await gate.release
            invocationStartGate = undefined
          }
          return await start(...args)
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

function forbiddenIntent(channel: 'lockedEnv' | 'env' | 'dispatchEnv'): HrcRuntimeIntent {
  const intent = baseIntent() as HrcRuntimeIntent & {
    placement: HrcRuntimeIntent['placement'] & Record<string, unknown>
  }
  intent.placement[channel] = { AGENT_ID: 'forged-app-agent' }
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

function dispatchedIdentityEnv(): Record<string, string> {
  const dispatch = ledger?.startCalls[0]?.dispatch as
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

function seedForeignRuntime(activeRunId: string): HrcRuntimeSnapshot {
  const foreignHost = `hsid-${randomUUID()}`
  const runtimeId = `rt-${randomUUID()}`
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
  internal.db.runtimes.insert({
    runtimeId,
    hostSessionId: foreignHost,
    scopeRef: 'agent:foreign:project:hrc-runtime',
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    createdAt: NOW,
    updatedAt: NOW,
  })
  // Seed the rev-5 residue directly so this termination-only red remains valid after the
  // repository handle writer starts refusing creation of such a foreign pointer.
  internal.db.sqlite.run('UPDATE runtimes SET active_run_id = ? WHERE runtime_id = ?', [
    activeRunId,
    runtimeId,
  ])
  return internal.db.runtimes.getByRuntimeId(runtimeId)!
}

describe('T-08576 app-session birth identity boundary', () => {
  it('R-B1/R-B2/R-B4 binds ensure birth correlation, launch env, persisted intent and frozen preparation', async () => {
    await bootAspdBirthServer()
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: adversarialIntent() },
    })
    expect(response.status).toBe(200)
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
    const appPreview = buildDispatchInvocation({
      ...baseIntent(),
      placement: {
        ...baseIntent().placement,
        correlation: { sessionRef: { scopeRef: 'app:t08576', laneRef: 'lane:preview' } },
      },
    } as HrcRuntimeIntent)
    await expect(appPreview).rejects.toThrow()

    const agentIntent = {
      ...baseIntent(),
      placement: {
        ...baseIntent().placement,
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

  it('R-B6 the app birth envelope cannot authorize as an operator', () => {
    const authorization = evaluateServerLifecycleAuthorization(
      {
        AGENT_HOST_SESSION_ID: 'hsid-t08576-app',
        HRC_HOST_SESSION_ID: 'hsid-t08576-app',
        AGENT_GENERATION: '1',
        HRC_GENERATION: '1',
      },
      'must not authorize'
    )
    expect(authorization.allowed).toBe(false)
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
        code: response.body.error?.code,
        effects: counts(),
      }).toEqual({
        status: 422,
        code: 'app-session-identity-env-forbidden',
        effects: before,
      })
      expect(launchCalls).toEqual([])
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

    expect({ status: response.status, code: response.body.error?.code, effects: counts() }).toEqual(
      {
        status: 422,
        code: 'app-session-identity-env-forbidden',
        effects: before,
      }
    )
    expect(launchCalls).toEqual([])
  })

  it('R-B3 refuses forbidden identity env on an existing ensure before any effect', async () => {
    seedAppIdentity()
    const before = counts()
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: forbiddenIntent('env') },
      forceRestart: true,
    })

    expect({ status: response.status, code: response.body.error?.code, effects: counts() }).toEqual(
      {
        status: 422,
        code: 'app-session-identity-env-forbidden',
        effects: before,
      }
    )
    expect(launchCalls).toEqual([])
  })

  it('R-B3 refuses a turns runtimeIntent identity override before birth', async () => {
    seedAppIdentity()
    const before = counts()
    const response = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must not launch',
      runtimeIntent: forbiddenIntent('dispatchEnv'),
    })

    expect({ status: response.status, code: response.body.error?.code, effects: counts() }).toEqual(
      {
        status: 422,
        code: 'app-session-identity-env-forbidden',
        effects: before,
      }
    )
    expect(launchCalls).toEqual([])
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

    expect({ status: response.status, code: response.body.error?.code, effects: counts() }).toEqual(
      {
        status: 422,
        code: 'app-session-identity-env-forbidden',
        effects: before,
      }
    )
    expect(internal.db.appManagedSessions.findByKey(APP_ID, KEY)).toEqual(beforeManaged)
    expect(launchCalls).toEqual([])
  })

  it('R-B3b rejects a stored forbidden intent at birth while preserving the identity', async () => {
    seedAppIdentity(forbiddenIntent('lockedEnv'))
    const before = counts()
    const beforeSession = internal.db.sessions.getByHostSessionId(appHost)
    const response = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must not launch',
    })

    expect({ status: response.status, code: response.body.error?.code }).toEqual({
      status: 422,
      code: 'app-session-identity-env-forbidden',
    })
    expect(counts()).toEqual(before)
    expect(internal.db.sessions.getByHostSessionId(appHost)).toEqual(beforeSession)
    expect(internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.status).toBe('active')
    expect(launchCalls).toEqual([])
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
    it(`R-B7(f) fresh cold ${mode} birth consumes exactly its caller run id`, async () => {
      await bootAspdBirthServer()
      const intent = {
        ...baseIntent(),
        harness: {
          provider: mode === 'interactive' ? ('anthropic' as const) : ('openai' as const),
          id: mode === 'interactive' ? 'claude-code' : 'codex-cli',
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
      expect(row).toMatchObject({ runId, hostSessionId: appHost, generation: 1 })
      expect(frozenPreparations(appHost)[0]?.intent?.placement?.correlation).toEqual({
        hostSessionId: appHost,
        generation: 1,
        runId,
      })
      expect(identityProjection(dispatchedIdentityEnv())).toMatchObject({
        HRC_RUN_ID: runId,
        AGENT_RUN_ID: runId,
      })
    })
  }

  it('R-B7(g) initialPrompt birth is granted while promptless ensure is grantless', async () => {
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
    expect(internal.db.runs.getByRunId(promptedRunId)).toMatchObject({
      hostSessionId: promptedHost,
      generation: 1,
    })

    const priorCalls = ledger?.startCalls.length ?? 0
    const promptless = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: 'promptless' },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
    })
    expect(promptless.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === priorCalls + 1)
    const secondDispatch = ledger?.startCalls[priorCalls]?.dispatch as Record<string, string>
    expect(secondDispatch).not.toHaveProperty('HRC_RUN_ID')
    expect(secondDispatch).not.toHaveProperty('AGENT_RUN_ID')
  })

  it('R-B7(i) concurrent app selectors cannot both dispatch the same caller run id', async () => {
    seedAppIdentity(baseIntent(), 'one')
    seedAppIdentity(baseIntent(), 'two')
    const runId = 'run-t08576-concurrent'
    const [one, two] = await Promise.all([
      post('/v1/app-sessions/turns', {
        selector: { appId: APP_ID, appSessionKey: 'one' },
        prompt: 'one',
        runId,
      }),
      post('/v1/app-sessions/turns', {
        selector: { appId: APP_ID, appSessionKey: 'two' },
        prompt: 'two',
        runId,
      }),
    ])
    expect([one.status, two.status].sort()).toEqual([200, 409])
    expect([one.body, two.body].find((body) => body.error)?.error).toMatchObject({
      code: 'run_mismatch',
      detail: { reason: 'app-session-run-id-reused' },
    })
    expect(launchCalls).toHaveLength(1)
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
    expect(internal.db.runs.getByRunId(runId)).toMatchObject({
      hostSessionId: appHost,
      generation: 1,
    })
    expect(dispatchedIdentityEnv()).toMatchObject({ HRC_RUN_ID: runId })
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
    expect(handleHosts).toEqual([appHost])
    expect(internal.db.runs.getByRunId(runId)?.hostSessionId).toBe(appHost)
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

  it('R-B7(q) direct foreign finalization cannot fail a live app run', () => {
    seedAppIdentity()
    const runId = 'run-t08576-live-direct'
    seedRun(runId, 'accepted')
    internal.db.sqlite.run("UPDATE runs SET status = 'running' WHERE run_id = ?", [runId])
    const foreign = seedForeignRuntime(runId)

    finalizeRuntimeTermination(internal.db, foreign, '2026-09-17T07:11:00.000Z')

    expect(internal.db.runs.getByRunId(runId)?.status).toBe('running')
    expect(internal.db.runtimes.getByRuntimeId(foreign.runtimeId)?.status).toBe('terminated')
  })

  it('R-B7(q) HTTP foreign termination cannot fail a live app run', async () => {
    seedAppIdentity()
    const runId = 'run-t08576-live-http'
    seedRun(runId, 'accepted')
    internal.db.sqlite.run("UPDATE runs SET status = 'running' WHERE run_id = ?", [runId])
    const foreign = seedForeignRuntime(runId)

    const response = await post('/v1/terminate', { runtimeId: foreign.runtimeId })

    expect(response.status).toBe(200)
    expect(internal.db.runs.getByRunId(runId)?.status).toBe('running')
    expect(internal.db.runtimes.getByRuntimeId(foreign.runtimeId)?.status).toBe('terminated')
  })
})
