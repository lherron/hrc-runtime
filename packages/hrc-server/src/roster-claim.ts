import { buildScopeRef } from 'agent-scope'
import {
  HrcConflictError,
  HrcErrorCode,
  type HrcRuntimeSnapshot,
  HrcRuntimeUnavailableError,
  type HrcSessionRecord,
  type StartRuntimeResponse,
  type StartRuntimeRosterClaim,
  type SuffixStartRuntimeRequest,
} from 'hrc-core'
import { ROSTER_SLOT_TOKENS } from 'spaces-config'

import type { HrcServerInstanceForHandlers } from './server-instance-context.js'

import { sendRemoteRosterStart } from './federation/roster-start-client.js'
import {
  preflightSuffixRosterFamily,
  resolveImplicitScopeHome,
} from './federation/summon-gate-server.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import {
  type ClaimScopeIdentity,
  canonicalRequestHash,
  isClaimScopeFree,
  localizeIntentToSession,
  mintClaimedSession,
  parseClaimScopeIdentity,
  recycleClaimedSession,
  replayRecordedClaim,
  withScopeClaimMutex,
} from './scope-claim-core.js'
import { toStartRuntimeResponse } from './status-views.js'
import { findContinuitySession } from './target-view.js'

/**
 * The fixed celestial roster (T-07118). Ten named slots follow the base slot,
 * iterated in list order. The list is a CONSTANT, not a generator: the slot a
 * given press lands on must be reproducible across daemon versions, and an
 * operator reading `primary-nova` in a tab title must be able to find it here.
 *
 * Suffixed slots are ordinary scope tokens (`[A-Za-z0-9._-]+`), so they address
 * normally over hrcchat and federation — `mable@hrc-runtime:primary-nova` is a
 * real, reachable handle, not a presentation-only alias. That is also why an
 * exact claim (T-07302) can name one, and why both policies share the mutex and
 * FREE predicate in scope-claim-core.ts.
 */
/** Base task token first, then the ten suffixed slots — iteration order. */
export function rosterSlotTokens(baseTaskId: string): string[] {
  return [baseTaskId, ...ROSTER_SLOT_TOKENS.map((suffix) => `${baseTaskId}-${suffix}`)]
}

type RosterBase = ClaimScopeIdentity & {
  readonly baseScopeRef: string
  readonly baseTaskId: string
}

function parseRosterBase(baseSessionRef: string): RosterBase {
  const identity = parseClaimScopeIdentity(baseSessionRef, 'baseSessionRef')
  return { ...identity, baseScopeRef: identity.scopeRef, baseTaskId: identity.taskId }
}

function slotScopeRef(base: RosterBase, slot: string): string {
  return buildScopeRef({
    agentId: base.agentId,
    projectId: base.projectId,
    taskId: slot,
    ...(base.roleName !== undefined ? { roleName: base.roleName } : {}),
  })
}

function slotSessionRef(base: RosterBase, slot: string): string {
  return `${slotScopeRef(base, slot)}/lane:${base.laneRef}`
}

export function suffixRosterFamily(baseSessionRef: string): {
  readonly baseScopeRef: string
  readonly scopeRefs: readonly string[]
} {
  const base = parseRosterBase(baseSessionRef)
  return {
    baseScopeRef: base.baseScopeRef,
    scopeRefs: rosterSlotTokens(base.baseTaskId).map((slot) => slotScopeRef(base, slot)),
  }
}

/**
 * Canonical semantic hash of a whole suffix-start request. Persisted alongside
 * the claim so an identical retry and a conflicting replay stay distinguishable
 * after a daemon restart, when the in-memory single-flight map is gone.
 */
export function suffixStartRequestHash(request: SuffixStartRuntimeRequest): string {
  return canonicalRequestHash({
    baseSessionRef: request.baseSessionRef,
    conflictPolicy: request.conflictPolicy,
    // Preserve the pre-federation hash for absent/explicit-local operator
    // retries. Only the new routed semantic changes durable identity.
    ...(request.summonIntent === 'implicit' ? { summonIntent: 'implicit' } : {}),
    runtimeIntent: request.runtimeIntent,
    restartStyle: request.restartStyle,
  })
}

type ClaimOutcome = {
  session: HrcSessionRecord
  slot: string
  replayed: boolean
}

/**
 * Routes only implicit (mobile) roster starts. The origin resolves placement;
 * the authenticated home node independently preflights and owns the claim.
 * Legacy omission stays explicit-local for compatibility with older CLIs.
 */
export async function startRoutedSuffixRosterRuntime(
  this: HrcServerInstanceForHandlers,
  request: SuffixStartRuntimeRequest
): Promise<StartRuntimeResponse> {
  if ((request.summonIntent ?? 'explicit_local') === 'explicit_local') {
    const { runtime, claim } = await startSuffixRosterRuntime.call(this, request)
    return { ...toStartRuntimeResponse(runtime), claim }
  }

  const base = parseRosterBase(request.baseSessionRef)
  const capabilityHint = {
    placement: request.runtimeIntent.placement,
    harness: request.runtimeIntent.harness,
  }
  const homeNodeId = await resolveImplicitScopeHome(this, {
    scopeRef: base.baseScopeRef,
    capabilityHint,
  })
  const config = this.options.federationConfig
  if (config === undefined || !config.sourceExists) {
    throw new HrcRuntimeUnavailableError(
      'implicit suffix-roster provisioning requires federation configuration',
      { scopeRef: base.baseScopeRef, retryable: true }
    )
  }
  if (homeNodeId === config.nodeId) {
    await preflightSuffixRosterFamily(this, {
      baseScopeRef: base.baseScopeRef,
      scopeRefs: rosterSlotTokens(base.baseTaskId).map((slot) => slotScopeRef(base, slot)),
      capabilityHint,
      origin: 'local',
    })
    const { runtime, claim } = await startSuffixRosterRuntime.call(this, request)
    return { ...toStartRuntimeResponse(runtime), claim }
  }

  const peer = [...config.peers.values()].find((candidate) => candidate.nodeId === homeNodeId)
  if (peer === undefined) {
    throw new HrcRuntimeUnavailableError('suffix-roster home is not a configured peer', {
      scopeRef: base.baseScopeRef,
      homeNodeId,
      retryable: true,
    })
  }
  return await sendRemoteRosterStart({ peer, request })
}

/**
 * Suffix-roster START (T-07118): claim a free slot and start it inside ONE
 * request, so a claim is never observable — nor replayable — apart from the
 * start it authorizes.
 *
 * Ordering inside the shared namespace mutex is load-bearing:
 *   1. durable idempotency lookup (hash compare BEFORE any start path, so a
 *      conflicting replay can never reach `startRuntimeForSession`'s intent
 *      write and mutate the claimed session's persisted intent),
 *   2. claim (rotation or fresh mint) + claim row in ONE transaction,
 *   3. `startRuntimeForSession` CALLED — not awaited — so its
 *      `runtimeStartOperations` registration is in place before the mutex is
 *      released and the next claimant (suffix OR exact) evaluates freedom.
 * Boot itself continues outside the mutex.
 */
export async function startSuffixRosterRuntime(
  this: HrcServerInstanceForHandlers,
  request: SuffixStartRuntimeRequest
): Promise<{ runtime: HrcRuntimeSnapshot; claim: StartRuntimeRosterClaim }> {
  const base = parseRosterBase(request.baseSessionRef)
  assertLocalPersonaAllowed(this, base.baseScopeRef)
  const requestHash = suffixStartRequestHash(request)
  const restartStyle = request.restartStyle ?? 'reuse_pty'

  const { outcome, startPromise } = await withScopeClaimMutex(this, base.mutexKey, async () => {
    const claimed = await resolveClaim.call(this, base, request, requestHash)
    const session = claimed.session
    const intent = localizeIntentToSession(request.runtimeIntent, session)
    // Called, not awaited: `startRuntimeForSession` registers its operation in
    // `runtimeStartOperations` synchronously, so by the time this returns a
    // promise the slot is already occupied for predicate (b).
    const pending = this.startRuntimeForSession(session, intent, restartStyle)
    // The real await happens after the mutex is released, so mark the rejection
    // handled here: a start that fails inside that gap is reported through the
    // awaited promise below, never as an unhandled rejection that could take the
    // daemon down.
    pending.catch(() => undefined)
    return { outcome: claimed, startPromise: pending }
  })

  const runtime = await startPromise
  return {
    runtime,
    claim: {
      slot: outcome.slot,
      scopeRef: outcome.session.scopeRef,
      sessionRef: `${outcome.session.scopeRef}/lane:${outcome.session.laneRef}`,
      hostSessionId: outcome.session.hostSessionId,
      idempotencyKey: request.idempotencyKey,
      replayed: outcome.replayed,
      conflictPolicy: 'suffix',
    },
  }
}

/** Durable-idempotent claim resolution. Runs under the shared namespace mutex. */
async function resolveClaim(
  this: HrcServerInstanceForHandlers,
  base: RosterBase,
  request: SuffixStartRuntimeRequest,
  requestHash: string
): Promise<ClaimOutcome> {
  const replayed = replayRecordedClaim(this, {
    idempotencyKey: request.idempotencyKey,
    requestHash,
  })
  if (replayed !== null) {
    return {
      session: replayed.session,
      slot: slotTokenOf(replayed.claimedScope, base),
      replayed: true,
    }
  }

  const claimRecord = {
    idempotencyKey: request.idempotencyKey,
    requestHash,
    claimSubjectScope: base.baseScopeRef,
  }

  for (const slot of rosterSlotTokens(base.baseTaskId)) {
    const sessionRef = slotSessionRef(base, slot)
    const existing = findContinuitySession(this.db, sessionRef)
    if (existing === null) {
      const minted = await mintClaimedSession(this, {
        ...claimRecord,
        scopeRef: slotScopeRef(base, slot),
        laneRef: base.laneRef,
        reason: 'roster-suffix-claim',
        capabilityHint: {
          placement: request.runtimeIntent.placement,
          harness: request.runtimeIntent.harness,
        },
        eventDetails: { baseScope: base.baseScopeRef },
      })
      return { session: minted, slot, replayed: false }
    }
    if (!isClaimScopeFree(this, existing)) continue

    // Recycle: rotation always drops the continuation, so a claimed slot always
    // starts a FRESH conversation rather than resuming a stranger's.
    const successor = await recycleClaimedSession(
      this,
      existing,
      claimRecord,
      'roster-suffix-claim'
    )
    return { session: successor, slot, replayed: false }
  }

  throw new HrcConflictError(
    HrcErrorCode.SESSION_ROSTER_EXHAUSTED,
    'every roster slot for this scope is occupied by a live session',
    {
      baseScope: base.baseScopeRef,
      laneRef: base.laneRef,
      slots: rosterSlotTokens(base.baseTaskId),
    }
  )
}

/** The slot token embedded in a claimed scope ref, for response reporting. */
function slotTokenOf(claimedScopeRef: string, base: RosterBase): string {
  try {
    return parseClaimScopeIdentity(`${claimedScopeRef}/lane:${base.laneRef}`, 'claimedScope').taskId
  } catch {
    return base.baseTaskId
  }
}

export const rosterClaimHandlersMethods = {
  startSuffixRosterRuntime,
  startRoutedSuffixRosterRuntime,
}

export type RosterClaimHandlersMethods = typeof rosterClaimHandlersMethods
