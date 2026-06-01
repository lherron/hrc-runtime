import {
  HrcBadRequestError,
  HrcErrorCode,
  HrcNotFoundError,
} from 'hrc-core'
import type {
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTargetRuntimeView,
  HrcTargetState,
  HrcTargetView,
  TargetCapabilityView,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {
  normalizeTargetLane,
  normalizeTargetSessionRef,
  targetLaneCandidates,
} from './messages.js'
import {
  isRuntimeUnavailableStatus,
  requireContinuity,
  requireSession,
} from './require-helpers.js'
import { findBoundSessionRuntime } from './runtime-select.js'
import { parseSessionRef, type BridgeTargetRequest } from './server-parsers.js'

export function findContinuitySession(
  db: HrcDatabase,
  sessionRef: string
): HrcSessionRecord | null {
  const { scopeRef, laneRef } = parseSessionRef(sessionRef)
  const continuity = db.continuities.getByKey(scopeRef, laneRef)
  if (!continuity) {
    return null
  }

  return db.sessions.getByHostSessionId(continuity.activeHostSessionId)
}

export function findTargetSession(db: HrcDatabase, sessionRef: string): HrcSessionRecord | null {
  const { scopeRef, laneRef } = parseSessionRef(normalizeTargetSessionRef(sessionRef))
  const candidates: HrcSessionRecord[] = []

  for (const candidateLaneRef of targetLaneCandidates(laneRef)) {
    const continuity = db.continuities.getByKey(scopeRef, candidateLaneRef)
    if (continuity) {
      const session = db.sessions.getByHostSessionId(continuity.activeHostSessionId)
      if (session) {
        candidates.push(session)
      }
    }
  }

  for (const candidateLaneRef of targetLaneCandidates(laneRef)) {
    candidates.push(...db.sessions.listByScopeRef(scopeRef, candidateLaneRef))
  }

  return selectLatestTargetSession(candidates)
}

export function selectLatestTargetSession(sessions: HrcSessionRecord[]): HrcSessionRecord | null {
  return (
    sessions.reduce<HrcSessionRecord | undefined>((latest, candidate) => {
      if (!latest) {
        return candidate
      }

      const latestActive = latest.status === 'active'
      const candidateActive = candidate.status === 'active'
      if (latestActive !== candidateActive) {
        return candidateActive ? candidate : latest
      }

      if (candidate.generation !== latest.generation) {
        return candidate.generation > latest.generation ? candidate : latest
      }

      return candidate.updatedAt >= latest.updatedAt ? candidate : latest
    }, undefined) ?? null
  )
}

export function isActiveTargetSession(db: HrcDatabase, session: HrcSessionRecord): boolean {
  const continuity = db.continuities.getByKey(session.scopeRef, session.laneRef)
  if (!continuity) {
    return true
  }

  return continuity.activeHostSessionId === session.hostSessionId
}

export function toTargetState(
  session: HrcSessionRecord,
  runtime: HrcTargetRuntimeView | undefined
): HrcTargetState {
  if (session.status !== 'active') {
    return 'broken'
  }
  if (!runtime) {
    return 'summoned'
  }
  if (
    runtime.activeRunId !== undefined ||
    runtime.status === 'busy' ||
    runtime.status === 'starting'
  ) {
    return 'busy'
  }

  if (runtime.transport === 'headless') {
    return 'summoned'
  }

  return 'bound'
}

export function toTargetCapabilities(
  session: HrcSessionRecord,
  runtime: HrcTargetRuntimeView | undefined,
  state: HrcTargetState
): TargetCapabilityView {
  const modesSupported = new Set<'headless' | 'nonInteractive'>()
  if (
    runtime?.transport === 'sdk' ||
    session.lastAppliedIntentJson?.harness.interactive === false
  ) {
    modesSupported.add('nonInteractive')
  }
  if (
    runtime?.transport === 'tmux' ||
    runtime?.transport === 'ghostty' ||
    runtime?.transport === 'headless' ||
    session.lastAppliedIntentJson?.harness.interactive === true
  ) {
    modesSupported.add('headless')
  }

  const supported = Array.from(modesSupported)
  return {
    state,
    modesSupported: supported,
    defaultMode: supported[0] ?? 'none',
    dmReady: supported.length > 0 || session.lastAppliedIntentJson !== undefined,
    sendReady: runtime?.transport === 'tmux' || runtime?.transport === 'ghostty',
    peekReady: runtime !== undefined && runtime.transport !== 'headless',
  }
}

export function toTargetRuntimeView(
  runtime: HrcRuntimeSnapshot | null
): HrcTargetRuntimeView | undefined {
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    return undefined
  }
  if (
    runtime.transport !== 'sdk' &&
    runtime.transport !== 'tmux' &&
    runtime.transport !== 'headless' &&
    runtime.transport !== 'ghostty'
  ) {
    return undefined
  }

  return {
    runtimeId: runtime.runtimeId,
    transport: runtime.transport,
    status: runtime.status,
    supportsLiteralSend: runtime.transport === 'tmux' || runtime.transport === 'ghostty',
    supportsCapture: runtime.transport !== 'headless',
    activeRunId: runtime.activeRunId,
    lastActivityAt: runtime.lastActivityAt,
  }
}

export function toTargetView(db: HrcDatabase, session: HrcSessionRecord): HrcTargetView {
  const runtime = toTargetRuntimeView(findBoundSessionRuntime(db, session.hostSessionId))
  const state = toTargetState(session, runtime)
  const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef

  return {
    sessionRef: `${session.scopeRef}/lane:${laneRef}`,
    scopeRef: session.scopeRef,
    laneRef,
    state,
    parsedScopeJson: session.parsedScopeJson,
    lastAppliedIntentJson: session.lastAppliedIntentJson,
    continuation: session.continuation,
    activeHostSessionId: session.hostSessionId,
    generation: session.generation,
    runtime,
    capabilities: toTargetCapabilities(session, runtime, state),
  }
}

export function resolveBridgeTargetSession(
  db: HrcDatabase,
  request: BridgeTargetRequest
): HrcSessionRecord {
  if (request.hostSessionId !== undefined) {
    return requireSession(db, request.hostSessionId)
  }

  if (request.selector === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'hostSessionId or selector is required'
    )
  }

  if ('hostSessionId' in request.selector) {
    return requireSession(db, request.selector.hostSessionId)
  }

  if ('sessionRef' in request.selector) {
    const session = findContinuitySession(db, request.selector.sessionRef)
    if (!session) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_SESSION,
        `unknown session "${request.selector.sessionRef}"`,
        {
          sessionRef: request.selector.sessionRef,
        }
      )
    }

    return session
  }

  const appSession = db.appManagedSessions.findByKey(
    request.selector.appSession.appId,
    request.selector.appSession.appSessionKey
  )
  if (!appSession || appSession.status === 'removed') {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_APP_SESSION, 'unknown app session', {
      appId: request.selector.appSession.appId,
      appSessionKey: request.selector.appSession.appSessionKey,
    })
  }

  const session = requireSession(db, appSession.activeHostSessionId)
  const continuity = requireContinuity(db, session)
  return requireSession(db, continuity.activeHostSessionId)
}
