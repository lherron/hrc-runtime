import { randomUUID } from 'node:crypto'
import {
  type DropContinuationResponse,
  HrcConflictError,
  HrcErrorCode,
  HrcNotFoundError,
  type HrcSessionRecord,
  type HrcSessionRetitledEventPayload,
  type LaunchCommandScopedRunResponse,
  type ResolveSessionResponse,
} from 'hrc-core'
import {
  appSelectorForSession,
  refuseAppScopedSession,
  withAppIdentityOwner,
} from './app-session-identity.js'
import {
  commandRunId,
  commandRunOperationId,
  commandRunResponseFromRun,
  finalizeConfiguredCommandRun,
  parseCommandRunSessionRef,
} from './command-run-helpers.js'
import { validateConfiguredCommandRunTarget } from './command-run-targets-config.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import {
  assertScopeNotRetired,
  persistSessionTaskClaimAuthority,
  withSummonAuthority,
} from './federation/summon-gate-server.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import type { HrcServerInstance } from './index.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import { resolveSessionProjectionDays } from './option-resolvers.js'
import {
  findManagedAppSessionForSession,
  isRunActive,
  requireKnownRuntime,
  requireRuntime,
  requireSession,
} from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import {
  COMMAND_RUNTIME_COMPAT_HARNESS,
  COMMAND_RUNTIME_COMPAT_PROVIDER,
} from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { parseRuntimeIdQuery } from './server-misc.js'
import {
  normalizeOptionalQuery,
  parseClearContextRequest,
  parseDropContinuationRequest,
  parseJsonBody,
  parseLaunchCommandScopedRunRequest,
  parseResolveSessionRequest,
  parseRuntimeActionBody,
  parseSessionAllQuery,
  parseSessionLimitQuery,
  parseSessionRef,
  parseSessionStatusQuery,
  parseSessionUpdatedSinceQuery,
  parseTerminateRuntimeRequest,
} from './server-parsers.js'
import { createHostSessionId, json, timestamp } from './server-util.js'
import { dropSessionContinuation } from './session-continuation-reuse.js'
import { decorateSessionTitles, parseSessionTitleWriteInput } from './session-title-helpers.js'
import { findContinuitySession } from './target-view.js'

export const serverSessionMethods = {
  async handleResolveSession(this: HrcServerInstance, request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    const parsed = parseResolveSessionRequest(body)
    const { scopeRef, laneRef } = parseSessionRef(parsed.sessionRef)
    if (parsed.create === true) {
      // T-08576 G8: resolve-create never mints app identity.
      refuseAppScopedSession({ scopeRef, laneRef }, 'resolve-create')
      assertLocalPersonaAllowed(this, scopeRef)
    }
    const existing = findContinuitySession(this.db, parsed.sessionRef)
    if (existing) {
      if (parsed.create === true) {
        // `resolve --create` is a summon surface even when continuity already
        // exists. A retired scope must not regain authority merely because a
        // pre-retirement session/runtime row survived the fence installation.
        await assertScopeNotRetired(this, { scopeRef, path: 'resolve-session' })
      }

      return json({
        found: true,
        hostSessionId: existing.hostSessionId,
        generation: existing.generation,
        created: false,
        session: existing,
      } satisfies ResolveSessionResponse)
    }

    if (parsed.create !== true) {
      return json({
        found: false,
        hostSessionId: null,
        generation: null,
        created: false,
        session: null,
      } satisfies ResolveSessionResponse)
    }

    // Covers `hrc run`, `hrc start`, and `hrc session resolve --create` — and
    // every generic SDK caller besides. `create: true` cannot tell those apart,
    // so the caller says which it is: `hrc run`/`hrc start` send
    // `explicit_local`, everything else omits the field and gets `implicit`
    // (spec §5). An omission is never upgraded.
    return await withSummonAuthority(
      this,
      {
        scopeRef,
        laneRef,
        path: 'resolve-session',
        intent: parsed.summonIntent ?? 'implicit',
        ...(parsed.runtimeIntent === undefined
          ? {}
          : {
              capabilityHint: {
                placement: parsed.runtimeIntent.placement,
                harness: parsed.runtimeIntent.harness,
              },
              // T-07398: the ensure/dm-summon door honors directives too.
              ...(parsed.runtimeIntent.provision === undefined
                ? {}
                : { provision: parsed.runtimeIntent.provision }),
            }),
      },
      (claimAuthority) => {
        const raced = findContinuitySession(this.db, parsed.sessionRef)
        if (raced !== null) {
          return json({
            found: true,
            hostSessionId: raced.hostSessionId,
            generation: raced.generation,
            created: false,
            session: raced,
          } satisfies ResolveSessionResponse)
        }
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

        const createdSession = this.db.sqlite.transaction(() => {
          const inserted = this.db.sessions.insert(session)
          if (claimAuthority !== undefined) {
            persistSessionTaskClaimAuthority(this, hostSessionId, claimAuthority, now)
          }
          this.db.continuities.upsert({
            scopeRef,
            laneRef,
            activeHostSessionId: hostSessionId,
            updatedAt: now,
          })
          return inserted
        })()

        const event = this.appendEvent(createdSession, 'session.created', {
          created: true,
        })
        this.notifyEvent(event)

        return json({
          found: true,
          hostSessionId,
          generation: createdSession.generation,
          created: true,
          session: createdSession,
        } satisfies ResolveSessionResponse)
      }
    )
  },

  async handleLaunchCommandScopedRun(this: HrcServerInstance, request: Request): Promise<Response> {
    const body = parseLaunchCommandScopedRunRequest(await parseJsonBody(request))
    const operationId = commandRunOperationId(body.idempotencyKey)
    const runId = commandRunId(body.idempotencyKey)
    // T-08576 G7: a command run never mints or acts on app identity.
    const requestedScope = parseCommandRunSessionRef(body.sessionRef)
    refuseAppScopedSession(requestedScope, 'command-run-launch')
    const replay = this.db.runs.getByRunId(runId)
    if (replay) {
      return json(commandRunResponseFromRun(replay, true))
    }
    // T-08576 D5: a run id reserved by an app birth cannot be claimed here.
    if (this.db.runIdOwnership.reservationFor(runId) !== undefined) {
      throw new HrcConflictError(
        HrcErrorCode.RUN_MISMATCH,
        `command run id "${runId}" is reserved by an app session birth`,
        { reason: 'run-id-reserved', runId }
      )
    }

    const command = this.options.commandRunTargets?.[body.configuredTargetId]
    if (!command) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_RUNTIME,
        `unknown command-run target "${body.configuredTargetId}"`,
        { configuredTargetId: body.configuredTargetId }
      )
    }
    validateConfiguredCommandRunTarget(body.configuredTargetId, command)

    const session = await this.resolveOrCreateCommandRunSession(body.sessionRef)
    refuseAppScopedSession(session, 'command-run-launch')
    const runtimeId = `rt-${randomUUID()}`
    const now = timestamp()

    this.db.runtimes.insert({
      runtimeId,
      runtimeKind: 'command',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness: COMMAND_RUNTIME_COMPAT_HARNESS,
      provider: COMMAND_RUNTIME_COMPAT_PROVIDER,
      status: 'busy',
      statusChangedAt: now,
      commandSpec: command,
      supportsInflightInput: false,
      adopted: false,
      activeRunId: runId,
      ...runtimeActivityPatch(this.db, runtimeId, {
        source: 'turn',
        occurredAt: now,
        updatedAt: now,
      }),
      createdAt: now,
    })

    this.db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      status: 'running',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
      operationId,
      invocationId: body.idempotencyKey,
    })

    this.notifyEvent(
      appendHrcEvent(this.db, 'command_run.started', {
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId,
        runId,
        transport: 'tmux',
        payload: {
          configuredTargetId: body.configuredTargetId,
          binding: body.binding,
          idempotencyKey: body.idempotencyKey,
        },
      })
    )

    void finalizeConfiguredCommandRun(this, {
      command,
      binding: body.binding,
      stdinJson: body.stdinJson,
      configuredTargetId: body.configuredTargetId,
      session,
      runtimeId,
      runId,
      transport: 'tmux',
    }).catch((error) => {
      writeServerLog('ERROR', 'command_run.finalize_failed', {
        configuredTargetId: body.configuredTargetId,
        hostSessionId: session.hostSessionId,
        runtimeId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })

    return json({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId,
      generation: session.generation,
      transport: 'tmux',
      replayed: false,
    } satisfies LaunchCommandScopedRunResponse)
  },

  async resolveOrCreateCommandRunSession(
    this: HrcServerInstance,
    sessionRef: string
  ): Promise<HrcSessionRecord> {
    const { scopeRef, laneRef } = parseCommandRunSessionRef(sessionRef)
    refuseAppScopedSession({ scopeRef, laneRef }, 'command-run-launch')
    assertLocalPersonaAllowed(this, scopeRef)
    const continuity = this.db.continuities.getByKey(scopeRef, laneRef)
    if (continuity) {
      const existing = this.db.sessions.getByHostSessionId(continuity.activeHostSessionId)
      if (existing) {
        return existing
      }
    }

    // wrkf / command-run births (POST /v1/command-runs/launch).
    return await withSummonAuthority(
      this,
      {
        scopeRef,
        laneRef,
        path: 'command-run',
        intent: 'implicit',
      },
      (claimAuthority) => {
        const racedContinuity = this.db.continuities.getByKey(scopeRef, laneRef)
        if (racedContinuity !== null) {
          const racedSession = this.db.sessions.getByHostSessionId(
            racedContinuity.activeHostSessionId
          )
          if (racedSession !== null) return racedSession
        }
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

        const createdSession = this.db.sqlite.transaction(() => {
          const inserted = this.db.sessions.insert(session)
          if (claimAuthority !== undefined) {
            persistSessionTaskClaimAuthority(this, hostSessionId, claimAuthority, now)
          }
          this.db.continuities.upsert({
            scopeRef,
            laneRef,
            activeHostSessionId: hostSessionId,
            updatedAt: now,
          })
          return inserted
        })()
        const event = this.appendEvent(createdSession, 'session.created', {
          created: true,
          commandRun: true,
        })
        this.notifyEvent(event)
        return createdSession
      }
    )
  },

  /**
   * T-07575 — an unscoped read is bounded by default.
   *
   * Before this, `GET /v1/sessions` with no `scopeRef` was a bare unbounded
   * scan of the whole table, and there was no parameter a caller could pass to
   * ask for less. On a host with four months of history that is 8k rows and
   * 33 MB of JSON for every dashboard refresh, which is what T-07575 was filed
   * about.
   *
   * The rules, in order:
   *
   * - A **scoped** read (`?scopeRef=`) is never bounded. Every generation of
   *   that scope comes back, always. This is the documented path to history and
   *   the one that selector resolution and resume depend on, so narrowing it
   *   would turn a display fix into a correctness bug.
   * - `?all=true` opts an unscoped read out of the bound entirely.
   * - `?updatedSince=<iso8601>` sets the window explicitly.
   * - Otherwise the window is `HRC_SESSION_PROJECTION_DAYS` (default 7), plus
   *   every session holding a live runtime regardless of age.
   *
   * `?status=` and `?limit=` narrow further; they never widen. Nothing here
   * deletes or hides a row from storage — an excluded session is one HTTP
   * parameter away.
   */
  handleListSessions(this: HrcServerInstance, url: URL): Response {
    const scopeRef = normalizeOptionalQuery(url.searchParams.get('scopeRef'))
    const laneRef = normalizeOptionalQuery(url.searchParams.get('laneRef'))
    const status = parseSessionStatusQuery(url)
    const limit = parseSessionLimitQuery(url)

    const rows = scopeRef
      ? this.listSessionsByScope(scopeRef, laneRef)
      : this.listUnscopedSessionsForProjection(url, laneRef)

    const filtered = status === undefined ? rows : rows.filter((row) => row.status === status)
    const limited = limit === undefined ? filtered : filtered.slice(0, limit)

    // The bound must never be silent: a caller that got 525 of 8,319 rows is
    // told so, in headers rather than in the body so the array shape every
    // existing consumer parses is untouched. `total` is a COUNT over an 8k-row
    // table — cheap next to the projection itself.
    const total = this.countAllSessions()
    return json(decorateSessionTitles(this.db, limited), 200, {
      'X-Hrc-Session-Total': String(total),
      'X-Hrc-Session-Returned': String(limited.length),
      'X-Hrc-Session-Withheld': String(Math.max(0, total - limited.length)),
    })
  },

  /** Total durable session rows, for reporting how much a bounded read withheld. */
  countAllSessions(this: HrcServerInstance): number {
    const row = this.db.sqlite
      .query<{ total: number }, []>('SELECT COUNT(*) AS total FROM sessions')
      .get()
    return row?.total ?? 0
  },

  /**
   * Resolve the unscoped session projection: unbounded on `?all=true`,
   * otherwise bounded by `?updatedSince=` or the configured projection window.
   */
  listUnscopedSessionsForProjection(
    this: HrcServerInstance,
    url: URL,
    laneRef?: string
  ): HrcSessionRecord[] {
    if (parseSessionAllQuery(url)) {
      return this.listAllSessions(laneRef)
    }

    const explicitSince = parseSessionUpdatedSinceQuery(url)
    const updatedSince =
      explicitSince ??
      new Date(Date.now() - resolveSessionProjectionDays() * 24 * 60 * 60 * 1000).toISOString()

    return this.listRecentSessions(updatedSince, laneRef)
  },

  handleGetSessionByHost(this: HrcServerInstance, hostSessionId: string): Response {
    const session = this.db.sessions.getByHostSessionId(hostSessionId)
    if (!session) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_HOST_SESSION,
        `unknown host session "${hostSessionId}"`,
        { hostSessionId }
      )
    }

    const title = this.db.sessionTitles.getByHostSessionId(hostSessionId)?.title
    return json(title === undefined ? session : { ...session, title })
  },

  async handleSetSessionTitle(
    this: HrcServerInstance,
    hostSessionId: string,
    request: Request
  ): Promise<Response> {
    if (!this.db.sessions.getByHostSessionId(hostSessionId)) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_HOST_SESSION,
        `unknown host session "${hostSessionId}"`,
        { hostSessionId }
      )
    }
    const input = parseSessionTitleWriteInput(await parseJsonBody(request))
    const now = timestamp()
    const stored = this.db.sqlite.transaction(() => {
      const existing = this.db.sessionTitles.getByHostSessionId(hostSessionId)
      if (existing?.source === 'manual' && !input.force) {
        throw new HrcConflictError(
          HrcErrorCode.STALE_CONTEXT,
          'manual session title requires force to overwrite',
          {
            hostSessionId,
            existingSource: existing.source,
            requestedSource: input.source,
            requiresForce: true,
          }
        )
      }
      return this.db.sessionTitles.upsert({
        hostSessionId,
        title: input.title,
        source: input.source,
        ...(input.model === undefined ? {} : { model: input.model }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
    })()
    this.appendSessionRetitled(hostSessionId, stored.title, now)
    return json(stored)
  },

  /**
   * T-07594 §5.2 — a title write/clear becomes a ledger fact so a presentation
   * consumer can retitle from the stream instead of polling. `null` is an
   * explicit clear, never an absence. Best-effort by construction: the title
   * has already been committed, and a ledger failure must not fail the write.
   */
  appendSessionRetitled(
    this: HrcServerInstance,
    hostSessionId: string,
    title: string | null,
    ts: string
  ): void {
    const session = this.db.sessions.getByHostSessionId(hostSessionId)
    if (!session) return
    try {
      this.notifyEvent(
        appendHrcEvent(this.db, 'session.retitled', {
          ts,
          hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          payload: { title } satisfies HrcSessionRetitledEventPayload,
        })
      )
    } catch (error) {
      writeServerLog('WARN', 'session_retitled.append_failed', {
        hostSessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  handleDeleteSessionTitle(this: HrcServerInstance, hostSessionId: string): Response {
    if (!this.db.sessions.getByHostSessionId(hostSessionId)) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_HOST_SESSION,
        `unknown host session "${hostSessionId}"`,
        { hostSessionId }
      )
    }
    const deleted = this.db.sessionTitles.delete(hostSessionId)
    if (deleted) {
      this.appendSessionRetitled(hostSessionId, null, timestamp())
    }
    return json({ hostSessionId, deleted })
  },

  async handleClearContext(this: HrcServerInstance, request: Request): Promise<Response> {
    const body = parseClearContextRequest(await parseJsonBody(request))
    const requested = requireSession(this.db, body.hostSessionId)
    // T-09762: an operator rotate mints generation+1 through rotateSessionContext
    // directly, so it gets the same retired-scope fence as auto-rotate and the doors.
    await assertScopeNotRetired(this, { scopeRef: requested.scopeRef, path: 'resolve-session' })
    const appSelector = appSelectorForSession(requested)
    if (appSelector !== null) {
      // T-08576 D8.1: generic clear-context stays supported for app sessions, under
      // the selector owner, with the session re-read after the owner is held.
      assertLocalPersonaAllowed(this, requested.scopeRef)
      return await withAppIdentityOwner(this.db, appSelector, async () => {
        const session = requireSession(this.db, body.hostSessionId)
        return json(
          await this.rotateSessionContext(session, {
            relaunch: body.relaunch === true,
            dropContinuation: body.dropContinuation === true,
            ...(body.runtimeIntent !== undefined ? { runtimeIntent: body.runtimeIntent } : {}),
          })
        )
      })
    }
    const session = requested
    const managed = findManagedAppSessionForSession(this.db, session)
    return json(
      await this.rotateSessionContext(session, {
        relaunch: body.relaunch === true,
        dropContinuation: body.dropContinuation === true,
        ...(body.runtimeIntent !== undefined ? { runtimeIntent: body.runtimeIntent } : {}),
        ...(managed ? { managed } : {}),
      })
    )
  },

  async handleCapture(this: HrcServerInstance, url: URL): Promise<Response> {
    const runtimeId = parseRuntimeIdQuery(url)
    const runtime = requireRuntime(this.db, runtimeId)
    return await this.captureRuntime(runtime)
  },

  async handleAttach(this: HrcServerInstance, url: URL): Promise<Response> {
    const runtimeId = parseRuntimeIdQuery(url)
    const runtime = await this.reconcileTmuxRuntimeLiveness(requireKnownRuntime(this.db, runtimeId))
    return await this.attachRuntimeEffectfully(runtime, { strictRuntimeId: true })
  },

  async handleInterrupt(this: HrcServerInstance, request: Request): Promise<Response> {
    const body = parseRuntimeActionBody(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    if (body.ownerRunId !== undefined && runtime.activeRunId !== body.ownerRunId) {
      return json({
        ok: true,
        hostSessionId: runtime.hostSessionId,
        runtimeId: runtime.runtimeId,
        warning:
          runtime.activeRunId === undefined
            ? 'owned run is no longer active; interrupt skipped'
            : 'another run is active; interrupt skipped',
      })
    }
    return await this.interruptRuntime(runtime, false)
  },

  async handleTerminate(this: HrcServerInstance, request: Request): Promise<Response> {
    const body = parseTerminateRuntimeRequest(await parseJsonBody(request))
    const knownRuntime = requireKnownRuntime(this.db, body.runtimeId)
    // Detached is unavailable for selection and ordinary runtime actions, but
    // it is an expected pre-eviction state for an externally-owned participant.
    // Let the lifecycle-owner branch finalize it instead of rejecting it at the
    // general availability preflight.
    const runtime = isExternalLifecycleOwner(knownRuntime)
      ? knownRuntime
      : requireRuntime(this.db, body.runtimeId)

    if (body.ownerRunId !== undefined && !isExternalLifecycleOwner(runtime)) {
      const rendezvous = this.invokeFirstTurnRendezvous.get(runtime.hostSessionId)
      const crossingRunIds =
        rendezvous !== undefined &&
        (rendezvous.runtimeId === undefined || rendezvous.runtimeId === runtime.runtimeId)
          ? [...rendezvous.crossingRunIds].filter((runId) => runId !== body.ownerRunId)
          : []
      const durableRunIds = this.db.runs
        .listByRuntimeId(runtime.runtimeId)
        .filter((run) => run.runId !== body.ownerRunId && isRunActive(run))
        .map((run) => run.runId)
      // The in-memory rendezvous is absent after a daemon restart. Preserve a
      // runtime for every other still-protected format-2 admission recorded in
      // the durable input ledger; no control acknowledgement proves removal.
      const protectedInputIds = this.db.inputs
        .listProtectedByRuntimeId(runtime.runtimeId)
        .map((input) => input.inputId)
      const protectedOwners = [
        ...new Set([...crossingRunIds, ...durableRunIds, ...protectedInputIds]),
      ]
      if (protectedOwners.length > 0) {
        return json({
          ok: true,
          hostSessionId: runtime.hostSessionId,
          runtimeId: runtime.runtimeId,
          droppedContinuation: false,
          warning: `runtime preserved for other protected work: ${protectedOwners.join(', ')}`,
        })
      }

      // No crossing invoke exists now. Close the old runtime to later
      // admission synchronously, before broker disposal reaches its first
      // await. Broker input-dispatchability reads invocation state, not only
      // the runtime row, so transition both projections in one event-loop turn.
      const stoppingAt = timestamp()
      if (runtime.activeInvocationId !== undefined) {
        this.db.brokerInvocations.update(runtime.activeInvocationId, {
          invocationState: 'stopping',
          updatedAt: stoppingAt,
        })
      }
      this.db.runtimes.update(runtime.runtimeId, {
        status: 'stopping',
        statusChangedAt: stoppingAt,
        updatedAt: stoppingAt,
      })
    }
    return await this.terminateRuntime(runtime, {
      dropContinuation: body.dropContinuation,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.actor !== undefined ? { actor: body.actor } : {}),
    })
  },

  async handleDropContinuation(this: HrcServerInstance, request: Request): Promise<Response> {
    const body = parseDropContinuationRequest(await parseJsonBody(request))
    const session = requireSession(this.db, body.hostSessionId)
    refuseAppScopedSession(session, 'drop-continuation')
    const drop = dropSessionContinuation(this.db, session, body.reason)
    if (drop.event !== undefined) this.notifyEvent(drop.event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      dropped: drop.dropped,
      previousContinuationKey: drop.previousContinuationKey,
    } satisfies DropContinuationResponse)
  },
}

export type ServerSessionMethods = typeof serverSessionMethods
