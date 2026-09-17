/**
 * T-08576 R-X ownership crossings. The daemon instance is real (including its real database and
 * handler composition); only launch, tmux delivery, and invalidation are manually gated.
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

describe('T-08576 app identity owner crossings', () => {
  it('R-X1 serializes ensure-create launch and removal to one live identity', async () => {
    const entered = deferred()
    const release = deferred()
    let launchCount = 0
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launchCount += 1
      entered.resolve()
      await release.promise
      return insertRuntime(session, command)
    }

    const ensure = ensureAppSessionFromBody.call(internal, commandRequest())
    await entered.promise
    let removeSettled = false
    const remove = removeAppSessionFromBody
      .call(internal, {
        selector: { appId: APP_ID, appSessionKey: KEY },
        terminateRuntime: false,
      })
      .finally(() => {
        removeSettled = true
      })
    await Bun.sleep(20)

    const removeWaitedForLaunch = !removeSettled
    release.resolve()
    await Promise.allSettled([ensure, remove])
    expect(removeWaitedForLaunch).toBe(true)
    expect(launchCount).toBe(1)
    expect(internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.status).toBe('removed')
    expect(internal.db.sessions.getByHostSessionId(hostSessionId)?.status).toBe('archived')
    expect(
      internal.db.runtimes
        .listByHostSessionId(hostSessionId)
        .filter((runtime) => !['terminated', 'stale', 'dead', 'crashed'].includes(runtime.status))
    ).toHaveLength(0)
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
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launchEntered.resolve()
      await releaseLaunch.promise
      return insertRuntime(session, command)
    }

    const ensure = ensureAppSessionFromBody.call(internal, commandRequest())
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
      .catch((error) => error)
      .finally(() => {
        clearSettled = true
      })
    await Bun.sleep(20)
    const clearWaitedForLaunch = !clearSettled
    releaseLaunch.resolve()
    await Promise.allSettled([ensure, clear])

    expect(clearWaitedForLaunch).toBe(true)
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
    ;(internal as any).invalidateHostContext = async () => {}
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
    await Promise.allSettled([clear, ensure])

    expect(ensureWaitedForRotation).toBe(true)
    expect(launchHosts).not.toContain(hostSessionId)
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
    ;(internal as any).ensureCommandRuntimeForSession = async (
      session: HrcSessionRecord,
      command: HrcCommandSpec
    ) => {
      launchEntered.resolve()
      await releaseLaunch.promise
      return insertRuntime(session, command)
    }

    const apply = handleApplyManagedAppSessions.call(internal, applyRequest())
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
    releaseLaunch.resolve()
    await Promise.allSettled([apply, remove])

    expect(removeWaitedForApply).toBe(true)
    expect(internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.status).toBe('removed')
    expect(internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.activeHostSessionId).not.toBe(
      hostSessionId
    )
  })

  it('R-X6 lets remove finish teardown before apply reactivates on a successor', async () => {
    insertRuntime(internal.db.sessions.getByHostSessionId(hostSessionId)!, {
      launchMode: 'exec',
      argv: ['/bin/true'],
    })
    const terminateEntered = deferred()
    const releaseTerminate = deferred()
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
    ) => insertRuntime(session, command)

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
    await Promise.allSettled([remove, apply])

    expect(applyWaitedForRemove).toBe(true)
    expect(internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.status).toBe('active')
    expect(internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.activeHostSessionId).not.toBe(
      hostSessionId
    )
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

    const ensure = ensureAppSessionFromBody.call(internal, commandRequest())
    await entered.promise
    const apply = handleApplyManagedAppSessions
      .call(internal, applyRequest())
      .catch((error) => error)
    await Bun.sleep(20)
    const launchesBeforeRelease = launches
    release.resolve()
    await Promise.allSettled([ensure, apply])

    expect({ launchesBeforeRelease, launches }).toEqual({
      launchesBeforeRelease: 1,
      launches: 1,
    })
  })

  it('R-X8 holds clear-context until an app dispatch boot settles', async () => {
    makeHarnessManaged()
    const releaseDispatch = deferred()
    let dispatchCalls = 0
    ;(internal as any).dispatchTurnForSession = async () => {
      dispatchCalls += 1
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
      .catch((error) => error)
      .finally(() => {
        clearSettled = true
      })
    await Bun.sleep(20)
    const clearWaitedForDispatch = !clearSettled
    releaseDispatch.resolve()
    await Promise.allSettled([dispatch, clear])

    expect({ clearWaitedForDispatch, dispatchCalls }).toEqual({
      clearWaitedForDispatch: true,
      dispatchCalls: 1,
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
    ;(internal as any).invalidateHostContext = async () => {}
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
    await Promise.allSettled([clear, dispatch])

    expect(dispatchWaitedForRotation).toBe(true)
    expect(dispatchHosts).not.toContain(hostSessionId)
  })

  it('R-X11 serializes two ensures to one launch and one identity', async () => {
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
    const first = ensureAppSessionFromBody.call(internal, commandRequest())
    await entered.promise
    const second = ensureAppSessionFromBody.call(internal, commandRequest()).catch((error) => error)
    await Bun.sleep(20)
    const launchesBeforeRelease = launches
    release.resolve()
    await Promise.allSettled([first, second])

    expect({ launchesBeforeRelease, launches }).toEqual({
      launchesBeforeRelease: 1,
      launches: 1,
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
    ;(internal as any).tmux = {
      sendLiteral: async () => {
        sendEntered.resolve()
        await releaseSend.promise
      },
      sendKeys: async () => {
        sendEntered.resolve()
        await releaseSend.promise
      },
      inspectSession: async () => null,
      terminate: async () => {},
    }

    const literal = handleAppSessionLiteralInput.call(
      internal,
      jsonRequest('/v1/app-sessions/literal-input', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        text: 'owned-input',
        enter: false,
      })
    )
    await sendEntered.promise
    let removeSettled = false
    const remove = removeAppSessionFromBody
      .call(internal, {
        selector: { appId: APP_ID, appSessionKey: KEY },
        terminateRuntime: false,
      })
      .finally(() => {
        removeSettled = true
      })
    await Bun.sleep(20)

    const removeWaitedForInput = !removeSettled
    releaseSend.resolve()
    await Promise.allSettled([literal, remove])
    expect(removeWaitedForInput).toBe(true)
    const events = internal.db.hrcEvents.listByKind('app-session.literal-input', {
      hostSessionId,
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.generation).toBe(1)
    expect(internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.lastActivityAt).toBeDefined()
  })

  it('R-X14 holds clear-context until literal input trailing writes finish', async () => {
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
    insertRuntime(session, { launchMode: 'exec', argv: ['/bin/true'] })
    const sendEntered = deferred()
    const releaseSend = deferred()
    ;(internal as any).tmux = {
      sendLiteral: async () => {
        sendEntered.resolve()
        await releaseSend.promise
      },
      sendKeys: async () => {},
      inspectSession: async () => null,
      terminate: async () => {},
    }
    ;(internal as any).invalidateHostContext = async () => {}

    const literal = handleAppSessionLiteralInput.call(
      internal,
      jsonRequest('/v1/app-sessions/literal-input', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        text: 'owned-input-before-rotation',
        enter: false,
      })
    )
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
    await Promise.allSettled([literal, clear])

    expect(clearWaitedForInput).toBe(true)
    expect(
      internal.db.hrcEvents.listByKind('app-session.literal-input', { hostSessionId })[0]
        ?.generation
    ).toBe(1)
  })

  it('R-X15 queues literal input behind clear-context and never sends to gen1', async () => {
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
    insertRuntime(session, { launchMode: 'exec', argv: ['/bin/true'] })
    const rotationEntered = deferred()
    const releaseRotation = deferred()
    const sentPanes: string[] = []
    const originalRotate = (internal as any).rotateSessionContext
    ;(internal as any).rotateSessionContext = async (...args: unknown[]) => {
      rotationEntered.resolve()
      await releaseRotation.promise
      return await originalRotate.apply(internal, args)
    }
    ;(internal as any).invalidateHostContext = async () => {}
    ;(internal as any).tmux = {
      sendLiteral: async (paneId: string) => sentPanes.push(paneId),
      sendKeys: async (paneId: string) => sentPanes.push(paneId),
      inspectSession: async () => null,
      terminate: async () => {},
    }

    const clear = handleAppSessionClearContext.call(
      internal,
      jsonRequest('/v1/app-sessions/clear-context', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        relaunch: false,
      })
    )
    await rotationEntered.promise
    let inputSettled = false
    const literal = handleAppSessionLiteralInput
      .call(
        internal,
        jsonRequest('/v1/app-sessions/literal-input', {
          selector: { appId: APP_ID, appSessionKey: KEY },
          text: 'must-not-hit-gen1',
          enter: false,
          expectedHostSessionId: hostSessionId,
          expectedGeneration: 1,
        })
      )
      .catch((error) => error)
      .finally(() => {
        inputSettled = true
      })
    await Bun.sleep(20)

    const inputWaitedForRotation = !inputSettled
    releaseRotation.resolve()
    await Promise.allSettled([clear, literal])
    expect(inputWaitedForRotation).toBe(true)
    expect(sentPanes).toEqual([])
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
    ;(internal as any).deliverInFlightInputToRuntime = async () => {
      deliveryEntered.resolve()
      await releaseDelivery.promise
      return { accepted: false, reason: 'test-rejection' }
    }

    const input = handleAppSessionInFlightInput.call(
      internal,
      jsonRequest('/v1/app-sessions/in-flight-input', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        prompt: 'x',
        runId: 'run-t08576-inflight',
      })
    )
    await deliveryEntered.promise
    let removeSettled = false
    const remove = removeAppSessionFromBody
      .call(internal, {
        selector: { appId: APP_ID, appSessionKey: KEY },
        terminateRuntime: false,
      })
      .finally(() => {
        removeSettled = true
      })
    await Bun.sleep(20)
    const removeWaitedForDelivery = !removeSettled
    releaseDelivery.resolve()
    await Promise.allSettled([input, remove])
    expect(removeWaitedForDelivery).toBe(true)
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

    expect({ status: response.status, continuity, sessionCount }).toEqual({
      status: 500,
      continuity: hostSessionId,
      sessionCount: 1,
    })
  })
})
