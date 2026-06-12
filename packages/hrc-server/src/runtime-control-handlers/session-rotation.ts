import { HrcConflictError, HrcErrorCode, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  ClearContextResponse,
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import type { AppManagedSessionRecord } from 'hrc-store-sqlite'
import { BrokerControllerError } from '../broker/controller.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import {
  requireContinuity,
  requireManagedAppSession,
  requireSession,
  requireTmuxPane,
  resolveClearContextSpec,
} from '../require-helpers.js'
import { findLatestRuntime, requireLatestRuntime } from '../runtime-select.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import { finalizeRuntimeTermination } from '../server-misc.js'
import { createHostSessionId, isRuntimeUnavailableStatus, timestamp } from '../server-util.js'

export function resolveManagedSessionRuntime(
  this: HrcServerInstanceForHandlers,
  selector: HrcAppSessionRef
): {
  managed: AppManagedSessionRecord
  session: HrcSessionRecord
  runtime: HrcRuntimeSnapshot
} {
  const managed = requireManagedAppSession(this.db, selector)
  const session = requireSession(this.db, managed.activeHostSessionId)
  const runtime = requireLatestRuntime(this.db, session.hostSessionId)
  return { managed, session, runtime }
}

export async function maybeAutoRotateStaleSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  options: {
    allowStaleGeneration?: boolean | undefined
    trigger: string
  }
): Promise<{
  session: HrcSessionRecord
  rotated: boolean
  ageSec: number
  thresholdSec: number
  priorGeneration?: number | undefined
  priorHostSessionId?: string | undefined
}> {
  const createdAtMs = Date.parse(session.createdAt)
  const ageSec = Number.isFinite(createdAtMs)
    ? Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000))
    : 0
  const thresholdSec = this.staleGenerationThresholdSec

  if (
    !this.staleGenerationEnabled ||
    thresholdSec <= 0 ||
    options.allowStaleGeneration === true ||
    ageSec < thresholdSec
  ) {
    return { session, rotated: false, ageSec, thresholdSec }
  }

  // Don't rotate sessions that have a live interactive tmux runtime — the
  // pane is the user-visible state of the agent, and rotating would call
  // invalidateHostContext() → tmux.terminate(), killing the REPL out from
  // under an active operator. Stale-generation rotation is bookkeeping for
  // dormant sessions; an actively-running interactive harness is not stale
  // regardless of wall-clock age.
  const liveTmuxRuntime = findLatestRuntime(this.db, session.hostSessionId)
  if (liveTmuxRuntime && !isRuntimeUnavailableStatus(liveTmuxRuntime.status)) {
    writeServerLog('INFO', 'session.generation_auto_rotate_skipped', {
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      ageSec,
      thresholdSec,
      trigger: options.trigger,
      reason: 'live-tmux-runtime',
      runtimeId: liveTmuxRuntime.runtimeId,
    })
    return { session, rotated: false, ageSec, thresholdSec }
  }

  const priorGeneration = session.generation
  const priorHostSessionId = session.hostSessionId
  writeServerLog('INFO', 'session.generation_auto_rotating', {
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    priorHostSessionId,
    priorGeneration,
    ageSec,
    thresholdSec,
    trigger: options.trigger,
  })

  const rotation = await this.rotateSessionContext(session, {
    relaunch: false,
    dropContinuation: true,
    reason: 'stale-generation-auto-rotate',
  })

  const next = requireSession(this.db, rotation.hostSessionId)
  appendHrcEvent(this.db, 'session.generation_auto_rotated', {
    ts: timestamp(),
    hostSessionId: next.hostSessionId,
    scopeRef: next.scopeRef,
    laneRef: next.laneRef,
    generation: next.generation,
    payload: {
      priorHostSessionId,
      priorGeneration,
      nextHostSessionId: next.hostSessionId,
      nextGeneration: next.generation,
      ageSec,
      thresholdSec,
      trigger: options.trigger,
    },
  })

  return {
    session: next,
    rotated: true,
    ageSec,
    thresholdSec,
    priorGeneration,
    priorHostSessionId,
  }
}

export async function rotateSessionContext(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  options: {
    relaunch: boolean
    dropContinuation?: boolean | undefined
    managed?: AppManagedSessionRecord | undefined
    relaunchSpec?: HrcAppSessionSpec | undefined
    reason?: string | undefined
  }
): Promise<ClearContextResponse> {
  const continuity = requireContinuity(this.db, session)
  if (continuity.activeHostSessionId !== session.hostSessionId) {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'host session is no longer active', {
      expectedHostSessionId: session.hostSessionId,
      activeHostSessionId: continuity.activeHostSessionId,
    })
  }

  const effectiveSpec = resolveClearContextSpec(
    options.managed,
    options.relaunchSpec,
    options.relaunch
  )
  const reason = options.reason ?? 'clear-context'
  const now = timestamp()
  const nextSession: HrcSessionRecord = {
    hostSessionId: createHostSessionId(),
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation + 1,
    status: 'active',
    priorHostSessionId: session.hostSessionId,
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: session.ancestorScopeRefs,
    ...(session.lastAppliedIntentJson
      ? { lastAppliedIntentJson: session.lastAppliedIntentJson }
      : {}),
    ...(!options.dropContinuation && session.continuation
      ? { continuation: session.continuation }
      : {}),
  }

  const invalidated = await this.invalidateHostContext(session.hostSessionId, reason)
  this.db.sessions.updateStatus(session.hostSessionId, 'archived', now)
  this.db.sessions.insert(nextSession)
  this.db.continuities.upsert({
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    activeHostSessionId: nextSession.hostSessionId,
    updatedAt: now,
  })

  if (options.managed) {
    this.db.appManagedSessions.update(options.managed.appId, options.managed.appSessionKey, {
      activeHostSessionId: nextSession.hostSessionId,
      generation: nextSession.generation,
      ...(effectiveSpec ? { lastAppliedSpec: effectiveSpec } : {}),
      updatedAt: now,
    })
  }

  const clearedEvent = appendHrcEvent(this.db, 'context.cleared', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    ...(options.managed
      ? {
          appId: options.managed.appId,
          appSessionKey: options.managed.appSessionKey,
        }
      : {}),
    payload: {
      nextHostSessionId: nextSession.hostSessionId,
      relaunch: options.relaunch,
      bridgesClosed: invalidated.bridgesClosed,
      surfacesUnbound: invalidated.surfacesUnbound,
      runtimesTerminated: invalidated.runtimesTerminated,
      dropContinuation: options.dropContinuation === true,
      ...(options.reason ? { reason: options.reason } : {}),
    },
  })
  this.notifyEvent(clearedEvent)

  const createdEvent = appendHrcEvent(this.db, 'session.created', {
    ts: now,
    hostSessionId: nextSession.hostSessionId,
    scopeRef: nextSession.scopeRef,
    laneRef: nextSession.laneRef,
    generation: nextSession.generation,
    payload: {
      created: true,
      priorHostSessionId: session.hostSessionId,
    },
  })
  this.notifyEvent(createdEvent)

  if (options.relaunch) {
    if (effectiveSpec) {
      if (effectiveSpec.kind === 'harness') {
        if (effectiveSpec.runtimeIntent.harness.interactive) {
          // T-01759 (Wave C): route relaunch through the same broker-only start
          // path as `hrc start` so it always produces a harness-broker runtime,
          // never a legacy tmux runtime.
          await this.startRuntimeForSession(nextSession, effectiveSpec.runtimeIntent, 'fresh_pty')
        } else {
          this.db.sessions.updateIntent(
            nextSession.hostSessionId,
            effectiveSpec.runtimeIntent,
            timestamp()
          )
        }
      } else {
        await this.ensureCommandRuntimeForSession(
          nextSession,
          effectiveSpec.command,
          'fresh_pty',
          true
        )
      }
    } else {
      const relaunchIntent = nextSession.lastAppliedIntentJson
      if (!relaunchIntent) {
        throw new HrcUnprocessableEntityError(
          HrcErrorCode.MISSING_RUNTIME_INTENT,
          'cannot relaunch without a prior runtime intent'
        )
      }
      // T-01759 (Wave C): relaunch through the broker-only start path used by
      // `hrc start` so the rematerialized runtime is always harness-broker.
      await this.startRuntimeForSession(nextSession, relaunchIntent, 'fresh_pty')
    }
  }

  return {
    hostSessionId: nextSession.hostSessionId,
    generation: nextSession.generation,
    priorHostSessionId: session.hostSessionId,
  } satisfies ClearContextResponse
}

export async function invalidateHostContext(
  this: HrcServerInstanceForHandlers,
  hostSessionId: string,
  reason: string
): Promise<{
  bridgesClosed: number
  surfacesUnbound: number
  runtimesTerminated: number
}> {
  const now = timestamp()
  let runtimesTerminated = 0
  for (const runtime of this.db.runtimes.listByHostSessionId(hostSessionId)) {
    if (isRuntimeUnavailableStatus(runtime.status)) {
      continue
    }

    if (
      runtime.transport === 'tmux' &&
      runtime.controllerKind === 'harness-broker' &&
      runtime.tmuxJson
    ) {
      const disposeResult = await this.getHarnessBrokerController()
        .dispose(runtime.runtimeId)
        .catch((error: unknown) => ({
          ok: false as const,
          error:
            error instanceof BrokerControllerError
              ? error
              : new BrokerControllerError(
                  'broker_dispose_failed',
                  error instanceof Error ? error.message : String(error)
                ),
        }))
      if (!disposeResult.ok && disposeResult.error.code !== 'broker_runtime_not_active') {
        writeServerLog('WARN', 'broker runtime dispose failed during context invalidation', {
          runtimeId: runtime.runtimeId,
          error: disposeResult.error.message,
          code: disposeResult.error.code,
        })
      }
    } else if (runtime.transport === 'tmux' && runtime.tmuxJson) {
      const tmuxPane = requireTmuxPane(runtime)
      const inspected = await this.tmux.inspectSession(tmuxPane.sessionName)
      if (inspected) {
        await this.tmux.terminate(tmuxPane.sessionName)
      }
    }

    finalizeRuntimeTermination(this.db, runtime, now)
    runtimesTerminated += 1
  }

  let bridgesClosed = 0
  for (const bridge of this.db.localBridges.listActive()) {
    if (bridge.hostSessionId === hostSessionId) {
      this.db.localBridges.close(bridge.bridgeId, now)
      bridgesClosed += 1
    }
  }

  let surfacesUnbound = 0
  for (const surface of this.db.surfaceBindings.listActive()) {
    if (surface.hostSessionId === hostSessionId) {
      this.db.surfaceBindings.unbind(surface.surfaceKind, surface.surfaceId, now, reason)
      surfacesUnbound += 1
    }
  }

  return {
    bridgesClosed,
    surfacesUnbound,
    runtimesTerminated,
  }
}
