/** T-08576 R-X14-R-X21 and D9 input-crossing acceptance tests. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HrcCommandSpec, HrcSessionRecord } from 'hrc-core'

import {
  ensureAppSessionFromBody,
  handleAppSessionClearContext,
  handleAppSessionInFlightInput,
  handleAppSessionLiteralInput,
  removeAppSessionFromBody,
} from '../app-session-handlers'
import {
  APP_ID,
  KEY,
  LANE,
  NOW,
  SCOPE,
  commandRequest,
  continuityHost,
  deferred,
  errorCode,
  hostSessionId,
  insertRuntime,
  internal,
  jsonRequest,
  makeHarnessManaged,
  queuedLiteralAfterRotation,
  responseBody,
  setUpAppSessionCrossingFixture,
  socketPath,
  tearDownAppSessionCrossingFixture,
} from './fixtures/app-session-crossing.fixture'

beforeEach(setUpAppSessionCrossingFixture)
afterEach(tearDownAppSessionCrossingFixture)

describe('T-08576 app identity owner crossings', () => {
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

  it('R-X-D9 commits the exact removal event with identity before teardown and returns counts', async () => {
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
    const runtime = insertRuntime(session, { launchMode: 'exec', argv: ['/bin/true'] })
    const order: string[] = []
    ;(internal as any).tmux = {
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async () => {
        const event = internal.db.hrcEvents.listByKind('app-session.removed', { hostSessionId })[0]
        order.push(event === undefined ? 'terminate-before-event' : 'terminate-after-event')
      },
    }

    const response = await removeAppSessionFromBody.call(internal, {
      selector: { appId: APP_ID, appSessionKey: KEY },
    })
    const body = await responseBody(response)
    const removedRows = internal.db.sqlite
      .query<{ hrc_seq: number; payload_json: string }, [string]>(
        "SELECT hrc_seq, payload_json FROM hrc_events WHERE host_session_id = ? AND event_kind = 'app-session.removed' ORDER BY hrc_seq"
      )
      .all(hostSessionId)

    expect({
      body,
      managedStatus: internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.status,
      sessionStatus: internal.db.sessions.getByHostSessionId(hostSessionId)?.status,
      runtimeStatus: internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.status,
      order,
      removedRows: removedRows.map((row) => ({
        hrcSeq: row.hrc_seq,
        payload: JSON.parse(row.payload_json),
      })),
    }).toEqual({
      body: {
        removed: true,
        runtimeTerminated: true,
        bridgesClosed: 0,
        surfacesUnbound: 0,
      },
      managedStatus: 'removed',
      sessionStatus: 'archived',
      runtimeStatus: 'terminated',
      order: ['terminate-after-event'],
      removedRows: [{ hrcSeq: expect.any(Number), payload: { kind: 'command' } }],
    })
  })

  it('R-X-D9 rolls status and archive back when removal event append aborts, before teardown', async () => {
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
    const runtime = insertRuntime(session, { launchMode: 'exec', argv: ['/bin/true'] })
    let teardownCalls = 0
    ;(internal as any).tmux = {
      inspectSession: async () => {
        teardownCalls += 1
        return { sessionId: '$1' }
      },
      terminate: async () => {
        teardownCalls += 1
      },
    }
    internal.db.sqlite.exec(`
      CREATE TRIGGER t08576_abort_removed_event
      BEFORE INSERT ON hrc_events
      WHEN NEW.event_kind = 'app-session.removed'
      BEGIN
        SELECT RAISE(ABORT, 't08576 removal event failure');
      END
    `)

    let error: unknown
    try {
      await removeAppSessionFromBody.call(internal, {
        selector: { appId: APP_ID, appSessionKey: KEY },
      })
    } catch (caught) {
      error = caught
    }

    expect({
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : undefined,
      managedStatus: internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.status,
      sessionStatus: internal.db.sessions.getByHostSessionId(hostSessionId)?.status,
      runtimeStatus: internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.status,
      teardownCalls,
      removedEvents: internal.db.hrcEvents.listByKind('app-session.removed', { hostSessionId }),
    }).toEqual({
      errorName: 'SQLiteError',
      errorMessage: expect.stringContaining('t08576 removal event failure'),
      managedStatus: 'active',
      sessionStatus: 'active',
      runtimeStatus: 'ready',
      teardownCalls: 0,
      removedEvents: [],
    })
  })

  it('R-X-D9 already-removed retry re-runs teardown without appending a second event', async () => {
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
    const runtime = insertRuntime(session, { launchMode: 'exec', argv: ['/bin/true'] })
    ;(internal as any).tmux = {
      inspectSession: async () => ({ sessionId: '$1' }),
      terminate: async () => {},
    }
    const first = await responseBody(
      await removeAppSessionFromBody.call(internal, {
        selector: { appId: APP_ID, appSessionKey: KEY },
        terminateRuntime: false,
      })
    )
    const second = await responseBody(
      await removeAppSessionFromBody.call(internal, {
        selector: { appId: APP_ID, appSessionKey: KEY },
      })
    )

    expect({
      first,
      second,
      removedEvents: internal.db.hrcEvents.listByKind('app-session.removed', { hostSessionId })
        .length,
      runtimeStatus: internal.db.runtimes.getByRuntimeId(runtime.runtimeId)?.status,
    }).toEqual({
      first: {
        removed: true,
        runtimeTerminated: false,
        bridgesClosed: 0,
        surfacesUnbound: 0,
      },
      second: {
        removed: true,
        runtimeTerminated: true,
        bridgesClosed: 0,
        surfacesUnbound: 0,
      },
      removedEvents: 1,
      runtimeStatus: 'terminated',
    })
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
