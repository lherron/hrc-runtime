/**
 * The claim-and-start core shared by BOTH conflict policies.
 *
 * `conflictPolicy: 'suffix'` (T-07118, roster-claim.ts) walks a fixed family of
 * slot scopes; `conflictPolicy: 'reject'` (T-07302, exact-claim.ts) claims the
 * one scope the caller named. They are different search strategies over the
 * SAME namespace — a typed exact token like `primary-nova` IS a roster member —
 * so they must not be able to observe the same continuity free at the same
 * moment and both rotate it.
 *
 * That is why the mutex, the FREE predicate, the durable-claim replay rules and
 * the mint/recycle transaction live here rather than in either caller: sharing
 * them is not a de-duplication convenience, it is the invariant
 * (`hrc-runtime.mobile-exact-scope-provisioning`). One `roster:<agentId>:<projectId>`
 * key, one definition of free, one durable claim table.
 */

import { createHash } from 'node:crypto'

import { parseScopeRef } from 'agent-scope'
import {
  HrcBadRequestError,
  HrcConflictError,
  HrcErrorCode,
  type HrcRuntimeIntent,
  type HrcSessionRecord,
} from 'hrc-core'

import type { HrcServerInstanceForHandlers } from './server-instance-context.js'

import {
  persistSessionTaskClaimAuthority,
  withSummonAuthority,
} from './federation/summon-gate-server.js'
import { parseSessionRef } from './parsers/messages.js'
import { createHostSessionId, isRuntimeUnavailableStatus, timestamp } from './server-util.js'

/** Parsed identity of one claimable scope, plus the mutex key it serializes on. */
export type ClaimScopeIdentity = {
  readonly scopeRef: string
  readonly laneRef: string
  readonly agentId: string
  readonly projectId: string
  readonly taskId: string
  readonly roleName?: string | undefined
  /**
   * Per agent+project mutex key. Deliberately NOT per exact scope: the suffix
   * family and every exact token inside it must serialize against each other.
   */
  readonly mutexKey: string
}

/**
 * Parse a `<scopeRef>/lane:<lane>` session ref into a claimable identity.
 *
 * `field` names the request field in the refusal so the caller sees which of
 * `baseSessionRef` / `sessionRef` was wrong.
 */
export function parseClaimScopeIdentity(sessionRef: string, field: string): ClaimScopeIdentity {
  const { scopeRef, laneRef } = parseSessionRef(sessionRef)
  let parsed: ReturnType<typeof parseScopeRef>
  try {
    parsed = parseScopeRef(scopeRef)
  } catch (error) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field} carries an invalid scope ref: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { field, [field]: sessionRef }
    )
  }
  const { agentId, projectId, taskId, roleName } = parsed as {
    agentId: string
    projectId?: string
    taskId?: string
    roleName?: string
  }
  if (projectId === undefined || taskId === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `claim-and-start requires a project- and task-qualified scope in ${field}`,
      { field, [field]: sessionRef }
    )
  }
  return {
    scopeRef,
    laneRef,
    agentId,
    projectId,
    taskId,
    ...(roleName !== undefined ? { roleName } : {}),
    mutexKey: `roster:${agentId}:${projectId}`,
  }
}

/**
 * Stable key-sorted JSON — the same canonicalization discipline the dispatch
 * idempotency machinery uses, so "same key, different body" means the same
 * thing on both surfaces.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function canonicalRequestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/**
 * In-process serialization keyed by agent+project, one chain per server
 * instance. hrc-server is a launchd singleton, so an in-process mutex is the
 * whole fence: two concurrent claim-and-starts for one namespace are strictly
 * ordered, and the later one sees the earlier one's claim committed and its
 * start registered. The chain never rejects, so a failed claim cannot wedge
 * later claims.
 */
const scopeClaimMutexes = new WeakMap<HrcServerInstanceForHandlers, Map<string, Promise<void>>>()

export function withScopeClaimMutex<T>(
  server: HrcServerInstanceForHandlers,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  let chains = scopeClaimMutexes.get(server)
  if (chains === undefined) {
    chains = new Map<string, Promise<void>>()
    scopeClaimMutexes.set(server, chains)
  }
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

/**
 * A scope is FREE iff its session has (a) no non-terminal runtime and (b) no
 * in-flight start operation. (b) is what makes a mid-boot scope read occupied to
 * a concurrent claim; (a) is what holds it once the durable runtime row exists.
 * A scope whose start died before writing its runtime row reads FREE again and
 * is recycled — which is safe precisely because the broker persists before it
 * starts an invocation, so a pre-row death left no started agent.
 */
export function isClaimScopeFree(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord
): boolean {
  if (server.runtimeStartOperations.has(session.hostSessionId)) return false
  return server.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .every((runtime) => isRuntimeUnavailableStatus(runtime.status))
}

/** Rewrite the intent's correlation onto the session actually being started. */
export function localizeIntentToSession(
  intent: HrcRuntimeIntent,
  session: HrcSessionRecord
): HrcRuntimeIntent {
  return {
    ...intent,
    placement: {
      ...intent.placement,
      correlation: {
        ...intent.placement?.correlation,
        sessionRef: { scopeRef: session.scopeRef, laneRef: session.laneRef },
        hostSessionId: session.hostSessionId,
        generation: session.generation,
      },
    },
  }
}

/**
 * Durable-idempotency replay, shared verbatim by both policies.
 *
 * Returns the recorded successor for an identical retry, `null` when the key is
 * new, and throws for the two failure modes that MUST be decided before any
 * start path runs:
 *
 *  - a different body under the same key (`idempotency_key_conflict`), because
 *    `startRuntimeForSession` writes the session's intent ahead of its reuse
 *    checks, so deciding later would mutate a claim the caller no longer owns;
 *  - a claim whose successor is no longer the scope's active session
 *    (`roster_claim_superseded`) — the original start died pre-runtime-row and a
 *    newer press recycled the scope. The logical press failed; a fresh press
 *    needs a fresh key, and the archived predecessor is never started.
 */
export function replayRecordedClaim(
  server: HrcServerInstanceForHandlers,
  input: { readonly idempotencyKey: string; readonly requestHash: string }
): { readonly session: HrcSessionRecord; readonly claimedScope: string } | null {
  const recorded = server.db.rosterClaims.getByIdempotencyKey(input.idempotencyKey)
  if (recorded === null) return null

  if (recorded.requestHash !== input.requestHash) {
    throw new HrcConflictError(
      HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT,
      'idempotencyKey was already used for a different claim-and-start request',
      {
        idempotencyKey: input.idempotencyKey,
        baseScope: recorded.baseScope,
        claimedScope: recorded.claimedScope,
      }
    )
  }

  const successor = server.db.sessions.getByHostSessionId(recorded.successorHostSessionId)
  const active =
    successor === null
      ? null
      : server.db.continuities.getByKey(successor.scopeRef, successor.laneRef)
  if (
    successor === null ||
    successor.status !== 'active' ||
    active?.activeHostSessionId !== successor.hostSessionId
  ) {
    throw new HrcConflictError(
      HrcErrorCode.ROSTER_CLAIM_SUPERSEDED,
      'the recorded claim is no longer the scope’s active session',
      {
        idempotencyKey: input.idempotencyKey,
        claimedScope: recorded.claimedScope,
        successorHostSessionId: recorded.successorHostSessionId,
      }
    )
  }
  return { session: successor, claimedScope: recorded.claimedScope }
}

export type ClaimRecordInput = {
  readonly idempotencyKey: string
  readonly requestHash: string
  /**
   * The subject the claim was made against: the base scope for a suffix claim,
   * the exact scope for an exact claim. Both share one durable table, so this
   * is provenance, never authority.
   */
  readonly claimSubjectScope: string
}

/**
 * Recycle a free-but-existing continuity into a fresh successor, writing the
 * claim row in the SAME transaction as the rotation.
 *
 * Rotation always drops the continuation, so a claimed scope always starts a
 * FRESH conversation rather than resuming a stranger's.
 */
export async function recycleClaimedSession(
  server: HrcServerInstanceForHandlers,
  existing: HrcSessionRecord,
  record: ClaimRecordInput,
  reason: string
): Promise<HrcSessionRecord> {
  const now = timestamp()
  const rotation = await server.rotateSessionContext(existing, {
    relaunch: false,
    dropContinuation: true,
    reason,
    withinTransaction: (nextSession) => {
      server.db.rosterClaims.insert({
        idempotencyKey: record.idempotencyKey,
        requestHash: record.requestHash,
        baseScope: record.claimSubjectScope,
        claimedScope: nextSession.scopeRef,
        successorHostSessionId: nextSession.hostSessionId,
        createdAt: now,
      })
    },
  })
  const successor = server.db.sessions.getByHostSessionId(rotation.hostSessionId)
  if (successor === null) {
    throw new HrcConflictError(
      HrcErrorCode.ROSTER_CLAIM_SUPERSEDED,
      'claim successor disappeared before start',
      { idempotencyKey: record.idempotencyKey, claimedScope: existing.scopeRef }
    )
  }
  return successor
}

export type MintClaimedSessionInput = ClaimRecordInput & {
  readonly scopeRef: string
  readonly laneRef: string
  readonly reason: string
  readonly capabilityHint: {
    readonly placement: HrcRuntimeIntent['placement']
    readonly harness: HrcRuntimeIntent['harness']
  }
  /** Extra `session.created` projection details (claim provenance). */
  readonly eventDetails?: Record<string, unknown> | undefined
}

/**
 * Mint a never-before-seen claimed session. Mirrors the `resolve --create`
 * chain: same summon gate, same `explicit_local` declaration `hrc start` makes
 * once placement has already been decided by the caller's preflight, same
 * insert + continuity upsert + `session.created` projection — plus the claim
 * row, committed in the same transaction as the session it names.
 */
export async function mintClaimedSession(
  server: HrcServerInstanceForHandlers,
  input: MintClaimedSessionInput
): Promise<HrcSessionRecord> {
  return await withSummonAuthority(
    server,
    {
      scopeRef: input.scopeRef,
      laneRef: input.laneRef,
      path: 'resolve-session',
      intent: 'explicit_local',
      capabilityHint: input.capabilityHint,
    },
    (claimAuthority) => {
      const now = timestamp()
      const hostSessionId = createHostSessionId()
      const session: HrcSessionRecord = {
        hostSessionId,
        scopeRef: input.scopeRef,
        laneRef: input.laneRef,
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      }
      const created = server.db.sqlite.transaction(() => {
        const inserted = server.db.sessions.insert(session)
        if (claimAuthority !== undefined) {
          persistSessionTaskClaimAuthority(server, hostSessionId, claimAuthority, now)
        }
        server.db.continuities.upsert({
          scopeRef: input.scopeRef,
          laneRef: input.laneRef,
          activeHostSessionId: hostSessionId,
          updatedAt: now,
        })
        server.db.rosterClaims.insert({
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          baseScope: input.claimSubjectScope,
          claimedScope: input.scopeRef,
          successorHostSessionId: hostSessionId,
          createdAt: now,
        })
        return inserted
      })()
      server.notifyEvent(
        server.appendEvent(created, 'session.created', {
          created: true,
          reason: input.reason,
          ...(input.eventDetails ?? {}),
        })
      )
      return created
    }
  )
}
