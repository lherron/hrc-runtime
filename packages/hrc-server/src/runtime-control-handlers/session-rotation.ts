import { HrcConflictError, HrcErrorCode, HrcUnprocessableEntityError } from 'hrc-core'
import type { ClearContextResponse, HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import {
  evictExternalParticipant,
  isExternalLifecycleOwner,
} from '../external-participant-lifecycle.js'
import { assertScopeNotRetired } from '../federation/summon-gate-server.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import { assertLocalPersonaAllowed } from '../local-persona-policy.js'
import { requireContinuity, requireSession, requireTmuxPane } from '../require-helpers.js'
import { findLatestRuntime } from '../runtime-select.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import { finalizeRuntimeTermination } from '../server-misc.js'
import { createHostSessionId, isRuntimeUnavailableStatus, timestamp } from '../server-util.js'
import {
  disposeBrokerRuntime,
  hasBrokerLeasedTmux,
  teardownBrokerLeasedTmux,
} from './broker-dispose.js'
import { sessionEventBase } from './session-event-base.js'

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
  assertLocalPersonaAllowed(this, session.scopeRef)
  // T-09762: a stale generation of a scope this node retired is never rotated
  // into a successor. That rotation is how svc minted gens 3-5 of a max3 scope.
  await assertScopeNotRetired(this, { scopeRef: session.scopeRef, path: 'resolve-session' })
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
    ...sessionEventBase(next, timestamp()),
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
    runtimeIntent?: HrcRuntimeIntent | undefined
    reason?: string | undefined
    /**
     * Extra statements to execute inside the SAME transaction as the successor
     * session's insert (T-07118). The suffix-roster claim uses this so the claim
     * row and the session it names commit — or vanish — together; a daemon death
     * before commit can never leave a claim pointing at a session that does not
     * exist, nor a rotated slot with no claim to converge on.
     */
    withinTransaction?: ((nextSession: HrcSessionRecord) => void) | undefined
  }
): Promise<ClearContextResponse> {
  assertLocalPersonaAllowed(this, session.scopeRef)
  const continuity = requireContinuity(this.db, session)
  if (continuity.activeHostSessionId !== session.hostSessionId) {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'host session is no longer active', {
      expectedHostSessionId: session.hostSessionId,
      activeHostSessionId: continuity.activeHostSessionId,
    })
  }

  const reason = options.reason ?? 'clear-context'
  const now = timestamp()
  const inheritedIntent = session.lastAppliedIntentJson
  const successorIntent =
    options.runtimeIntent ??
    (options.dropContinuation === true && inheritedIntent !== undefined
      ? withoutPerBirthOperatorChoice(inheritedIntent)
      : inheritedIntent)
  const nextSession: HrcSessionRecord = {
    hostSessionId: createHostSessionId(),
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation + 1,
    status: 'active',
    priorHostSessionId: session.hostSessionId,
    createdAt: now,
    updatedAt: now,
    ...(successorIntent ? { lastAppliedIntentJson: successorIntent } : {}),
    ...(!options.dropContinuation && session.continuation
      ? { continuation: session.continuation }
      : {}),
  }

  const invalidated = await this.invalidateHostContext(session.hostSessionId, reason)
  this.db.sqlite.transaction(() => {
    this.db.sessions.updateStatus(session.hostSessionId, 'archived', now)
    this.db.sessions.insert(nextSession)
    this.db.continuities.upsert({
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      activeHostSessionId: nextSession.hostSessionId,
      updatedAt: now,
    })
    options.withinTransaction?.(nextSession)
  })()

  const clearedEvent = appendHrcEvent(this.db, 'context.cleared', {
    ...sessionEventBase(session, now),
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
    ...sessionEventBase(nextSession, now),
    payload: {
      created: true,
      priorHostSessionId: session.hostSessionId,
    },
  })
  this.notifyEvent(createdEvent)

  if (options.relaunch) {
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

  return {
    hostSessionId: nextSession.hostSessionId,
    generation: nextSession.generation,
    priorHostSessionId: session.hostSessionId,
  } satisfies ClearContextResponse
}

/**
 * A dropped continuation is a new birth, not a replay of the prior birth.
 * Keep the reusable execution/provisioning intent, but make an omitted operator
 * presentation choice consult node policy again. Callers that deliberately
 * choose a presentation for the successor pass `runtimeIntent` explicitly.
 */
function withoutPerBirthOperatorChoice(intent: HrcRuntimeIntent): HrcRuntimeIntent {
  if (intent.presentation?.operator === undefined) return intent
  const { operator: _operator, ...presentation } = intent.presentation
  const { presentation: _priorPresentation, ...rest } = intent
  return Object.keys(presentation).length > 0 ? { ...rest, presentation } : rest
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

    if (isExternalLifecycleOwner(runtime)) {
      await evictExternalParticipant(this, runtime)
      runtimesTerminated += 1
      continue
    }

    if (runtime.controllerKind === 'harness-broker') {
      await disposeBrokerRuntime(this.getHarnessBrokerController(), runtime.runtimeId, {
        logMessage: 'broker runtime dispose failed during context invalidation',
      })
      if (hasBrokerLeasedTmux(runtime)) {
        await teardownBrokerLeasedTmux(runtime, {
          runtimeRoot: this.options.runtimeRoot,
          logMessage: 'broker leased tmux teardown failed during context invalidation',
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
