/** T-08576 R-R1..R-R5: app rows are readable locally but never masquerade as agent seats. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcSessionRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { ensureAppSessionFromBody } from '../app-session-handlers'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
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

  it('R-R2 allowlist refuses an app ensure before identity, launch, or entry validation effects', async () => {
    const calls: string[] = []
    const instance = handlerInstance({
      options: { localPersonaAllowlist: ['smokey'] },
      notifyEvent: () => calls.push('event'),
      ensureCommandRuntimeForSession: async () => {
        calls.push('launch')
        throw new Error('launch must not be reached')
      },
    })
    let refusal: Record<string, unknown> = {}
    try {
      await ensureAppSessionFromBody.call(instance, {
        selector: { appId: 't08576', appSessionKey: 'blocked' },
        spec: { kind: 'command', command: { launchMode: 'exec', argv: ['/bin/true'] } },
      })
    } catch (error) {
      const value = error as { code?: string; detail?: Record<string, unknown> }
      refusal = { code: value.code, ...value.detail }
    }

    expect({
      refusal,
      calls,
      sessions: db.sqlite.query('SELECT * FROM sessions').all().length,
    }).toEqual({
      refusal: expect.objectContaining({
        code: 'stale_context',
        reason: 'app-session-not-allowed',
        scopeRef: 'app:t08576',
      }),
      calls: [],
      sessions: 0,
    })
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
