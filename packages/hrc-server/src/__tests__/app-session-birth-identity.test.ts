/**
 * T-08576 R-B birth-boundary reds observable through the base HTTP/store surfaces.
 *
 * The future binding/grant helpers are intentionally not imported: a missing-export failure is
 * not a behavioral red. Real server composition and SQLite are used; only the broker dispatch
 * seam is replaced where the assertion requires proving that refusal happened before launch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'
import { finalizeRuntimeTermination } from '../server-misc'

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
  await rm(root, { recursive: true, force: true })
})

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

function seedAppIdentity(intent: HrcRuntimeIntent = baseIntent()): void {
  appHost = `hsid-${randomUUID()}`
  internal.db.sessions.insert({
    hostSessionId: appHost,
    scopeRef: APP_SCOPE,
    laneRef: KEY,
    generation: 1,
    status: 'active',
    lastAppliedIntentJson: intent,
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  internal.db.sqlite.run(
    'INSERT INTO continuities (scope_ref, lane_ref, active_host_session_id, updated_at) VALUES (?, ?, ?, ?)',
    [APP_SCOPE, KEY, appHost, NOW]
  )
  internal.db.appManagedSessions.create({
    appId: APP_ID,
    appSessionKey: KEY,
    kind: 'harness',
    activeHostSessionId: appHost,
    generation: 1,
    status: 'active',
    lastAppliedSpec: { kind: 'harness', runtimeIntent: intent },
    createdAt: NOW,
    updatedAt: NOW,
  })
}

function forbiddenIntent(channel: 'lockedEnv' | 'env' | 'dispatchEnv'): HrcRuntimeIntent {
  const intent = baseIntent() as HrcRuntimeIntent & {
    placement: HrcRuntimeIntent['placement'] & Record<string, unknown>
  }
  intent.placement[channel] = { AGENT_ID: 'forged-app-agent' }
  return intent
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
