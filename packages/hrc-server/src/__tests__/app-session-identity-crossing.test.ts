/** T-08576 R-X1-R-X13 owner-crossing acceptance tests. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HrcCommandSpec, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'

import {
  ensureAppSessionFromBody,
  handleAppSessionClearContext,
  handleAppSessionDispatchTurn,
  handleApplyManagedAppSessions,
  removeAppSessionFromBody,
} from '../app-session-handlers'
import {
  APP_ID,
  KEY,
  LANE,
  NOW,
  SCOPE,
  applyRequest,
  availableRuntimeIds,
  commandRequest,
  continuityHost,
  deferred,
  errorCode,
  hostSessionId,
  insertRuntime,
  internal,
  jsonRequest,
  makeHarnessManaged,
  responseBody,
  selectorSessions,
  setUpAppSessionCrossingFixture,
  tearDownAppSessionCrossingFixture,
} from './fixtures/app-session-crossing.fixture'

beforeEach(setUpAppSessionCrossingFixture)
afterEach(tearDownAppSessionCrossingFixture)

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
})
