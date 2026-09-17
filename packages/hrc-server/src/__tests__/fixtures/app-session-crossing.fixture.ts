/** Shared real-server setup for T-08576 app-session crossing acceptance tests. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcCommandSpec, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  handleAppSessionClearContext,
  handleAppSessionLiteralInput,
} from '../../app-session-handlers'
import { createHrcServer } from '../../index'
import type { HrcServer } from '../../index'
import type { HrcServerInstanceForHandlers } from '../../server-instance-context'

export const NOW = '2026-09-17T07:05:00.000Z'
export const APP_ID = 't08576'
export const KEY = 'crossing'
export const SCOPE = `app:${APP_ID}`
export const LANE = KEY

export type Deferred<T = void> = {
  promise: Promise<T>
  resolve(value: T): void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

export let root: string
export let socketPath: string
export let server: HrcServer
export let internal: HrcServerInstanceForHandlers & { db: HrcDatabase }
export let hostSessionId: string

export async function setUpAppSessionCrossingFixture(): Promise<void> {
  Reflect.deleteProperty(process.env, 'HRC_ALLOW_HARNESS_SHIM')
  root = await mkdtemp(join(tmpdir(), 't08576-cross-'))
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
  hostSessionId = `hsid-${randomUUID()}`
  internal.db.sessions.insert({
    hostSessionId,
    scopeRef: SCOPE,
    laneRef: LANE,
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  internal.db.sqlite.run(
    'INSERT INTO continuities (scope_ref, lane_ref, active_host_session_id, updated_at) VALUES (?, ?, ?, ?)',
    [SCOPE, LANE, hostSessionId, NOW]
  )
  internal.db.appManagedSessions.create({
    appId: APP_ID,
    appSessionKey: KEY,
    kind: 'command',
    activeHostSessionId: hostSessionId,
    generation: 1,
    status: 'active',
    lastAppliedSpec: {
      kind: 'command',
      command: { launchMode: 'exec', argv: ['/bin/true'] },
    },
    createdAt: NOW,
    updatedAt: NOW,
  })
}

export async function tearDownAppSessionCrossingFixture(): Promise<void> {
  await server.stop()
  await rm(root, { recursive: true, force: true })
}

export function commandRequest() {
  return {
    selector: { appId: APP_ID, appSessionKey: KEY },
    spec: {
      kind: 'command' as const,
      command: { launchMode: 'exec' as const, argv: ['/bin/true'] },
    },
    forceRestart: true,
  }
}

export function insertRuntime(
  session: HrcSessionRecord,
  command: HrcCommandSpec
): HrcRuntimeSnapshot {
  const id = `rt-${randomUUID()}`
  internal.db.runtimes.insert({
    runtimeId: id,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'tmux',
    harness: 'command',
    provider: 'command',
    runtimeKind: 'command',
    commandSpec: command,
    status: 'ready',
    tmuxJson: {
      socketPath: join(root, 'run', 'tmux.sock'),
      sessionName: `t08576-${id}`,
      sessionId: '$1',
      windowId: '@1',
      paneId: '%1',
    },
    supportsInflightInput: false,
    adopted: false,
    createdAt: NOW,
    updatedAt: NOW,
  })
  return internal.db.runtimes.getByRuntimeId(id)!
}

export function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://hrc${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function applyRequest(): Request {
  return jsonRequest('/v1/app-sessions/apply', {
    appId: APP_ID,
    sessions: [{ appSessionKey: KEY, spec: commandRequest().spec }],
  })
}

export function makeHarnessManaged(): void {
  const runtimeIntent = {
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
  internal.db.sqlite.run(
    "UPDATE app_managed_sessions SET kind = 'harness', last_applied_spec_json = ? WHERE app_id = ? AND app_session_key = ?",
    [JSON.stringify({ kind: 'harness', runtimeIntent }), APP_ID, KEY]
  )
  internal.db.sessions.updateIntent(hostSessionId, runtimeIntent, NOW)
}

export function continuityHost(): string | undefined {
  return internal.db.sqlite
    .query<{ active_host_session_id: string }, [string, string]>(
      'SELECT active_host_session_id FROM continuities WHERE scope_ref = ? AND lane_ref = ?'
    )
    .get(SCOPE, LANE)?.active_host_session_id
}

export function selectorSessions(): HrcSessionRecord[] {
  return internal.db.sqlite
    .query<
      {
        host_session_id: string
        scope_ref: string
        lane_ref: string
        generation: number
        status: string
        created_at: string
        updated_at: string
        ancestor_scope_refs_json: string
      },
      []
    >(`SELECT * FROM sessions WHERE scope_ref = '${SCOPE}' AND lane_ref = '${LANE}'`)
    .all()
    .map((row) => internal.db.sessions.getByHostSessionId(row.host_session_id)!)
}

export function availableRuntimeIds(host: string): string[] {
  return internal.db.runtimes
    .listByHostSessionId(host)
    .filter((runtime) => !['terminated', 'stale', 'dead', 'crashed'].includes(runtime.status))
    .map((runtime) => runtime.runtimeId)
}

export function errorCode(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'code' in value
    ? String((value as { code?: unknown }).code)
    : undefined
}

export async function responseBody(value: unknown): Promise<Record<string, unknown> | null> {
  return value instanceof Response ? ((await value.json()) as Record<string, unknown>) : null
}

export async function queuedLiteralAfterRotation(fence?: {
  expectedHostSessionId: string
  expectedGeneration: number
}): Promise<{
  inputWaitedForRotation: boolean
  clearError: string | undefined
  literalError: string | undefined
  sentPanes: string[]
  managedHost: string | undefined
  continuityHost: string | undefined
  successorGeneration: number | undefined
  predecessorLiteralEvents: number
  predecessorLastActivityAt: string | undefined
}> {
  const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
  const runtime = insertRuntime(session, { launchMode: 'exec', argv: ['/bin/true'] })
  const rotationEntered = deferred()
  const releaseRotation = deferred()
  const sentPanes: string[] = []
  const originalRotate = (internal as any).rotateSessionContext
  ;(internal as any).rotateSessionContext = async (...args: unknown[]) => {
    rotationEntered.resolve()
    await releaseRotation.promise
    return await originalRotate.apply(internal, args)
  }
  ;(internal as any).tmux = {
    sendLiteral: async (paneId: string) => sentPanes.push(paneId),
    sendKeys: async (paneId: string) => sentPanes.push(paneId),
    inspectSession: async () => ({ sessionId: '$1' }),
    terminate: async () => {},
  }

  const clear = handleAppSessionClearContext
    .call(
      internal,
      jsonRequest('/v1/app-sessions/clear-context', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        relaunch: false,
      })
    )
    .catch((error) => error)
  await rotationEntered.promise
  let inputSettled = false
  const literal = handleAppSessionLiteralInput
    .call(
      internal,
      jsonRequest('/v1/app-sessions/literal-input', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        text: 'must-not-hit-gen1',
        enter: false,
        ...(fence ? { fence } : {}),
      })
    )
    .catch((error) => error)
    .finally(() => {
      inputSettled = true
    })
  await Bun.sleep(20)

  const inputWaitedForRotation = !inputSettled
  releaseRotation.resolve()
  const [clearResult, literalResult] = await Promise.all([clear, literal])
  const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
  const successor = managed
    ? internal.db.sessions.getByHostSessionId(managed.activeHostSessionId)
    : null

  return {
    inputWaitedForRotation,
    clearError: errorCode(clearResult),
    literalError: errorCode(literalResult),
    sentPanes,
    managedHost: managed?.activeHostSessionId,
    continuityHost: continuityHost(),
    successorGeneration: successor?.generation,
    predecessorLiteralEvents: internal.db.hrcEvents.listByKind('app-session.literal-input', {
      hostSessionId,
    }).length,
    predecessorLastActivityAt: internal.db.runtimes.getByRuntimeId(runtime.runtimeId)
      ?.lastActivityAt,
  }
}
