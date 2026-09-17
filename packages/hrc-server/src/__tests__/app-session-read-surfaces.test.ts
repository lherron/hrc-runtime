/** T-08576 R-R1..R-R5: app rows are readable locally but never masquerade as agent seats. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcSessionRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  handleAppSessionCapture,
  handleAppSessionInterrupt,
  handleAppSessionTerminate,
  handleApplyManagedAppSessions,
  handleListManagedAppSessions,
  handleRemoveAppSession,
} from '../app-session-handlers'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { assertLocalPersonaAllowed } from '../local-persona-policy'
import { listAllSessions } from '../selector-message-handlers'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'
import { archiveIdleSessions, handleListTargets } from '../target-message-handlers'
import { handleMailHintDecision, handleMailStopDecision } from '../wrkq/stop-gate-handlers'

const NOW = '2026-09-17T06:55:00.000Z'
let root: string
let dbPath: string
let db: HrcDatabase
let server: HrcServer | undefined

beforeEach(async () => {
  Reflect.deleteProperty(process.env, 'HRC_ALLOW_HARNESS_SHIM')
  root = await mkdtemp(join(tmpdir(), 't08576-read-'))
  dbPath = join(root, 'state.sqlite')
  db = openHrcDatabase(dbPath)
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  db.close()
  await rm(root, { recursive: true, force: true })
})

function seedSession(hostSessionId: string, scopeRef: string, laneRef: string): HrcSessionRecord {
  return db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef,
    generation: 1,
    status: 'active',
    continuation: { provider: 'anthropic', key: `cont-${hostSessionId}` },
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
}

function seedAppRuntime(runtimeId = 'rt-t08576-read'): void {
  seedSession('hsid-t08576-read-app', 'app:t08576', 'assistant')
  db.sqlite.run(
    'INSERT INTO continuities (scope_ref, lane_ref, active_host_session_id, updated_at) VALUES (?, ?, ?, ?)',
    ['app:t08576', 'assistant', 'hsid-t08576-read-app', NOW]
  )
  db.appManagedSessions.create({
    appId: 't08576',
    appSessionKey: 'assistant',
    kind: 'harness',
    activeHostSessionId: 'hsid-t08576-read-app',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  })
  db.runtimes.insert({
    runtimeId,
    hostSessionId: 'hsid-t08576-read-app',
    scopeRef: 'app:t08576',
    laneRef: 'assistant',
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
}

function handlerInstance(extra: Record<string, unknown> = {}): HrcServerInstanceForHandlers {
  return {
    db,
    listAllSessions,
    options: {},
    ...extra,
  } as unknown as HrcServerInstanceForHandlers
}

const EFFECT_TABLES = [
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
] as const

function effectCounts(): Record<string, number> {
  const existing = new Set(
    db.sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(({ name }) => name)
  )
  return Object.fromEntries(
    EFFECT_TABLES.filter((table) => existing.has(table)).map((table) => [
      table,
      db.sqlite.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
        ?.count ?? 0,
    ])
  )
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://hrc${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function refusalFrom(
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

async function bootPolicyServer(): Promise<string> {
  db.close()
  const runtimeRoot = join(root, 'policy-run')
  const stateRoot = join(root, 'policy-state')
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  const socketPath = join(runtimeRoot, 'hrc.sock')
  dbPath = join(stateRoot, 'state.sqlite')
  server = await createHrcServer({
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath: join(runtimeRoot, 'server.lock'),
    spoolDir: join(runtimeRoot, 'spool'),
    dbPath,
    tmuxSocketPath: join(runtimeRoot, 'tmux.sock'),
    localPersonaAllowlist: ['smokey'],
  })
  db = (server as unknown as { db: HrcDatabase }).db
  return socketPath
}

async function policyPost(
  socketPath: string,
  path: string,
  body: unknown
): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://localhost${path}`, {
    unix: socketPath,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

const policyIntent = {
  placement: {
    agentRoot: '/tmp/t08576-agent',
    projectRoot: '/tmp/t08576-project',
    cwd: '/tmp/t08576-project',
    runMode: 'task' as const,
    bundle: { kind: 'compose' as const, compose: [] },
    dryRun: true,
  },
  harness: { provider: 'anthropic' as const, id: 'claude-code', interactive: true },
}

const BLOCKED_POLICY_CASES = [
  {
    gate: 'ensure',
    path: '/v1/app-sessions/ensure',
    body: {
      selector: { appId: 't08576', appSessionKey: 'new' },
      spec: { kind: 'harness', runtimeIntent: policyIntent },
    },
  },
  {
    gate: 'ensure dry-run',
    path: '/v1/app-sessions/ensure',
    body: {
      selector: { appId: 't08576', appSessionKey: 'new' },
      spec: { kind: 'harness', runtimeIntent: policyIntent },
      dryRun: true,
    },
  },
  {
    gate: 'apply with sessions',
    path: '/v1/app-sessions/apply',
    body: {
      appId: 't08576',
      sessions: [
        {
          appSessionKey: 'new',
          spec: { kind: 'harness', runtimeIntent: policyIntent },
        },
      ],
    },
  },
  {
    gate: 'turns',
    path: '/v1/app-sessions/turns',
    body: {
      selector: { appId: 't08576', appSessionKey: 'assistant' },
      prompt: 'must not dispatch',
    },
  },
  {
    gate: 'in-flight input',
    path: '/v1/app-sessions/in-flight-input',
    body: {
      selector: { appId: 't08576', appSessionKey: 'assistant' },
      prompt: 'must not deliver',
    },
  },
  {
    gate: 'literal input',
    path: '/v1/app-sessions/literal-input',
    body: {
      selector: { appId: 't08576', appSessionKey: 'assistant' },
      text: 'must not send',
      enter: false,
    },
  },
  {
    gate: 'app clear-context',
    path: '/v1/app-sessions/clear-context',
    body: {
      selector: { appId: 't08576', appSessionKey: 'assistant' },
      relaunch: false,
    },
  },
  {
    gate: 'generic clear-context on app',
    path: '/v1/clear-context',
    body: { hostSessionId: 'hsid-t08576-read-app', relaunch: false },
  },
] as const

describe('T-08576 app read and policy surfaces', () => {
  it('R-R1 GET /v1/targets excludes active and orphan app rows while serving agents', async () => {
    seedAppRuntime()
    seedSession('hsid-t08576-orphan', 'app:t08576', 'orphan')
    seedSession('hsid-t08576-agent', 'agent:smokey:project:hrc-runtime', 'main')
    db.continuities.upsert({
      scopeRef: 'agent:smokey:project:hrc-runtime',
      laneRef: 'main',
      activeHostSessionId: 'hsid-t08576-agent',
      updatedAt: NOW,
    })

    let status = 200
    let scopes: string[] = []
    try {
      const response = handleListTargets.call(handlerInstance(), new URL('http://hrc/v1/targets'))
      const body = (await response.json()) as Array<{ scopeRef: string }>
      scopes = body.map((target) => target.scopeRef)
    } catch {
      status = 400
    }

    expect({ status, scopes }).toEqual({
      status: 200,
      scopes: ['agent:smokey:project:hrc-runtime'],
    })
  })

  for (const testCase of BLOCKED_POLICY_CASES) {
    it(`R-R2 allowlist refuses ${testCase.gate} before every effect`, async () => {
      const socketPath = await bootPolicyServer()
      seedAppRuntime()
      const before = effectCounts()
      const response = await policyPost(socketPath, testCase.path, testCase.body)

      expect({
        status: response.status,
        code: response.body.error?.code,
        reason: response.body.error?.detail?.reason,
        effects: effectCounts(),
      }).toEqual({
        status: 409,
        code: 'stale_context',
        reason: 'app-session-not-allowed',
        effects: before,
      })
    })
  }

  it('R-R2 exemptions remain allowed while an app allowlist is configured', async () => {
    seedAppRuntime()
    const calls: string[] = []
    const instance = handlerInstance({
      options: { localPersonaAllowlist: ['smokey'] },
      resolveManagedSessionRuntime: () => ({
        runtime: db.runtimes.getByRuntimeId('rt-t08576-read'),
      }),
      captureRuntime: async () => {
        calls.push('capture')
        return new Response(JSON.stringify({ ok: true }))
      },
      interruptRuntime: async () => {
        calls.push('interrupt')
        return new Response(JSON.stringify({ ok: true }))
      },
      terminateRuntime: async () => {
        calls.push('terminate')
        return new Response(JSON.stringify({ ok: true }))
      },
      removeAppSessionFromBody: async () => {
        calls.push('remove')
        return new Response(JSON.stringify({ removed: true }))
      },
    })

    expect(
      handleListManagedAppSessions.call(instance, new URL('http://hrc/?appId=t08576')).status
    ).toBe(200)
    expect(
      (
        await handleAppSessionCapture.call(
          instance,
          new URL('http://hrc/?appId=t08576&appSessionKey=assistant')
        )
      ).status
    ).toBe(200)
    expect(
      (
        await handleAppSessionInterrupt.call(
          instance,
          jsonRequest('/interrupt', {
            selector: { appId: 't08576', appSessionKey: 'assistant' },
          })
        )
      ).status
    ).toBe(200)
    expect(
      (
        await handleAppSessionTerminate.call(
          instance,
          jsonRequest('/terminate', {
            selector: { appId: 't08576', appSessionKey: 'assistant' },
          })
        )
      ).status
    ).toBe(200)
    expect(
      (
        await handleRemoveAppSession.call(
          instance,
          jsonRequest('/remove', {
            selector: { appId: 't08576', appSessionKey: 'assistant' },
          })
        )
      ).status
    ).toBe(200)
    expect(
      (
        await handleApplyManagedAppSessions.call(
          instance,
          jsonRequest('/apply', { appId: 't08576', sessions: [], pruneMissing: true })
        )
      ).status
    ).toBe(200)
    expect(calls).toEqual(['capture', 'interrupt', 'terminate', 'remove', 'remove'])
  })

  it('R-R2 preserves the existing agent allowlist behavior', async () => {
    const instance = handlerInstance({ options: { localPersonaAllowlist: ['smokey'] } })
    expect(() =>
      assertLocalPersonaAllowed(instance, 'agent:smokey:project:hrc-runtime')
    ).not.toThrow()
    expect(
      await refusalFrom(() =>
        assertLocalPersonaAllowed(instance, 'agent:mable:project:hrc-runtime')
      )
    ).toEqual(
      expect.objectContaining({
        code: 'stale_context',
        reason: 'local-persona-not-allowed',
        agentId: 'mable',
      })
    )
  })

  it('R-R3 reports app capabilities false with an allowlist and true without one', async () => {
    db.close()
    const runtimeRoot = join(root, 'run')
    const stateRoot = join(root, 'state')
    await mkdir(runtimeRoot, { recursive: true })
    await mkdir(stateRoot, { recursive: true })
    const socketPath = join(runtimeRoot, 'hrc.sock')
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath: join(runtimeRoot, 'server.lock'),
      spoolDir: join(runtimeRoot, 'spool'),
      dbPath: join(stateRoot, 'state.sqlite'),
      tmuxSocketPath: join(runtimeRoot, 'tmux.sock'),
      localPersonaAllowlist: ['smokey'],
    })
    const restricted = (await (
      await fetch('http://localhost/v1/status', { unix: socketPath })
    ).json()) as { capabilities: { platform: Record<string, boolean> } }
    await server.stop()
    server = undefined
    await rm(runtimeRoot, { recursive: true, force: true })
    await mkdir(runtimeRoot, { recursive: true })
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath: join(runtimeRoot, 'server.lock'),
      spoolDir: join(runtimeRoot, 'spool'),
      dbPath: join(stateRoot, 'state.sqlite'),
      tmuxSocketPath: join(runtimeRoot, 'tmux.sock'),
    })
    const unrestricted = (await (
      await fetch('http://localhost/v1/status', { unix: socketPath })
    ).json()) as { capabilities: { platform: Record<string, boolean> } }
    db = openHrcDatabase(dbPath)

    const keys = ['appOwnedSessions', 'appHarnessSessions', 'commandSessions', 'literalInput']
    expect(
      Object.fromEntries(keys.map((key) => [key, restricted.capabilities.platform[key]]))
    ).toEqual(Object.fromEntries(keys.map((key) => [key, false])))
    expect(
      Object.fromEntries(keys.map((key) => [key, unrestricted.capabilities.platform[key]]))
    ).toEqual(Object.fromEntries(keys.map((key) => [key, true])))
  })

  it('R-R4 mail stop and hint treat app runtimes as non-addressable without ledger writes', async () => {
    seedAppRuntime('rt-t08576-mail')
    let ledgerCalls = 0
    const instance = handlerInstance({
      wrkqLedger: {
        pendingView: async () => {
          ledgerCalls += 1
          return { blocking: [], items: [] }
        },
      },
    })
    const request = () =>
      new Request('http://hrc/v1/internal/mail/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtimeId: 'rt-t08576-mail' }),
      })

    let stop: unknown
    try {
      stop = await (await handleMailStopDecision.call(instance, request())).json()
    } catch (error) {
      stop = { error: (error as { code?: string }).code }
    }
    const hint = await (await handleMailHintDecision.call(instance, request())).json()

    const refusalRows = db.sqlite
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM hrcmail_stop_refusals WHERE runtime_id = ?'
      )
      .get('rt-t08576-mail')?.count
    expect({ stop, hint, ledgerCalls, refusalRows }).toEqual({
      stop: expect.objectContaining({ decision: 'allow', reason: 'not-mail-addressable' }),
      hint: expect.objectContaining({ heldCount: 0 }),
      ledgerCalls: 0,
      refusalRows: 0,
    })
  })

  it('R-R5 archive-abandoned explicitly counts and preserves app sessions', () => {
    const app = seedSession('hsid-t08576-idle-app', 'app:t08576', 'idle')
    const instance = handlerInstance({
      listAllSessions: () => [app],
      listIdleSessionCandidates: () => new Set([app.hostSessionId]),
    })

    const result = archiveIdleSessions(instance, 7) as Record<string, number>

    expect(result).toMatchObject({ archived: 0, skippedApp: 1 })
    expect(db.sessions.getByHostSessionId(app.hostSessionId)?.status).toBe('active')
  })
})
