import { randomUUID } from 'node:crypto'

import {
  HrcBadRequestError,
  HrcConflictError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
  HrcUnprocessableEntityError,
  validateFence,
} from 'hrc-core'
import type {
  ApplyAppManagedSessionsResponse,
  ApplyAppSessionsResponse,
  ClearAppSessionContextResponse,
  EnsureAppSessionDryRunPlan,
  EnsureAppSessionRequest,
  EnsureAppSessionResponse,
  HrcAppSessionSpec,
  HrcSessionRecord,
  RemoveAppSessionRequest,
  RemoveAppSessionResponse,
  SendAppHarnessInFlightInputResponse,
  SendLiteralInputResponse,
} from 'hrc-core'
import { buildDispatchInvocation, normalizeDispatchIntent } from './dispatch-invocation.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import {
  requireContinuity,
  requireManagedAppSession,
  requireSession,
  requireTmuxPane,
  resolveManagedHarnessIntent,
  validateAppSessionFence,
} from './require-helpers.js'
import {
  findLatestRuntime,
  requireLatestRuntime,
  requireLatestSessionRuntime,
  resolveActiveRunId,
} from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { finalizeRuntimeTermination } from './server-misc.js'
import {
  normalizeOptionalQuery,
  parseAppHarnessInFlightInputRequest,
  parseAppSessionSelectorFromQuery,
  parseApplyAppSessionsRequest,
  parseApplyManagedAppSessionsRequest,
  parseClearAppSessionContextRequest,
  parseDispatchAppHarnessTurnRequest,
  parseEnsureAppSessionRequest,
  parseInterruptAppSessionRequest,
  parseJsonBody,
  parseRemoveAppSessionRequest,
  parseSendLiteralInputRequest,
  parseTerminateAppSessionRequest,
} from './server-parsers.js'
import { createHostSessionId, isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { getObservedTmuxSessionName } from './startup-reconcile.js'
import { toManagedSessionRecord } from './status-views.js'
import { isInteractiveRuntimeLive } from './sweep-helpers.js'

export async function handleApplyAppSessions(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseApplyAppSessionsRequest(await parseJsonBody(request))
  requireSession(this.db, body.hostSessionId)

  const result = this.db.appSessions.bulkApply(body.appId, body.hostSessionId, body.sessions)

  return json({
    inserted: result.inserted,
    updated: result.updated,
    removed: result.removed,
  } satisfies ApplyAppSessionsResponse)
}

export function handleListAppSessions(this: HrcServerInstanceForHandlers, url: URL): Response {
  const appId = normalizeOptionalQuery(url.searchParams.get('appId'))
  const hostSessionId = normalizeOptionalQuery(url.searchParams.get('hostSessionId'))
  if (!appId) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'appId is required', {
      field: 'appId',
    })
  }
  if (!hostSessionId) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }

  requireSession(this.db, hostSessionId)
  return json(
    this.db.appSessions.findByHostSession(hostSessionId).filter((record) => record.appId === appId)
  )
}

export async function handleEnsureAppSession(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseEnsureAppSessionRequest(await parseJsonBody(request))
  return await this.ensureAppSessionFromBody(body)
}

/**
 * Core ensure-app-session logic operating on an already-parsed request body.
 * Extracted from {@link handleEnsureAppSession} so in-process callers (e.g.
 * apply-managed-sessions) can invoke it directly instead of constructing a
 * synthetic HTTP {@link Request} to re-enter the route. Behavior-preserving.
 */
export async function ensureAppSessionFromBody(
  this: HrcServerInstanceForHandlers,
  body: EnsureAppSessionRequest
): Promise<Response> {
  const { appId, appSessionKey } = body.selector
  const spec = body.spec

  // Merge request-level initialPrompt into the harness runtime intent
  if (body.initialPrompt !== undefined && spec.kind === 'harness') {
    spec.runtimeIntent = { ...spec.runtimeIntent, initialPrompt: body.initialPrompt }
  }

  // ---- Dry-run mode: compute the plan without mutating anything -----------
  if (body.dryRun === true) {
    return await this.handleEnsureAppSessionDryRun(body, spec)
  }

  const now = timestamp()

  const existing = this.db.appManagedSessions.findByKey(appId, appSessionKey)

  if (existing) {
    if (existing.status === 'removed') {
      throw new HrcConflictError(
        HrcErrorCode.APP_SESSION_REMOVED,
        `app session "${appId}/${appSessionKey}" has been removed`,
        { appId, appSessionKey }
      )
    }
    if (existing.kind !== spec.kind) {
      throw new HrcUnprocessableEntityError(
        HrcErrorCode.SESSION_KIND_MISMATCH,
        `app session "${appId}/${appSessionKey}" is kind "${existing.kind}", cannot ensure as "${spec.kind}"`,
        { appId, appSessionKey, existingKind: existing.kind, requestedKind: spec.kind }
      )
    }

    // Update spec/label/metadata if provided
    this.db.appManagedSessions.update(appId, appSessionKey, {
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      lastAppliedSpec: spec,
      updatedAt: now,
    })

    let runtimeId: string | undefined
    let restarted = false

    if (spec.kind === 'harness') {
      if (spec.runtimeIntent.harness.interactive) {
        const session = requireSession(this.db, existing.activeHostSessionId)
        const priorRuntime = findLatestRuntime(this.db, session.hostSessionId)

        // Liveness gate (T-01026): when not force-restarting, check if the
        // existing runtime is still alive (tmux pane exists + tracked process
        // running).  If so, skip re-ensure and return the live runtime as-is.
        const runtimeLive = await isInteractiveRuntimeLive(
          priorRuntime,
          body.forceRestart === true,
          this.tmux
        )

        if (runtimeLive && priorRuntime) {
          // Live runtime — reuse as-is without calling ensureRuntimeForSession
          runtimeId = priorRuntime.runtimeId

          // Still honour an explicit initialPrompt even on reattach
          if (body.initialPrompt) {
            const runId = `run-${randomUUID()}`
            const intent = normalizeDispatchIntent(spec.runtimeIntent, session, runId)
            await this.dispatchTurnForSession(session, intent, body.initialPrompt, { runId })
          }
        } else {
          // No live runtime, unavailable, or forceRestart — proceed with re-ensure.
          // When a prior runtime exists but failed liveness (dead process / tmux
          // gone), force fresh_pty so ensureRuntimeForSession creates a new
          // runtime instead of updating the dead one in-place (T-01026).
          const deadRuntimeNeedsReplace =
            priorRuntime !== null && !isRuntimeUnavailableStatus(priorRuntime.status)
          const restartStyle =
            body.restartStyle ??
            (body.forceRestart === true || deadRuntimeNeedsReplace ? 'fresh_pty' : 'reuse_pty')
          const runtime = await this.ensureRuntimeForSession(
            session,
            spec.runtimeIntent,
            restartStyle
          )
          runtimeId = runtime.runtimeId
          restarted = body.forceRestart === true

          // Auto-dispatch harness turn when the runtime was freshly created
          // or when an explicit prompt is provided (T-01021 / T-01024).
          // Skip dispatch when re-ensuring an already-running runtime to
          // avoid RUNTIME_BUSY conflicts on idempotent re-ensure.
          const runtimeIsNew = !priorRuntime || priorRuntime.runtimeId !== runtime.runtimeId
          if (runtimeIsNew || body.initialPrompt) {
            const runId = `run-${randomUUID()}`
            const intent = normalizeDispatchIntent(spec.runtimeIntent, session, runId)
            await this.dispatchTurnForSession(session, intent, body.initialPrompt ?? '', {
              runId,
            })
          }
        }
      }
    } else {
      const session = requireSession(this.db, existing.activeHostSessionId)
      const currentRuntime = findLatestRuntime(this.db, session.hostSessionId)
      const shouldLaunch =
        body.forceRestart === true ||
        !currentRuntime ||
        isRuntimeUnavailableStatus(currentRuntime.status)

      if (shouldLaunch) {
        const runtime = await this.ensureCommandRuntimeForSession(
          session,
          spec.command,
          body.restartStyle ?? (body.forceRestart === true ? 'fresh_pty' : 'reuse_pty'),
          body.forceRestart === true
        )
        runtimeId = runtime.runtimeId
        restarted = body.forceRestart === true
      } else {
        this.db.runtimes.update(currentRuntime.runtimeId, {
          runtimeKind: 'command',
          commandSpec: spec.command,
          updatedAt: now,
        })
        runtimeId = currentRuntime.runtimeId
      }
    }

    const refreshed = this.db.appManagedSessions.findByKey(appId, appSessionKey)
    if (!refreshed) {
      throw new HrcInternalError('managed session disappeared during update', {
        appId,
        appSessionKey,
      })
    }
    return json({
      session: toManagedSessionRecord(refreshed),
      created: false,
      restarted,
      status: restarted ? 'restarted' : 'ensured',
      ...(runtimeId !== undefined ? { runtimeId } : {}),
    } satisfies EnsureAppSessionResponse)
  }

  // Create new managed session with a dedicated host session
  const scopeRef = `app:${appId}`
  const laneRef = appSessionKey
  const hostSessionId = createHostSessionId()

  const session: HrcSessionRecord = {
    hostSessionId,
    scopeRef,
    laneRef,
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  }

  this.db.sessions.insert(session)
  this.db.continuities.upsert({
    scopeRef,
    laneRef,
    activeHostSessionId: hostSessionId,
    updatedAt: now,
  })

  const managed = this.db.appManagedSessions.create({
    appId,
    appSessionKey,
    kind: spec.kind,
    label: body.label,
    metadata: body.metadata,
    activeHostSessionId: hostSessionId,
    generation: 1,
    status: 'active',
    lastAppliedSpec: spec,
    createdAt: now,
    updatedAt: now,
  })

  let runtimeId: string | undefined

  if (spec.kind === 'harness' && spec.runtimeIntent.harness.interactive) {
    const restartStyle = body.restartStyle ?? 'reuse_pty'
    const runtime = await this.ensureRuntimeForSession(session, spec.runtimeIntent, restartStyle)
    runtimeId = runtime.runtimeId

    // Auto-dispatch harness turn — with or without prompt (T-01021 / T-01024)
    const runId = `run-${randomUUID()}`
    const intent = normalizeDispatchIntent(spec.runtimeIntent, session, runId)
    await this.dispatchTurnForSession(session, intent, body.initialPrompt ?? '', { runId })
  }

  if (spec.kind === 'command') {
    const runtime = await this.ensureCommandRuntimeForSession(
      session,
      spec.command,
      body.restartStyle ?? 'reuse_pty',
      false
    )
    runtimeId = runtime.runtimeId
  }

  this.notifyEvent(
    appendHrcEvent(this.db, 'app-session.created', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      appId,
      appSessionKey,
      payload: {
        kind: spec.kind,
      },
    })
  )

  return json({
    session: toManagedSessionRecord(managed),
    created: true,
    restarted: false,
    status: 'created',
    ...(runtimeId !== undefined ? { runtimeId } : {}),
  } satisfies EnsureAppSessionResponse)
}

export async function handleEnsureAppSessionDryRun(
  this: HrcServerInstanceForHandlers,
  body: EnsureAppSessionRequest,
  spec: HrcAppSessionSpec
): Promise<Response> {
  const { appId, appSessionKey } = body.selector
  const existing = this.db.appManagedSessions.findByKey(appId, appSessionKey)

  if (!existing || existing.status === 'removed') {
    // No existing session — would create a new one
    const plan: EnsureAppSessionDryRunPlan = {
      action: 'create',
      sessionExists: false,
    }

    // Build the invocation that would be used
    if (spec.kind === 'harness' && spec.runtimeIntent.harness.interactive) {
      try {
        const invocation = await buildDispatchInvocation(spec.runtimeIntent)
        plan.invocation = invocation
      } catch {
        // Invocation build failed — still report the plan without it
      }
    }

    return json({ dryRun: plan })
  }

  // Session exists — check runtime liveness
  if (spec.kind === 'harness' && spec.runtimeIntent.harness.interactive) {
    const session = requireSession(this.db, existing.activeHostSessionId)
    const priorRuntime = findLatestRuntime(this.db, session.hostSessionId)
    const runtimeLive = await isInteractiveRuntimeLive(
      priorRuntime,
      body.forceRestart === true,
      this.tmux
    )

    if (runtimeLive && priorRuntime) {
      const tmuxSessionName = priorRuntime.tmuxJson
        ? getObservedTmuxSessionName(priorRuntime)
        : undefined

      return json({
        dryRun: {
          action: 'reattach',
          sessionExists: true,
          runtimeId: priorRuntime.runtimeId,
          runtimeStatus: priorRuntime.status,
          runtimePid: priorRuntime.childPid ?? priorRuntime.wrapperPid,
          ...(tmuxSessionName ? { tmuxSession: tmuxSessionName } : {}),
        } satisfies EnsureAppSessionDryRunPlan,
      })
    }

    // Would create a new runtime
    const plan: EnsureAppSessionDryRunPlan = {
      action: 'create',
      sessionExists: true,
      ...(priorRuntime
        ? {
            runtimeId: priorRuntime.runtimeId,
            runtimeStatus: priorRuntime.status,
          }
        : {}),
    }

    try {
      const invocation = await buildDispatchInvocation(spec.runtimeIntent)
      plan.invocation = invocation
    } catch {
      // Invocation build failed — still report the plan without it
    }

    return json({ dryRun: plan })
  }

  // Non-interactive or command session — just report existence
  return json({
    dryRun: {
      action: 'create',
      sessionExists: true,
    } satisfies EnsureAppSessionDryRunPlan,
  })
}

export function handleListManagedAppSessions(
  this: HrcServerInstanceForHandlers,
  url: URL
): Response {
  const appId = normalizeOptionalQuery(url.searchParams.get('appId'))
  if (!appId) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'appId is required', {
      field: 'appId',
    })
  }

  const kind = normalizeOptionalQuery(url.searchParams.get('kind')) as
    | 'harness'
    | 'command'
    | undefined
  const status = normalizeOptionalQuery(url.searchParams.get('status')) as
    | 'active'
    | 'removed'
    | undefined
  const includeRemoved = status === 'removed' || url.searchParams.get('includeRemoved') === 'true'

  let sessions = this.db.appManagedSessions.findByApp(appId, {
    kind,
    includeRemoved,
  })

  if (status !== undefined) {
    sessions = sessions.filter((s) => s.status === status)
  }

  return json(sessions.map(toManagedSessionRecord))
}

export function handleGetManagedAppSessionByKey(
  this: HrcServerInstanceForHandlers,
  url: URL
): Response {
  const appId = normalizeOptionalQuery(url.searchParams.get('appId'))
  const appSessionKey = normalizeOptionalQuery(url.searchParams.get('appSessionKey'))

  if (!appId) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'appId is required', {
      field: 'appId',
    })
  }
  if (!appSessionKey) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'appSessionKey is required', {
      field: 'appSessionKey',
    })
  }

  const managed = this.db.appManagedSessions.findByKey(appId, appSessionKey)
  if (!managed) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_APP_SESSION,
      `unknown app session "${appId}/${appSessionKey}"`,
      { appId, appSessionKey }
    )
  }

  return json(toManagedSessionRecord(managed))
}

export async function handleRemoveAppSession(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseRemoveAppSessionRequest(await parseJsonBody(request))
  return await this.removeAppSessionFromBody(body)
}

/**
 * Core remove-app-session logic operating on an already-parsed request body.
 * Extracted from {@link handleRemoveAppSession} so in-process callers (e.g.
 * apply-managed-sessions prune) can invoke it directly instead of constructing a
 * synthetic HTTP {@link Request}. Behavior-preserving.
 */
export async function removeAppSessionFromBody(
  this: HrcServerInstanceForHandlers,
  body: RemoveAppSessionRequest
): Promise<Response> {
  const { appId, appSessionKey } = body.selector
  const now = timestamp()

  const managed = this.db.appManagedSessions.findByKey(appId, appSessionKey)
  if (!managed) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_APP_SESSION,
      `unknown app session "${appId}/${appSessionKey}"`,
      { appId, appSessionKey }
    )
  }

  if (managed.status === 'removed') {
    return json({
      removed: true,
      runtimeTerminated: false,
      bridgesClosed: 0,
      surfacesUnbound: 0,
    } satisfies RemoveAppSessionResponse)
  }

  // Mark session as removed
  this.db.appManagedSessions.update(appId, appSessionKey, {
    status: 'removed',
    removedAt: now,
    updatedAt: now,
  })

  let runtimeTerminated = false
  let bridgesClosed = 0
  let surfacesUnbound = 0
  const hostSessionId = managed.activeHostSessionId

  // Terminate runtime if requested (default: true for harness sessions)
  const shouldTerminate = body.terminateRuntime !== false
  if (shouldTerminate) {
    const runtimes = this.db.runtimes.listByHostSessionId(hostSessionId)
    for (const runtime of runtimes) {
      if (!isRuntimeUnavailableStatus(runtime.status)) {
        if (runtime.transport === 'tmux' && runtime.tmuxJson) {
          const tmuxPane = requireTmuxPane(runtime)
          const inspected = await this.tmux.inspectSession(tmuxPane.sessionName)
          if (inspected) {
            await this.tmux.terminate(tmuxPane.sessionName)
          }
        }
        finalizeRuntimeTermination(this.db, runtime, now)
        runtimeTerminated = true
      }
    }
  }

  // Close active bridges for the host session
  const activeBridges = this.db.localBridges.listActive()
  for (const bridge of activeBridges) {
    if (bridge.hostSessionId === hostSessionId) {
      this.db.localBridges.close(bridge.bridgeId, now)
      bridgesClosed += 1
    }
  }

  // Unbind active surfaces for the host session
  const activeSurfaces = this.db.surfaceBindings.listActive()
  for (const surface of activeSurfaces) {
    if (surface.hostSessionId === hostSessionId) {
      this.db.surfaceBindings.unbind(
        surface.surfaceKind,
        surface.surfaceId,
        now,
        'app-session-removed'
      )
      surfacesUnbound += 1
    }
  }

  // Archive the host session
  this.db.sessions.updateStatus(hostSessionId, 'archived', now)

  const session = this.db.sessions.getByHostSessionId(hostSessionId)
  if (session) {
    this.notifyEvent(
      appendHrcEvent(this.db, 'app-session.removed', {
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        appId,
        appSessionKey,
        payload: {
          runtimeTerminated,
          bridgesClosed,
          surfacesUnbound,
        },
      })
    )
  }

  return json({
    removed: true,
    runtimeTerminated,
    bridgesClosed,
    surfacesUnbound,
  } satisfies RemoveAppSessionResponse)
}

export async function handleApplyManagedAppSessions(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseApplyManagedAppSessionsRequest(await parseJsonBody(request))
  const results: EnsureAppSessionResponse[] = []
  let ensured = 0
  let removed = 0

  // Ensure each session in the payload
  for (const entry of body.sessions) {
    const ensureBody: EnsureAppSessionRequest = {
      selector: { appId: body.appId, appSessionKey: entry.appSessionKey },
      spec: entry.spec,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    }

    const existing = this.db.appManagedSessions.findByKey(body.appId, entry.appSessionKey)

    // For apply, re-create removed sessions by updating status back to active
    if (existing?.status === 'removed') {
      const now = timestamp()
      this.db.appManagedSessions.update(body.appId, entry.appSessionKey, {
        status: 'active',
        removedAt: null,
        lastAppliedSpec: entry.spec,
        updatedAt: now,
      })
    }

    // Use internal ensure logic directly (no synthetic HTTP self-call)
    const ensureResponse = await this.ensureAppSessionFromBody(ensureBody)
    const result = (await ensureResponse.json()) as EnsureAppSessionResponse
    results.push(result)
    ensured += 1
  }

  // Prune missing sessions if requested
  if (body.pruneMissing === true) {
    const incomingKeys = new Set(body.sessions.map((s) => s.appSessionKey))
    const allActive = this.db.appManagedSessions.findByApp(body.appId, { includeRemoved: false })
    for (const session of allActive) {
      if (!incomingKeys.has(session.appSessionKey)) {
        await this.removeAppSessionFromBody({
          selector: { appId: body.appId, appSessionKey: session.appSessionKey },
        })
        removed += 1
      }
    }
  }

  return json({
    ensured,
    removed,
    results,
  } satisfies ApplyAppManagedSessionsResponse)
}

export async function handleAppSessionDispatchTurn(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseDispatchAppHarnessTurnRequest(await parseJsonBody(request))
  const managed = requireManagedAppSession(this.db, body.selector)
  if (managed.kind !== 'harness') {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.SESSION_KIND_MISMATCH,
      `app session "${managed.appId}/${managed.appSessionKey}" is kind "${managed.kind}", cannot dispatch turns`,
      {
        appId: managed.appId,
        appSessionKey: managed.appSessionKey,
        existingKind: managed.kind,
        requestedOperation: 'dispatch-turn',
      }
    )
  }

  const requestedSession = requireSession(this.db, managed.activeHostSessionId)
  const continuity = requireContinuity(this.db, requestedSession)
  const activeSession = requireSession(this.db, continuity.activeHostSessionId)
  const fence = validateFence(body.fences, {
    activeHostSessionId: activeSession.hostSessionId,
    generation: activeSession.generation,
  })

  if (!fence.ok) {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, fence.message, fence.detail)
  }

  const session = requireSession(this.db, fence.resolvedHostSessionId)
  const runId = body.runId ?? `run-${randomUUID()}`
  const intent = normalizeDispatchIntent(
    body.runtimeIntent ?? resolveManagedHarnessIntent(managed, session),
    session,
    runId
  )

  return await this.dispatchTurnForSession(session, intent, body.prompt, {
    runId,
    ensureInteractiveRuntime: true,
  })
}

export async function handleAppSessionInFlightInput(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseAppHarnessInFlightInputRequest(await parseJsonBody(request))
  const managed = requireManagedAppSession(this.db, body.selector)
  if (managed.kind !== 'harness') {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.SESSION_KIND_MISMATCH,
      `app session "${managed.appId}/${managed.appSessionKey}" is kind "${managed.kind}", cannot accept semantic in-flight input`,
      {
        appId: managed.appId,
        appSessionKey: managed.appSessionKey,
        existingKind: managed.kind,
        requestedOperation: 'in-flight-input',
      }
    )
  }

  const session = requireSession(this.db, managed.activeHostSessionId)
  validateAppSessionFence(body.fence, session)
  const runtime = requireLatestSessionRuntime(this.db, session.hostSessionId)
  const runId = body.runId ?? resolveActiveRunId(this.db, runtime)
  const result = await this.deliverInFlightInputToRuntime(session, runtime, {
    runtimeId: runtime.runtimeId,
    runId,
    prompt: body.prompt,
    ...(body.inputType ? { inputType: body.inputType } : {}),
  })

  return json({
    ...result,
    hostSessionId: session.hostSessionId,
  } satisfies SendAppHarnessInFlightInputResponse)
}

export async function handleAppSessionClearContext(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseClearAppSessionContextRequest(await parseJsonBody(request))
  const managed = requireManagedAppSession(this.db, body.selector)
  const session = requireSession(this.db, managed.activeHostSessionId)
  return json(
    (await this.rotateSessionContext(session, {
      relaunch: body.relaunch === true,
      managed,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.spec ? { relaunchSpec: body.spec } : {}),
    })) satisfies ClearAppSessionContextResponse
  )
}

export async function handleAppSessionLiteralInput(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseSendLiteralInputRequest(await parseJsonBody(request))
  const managed = requireManagedAppSession(this.db, body.selector)
  const session = requireSession(this.db, managed.activeHostSessionId)

  if (managed.kind !== 'command') {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.SESSION_KIND_MISMATCH,
      `app session "${managed.appId}/${managed.appSessionKey}" is kind "${managed.kind}", cannot accept literal input`,
      {
        appId: managed.appId,
        appSessionKey: managed.appSessionKey,
        existingKind: managed.kind,
        requestedOperation: 'literal-input',
      }
    )
  }

  validateAppSessionFence(body.fence, session)
  const runtime = requireLatestRuntime(this.db, session.hostSessionId)

  const pane = requireTmuxPane(runtime)
  const tmux = this.tmuxForPane(pane)
  if (body.enter === true) {
    await tmux.sendKeys(pane.paneId, body.text)
  } else {
    await tmux.sendLiteral(pane.paneId, body.text)
  }

  const now = timestamp()
  this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
  const event = appendHrcEvent(this.db, 'app-session.literal-input', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    appId: managed.appId,
    appSessionKey: managed.appSessionKey,
    payload: {
      payloadLength: body.text.length,
      enter: body.enter === true,
    },
  })
  this.notifyEvent(event)

  return json({
    delivered: true,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
  } satisfies SendLiteralInputResponse)
}

export async function handleAppSessionCapture(
  this: HrcServerInstanceForHandlers,
  url: URL
): Promise<Response> {
  const { runtime } = this.resolveManagedSessionRuntime(parseAppSessionSelectorFromQuery(url))
  return await this.captureRuntime(runtime)
}

export function handleAppSessionAttach(this: HrcServerInstanceForHandlers, url: URL): Response {
  const { runtime } = this.resolveManagedSessionRuntime(parseAppSessionSelectorFromQuery(url))
  return this.attachRuntime(runtime, { allowLegacyOperatorAttach: true })
}

export async function handleAppSessionInterrupt(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseInterruptAppSessionRequest(await parseJsonBody(request))
  const { runtime } = this.resolveManagedSessionRuntime(body.selector)
  return await this.interruptRuntime(runtime, body.hard === true)
}

export async function handleAppSessionTerminate(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseTerminateAppSessionRequest(await parseJsonBody(request))
  const { runtime } = this.resolveManagedSessionRuntime(body.selector)
  return await this.terminateRuntime(runtime)
}

export const appSessionHandlersMethods = {
  handleApplyAppSessions,
  handleListAppSessions,
  handleEnsureAppSession,
  ensureAppSessionFromBody,
  handleEnsureAppSessionDryRun,
  handleListManagedAppSessions,
  handleGetManagedAppSessionByKey,
  handleRemoveAppSession,
  removeAppSessionFromBody,
  handleApplyManagedAppSessions,
  handleAppSessionDispatchTurn,
  handleAppSessionInFlightInput,
  handleAppSessionClearContext,
  handleAppSessionLiteralInput,
  handleAppSessionCapture,
  handleAppSessionAttach,
  handleAppSessionInterrupt,
  handleAppSessionTerminate,
}

export type AppSessionHandlersMethods = typeof appSessionHandlersMethods
