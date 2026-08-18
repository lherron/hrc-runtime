/**
 * Exact-scope claim-and-start (T-07302).
 *
 * HRC Mobile needs to provision the ONE scope a person typed — including a
 * pinned task scope such as `cody@hrc-runtime:hrcdev` — without turning that
 * name into an eleven-member suffix family and without ever landing the person
 * in somebody else's live conversation.
 *
 * So this path has exactly two outcomes: it claims the named scope and starts a
 * FRESH conversation on it, or it refuses with `session_scope_occupied` having
 * mutated nothing. There is no reuse option and no next slot.
 *
 * It shares scope-claim-core.ts's `roster:<agentId>:<projectId>` mutex and FREE
 * predicate with the suffix roster on purpose. A typed exact token can BE a
 * roster member (`primary-nova`), so two independent locks could each observe
 * that continuity free and both rotate it. One mutex over the whole namespace
 * serializes the overlap instead: whoever gets there first registers its start,
 * and the loser sees the scope occupied (exact) or walks on (suffix).
 */

import {
  type ExactStartRuntimeRequest,
  HrcConflictError,
  HrcErrorCode,
  type HrcRuntimeSnapshot,
  HrcRuntimeUnavailableError,
  type HrcSessionRecord,
  type StartRuntimeResponse,
  type StartRuntimeRosterClaim,
} from 'hrc-core'

import type { HrcServerInstanceForHandlers } from './server-instance-context.js'

import { sendRemoteExactStart } from './federation/exact-start-client.js'
import { preflightExactScope, resolveImplicitScopeHome } from './federation/summon-gate-server.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import {
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

/** The claimable identity named by an exact request, plus its shared mutex key. */
export function exactStartScope(request: ExactStartRuntimeRequest): {
  readonly scopeRef: string
  readonly laneRef: string
  readonly taskId: string
  readonly mutexKey: string
} {
  return parseClaimScopeIdentity(request.sessionRef, 'sessionRef')
}

/**
 * Canonical semantic hash of a whole exact-start request. Persisted alongside
 * the claim so an identical retry and a conflicting replay stay distinguishable
 * after a daemon restart, when the in-memory single-flight map is gone.
 *
 * `conflictPolicy` is part of the hash, so replaying one key across the two
 * policies is a conflict rather than a silent policy switch.
 */
export function exactStartRequestHash(request: ExactStartRuntimeRequest): string {
  return canonicalRequestHash({
    sessionRef: request.sessionRef,
    conflictPolicy: request.conflictPolicy,
    summonIntent: request.summonIntent,
    runtimeIntent: request.runtimeIntent,
    restartStyle: request.restartStyle,
  })
}

/**
 * Origin-side routing for an exact start.
 *
 * The origin resolves the exact scope's home from policy and registry state —
 * the caller asserts no node — and then either owns the claim locally or hands
 * the canonical request to the authenticated home peer, which re-derives all of
 * it for itself.
 */
export async function startRoutedExactScopeRuntime(
  this: HrcServerInstanceForHandlers,
  request: ExactStartRuntimeRequest
): Promise<StartRuntimeResponse> {
  const scope = exactStartScope(request)
  const capabilityHint = {
    placement: request.runtimeIntent.placement,
    harness: request.runtimeIntent.harness,
  }
  const homeNodeId = await resolveImplicitScopeHome(this, {
    scopeRef: scope.scopeRef,
    capabilityHint,
  })
  const config = this.options.federationConfig
  if (config === undefined || !config.sourceExists) {
    throw new HrcRuntimeUnavailableError(
      'exact-scope provisioning requires federation configuration',
      { scopeRef: scope.scopeRef, retryable: true }
    )
  }
  if (homeNodeId === config.nodeId) {
    await preflightExactScope(this, {
      scopeRef: scope.scopeRef,
      capabilityHint,
      origin: 'local',
    })
    const { runtime, claim } = await startExactScopeRuntime.call(this, request)
    return { ...toStartRuntimeResponse(runtime), claim }
  }

  const peer = [...config.peers.values()].find((candidate) => candidate.nodeId === homeNodeId)
  if (peer === undefined) {
    throw new HrcRuntimeUnavailableError('exact-scope home is not a configured peer', {
      scopeRef: scope.scopeRef,
      homeNodeId,
      retryable: true,
    })
  }
  return await sendRemoteExactStart({ peer, request })
}

/**
 * Exact START on the authoritative home.
 *
 * Ordering inside the shared namespace mutex is the same load-bearing sequence
 * the suffix roster uses:
 *   1. durable idempotency lookup (hash compare BEFORE any start path, so a
 *      conflicting replay can never reach `startRuntimeForSession`'s intent
 *      write and mutate the claimed session's persisted intent),
 *   2. occupancy check on the ONE named scope — occupied is the final answer,
 *   3. claim (rotation or fresh mint) + claim row in ONE transaction,
 *   4. `startRuntimeForSession` CALLED — not awaited — so its
 *      `runtimeStartOperations` registration is in place before the mutex is
 *      released and the next claimant evaluates freedom.
 */
export async function startExactScopeRuntime(
  this: HrcServerInstanceForHandlers,
  request: ExactStartRuntimeRequest
): Promise<{ runtime: HrcRuntimeSnapshot; claim: StartRuntimeRosterClaim }> {
  const scope = exactStartScope(request)
  assertLocalPersonaAllowed(this, scope.scopeRef)
  const requestHash = exactStartRequestHash(request)
  const restartStyle = request.restartStyle ?? 'reuse_pty'

  const { session, replayed, startPromise } = await withScopeClaimMutex(
    this,
    scope.mutexKey,
    async () => {
      const claimed = await resolveExactClaim.call(this, request, requestHash)
      const intent = localizeIntentToSession(request.runtimeIntent, claimed.session)
      const pending = this.startRuntimeForSession(claimed.session, intent, restartStyle)
      pending.catch(() => undefined)
      return { ...claimed, startPromise: pending }
    }
  )

  const runtime = await startPromise
  return {
    runtime,
    claim: {
      slot: scope.taskId,
      scopeRef: session.scopeRef,
      sessionRef: `${session.scopeRef}/lane:${session.laneRef}`,
      hostSessionId: session.hostSessionId,
      idempotencyKey: request.idempotencyKey,
      replayed,
      conflictPolicy: 'reject',
    },
  }
}

/** Durable-idempotent exact claim resolution. Runs under the shared mutex. */
async function resolveExactClaim(
  this: HrcServerInstanceForHandlers,
  request: ExactStartRuntimeRequest,
  requestHash: string
): Promise<{ session: HrcSessionRecord; replayed: boolean }> {
  const scope = exactStartScope(request)
  const replayed = replayRecordedClaim(this, {
    idempotencyKey: request.idempotencyKey,
    requestHash,
  })
  if (replayed !== null) return { session: replayed.session, replayed: true }

  const claimRecord = {
    idempotencyKey: request.idempotencyKey,
    requestHash,
    claimSubjectScope: scope.scopeRef,
  }
  const existing = findContinuitySession(this.db, `${scope.scopeRef}/lane:${scope.laneRef}`)
  if (existing === null) {
    const minted = await mintClaimedSession(this, {
      ...claimRecord,
      scopeRef: scope.scopeRef,
      laneRef: scope.laneRef,
      reason: 'exact-scope-claim',
      capabilityHint: {
        placement: request.runtimeIntent.placement,
        harness: request.runtimeIntent.harness,
      },
      eventDetails: { exactScope: scope.scopeRef },
    })
    return { session: minted, replayed: false }
  }

  if (!isClaimScopeFree(this, existing)) {
    // The whole point of `conflictPolicy: 'reject'`: no reuse, no next slot, and
    // above all no mutation of the conversation already living here.
    throw new HrcConflictError(
      HrcErrorCode.SESSION_SCOPE_OCCUPIED,
      'the exact scope is occupied by a live session',
      {
        scopeRef: scope.scopeRef,
        laneRef: scope.laneRef,
        sessionRef: `${scope.scopeRef}/lane:${scope.laneRef}`,
        occupyingHostSessionId: existing.hostSessionId,
        retryable: false,
      }
    )
  }

  const successor = await recycleClaimedSession(this, existing, claimRecord, 'exact-scope-claim')
  return { session: successor, replayed: false }
}

export const exactClaimHandlersMethods = {
  startExactScopeRuntime,
  startRoutedExactScopeRuntime,
}

export type ExactClaimHandlersMethods = typeof exactClaimHandlersMethods
