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
} from 'hrc-core'
import type {
  ApplyAppManagedSessionsResponse,
  ApplyAppSessionsResponse,
  EnsureAppSessionDryRunPlan,
  EnsureAppSessionRequest,
  EnsureAppSessionResponse,
  HrcAppSessionSpec,
  HrcSessionRecord,
  RemoveAppSessionRequest,
  RemoveAppSessionResponse,
} from 'hrc-core'
import type { AppManagedSessionRecord } from 'hrc-store-sqlite'
import {
  assertAppIdentityCurrent,
  assertAppIntentIdentityEnv,
  onAppIdentityOwnerRelease,
  withAppIdentityOwner,
} from './app-session-identity.js'
import {
  handleAppSessionAttach,
  handleAppSessionCapture,
  handleAppSessionClearContext,
  handleAppSessionDispatchTurn,
  handleAppSessionInFlightInput,
  handleAppSessionInterrupt,
  handleAppSessionLiteralInput,
  handleAppSessionTerminate,
} from './app-session-runtime-handlers.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import {
  evictExternalParticipant,
  isExternalLifecycleOwner,
} from './external-participant-lifecycle.js'
import { assertSummonAuthority } from './federation/summon-gate-server.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import {
  isBrokerRuntimeInputDispatchable,
  requireSession,
  requireTmuxPane,
} from './require-helpers.js'
import { findLatestRuntime } from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { finalizeRuntimeTermination } from './server-misc.js'
import {
  normalizeOptionalQuery,
  parseApplyAppSessionsRequest,
  parseApplyManagedAppSessionsRequest,
  parseEnsureAppSessionRequest,
  parseJsonBody,
  parseRemoveAppSessionRequest,
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

/** Upper bound for an ensure to await its own just-born runtime (T-09823). */
const ENSURE_BORN_RUNTIME_READY_WAIT_MS = 60_000
const ENSURE_BORN_RUNTIME_READY_POLL_MS = 100

/**
 * T-09823: a fresh birth can return while its broker invocation is still
 * `starting`. The producer-selected reuse door refuses a transitioning seat and
 * leaves the retry to the caller — but ensure IS the caller, and its first turn
 * belongs on the runtime it just made. Await that runtime's readiness (bounded)
 * before the auto-dispatch. This is not a retry: on a failed/unavailable runtime
 * or at the bound it returns, and the dispatch reports the same typed refusal.
 */
async function awaitBornRuntimeDispatchable(
  server: HrcServerInstanceForHandlers,
  runtimeId: string
): Promise<void> {
  const deadline = Date.now() + ENSURE_BORN_RUNTIME_READY_WAIT_MS
  while (Date.now() < deadline) {
    const runtime = server.db.runtimes.getByRuntimeId(runtimeId)
    if (
      runtime === null ||
      runtime.status === 'failed' ||
      isRuntimeUnavailableStatus(runtime.status) ||
      isBrokerRuntimeInputDispatchable(server.db, runtime)
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, ENSURE_BORN_RUNTIME_READY_POLL_MS))
  }
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
    await awaitBornRuntimeDispatchable(this, runtime.runtimeId)

    // Auto-dispatch harness turn — with or without prompt (T-01021 / T-01024).
    // Ensure materializes the session and admits its first turn; it never
    // waits for that turn to complete. A reused live v2 headless runtime would
    // otherwise block ensure on the provider turn (T-09746, since 78b1077b).
    const runId = `run-${randomUUID()}`
    const intent = normalizeDispatchIntent(spec.runtimeIntent, session, runId)
    await this.dispatchTurnForSession(session, intent, body.initialPrompt ?? '', {
      runId,
      waitForCompletion: false,
    })
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
          await this.dispatchTurnForSession(session, intent, body.initialPrompt, {
            runId,
            waitForCompletion: false,
          })
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
          if (runtimeIsNew) await awaitBornRuntimeDispatchable(this, runtime.runtimeId)
          const runId = `run-${randomUUID()}`
          const intent = normalizeDispatchIntent(spec.runtimeIntent, session, runId)
          await this.dispatchTurnForSession(session, intent, body.initialPrompt ?? '', {
            runId,
            waitForCompletion: false,
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

export {
  handleAppSessionAttach,
  handleAppSessionCapture,
  handleAppSessionClearContext,
  handleAppSessionDispatchTurn,
  handleAppSessionInFlightInput,
  handleAppSessionInterrupt,
  handleAppSessionLiteralInput,
  handleAppSessionTerminate,
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
