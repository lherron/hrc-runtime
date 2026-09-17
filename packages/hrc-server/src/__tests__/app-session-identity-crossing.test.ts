/**
 * T-08576 R-X ownership crossings. The daemon instance is real (including its real database and
 * handler composition); only launch, tmux I/O, delivery entry, and rotation entry are manually
 * gated. Production invalidation, teardown, and trailing event writers remain active.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcCommandSpec, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  ensureAppSessionFromBody,
  handleAppSessionClearContext,
  handleAppSessionDispatchTurn,
  handleAppSessionInFlightInput,
  handleAppSessionLiteralInput,
  handleApplyManagedAppSessions,
  removeAppSessionFromBody,
} from '../app-session-handlers'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

const NOW = '2026-09-17T07:05:00.000Z'
const APP_ID = 't08576'
const KEY = 'crossing'
const SCOPE = `app:${APP_ID}`
const LANE = KEY

type Deferred<T = void> = {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

let root: string
let socketPath: string
let server: HrcServer
let internal: HrcServerInstanceForHandlers & { db: HrcDatabase }
let hostSessionId: string

beforeEach(async () => {
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
})

afterEach(async () => {
  await server.stop()
  await rm(root, { recursive: true, force: true })
})

function commandRequest() {
  return {
    selector: { appId: APP_ID, appSessionKey: KEY },
    spec: {
      kind: 'command' as const,
      command: { launchMode: 'exec' as const, argv: ['/bin/true'] },
    },
    forceRestart: true,
  }
}

function insertRuntime(session: HrcSessionRecord, command: HrcCommandSpec): HrcRuntimeSnapshot {
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

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://hrc${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function applyRequest(): Request {
  return jsonRequest('/v1/app-sessions/apply', {
    appId: APP_ID,
    sessions: [{ appSessionKey: KEY, spec: commandRequest().spec }],
  })
}

function makeHarnessManaged(): void {
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

function continuityHost(): string | undefined {
  return internal.db.sqlite
    .query<{ active_host_session_id: string }, [string, string]>(
      'SELECT active_host_session_id FROM continuities WHERE scope_ref = ? AND lane_ref = ?'
    )
    .get(SCOPE, LANE)?.active_host_session_id
}

function selectorSessions(): HrcSessionRecord[] {
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

function availableRuntimeIds(host: string): string[] {
  return internal.db.runtimes
    .listByHostSessionId(host)
    .filter((runtime) => !['terminated', 'stale', 'dead', 'crashed'].includes(runtime.status))
    .map((runtime) => runtime.runtimeId)
}

function errorCode(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'code' in value
    ? String((value as { code?: unknown }).code)
    : undefined
}

async function responseBody(value: unknown): Promise<Record<string, unknown> | null> {
  return value instanceof Response ? ((await value.json()) as Record<string, unknown>) : null
}

async function queuedLiteralAfterRotation(fence?: {
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

describe('T-08576 app identity owner crossings', () => {
  it('R-X1 serializes ensure-create launch and removal to one live identity', async () => {
    const entered = deferred()
    const release = deferred()
    let launchCount = 0
    let launchReleased = false
    let launchedRuntime: HrcRuntimeSnapshot | undefined
    const inspected: string[] = []
    const terminated: Array<{ sessionName: string; afterLaunchRelease: boolean }> = []
    ;(internal as any).tmux = {
      inspectSession: async (sessionName: string) => {
        inspected.push(sessionName)
        return { sessionId: '$1' }
      },
      terminate: async (sessionName: string) => {
        terminated.push({ sessionName, afterLaunchRelease: launchReleased })
      },
    }
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launchCount += 1
      entered.resolve()
      await release.promise
      launchedRuntime = insertRuntime(session, command)
      return launchedRuntime
    }

    const ensure = ensureAppSessionFromBody.call(internal, commandRequest()).catch((error) => error)
    await entered.promise
    let removeSettled = false
    const remove = removeAppSessionFromBody
      .call(internal, { selector: { appId: APP_ID, appSessionKey: KEY } })
      .catch((error) => error)
      .finally(() => {
        removeSettled = true
      })
    await Bun.sleep(20)

    const removeWaitedForLaunch = !removeSettled
    launchReleased = true
    release.resolve()
    const [ensureResult, removeResult] = await Promise.all([ensure, remove])
    const expectedSessionName = launchedRuntime?.tmuxJson?.sessionName

    expect({
      removeWaitedForLaunch,
      launchCount,
      ensureError: errorCode(ensureResult),
      removeError: errorCode(removeResult),
      inspected,
      terminated,
      managedStatus: internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.status,
      predecessorStatus: internal.db.sessions.getByHostSessionId(hostSessionId)?.status,
      availableRuntimeIds: availableRuntimeIds(hostSessionId),
    }).toEqual({
      removeWaitedForLaunch: true,
      launchCount: 1,
      ensureError: undefined,
      removeError: undefined,
      inspected: [expectedSessionName],
      terminated: [{ sessionName: expectedSessionName, afterLaunchRelease: true }],
      managedStatus: 'removed',
      predecessorStatus: 'archived',
      availableRuntimeIds: [],
    })
  })

  it('R-X2 holds ensure behind removal teardown and then returns removed', async () => {
    const runtime = insertRuntime(internal.db.sessions.getByHostSessionId(hostSessionId)!, {
      launchMode: 'exec',
      argv: ['/bin/true'],
    })
    const terminateEntered = deferred()
    const releaseTerminate = deferred()
    let launches = 0
    ;(internal as any).tmux = {
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async () => {
        terminateEntered.resolve()
        await releaseTerminate.promise
      },
    }
    ;(internal as any).ensureCommandRuntimeForSession = async () => {
      launches += 1
      return runtime
    }

    const remove = removeAppSessionFromBody.call(internal, {
      selector: { appId: APP_ID, appSessionKey: KEY },
    })
    await terminateEntered.promise
    let ensureSettled = false
    const ensure = ensureAppSessionFromBody
      .call(internal, commandRequest())
      .catch((error) => error)
      .finally(() => {
        ensureSettled = true
      })
    await Bun.sleep(20)
    const ensureWaitedForRemove = !ensureSettled
    releaseTerminate.resolve()
    const [, ensureResult] = await Promise.all([remove, ensure])

    expect(ensureWaitedForRemove).toBe(true)
    expect((ensureResult as { code?: string }).code).toBe('app_session_removed')
    expect(launches).toBe(0)
  })

  it('R-X3 holds clear-context behind an existing-session relaunch', async () => {
    const launchEntered = deferred()
    const releaseLaunch = deferred()
    let launchedRuntime: HrcRuntimeSnapshot | undefined
    const settlementOrder: string[] = []
    const terminated: string[] = []
    ;(internal as any).tmux = {
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async (sessionName: string) => terminated.push(sessionName),
    }
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launchEntered.resolve()
      await releaseLaunch.promise
      launchedRuntime = insertRuntime(session, command)
      return launchedRuntime
    }

    const ensure = ensureAppSessionFromBody
      .call(internal, commandRequest())
      .then((response) => {
        settlementOrder.push('ensure')
        return response
      })
      .catch((error) => error)
    await launchEntered.promise
    let clearSettled = false
    const clear = handleAppSessionClearContext
      .call(
        internal,
        jsonRequest('/v1/app-sessions/clear-context', {
          selector: { appId: APP_ID, appSessionKey: KEY },
          relaunch: false,
        })
      )
      .then((response) => {
        settlementOrder.push('clear')
        return response
      })
      .catch((error) => error)
      .finally(() => {
        clearSettled = true
      })
    await Bun.sleep(20)
    const clearWaitedForLaunch = !clearSettled
    releaseLaunch.resolve()
    const [ensureResult, clearResult] = await Promise.all([ensure, clear])
    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
    const successor = managed
      ? internal.db.sessions.getByHostSessionId(managed.activeHostSessionId)
      : null

    expect({
      clearWaitedForLaunch,
      settlementOrder,
      ensureError: errorCode(ensureResult),
      clearError: errorCode(clearResult),
      managedHost: managed?.activeHostSessionId,
      continuityHost: continuityHost(),
      successorGeneration: successor?.generation,
      isSuccessor:
        managed?.activeHostSessionId !== undefined && managed.activeHostSessionId !== hostSessionId,
      predecessorStatus: internal.db.sessions.getByHostSessionId(hostSessionId)?.status,
      terminated,
    }).toEqual({
      clearWaitedForLaunch: true,
      settlementOrder: ['ensure', 'clear'],
      ensureError: undefined,
      clearError: undefined,
      managedHost: managed?.activeHostSessionId,
      continuityHost: managed?.activeHostSessionId,
      successorGeneration: 2,
      isSuccessor: true,
      predecessorStatus: 'archived',
      terminated: [launchedRuntime?.tmuxJson?.sessionName],
    })
  })

  it('R-X4 holds ensure behind rotation and launches only on the successor', async () => {
    const rotationEntered = deferred()
    const releaseRotation = deferred()
    const originalRotate = (internal as any).rotateSessionContext
    const launchHosts: string[] = []
    ;(internal as any).rotateSessionContext = async (...args: unknown[]) => {
      rotationEntered.resolve()
      await releaseRotation.promise
      return await originalRotate.apply(internal, args)
    }
    ;(internal as any).tmux = {
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async () => {},
    }
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launchHosts.push(session.hostSessionId)
      return insertRuntime(session, command)
    }

    const clear = handleAppSessionClearContext.call(
      internal,
      jsonRequest('/v1/app-sessions/clear-context', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        relaunch: false,
      })
    )
    await rotationEntered.promise
    let ensureSettled = false
    const ensure = ensureAppSessionFromBody
      .call(internal, commandRequest())
      .catch((error) => error)
      .finally(() => {
        ensureSettled = true
      })
    await Bun.sleep(20)
    const ensureWaitedForRotation = !ensureSettled
    releaseRotation.resolve()
    const [clearResult, ensureResult] = await Promise.all([clear.catch((error) => error), ensure])
    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
    const successor = managed
      ? internal.db.sessions.getByHostSessionId(managed.activeHostSessionId)
      : null

    expect({
      ensureWaitedForRotation,
      clearError: errorCode(clearResult),
      ensureError: errorCode(ensureResult),
      launchHosts,
      managedHost: managed?.activeHostSessionId,
      continuityHost: continuityHost(),
      successorGeneration: successor?.generation,
      isSuccessor:
        managed?.activeHostSessionId !== undefined && managed.activeHostSessionId !== hostSessionId,
    }).toEqual({
      ensureWaitedForRotation: true,
      clearError: undefined,
      ensureError: undefined,
      launchHosts: [managed?.activeHostSessionId],
      managedHost: managed?.activeHostSessionId,
      continuityHost: managed?.activeHostSessionId,
      successorGeneration: 2,
      isSuccessor: true,
    })
  })

  it('R-X5 lets apply finish reactivation before a concurrent remove', async () => {
    internal.db.appManagedSessions.update(APP_ID, KEY, {
      status: 'removed',
      removedAt: NOW,
      updatedAt: NOW,
    })
    internal.db.sessions.updateStatus(hostSessionId, 'archived', NOW)
    const launchEntered = deferred()
    const releaseLaunch = deferred()
    let launchReleased = false
    let launchedRuntime: HrcRuntimeSnapshot | undefined
    const launchHosts: string[] = []
    const terminated: Array<{ sessionName: string; afterLaunchRelease: boolean }> = []
    ;(internal as any).tmux = {
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async (sessionName: string) => {
        terminated.push({ sessionName, afterLaunchRelease: launchReleased })
      },
    }
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launchHosts.push(session.hostSessionId)
      launchEntered.resolve()
      await releaseLaunch.promise
      launchedRuntime = insertRuntime(session, command)
      return launchedRuntime
    }

    const apply = handleApplyManagedAppSessions
      .call(internal, applyRequest())
      .catch((error) => error)
    await launchEntered.promise
    let removeSettled = false
    const remove = removeAppSessionFromBody
      .call(internal, { selector: { appId: APP_ID, appSessionKey: KEY } })
      .catch((error) => error)
      .finally(() => {
        removeSettled = true
      })
    await Bun.sleep(20)
    const removeWaitedForApply = !removeSettled
    launchReleased = true
    releaseLaunch.resolve()
    const [applyResult, removeResult] = await Promise.all([apply, remove])
    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
    const successorHost = managed?.activeHostSessionId

    expect({
      removeWaitedForApply,
      applyError: errorCode(applyResult),
      removeError: errorCode(removeResult),
      launchHosts,
      managedStatus: managed?.status,
      successorHost,
      isSuccessor: successorHost !== undefined && successorHost !== hostSessionId,
      successorStatus: successorHost
        ? internal.db.sessions.getByHostSessionId(successorHost)?.status
        : undefined,
      availableRuntimeIds: successorHost ? availableRuntimeIds(successorHost) : [],
      terminated,
    }).toEqual({
      removeWaitedForApply: true,
      applyError: undefined,
      removeError: undefined,
      launchHosts: [successorHost],
      managedStatus: 'removed',
      successorHost,
      isSuccessor: true,
      successorStatus: 'archived',
      availableRuntimeIds: [],
      terminated: [
        { sessionName: launchedRuntime?.tmuxJson?.sessionName, afterLaunchRelease: true },
      ],
    })
  })

  it('R-X6 lets remove finish teardown before apply reactivates on a successor', async () => {
    insertRuntime(internal.db.sessions.getByHostSessionId(hostSessionId)!, {
      launchMode: 'exec',
      argv: ['/bin/true'],
    })
    const terminateEntered = deferred()
    const releaseTerminate = deferred()
    const launchHosts: string[] = []
    ;(internal as any).tmux = {
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async () => {
        terminateEntered.resolve()
        await releaseTerminate.promise
      },
    }
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launchHosts.push(session.hostSessionId)
      return insertRuntime(session, command)
    }

    const remove = removeAppSessionFromBody.call(internal, {
      selector: { appId: APP_ID, appSessionKey: KEY },
    })
    await terminateEntered.promise
    let applySettled = false
    const apply = handleApplyManagedAppSessions
      .call(internal, applyRequest())
      .catch((error) => error)
      .finally(() => {
        applySettled = true
      })
    await Bun.sleep(20)
    const applyWaitedForRemove = !applySettled
    releaseTerminate.resolve()
    const [removeResult, applyResult] = await Promise.all([remove.catch((error) => error), apply])
    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
    const successor = managed
      ? internal.db.sessions.getByHostSessionId(managed.activeHostSessionId)
      : null

    expect({
      applyWaitedForRemove,
      removeError: errorCode(removeResult),
      applyError: errorCode(applyResult),
      managedStatus: managed?.status,
      managedHost: managed?.activeHostSessionId,
      continuityHost: continuityHost(),
      successorGeneration: successor?.generation,
      isSuccessor:
        managed?.activeHostSessionId !== undefined && managed.activeHostSessionId !== hostSessionId,
      predecessorStatus: internal.db.sessions.getByHostSessionId(hostSessionId)?.status,
      launchHosts,
    }).toEqual({
      applyWaitedForRemove: true,
      removeError: undefined,
      applyError: undefined,
      managedStatus: 'active',
      managedHost: managed?.activeHostSessionId,
      continuityHost: managed?.activeHostSessionId,
      successorGeneration: 2,
      isSuccessor: true,
      predecessorStatus: 'archived',
      launchHosts: [managed?.activeHostSessionId],
    })
  })

  it('R-X7 serializes ensure against apply and launches once', async () => {
    const entered = deferred()
    const release = deferred()
    let launches = 0
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launches += 1
      entered.resolve()
      await release.promise
      return insertRuntime(session, command)
    }

    const ensure = ensureAppSessionFromBody.call(internal, commandRequest()).catch((error) => error)
    await entered.promise
    const apply = handleApplyManagedAppSessions
      .call(internal, applyRequest())
      .catch((error) => error)
    await Bun.sleep(20)
    const launchesBeforeRelease = launches
    release.resolve()
    const [ensureResult, applyResult] = await Promise.all([ensure, apply])
    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)

    expect({
      launchesBeforeRelease,
      launches,
      ensureError: errorCode(ensureResult),
      applyError: errorCode(applyResult),
      sessionCount: selectorSessions().length,
      managedHost: managed?.activeHostSessionId,
      continuityHost: continuityHost(),
    }).toEqual({
      launchesBeforeRelease: 1,
      launches: 1,
      ensureError: undefined,
      applyError: undefined,
      sessionCount: 1,
      managedHost: hostSessionId,
      continuityHost: hostSessionId,
    })
  })

  it('R-X8 holds clear-context until an app dispatch boot settles', async () => {
    makeHarnessManaged()
    const releaseDispatch = deferred()
    let dispatchCalls = 0
    const dispatchHosts: string[] = []
    const settlementOrder: string[] = []
    ;(internal as any).dispatchTurnForSession = async (session: HrcSessionRecord) => {
      dispatchCalls += 1
      dispatchHosts.push(session.hostSessionId)
      await releaseDispatch.promise
      return new Response('{}')
    }

    const dispatch = handleAppSessionDispatchTurn
      .call(
        internal,
        jsonRequest('/v1/app-sessions/turns', {
          selector: { appId: APP_ID, appSessionKey: KEY },
          prompt: 'x',
        })
      )
      .then((response) => {
        settlementOrder.push('dispatch')
        return response
      })
      .catch((error) => error)
    let clearSettled = false
    const clear = handleAppSessionClearContext
      .call(
        internal,
        jsonRequest('/v1/app-sessions/clear-context', {
          selector: { appId: APP_ID, appSessionKey: KEY },
          relaunch: false,
        })
      )
      .then((response) => {
        settlementOrder.push('clear')
        return response
      })
      .catch((error) => error)
      .finally(() => {
        clearSettled = true
      })
    await Bun.sleep(20)
    const clearWaitedForDispatch = !clearSettled
    releaseDispatch.resolve()
    const [dispatchResult, clearResult] = await Promise.all([dispatch, clear])
    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
    const successor = managed
      ? internal.db.sessions.getByHostSessionId(managed.activeHostSessionId)
      : null

    expect({
      clearWaitedForDispatch,
      dispatchCalls,
      dispatchHosts,
      settlementOrder,
      dispatchError: errorCode(dispatchResult),
      clearError: errorCode(clearResult),
      managedHost: managed?.activeHostSessionId,
      continuityHost: continuityHost(),
      successorGeneration: successor?.generation,
      isSuccessor:
        managed?.activeHostSessionId !== undefined && managed.activeHostSessionId !== hostSessionId,
    }).toEqual({
      clearWaitedForDispatch: true,
      dispatchCalls: 1,
      dispatchHosts: [hostSessionId],
      settlementOrder: ['dispatch', 'clear'],
      dispatchError: undefined,
      clearError: undefined,
      managedHost: managed?.activeHostSessionId,
      continuityHost: managed?.activeHostSessionId,
      successorGeneration: 2,
      isSuccessor: true,
    })
  })

  it('R-X9 holds app dispatch behind rotation and resolves the successor', async () => {
    makeHarnessManaged()
    const rotationEntered = deferred()
    const releaseRotation = deferred()
    const originalRotate = (internal as any).rotateSessionContext
    const dispatchHosts: string[] = []
    ;(internal as any).rotateSessionContext = async (...args: unknown[]) => {
      rotationEntered.resolve()
      await releaseRotation.promise
      return await originalRotate.apply(internal, args)
    }
    ;(internal as any).tmux = {
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async () => {},
    }
    ;(internal as any).dispatchTurnForSession = async (session: HrcSessionRecord) => {
      dispatchHosts.push(session.hostSessionId)
      return new Response('{}')
    }

    const clear = handleAppSessionClearContext.call(
      internal,
      jsonRequest('/v1/app-sessions/clear-context', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        relaunch: false,
      })
    )
    await rotationEntered.promise
    let dispatchSettled = false
    const dispatch = handleAppSessionDispatchTurn
      .call(
        internal,
        jsonRequest('/v1/app-sessions/turns', {
          selector: { appId: APP_ID, appSessionKey: KEY },
          prompt: 'x',
        })
      )
      .catch((error) => error)
      .finally(() => {
        dispatchSettled = true
      })
    await Bun.sleep(20)
    const dispatchWaitedForRotation = !dispatchSettled
    releaseRotation.resolve()
    const [clearResult, dispatchResult] = await Promise.all([
      clear.catch((error) => error),
      dispatch,
    ])
    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
    const successor = managed
      ? internal.db.sessions.getByHostSessionId(managed.activeHostSessionId)
      : null

    expect({
      dispatchWaitedForRotation,
      clearError: errorCode(clearResult),
      dispatchError: errorCode(dispatchResult),
      dispatchHosts,
      managedHost: managed?.activeHostSessionId,
      continuityHost: continuityHost(),
      successorGeneration: successor?.generation,
      isSuccessor:
        managed?.activeHostSessionId !== undefined && managed.activeHostSessionId !== hostSessionId,
    }).toEqual({
      dispatchWaitedForRotation: true,
      clearError: undefined,
      dispatchError: undefined,
      dispatchHosts: [managed?.activeHostSessionId],
      managedHost: managed?.activeHostSessionId,
      continuityHost: managed?.activeHostSessionId,
      successorGeneration: 2,
      isSuccessor: true,
    })
  })

  it('R-X11 serializes two ensures to one launch and one identity', async () => {
    internal.db.sqlite.run(
      'DELETE FROM app_managed_sessions WHERE app_id = ? AND app_session_key = ?',
      [APP_ID, KEY]
    )
    internal.db.sqlite.run('DELETE FROM continuities WHERE scope_ref = ? AND lane_ref = ?', [
      SCOPE,
      LANE,
    ])
    internal.db.sqlite.run('DELETE FROM sessions WHERE host_session_id = ?', [hostSessionId])
    const entered = deferred()
    const release = deferred()
    let launches = 0
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launches += 1
      entered.resolve()
      await release.promise
      return insertRuntime(session, command)
    }
    const first = ensureAppSessionFromBody.call(internal, commandRequest()).catch((error) => error)
    const firstReachedLaunch = await Promise.race([
      entered.promise.then(() => true),
      first.then(() => false),
    ])
    const second = ensureAppSessionFromBody.call(internal, commandRequest()).catch((error) => error)
    await Bun.sleep(20)
    const launchesBeforeRelease = launches
    release.resolve()
    const [firstResult, secondResult] = await Promise.all([first, second])
    const [firstBody, secondBody] = await Promise.all([
      responseBody(firstResult),
      responseBody(secondResult),
    ])
    const firstSession = firstBody?.['session'] as Record<string, unknown> | undefined
    const secondSession = secondBody?.['session'] as Record<string, unknown> | undefined
    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)

    expect({
      firstReachedLaunch,
      launchesBeforeRelease,
      launches,
      firstError: errorCode(firstResult),
      secondError: errorCode(secondResult),
      sessionCount: selectorSessions().length,
      managedHost: managed?.activeHostSessionId,
      continuityHost: continuityHost(),
      responseHosts: [
        firstSession?.['activeHostSessionId'],
        secondSession?.['activeHostSessionId'],
      ],
      created: [firstBody?.['created'], secondBody?.['created']].sort(),
    }).toEqual({
      firstReachedLaunch: true,
      launchesBeforeRelease: 1,
      launches: 1,
      firstError: undefined,
      secondError: undefined,
      sessionCount: 1,
      managedHost: continuityHost(),
      continuityHost: expect.any(String),
      responseHosts: [continuityHost(), continuityHost()],
      created: [false, true],
    })
  })

  it('R-X12 base control: duplicated apply entries are sequential without duplicate launch', async () => {
    let launches = 0
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launches += 1
      return insertRuntime(session, command)
    }
    const request = jsonRequest('/v1/app-sessions/apply', {
      appId: APP_ID,
      sessions: [
        { appSessionKey: KEY, spec: commandRequest().spec },
        { appSessionKey: KEY, spec: commandRequest().spec },
      ],
    })

    const response = await handleApplyManagedAppSessions.call(internal, request)
    expect({ status: response.status, launches }).toEqual({ status: 200, launches: 1 })
    expect(
      internal.db.sqlite
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sessions WHERE scope_ref = '${SCOPE}' AND lane_ref = '${LANE}'`
        )
        .get()?.count
    ).toBe(1)
  })

  it('R-X13 keeps a committed identity intact across launch failure and retry', async () => {
    const request = {
      ...commandRequest(),
      selector: { appId: APP_ID, appSessionKey: 'restart' },
    }
    ;(internal as any).ensureCommandRuntimeForSession = async () => {
      throw new Error('T-08576 injected restart-window failure')
    }
    await ensureAppSessionFromBody.call(internal, request).catch((error) => error)
    const committed = internal.db.appManagedSessions.findByKey(APP_ID, 'restart')
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => insertRuntime(session, command)
    await ensureAppSessionFromBody.call(internal, request).catch((error) => error)

    expect({
      committed: committed !== null,
      firstHost: committed?.activeHostSessionId,
      retriedHost: internal.db.appManagedSessions.findByKey(APP_ID, 'restart')?.activeHostSessionId,
      sessionCount: internal.db.sqlite
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sessions WHERE scope_ref = '${SCOPE}' AND lane_ref = 'restart'`
        )
        .get()?.count,
    }).toEqual({
      committed: true,
      firstHost: expect.any(String),
      retriedHost: committed?.activeHostSessionId,
      sessionCount: 1,
    })
  })

  it('R-X16 holds removal until literal input trailing writes finish', async () => {
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
    const runtime = insertRuntime(session, {
      launchMode: 'exec',
      argv: ['/bin/true'],
    })
    const sendEntered = deferred()
    const releaseSend = deferred()
    const terminationObservations: Array<{
      sessionName: string
      literalEvents: number
      lastActivityAt: string | undefined
    }> = []
    ;(internal as any).tmux = {
      sendLiteral: async () => {
        sendEntered.resolve()
        await releaseSend.promise
      },
      sendKeys: async () => {
        sendEntered.resolve()
        await releaseSend.promise
      },
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async (sessionName: string) => {
        terminationObservations.push({
          sessionName,
          literalEvents: internal.db.hrcEvents.listByKind('app-session.literal-input', {
            hostSessionId,
          }).length,
          lastActivityAt: internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.lastActivityAt,
        })
      },
    }

    const literal = handleAppSessionLiteralInput
      .call(
        internal,
        jsonRequest('/v1/app-sessions/literal-input', {
          selector: { appId: APP_ID, appSessionKey: KEY },
          text: 'owned-input',
          enter: false,
        })
      )
      .catch((error) => error)
    await sendEntered.promise
    let removeSettled = false
    const remove = removeAppSessionFromBody
      .call(internal, { selector: { appId: APP_ID, appSessionKey: KEY } })
      .catch((error) => error)
      .finally(() => {
        removeSettled = true
      })
    await Bun.sleep(20)

    const removeWaitedForInput = !removeSettled
    releaseSend.resolve()
    const [literalResult, removeResult] = await Promise.all([literal, remove])
    const literalEvents = internal.db.hrcEvents.listByKind('app-session.literal-input', {
      hostSessionId,
    })
    const removedEvents = internal.db.hrcEvents.listByKind('app-session.removed', {
      hostSessionId,
    })
    const finalActivityAt = internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.lastActivityAt
    await Bun.sleep(10)

    expect({
      removeWaitedForInput,
      literalError: errorCode(literalResult),
      removeError: errorCode(removeResult),
      terminationObservations,
      literalEventCount: literalEvents.length,
      literalGeneration: literalEvents[0]?.generation,
      removedEventCount: removedEvents.length,
      literalBeforeRemoved:
        (literalEvents[0]?.hrcSeq ?? Number.POSITIVE_INFINITY) < (removedEvents[0]?.hrcSeq ?? -1),
      finalActivityAt,
      noLiteralAfterRemoval:
        internal.db.hrcEvents.listByKind('app-session.literal-input', { hostSessionId }).length ===
        literalEvents.length,
      noActivityAfterRemoval:
        internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.lastActivityAt === finalActivityAt,
    }).toEqual({
      removeWaitedForInput: true,
      literalError: undefined,
      removeError: undefined,
      terminationObservations: [
        {
          sessionName: runtime.tmuxJson?.sessionName,
          literalEvents: 1,
          lastActivityAt: expect.any(String),
        },
      ],
      literalEventCount: 1,
      literalGeneration: 1,
      removedEventCount: 1,
      literalBeforeRemoved: true,
      finalActivityAt: expect.any(String),
      noLiteralAfterRemoval: true,
      noActivityAfterRemoval: true,
    })
  })

  it('R-X14 holds clear-context until literal input trailing writes finish', async () => {
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
    const runtime = insertRuntime(session, { launchMode: 'exec', argv: ['/bin/true'] })
    const sendEntered = deferred()
    const releaseSend = deferred()
    const terminationObservations: Array<{
      sessionName: string
      literalEvents: number
      lastActivityAt: string | undefined
    }> = []
    ;(internal as any).tmux = {
      sendLiteral: async () => {
        sendEntered.resolve()
        await releaseSend.promise
      },
      sendKeys: async () => {},
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async (sessionName: string) => {
        terminationObservations.push({
          sessionName,
          literalEvents: internal.db.hrcEvents.listByKind('app-session.literal-input', {
            hostSessionId,
          }).length,
          lastActivityAt: internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.lastActivityAt,
        })
      },
    }

    const literal = handleAppSessionLiteralInput
      .call(
        internal,
        jsonRequest('/v1/app-sessions/literal-input', {
          selector: { appId: APP_ID, appSessionKey: KEY },
          text: 'owned-input-before-rotation',
          enter: false,
        })
      )
      .catch((error) => error)
    await sendEntered.promise
    let clearSettled = false
    const clear = handleAppSessionClearContext
      .call(
        internal,
        jsonRequest('/v1/app-sessions/clear-context', {
          selector: { appId: APP_ID, appSessionKey: KEY },
          relaunch: false,
        })
      )
      .catch((error) => error)
      .finally(() => {
        clearSettled = true
      })
    await Bun.sleep(20)
    const clearWaitedForInput = !clearSettled
    releaseSend.resolve()
    const [literalResult, clearResult] = await Promise.all([literal, clear])
    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
    const successor = managed
      ? internal.db.sessions.getByHostSessionId(managed.activeHostSessionId)
      : null
    const literalEvents = internal.db.hrcEvents.listByKind('app-session.literal-input', {
      hostSessionId,
    })
    const clearedEvents = internal.db.hrcEvents.listByKind('context.cleared', { hostSessionId })
    const finalActivityAt = internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.lastActivityAt
    await Bun.sleep(10)

    expect({
      clearWaitedForInput,
      literalError: errorCode(literalResult),
      clearError: errorCode(clearResult),
      managedHost: managed?.activeHostSessionId,
      continuityHost: continuityHost(),
      successorGeneration: successor?.generation,
      isSuccessor:
        managed?.activeHostSessionId !== undefined && managed.activeHostSessionId !== hostSessionId,
      predecessorStatus: internal.db.sessions.getByHostSessionId(hostSessionId)?.status,
      terminationObservations,
      literalGeneration: literalEvents[0]?.generation,
      literalBeforeRotation:
        (literalEvents[0]?.hrcSeq ?? Number.POSITIVE_INFINITY) < (clearedEvents[0]?.hrcSeq ?? -1),
      noLiteralAfterRotation:
        internal.db.hrcEvents.listByKind('app-session.literal-input', { hostSessionId }).length ===
        literalEvents.length,
      noActivityAfterRotation:
        internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.lastActivityAt === finalActivityAt,
    }).toEqual({
      clearWaitedForInput: true,
      literalError: undefined,
      clearError: undefined,
      managedHost: managed?.activeHostSessionId,
      continuityHost: managed?.activeHostSessionId,
      successorGeneration: 2,
      isSuccessor: true,
      predecessorStatus: 'archived',
      terminationObservations: [
        {
          sessionName: runtime.tmuxJson?.sessionName,
          literalEvents: 1,
          lastActivityAt: expect.any(String),
        },
      ],
      literalGeneration: 1,
      literalBeforeRotation: true,
      noLiteralAfterRotation: true,
      noActivityAfterRotation: true,
    })
  })

  it('R-X15(a) queues unfenced literal input behind rotation and never touches gen1', async () => {
    const outcome = await queuedLiteralAfterRotation()
    expect({
      ...outcome,
      isSuccessor: outcome.managedHost !== undefined && outcome.managedHost !== hostSessionId,
    }).toEqual({
      inputWaitedForRotation: true,
      clearError: undefined,
      literalError: 'runtime_unavailable',
      sentPanes: [],
      managedHost: outcome.continuityHost,
      continuityHost: expect.any(String),
      successorGeneration: 2,
      predecessorLiteralEvents: 0,
      predecessorLastActivityAt: undefined,
      isSuccessor: true,
    })
  })

  it('R-X15(b) applies the gen1 fence after rotation and refuses before writes', async () => {
    const outcome = await queuedLiteralAfterRotation({
      expectedHostSessionId: hostSessionId,
      expectedGeneration: 1,
    })
    expect({
      ...outcome,
      isSuccessor: outcome.managedHost !== undefined && outcome.managedHost !== hostSessionId,
    }).toEqual({
      inputWaitedForRotation: true,
      clearError: undefined,
      literalError: 'stale_context',
      sentPanes: [],
      managedHost: outcome.continuityHost,
      continuityHost: expect.any(String),
      successorGeneration: 2,
      predecessorLiteralEvents: 0,
      predecessorLastActivityAt: undefined,
      isSuccessor: true,
    })
  })

  it('R-X17 holds literal input behind removal and refuses it without writes', async () => {
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
    insertRuntime(session, { launchMode: 'exec', argv: ['/bin/true'] })
    const terminateEntered = deferred()
    const releaseTerminate = deferred()
    ;(internal as any).tmux = {
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async () => {
        terminateEntered.resolve()
        await releaseTerminate.promise
      },
      sendLiteral: async () => {},
      sendKeys: async () => {},
    }

    const remove = removeAppSessionFromBody.call(internal, {
      selector: { appId: APP_ID, appSessionKey: KEY },
    })
    await terminateEntered.promise
    let literalSettled = false
    const literal = handleAppSessionLiteralInput
      .call(
        internal,
        jsonRequest('/v1/app-sessions/literal-input', {
          selector: { appId: APP_ID, appSessionKey: KEY },
          text: 'must-not-send-after-remove',
          enter: false,
        })
      )
      .catch((error) => error)
      .finally(() => {
        literalSettled = true
      })
    await Bun.sleep(20)
    const literalWaitedForRemove = !literalSettled
    releaseTerminate.resolve()
    const [, literalResult] = await Promise.all([remove, literal])

    expect(literalWaitedForRemove).toBe(true)
    expect((literalResult as { code?: string }).code).toBe('app_session_removed')
    expect(
      internal.db.hrcEvents.listByKind('app-session.literal-input', { hostSessionId })
    ).toHaveLength(0)
  })

  it('R-X18 holds remove behind an in-flight delivery and its trailing event', async () => {
    internal.db.sqlite.run(
      "UPDATE app_managed_sessions SET kind = 'harness' WHERE app_id = ? AND app_session_key = ?",
      [APP_ID, KEY]
    )
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
    const runtime = insertRuntime(session, { launchMode: 'exec', argv: ['/bin/true'] })
    internal.db.runtimes.updateRunId(runtime.runtimeId, 'run-t08576-inflight', NOW)
    const deliveryEntered = deferred()
    const releaseDelivery = deferred()
    const originalDelivery = (internal as any).deliverInFlightInputToRuntime.bind(internal)
    const terminationObservations: Array<{ sessionName: string; rejectionEvents: number }> = []
    ;(internal as any).deliverInFlightInputToRuntime = async (...args: unknown[]) => {
      deliveryEntered.resolve()
      await releaseDelivery.promise
      return await originalDelivery(...args)
    }
    ;(internal as any).tmux = {
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async (sessionName: string) => {
        terminationObservations.push({
          sessionName,
          rejectionEvents: internal.db.hrcEvents.listByKind('inflight.rejected', {
            hostSessionId,
          }).length,
        })
      },
    }

    const input = handleAppSessionInFlightInput
      .call(
        internal,
        jsonRequest('/v1/app-sessions/in-flight-input', {
          selector: { appId: APP_ID, appSessionKey: KEY },
          prompt: 'x',
          runId: 'run-t08576-inflight',
        })
      )
      .catch((error) => error)
    await deliveryEntered.promise
    let removeSettled = false
    const remove = removeAppSessionFromBody
      .call(internal, { selector: { appId: APP_ID, appSessionKey: KEY } })
      .catch((error) => error)
      .finally(() => {
        removeSettled = true
      })
    await Bun.sleep(20)
    const removeWaitedForDelivery = !removeSettled
    releaseDelivery.resolve()
    const [inputResult, removeResult] = await Promise.all([input, remove])
    const rejectionEvents = internal.db.hrcEvents.listByKind('inflight.rejected', {
      hostSessionId,
    })
    const removedEvents = internal.db.hrcEvents.listByKind('app-session.removed', {
      hostSessionId,
    })
    await Bun.sleep(10)

    expect({
      removeWaitedForDelivery,
      inputError: errorCode(inputResult),
      removeError: errorCode(removeResult),
      terminationObservations,
      rejectionEventCount: rejectionEvents.length,
      rejectionBeforeRemoved:
        (rejectionEvents[0]?.hrcSeq ?? Number.POSITIVE_INFINITY) < (removedEvents[0]?.hrcSeq ?? -1),
      noRejectionAfterRemoved:
        internal.db.hrcEvents.listByKind('inflight.rejected', { hostSessionId }).length ===
        rejectionEvents.length,
    }).toEqual({
      removeWaitedForDelivery: true,
      inputError: 'inflight_unsupported',
      removeError: undefined,
      terminationObservations: [{ sessionName: runtime.tmuxJson?.sessionName, rejectionEvents: 1 }],
      rejectionEventCount: 1,
      rejectionBeforeRemoved: true,
      noRejectionAfterRemoved: true,
    })
  })

  it('R-X19 holds in-flight input behind removal and never delivers on the predecessor', async () => {
    makeHarnessManaged()
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
    const runtime = insertRuntime(session, { launchMode: 'exec', argv: ['/bin/true'] })
    internal.db.runtimes.updateRunId(runtime.runtimeId, 'run-t08576-x19', NOW)
    const terminateEntered = deferred()
    const releaseTerminate = deferred()
    let deliveries = 0
    ;(internal as any).tmux = {
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async () => {
        terminateEntered.resolve()
        await releaseTerminate.promise
      },
    }
    ;(internal as any).deliverInFlightInputToRuntime = async () => {
      deliveries += 1
      return { accepted: true }
    }

    const remove = removeAppSessionFromBody.call(internal, {
      selector: { appId: APP_ID, appSessionKey: KEY },
    })
    await terminateEntered.promise
    let inputSettled = false
    const input = handleAppSessionInFlightInput
      .call(
        internal,
        jsonRequest('/v1/app-sessions/in-flight-input', {
          selector: { appId: APP_ID, appSessionKey: KEY },
          prompt: 'must-not-deliver-after-remove',
          runId: 'run-t08576-x19',
        })
      )
      .catch((error) => error)
      .finally(() => {
        inputSettled = true
      })
    await Bun.sleep(20)
    const inputWaitedForRemove = !inputSettled
    releaseTerminate.resolve()
    const [, inputResult] = await Promise.all([remove, input])

    expect(inputWaitedForRemove).toBe(true)
    expect((inputResult as { code?: string }).code).toBe('app_session_removed')
    expect(deliveries).toBe(0)
  })

  it('R-X20 refuses owner re-entry instead of deadlocking or double-launching', async () => {
    let nested = false
    let launches = 0
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launches += 1
      if (!nested) {
        nested = true
        await ensureAppSessionFromBody.call(internal, commandRequest())
      }
      return insertRuntime(session, command)
    }

    let message = ''
    try {
      await ensureAppSessionFromBody.call(internal, commandRequest())
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect({ message, launches }).toEqual({
      message: expect.stringContaining('app identity owner re-entry'),
      launches: 1,
    })
  })

  it('R-X21 rolls successor, continuity and managed pointer back together', async () => {
    const originalInvalidate = (internal as any).invalidateHostContext.bind(internal)
    const invalidatedHosts: string[] = []
    ;(internal as any).invalidateHostContext = async (...args: [string, string]) => {
      invalidatedHosts.push(args[0])
      return await originalInvalidate(...args)
    }
    internal.db.sqlite.exec(`
      CREATE TRIGGER t08576_fail_managed_update
      BEFORE UPDATE ON app_managed_sessions
      BEGIN SELECT RAISE(ABORT, 't08576 managed update failure'); END;
    `)
    const response = await fetch('http://localhost/v1/clear-context', {
      unix: socketPath,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostSessionId, dropContinuation: true, relaunch: false }),
    })
    const responseText = JSON.stringify(await response.json())
    const continuity = internal.db.sqlite
      .query<{ active_host_session_id: string }, []>(
        `SELECT active_host_session_id FROM continuities WHERE scope_ref = '${SCOPE}' AND lane_ref = '${LANE}'`
      )
      .get()?.active_host_session_id
    const sessionCount = internal.db.sqlite
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM sessions WHERE scope_ref = '${SCOPE}' AND lane_ref = '${LANE}'`
      )
      .get()?.count
    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)

    expect({
      rotationReached: invalidatedHosts,
      responseIsError: response.status >= 400,
      errorNamesInjectedFailure: responseText.includes('t08576 managed update failure'),
      continuity,
      sessionCount,
      managedHost: managed?.activeHostSessionId,
      sessionCreatedEvents: internal.db.hrcEvents.listByKind('session.created', {
        scopeRef: SCOPE,
      }).length,
      contextClearedEvents: internal.db.hrcEvents.listByKind('context.cleared', {
        hostSessionId,
      }).length,
    }).toEqual({
      rotationReached: [hostSessionId],
      responseIsError: true,
      errorNamesInjectedFailure: true,
      continuity: hostSessionId,
      sessionCount: 1,
      managedHost: hostSessionId,
      sessionCreatedEvents: 0,
      contextClearedEvents: 0,
    })
  })
})
