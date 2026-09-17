import { randomUUID } from 'node:crypto'

import {
  APP_SESSION_SCOPE_PREFIX,
  HrcBadRequestError,
  HrcConflictError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
  HrcUnprocessableEntityError,
  appSessionSelectorKey,
  validateAppSessionSelector,
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
import type { AppManagedSessionRecord } from 'hrc-store-sqlite'
import {
  assertAppIdentityCurrent,
  assertAppIntentIdentityEnv,
  assertAppRunIdUnused,
  onAppIdentityOwnerRelease,
  withAppIdentityOwner,
} from './app-session-identity.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import {
  evictExternalParticipant,
  isExternalLifecycleOwner,
} from './external-participant-lifecycle.js'
import { assertSummonAuthority } from './federation/summon-gate-server.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import {
  requireContinuity,
  requireManagedAppSession,
  requireSession,
  requireTmuxPane,
  resolveManagedHarnessIntent,
  validateAppSessionFence,
} from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
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
 * Extracted from {@link handleEnsureAppSession} so in-process callers can invoke
 * it directly instead of constructing a synthetic HTTP {@link Request}.
 *
 * T-08576: every non-dry-run ensure runs under the selector's app identity
 * owner (D8), validates before any write (D3/D7), and creates identity in one
 * transaction.
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

  assertLocalPersonaAllowed(this, `${APP_SESSION_SCOPE_PREFIX}${appId}`)

  // ---- Dry-run mode: compute the plan without mutating anything -----------
  if (body.dryRun === true) {
    return await this.handleEnsureAppSessionDryRun(body, spec)
  }

  if (spec.kind === 'harness') {
    assertAppIntentIdentityEnv(spec.runtimeIntent, 'spec.runtimeIntent')
  }

  const selector = { appId, appSessionKey }
  const arrivalEpoch = appIdentityCreationEpoch(this.db, selector)
  return await withAppIdentityOwner(this.db, selector, () =>
    ensureAppSessionOwned.call(this, body, spec, arrivalEpoch)
  )
}

const appIdentityCreationEpochs = new WeakMap<object, Map<string, number>>()

function appIdentityCreationEpoch(
  db: HrcServerInstanceForHandlers['db'],
  selector: { appId: string; appSessionKey: string }
): number {
  return appIdentityCreationEpochs.get(db)?.get(appSessionSelectorKey(selector)) ?? 0
}

function bumpAppIdentityCreationEpoch(
  db: HrcServerInstanceForHandlers['db'],
  selector: { appId: string; appSessionKey: string }
): void {
  let epochs = appIdentityCreationEpochs.get(db)
  if (epochs === undefined) {
    epochs = new Map()
    appIdentityCreationEpochs.set(db, epochs)
  }
  const key = appSessionSelectorKey(selector)
  epochs.set(key, (epochs.get(key) ?? 0) + 1)
}

/** The ensure body, run while the caller holds the selector's app identity owner. */
async function ensureAppSessionOwned(
  this: HrcServerInstanceForHandlers,
  body: EnsureAppSessionRequest,
  spec: HrcAppSessionSpec,
  arrivalEpoch: number
): Promise<Response> {
  const { appId, appSessionKey } = body.selector
  const selector = { appId, appSessionKey }
  const existing = this.db.appManagedSessions.findByKey(appId, appSessionKey)
  if (existing) {
    // An ensure that waited behind the creation of this identity is answered by
    // that creation: its fresh runtime already satisfies a restart request.
    const forceRestart =
      body.forceRestart === true && appIdentityCreationEpoch(this.db, selector) === arrivalEpoch
    return await ensureExistingAppSession.call(this, body, spec, existing, forceRestart)
  }

  validateAppSessionSelector(selector)
  const scopeRef = `${APP_SESSION_SCOPE_PREFIX}${appId}`
  const laneRef = appSessionKey

  // Gated for completeness of the session-creation cut set. `app:<appId>` is a
  // synthetic container rather than an agent scope, so the gate abstains
  // (`non-agent-scope`) — see summon-gate.ts for why that is not a coverage hole.
  await assertSummonAuthority(this, { scopeRef, path: 'app-session', intent: 'implicit' })

  const now = timestamp()
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

  // D3: session, continuity, managed row and the created event commit together.
  const created = this.db.sqlite
    .transaction(() => {
      const raced = this.db.appManagedSessions.findByKey(appId, appSessionKey)
      if (raced) return { raced }
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
      const event = appendHrcEvent(this.db, 'app-session.created', {
        ts: now,
        hostSessionId,
        scopeRef,
        laneRef,
        generation: 1,
        appId,
        appSessionKey,
        payload: { kind: spec.kind },
      })
      return { managed, event }
    })
    .immediate()
  if ('raced' in created) {
    return await ensureExistingAppSession.call(
      this,
      body,
      spec,
      created.raced,
      body.forceRestart === true
    )
  }
  // Requests queued behind this create arrived before the identity existed; bump
  // at release so their forceRestart does not relaunch the birth it never saw.
  onAppIdentityOwnerRelease(selector, () => bumpAppIdentityCreationEpoch(this.db, selector))
  this.notifyEvent(created.event)

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

  return json({
    session: toManagedSessionRecord(created.managed),
    created: true,
    restarted: false,
    status: 'created',
    ...(runtimeId !== undefined ? { runtimeId } : {}),
  } satisfies EnsureAppSessionResponse)
}

async function ensureExistingAppSession(
  this: HrcServerInstanceForHandlers,
  body: EnsureAppSessionRequest,
  spec: HrcAppSessionSpec,
  existing: AppManagedSessionRecord,
  forceRestart: boolean
): Promise<Response> {
  const { appId, appSessionKey } = body.selector
  const now = timestamp()
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

  const session = requireSession(this.db, existing.activeHostSessionId)
  assertAppIdentityCurrent(this.db, session)

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
      const priorRuntime = findLatestRuntime(this.db, session.hostSessionId)

      // Liveness gate (T-01026): when not force-restarting, check if the
      // existing runtime is still alive (tmux pane exists + tracked process
      // running).  If so, skip re-ensure and return the live runtime as-is.
      const runtimeLive = await isInteractiveRuntimeLive(priorRuntime, forceRestart, this.tmux)

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
          body.restartStyle ?? (forceRestart || deadRuntimeNeedsReplace ? 'fresh_pty' : 'reuse_pty')
        const runtime = await this.ensureRuntimeForSession(
          session,
          spec.runtimeIntent,
          restartStyle
        )
        runtimeId = runtime.runtimeId
        restarted = forceRestart

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
    const currentRuntime = findLatestRuntime(this.db, session.hostSessionId)
    const shouldLaunch =
      forceRestart || !currentRuntime || isRuntimeUnavailableStatus(currentRuntime.status)

    if (shouldLaunch) {
      const runtime = await this.ensureCommandRuntimeForSession(
        session,
        spec.command,
        body.restartStyle ?? (forceRestart ? 'fresh_pty' : 'reuse_pty'),
        forceRestart
      )
      runtimeId = runtime.runtimeId
      restarted = forceRestart
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

export async function handleEnsureAppSessionDryRun(
  this: HrcServerInstanceForHandlers,
  body: EnsureAppSessionRequest,
  spec: HrcAppSessionSpec
): Promise<Response> {
  const { appId, appSessionKey } = body.selector
  const existing = this.db.appManagedSessions.findByKey(appId, appSessionKey)

  if (!existing || existing.status === 'removed') {
    // No existing session — would create a new one. The plan names the
    // outcome only; the broker-plan preview (T-08584) is the only preview.
    const plan: EnsureAppSessionDryRunPlan = {
      action: 'create',
      sessionExists: false,
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

    // Would create a new runtime. The plan names the outcome only; the
    // broker-plan preview (T-08584) is the only preview.
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
 * apply-managed-sessions prune) can invoke it directly.
 *
 * T-08576 D9: removal runs under the selector owner; the managed status and the
 * host-session archive commit together before teardown, and a retry on an
 * already-removed selector re-runs the idempotent teardown.
 */
export async function removeAppSessionFromBody(
  this: HrcServerInstanceForHandlers,
  body: RemoveAppSessionRequest
): Promise<Response> {
  const { appId, appSessionKey } = body.selector
  return await withAppIdentityOwner(this.db, { appId, appSessionKey }, () =>
    removeAppSessionOwned.call(this, body)
  )
}

async function removeAppSessionOwned(
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

  const hostSessionId = managed.activeHostSessionId
  const alreadyRemoved = managed.status === 'removed'
  if (!alreadyRemoved) {
    // T-08576 D9: status, archive and the removal event commit together. Teardown
    // counts are not known yet, so they are reported only in the response.
    const removedEvent = this.db.sqlite
      .transaction(() => {
        this.db.appManagedSessions.update(appId, appSessionKey, {
          status: 'removed',
          removedAt: now,
          updatedAt: now,
        })
        this.db.sessions.updateStatus(hostSessionId, 'archived', now)
        const session = this.db.sessions.getByHostSessionId(hostSessionId)
        if (!session) return undefined
        return appendHrcEvent(this.db, 'app-session.removed', {
          ts: now,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          appId,
          appSessionKey,
          payload: { kind: managed.kind },
        })
      })
      .immediate()
    if (removedEvent) this.notifyEvent(removedEvent)
  }

  let runtimeTerminated = false
  let bridgesClosed = 0
  let surfacesUnbound = 0

  // Terminate runtime if requested (default: true for harness sessions)
  const shouldTerminate = body.terminateRuntime !== false
  if (shouldTerminate) {
    const runtimes = this.db.runtimes.listByHostSessionId(hostSessionId)
    for (const runtime of runtimes) {
      if (!isRuntimeUnavailableStatus(runtime.status)) {
        if (isExternalLifecycleOwner(runtime)) {
          await evictExternalParticipant(this, runtime)
          runtimeTerminated = true
          continue
        }
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

  // T-08576 D3/D7: the whole payload is authorized and validated before any
  // entry is touched. Prune-only applies are teardown and stay exempt.
  if (body.sessions.length > 0) {
    assertLocalPersonaAllowed(this, `${APP_SESSION_SCOPE_PREFIX}${body.appId}`)
  }
  for (const entry of body.sessions) {
    validateAppSessionSelector({ appId: body.appId, appSessionKey: entry.appSessionKey })
    if (entry.spec.kind === 'harness') {
      assertAppIntentIdentityEnv(entry.spec.runtimeIntent, 'spec.runtimeIntent')
    }
  }

  for (const entry of body.sessions) {
    const selector = { appId: body.appId, appSessionKey: entry.appSessionKey }
    const ensureBody: EnsureAppSessionRequest = {
      selector,
      spec: entry.spec,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    }
    const arrivalEpoch = appIdentityCreationEpoch(this.db, selector)
    const result = await withAppIdentityOwner(this.db, selector, async () => {
      const existing = this.db.appManagedSessions.findByKey(body.appId, entry.appSessionKey)
      if (existing?.status === 'removed') {
        reactivateRemovedAppSession.call(this, existing, entry.spec)
      }
      const response = await ensureAppSessionOwned.call(this, ensureBody, entry.spec, arrivalEpoch)
      return (await response.json()) as EnsureAppSessionResponse
    })
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

/**
 * T-08576 D9: reactivating a removed selector mints a successor incarnation in
 * one transaction; the archived predecessor is never relaunched.
 */
function reactivateRemovedAppSession(
  this: HrcServerInstanceForHandlers,
  managed: AppManagedSessionRecord,
  spec: HrcAppSessionSpec
): void {
  const now = timestamp()
  const predecessor = requireSession(this.db, managed.activeHostSessionId)
  const successor: HrcSessionRecord = {
    hostSessionId: createHostSessionId(),
    scopeRef: predecessor.scopeRef,
    laneRef: predecessor.laneRef,
    generation: managed.generation + 1,
    status: 'active',
    priorHostSessionId: predecessor.hostSessionId,
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: predecessor.ancestorScopeRefs,
  }
  const event = this.db.sqlite
    .transaction(() => {
      if (predecessor.status !== 'archived') {
        this.db.sessions.updateStatus(predecessor.hostSessionId, 'archived', now)
      }
      this.db.sessions.insert(successor)
      this.db.continuities.upsert({
        scopeRef: successor.scopeRef,
        laneRef: successor.laneRef,
        activeHostSessionId: successor.hostSessionId,
        updatedAt: now,
      })
      this.db.appManagedSessions.update(managed.appId, managed.appSessionKey, {
        status: 'active',
        removedAt: null,
        activeHostSessionId: successor.hostSessionId,
        generation: successor.generation,
        lastAppliedSpec: spec,
        updatedAt: now,
      })
      return appendHrcEvent(this.db, 'app-session.created', {
        ts: now,
        hostSessionId: successor.hostSessionId,
        scopeRef: successor.scopeRef,
        laneRef: successor.laneRef,
        generation: successor.generation,
        appId: managed.appId,
        appSessionKey: managed.appSessionKey,
        payload: { kind: spec.kind, reactivatedFromHostSessionId: predecessor.hostSessionId },
      })
    })
    .immediate()
  this.notifyEvent(event)
}

export async function handleAppSessionDispatchTurn(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseDispatchAppHarnessTurnRequest(await parseJsonBody(request))
  assertLocalPersonaAllowed(this, `${APP_SESSION_SCOPE_PREFIX}${body.selector.appId}`)
  assertAppIntentIdentityEnv(body.runtimeIntent, 'runtimeIntent')
  return await withAppIdentityOwner(this.db, body.selector, async () => {
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
    assertAppIdentityCurrent(this.db, session)
    assertAppRunIdUnused(this.db, body.runId)
    const runId = body.runId ?? `run-${randomUUID()}`
    const effectiveIntent = body.runtimeIntent ?? resolveManagedHarnessIntent(managed, session)
    assertAppIntentIdentityEnv(effectiveIntent, 'stored-or-supplied intent')
    const intent = normalizeDispatchIntent(effectiveIntent, session, runId)

    return await this.dispatchTurnForSession(session, intent, body.prompt, {
      runId,
      ensureInteractiveRuntime: true,
    })
  })
}

export async function handleAppSessionInFlightInput(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseAppHarnessInFlightInputRequest(await parseJsonBody(request))
  assertLocalPersonaAllowed(this, `${APP_SESSION_SCOPE_PREFIX}${body.selector.appId}`)
  return await withAppIdentityOwner(this.db, body.selector, async () => {
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
    assertAppIdentityCurrent(this.db, session)
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
  })
}

export async function handleAppSessionClearContext(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseClearAppSessionContextRequest(await parseJsonBody(request))
  assertLocalPersonaAllowed(this, `${APP_SESSION_SCOPE_PREFIX}${body.selector.appId}`)
  if (body.spec?.kind === 'harness') {
    assertAppIntentIdentityEnv(body.spec.runtimeIntent, 'spec.runtimeIntent')
  }
  return await withAppIdentityOwner(this.db, body.selector, async () => {
    const managed = requireManagedAppSession(this.db, body.selector)
    const session = requireSession(this.db, managed.activeHostSessionId)
    assertAppIdentityCurrent(this.db, session)
    return json(
      (await this.rotateSessionContext(session, {
        relaunch: body.relaunch === true,
        managed,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.spec ? { relaunchSpec: body.spec } : {}),
      })) satisfies ClearAppSessionContextResponse
    )
  })
}

export async function handleAppSessionLiteralInput(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseSendLiteralInputRequest(await parseJsonBody(request))
  assertLocalPersonaAllowed(this, `${APP_SESSION_SCOPE_PREFIX}${body.selector.appId}`)
  return await withAppIdentityOwner(this.db, body.selector, async () => {
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
    assertAppIdentityCurrent(this.db, session)
    const runtime = requireLatestRuntime(this.db, session.hostSessionId)

    const pane = requireTmuxPane(runtime)
    const tmux = this.tmuxForPane(pane)
    if (body.enter === true) {
      await tmux.sendKeys(pane.paneId, body.text)
    } else {
      await tmux.sendLiteral(pane.paneId, body.text)
    }

    const now = timestamp()
    this.db.runtimes.update(
      runtime.runtimeId,
      runtimeActivityPatch(this.db, runtime.runtimeId, {
        source: 'agent-message',
        occurredAt: now,
        updatedAt: now,
      })
    )
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
  })
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
  return this.attachRuntime(runtime, { allowLegacyTmuxAttach: true })
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
