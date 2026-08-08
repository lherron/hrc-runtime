import { createHash } from 'node:crypto'

import { buildScopeRef, parseScopeRef } from 'agent-scope'
import {
  HrcBadRequestError,
  HrcConflictError,
  HrcErrorCode,
  type HrcRuntimeIntent,
  type HrcRuntimeSnapshot,
  type HrcSessionRecord,
  type StartRuntimeRosterClaim,
  type SuffixStartRuntimeRequest,
} from 'hrc-core'

import type { HrcServerInstanceForHandlers } from './server-instance-context.js'

import {
  persistSessionTaskClaimAuthority,
  withSummonAuthority,
} from './federation/summon-gate-server.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import { parseSessionRef } from './parsers/messages.js'
import { createHostSessionId, isRuntimeUnavailableStatus, timestamp } from './server-util.js'
import { findContinuitySession } from './target-view.js'

/**
 * The fixed celestial roster (T-07118). Ten named slots follow the base slot,
 * iterated in list order. The list is a CONSTANT, not a generator: the slot a
 * given press lands on must be reproducible across daemon versions, and an
 * operator reading `primary-nova` in a tab title must be able to find it here.
 *
 * Suffixed slots are ordinary scope tokens (`[A-Za-z0-9._-]+`), so they address
 * normally over hrcchat and federation — `mable@hrc-runtime:primary-nova` is a
 * real, reachable handle, not a presentation-only alias.
 */
export const ROSTER_SLOT_SUFFIXES = [
  'nova',
  'comet',
  'pulsar',
  'quasar',
  'meteor',
  'aurora',
  'zenith',
  'eclipse',
  'orbit',
  'cosmos',
] as const

/** Base task token first, then the ten suffixed slots — iteration order. */
export function rosterSlotTokens(baseTaskId: string): string[] {
  return [baseTaskId, ...ROSTER_SLOT_SUFFIXES.map((suffix) => `${baseTaskId}-${suffix}`)]
}

type RosterBase = {
  baseScopeRef: string
  laneRef: string
  agentId: string
  projectId: string
  baseTaskId: string
  roleName?: string | undefined
  /** Per-base-scope mutex key. */
  mutexKey: string
}

function parseRosterBase(baseSessionRef: string): RosterBase {
  const { scopeRef, laneRef } = parseSessionRef(baseSessionRef)
  let parsed: ReturnType<typeof parseScopeRef>
  try {
    parsed = parseScopeRef(scopeRef)
  } catch (error) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `baseSessionRef carries an invalid scope ref: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { field: 'baseSessionRef', baseSessionRef }
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
      'conflictPolicy "suffix" requires a project- and task-qualified base scope',
      { field: 'baseSessionRef', baseSessionRef }
    )
  }
  return {
    baseScopeRef: scopeRef,
    laneRef,
    agentId,
    projectId,
    baseTaskId: taskId,
    ...(roleName !== undefined ? { roleName } : {}),
    mutexKey: `roster:${agentId}:${projectId}`,
  }
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

/**
 * Stable key-sorted JSON — the same canonicalization discipline the dispatch
 * idempotency machinery uses, so "same key, different body" means the same
 * thing on both surfaces.
 */
function canonicalJson(value: unknown): string {
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

/**
 * Canonical semantic hash of a whole suffix-start request. Persisted alongside
 * the claim so an identical retry and a conflicting replay stay distinguishable
 * after a daemon restart, when the in-memory single-flight map is gone.
 */
export function suffixStartRequestHash(request: SuffixStartRuntimeRequest): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        baseSessionRef: request.baseSessionRef,
        conflictPolicy: request.conflictPolicy,
        runtimeIntent: request.runtimeIntent,
        restartStyle: request.restartStyle,
      })
    )
    .digest('hex')
}

/**
 * In-process serialization keyed by base scope, one chain per server instance.
 * hrc-server is a launchd singleton, so an in-process mutex is the whole fence:
 * two concurrent suffix starts for one base scope are strictly ordered, and the
 * later one sees the earlier one's claim committed and its start registered.
 * The chain never rejects, so a failed claim cannot wedge later claims.
 */
const rosterMutexes = new WeakMap<HrcServerInstanceForHandlers, Map<string, Promise<void>>>()

function withRosterMutex<T>(
  server: HrcServerInstanceForHandlers,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  let chains = rosterMutexes.get(server)
  if (chains === undefined) {
    chains = new Map<string, Promise<void>>()
    rosterMutexes.set(server, chains)
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
 * A slot is FREE iff its session has (a) no non-terminal runtime and (b) no
 * in-flight start operation. (b) is what makes a mid-boot slot read occupied to
 * a concurrent claim; (a) is what holds the slot once the durable runtime row
 * exists. A slot whose start died before writing its runtime row reads FREE
 * again and is recycled — which is safe precisely because the broker persists
 * before it starts an invocation, so a pre-row death left no started agent.
 */
function isSlotFree(server: HrcServerInstanceForHandlers, session: HrcSessionRecord): boolean {
  if (server.runtimeStartOperations.has(session.hostSessionId)) return false
  return server.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .every((runtime) => isRuntimeUnavailableStatus(runtime.status))
}

/** Rewrite the intent's correlation onto the session actually being started. */
function localizeIntentToSession(
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
      },
    },
  }
}

type ClaimOutcome = {
  session: HrcSessionRecord
  slot: string
  replayed: boolean
}

/**
 * Suffix-roster START (T-07118): claim a free slot and start it inside ONE
 * request, so a claim is never observable — nor replayable — apart from the
 * start it authorizes.
 *
 * Ordering inside the per-base-scope mutex is load-bearing:
 *   1. durable idempotency lookup (hash compare BEFORE any start path, so a
 *      conflicting replay can never reach `startRuntimeForSession`'s intent
 *      write and mutate the claimed session's persisted intent),
 *   2. claim (rotation or fresh mint) + claim row in ONE transaction,
 *   3. `startRuntimeForSession` CALLED — not awaited — so its
 *      `runtimeStartOperations` registration is in place before the mutex is
 *      released and the next claimant evaluates freedom.
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

  const { outcome, startPromise } = await withRosterMutex(this, base.mutexKey, async () => {
    const claimed = await resolveClaim.call(this, base, request, requestHash)
    const session = claimed.session
    const intent = localizeIntentToSession(request.runtimeIntent, session)
    // Called, not awaited: `startRuntimeForSession` registers its operation in
    // `runtimeStartOperations` synchronously, so by the time this returns a
    // promise the slot is already occupied for predicate (b).
    const pending = this.startRuntimeForSession(session, intent, restartStyle)
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
    },
  }
}

/** Durable-idempotent claim resolution. Runs under the roster mutex. */
async function resolveClaim(
  this: HrcServerInstanceForHandlers,
  base: RosterBase,
  request: SuffixStartRuntimeRequest,
  requestHash: string
): Promise<ClaimOutcome> {
  const recorded = this.db.rosterClaims.getByIdempotencyKey(request.idempotencyKey)
  if (recorded !== null) {
    if (recorded.requestHash !== requestHash) {
      // BEFORE the start path — a conflicting replay must not touch the claimed
      // session's persisted intent (startRuntimeForSession writes intent ahead
      // of its reuse checks).
      throw new HrcConflictError(
        HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT,
        'idempotencyKey was already used for a different suffix-start request',
        {
          idempotencyKey: request.idempotencyKey,
          baseScope: recorded.baseScope,
          claimedScope: recorded.claimedScope,
        }
      )
    }
    const successor = this.db.sessions.getByHostSessionId(recorded.successorHostSessionId)
    const active =
      successor === null
        ? null
        : this.db.continuities.getByKey(successor.scopeRef, successor.laneRef)
    // Supersession fence: only reachable when the original start died before
    // writing a runtime row and a newer press recycled the slot. Never start an
    // archived predecessor — the logical press failed, a fresh press needs a
    // fresh key.
    if (
      successor === null ||
      successor.status !== 'active' ||
      active?.activeHostSessionId !== successor.hostSessionId
    ) {
      throw new HrcConflictError(
        HrcErrorCode.ROSTER_CLAIM_SUPERSEDED,
        'the recorded roster claim is no longer the slot’s active session',
        {
          idempotencyKey: request.idempotencyKey,
          claimedScope: recorded.claimedScope,
          successorHostSessionId: recorded.successorHostSessionId,
        }
      )
    }
    return {
      session: successor,
      slot: slotTokenOf(recorded.claimedScope, base),
      replayed: true,
    }
  }

  for (const slot of rosterSlotTokens(base.baseTaskId)) {
    const sessionRef = slotSessionRef(base, slot)
    const existing = findContinuitySession(this.db, sessionRef)
    if (existing === null) {
      const minted = await mintSlotSession.call(this, base, slot, request, requestHash)
      return { session: minted, slot, replayed: false }
    }
    if (!isSlotFree(this, existing)) continue

    // Recycle: rotation always drops the continuation, so a claimed slot always
    // starts a FRESH conversation rather than resuming a stranger's.
    const now = timestamp()
    const rotation = await this.rotateSessionContext(existing, {
      relaunch: false,
      dropContinuation: true,
      reason: 'roster-suffix-claim',
      withinTransaction: (nextSession) => {
        this.db.rosterClaims.insert({
          idempotencyKey: request.idempotencyKey,
          requestHash,
          baseScope: base.baseScopeRef,
          claimedScope: nextSession.scopeRef,
          successorHostSessionId: nextSession.hostSessionId,
          createdAt: now,
        })
      },
    })
    const successor = this.db.sessions.getByHostSessionId(rotation.hostSessionId)
    if (successor === null) {
      throw new HrcConflictError(
        HrcErrorCode.ROSTER_CLAIM_SUPERSEDED,
        'roster claim successor disappeared before start',
        { idempotencyKey: request.idempotencyKey, claimedScope: slotScopeRef(base, slot) }
      )
    }
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
    const { taskId } = parseScopeRef(claimedScopeRef) as { taskId?: string }
    return taskId ?? base.baseTaskId
  } catch {
    return base.baseTaskId
  }
}

/**
 * Mint a never-before-seen slot session. Mirrors the `resolve --create` chain:
 * same summon gate, same `explicit_local` declaration `hrc start` makes, same
 * insert + continuity upsert + `session.created` projection — plus the claim
 * row, committed in the same transaction as the session it names.
 */
async function mintSlotSession(
  this: HrcServerInstanceForHandlers,
  base: RosterBase,
  slot: string,
  request: SuffixStartRuntimeRequest,
  requestHash: string
): Promise<HrcSessionRecord> {
  const scopeRef = slotScopeRef(base, slot)
  return await withSummonAuthority(
    this,
    {
      scopeRef,
      laneRef: base.laneRef,
      path: 'resolve-session',
      intent: 'explicit_local',
      capabilityHint: {
        placement: request.runtimeIntent.placement,
        harness: request.runtimeIntent.harness,
      },
    },
    (claimAuthority) => {
      const now = timestamp()
      const hostSessionId = createHostSessionId()
      const session: HrcSessionRecord = {
        hostSessionId,
        scopeRef,
        laneRef: base.laneRef,
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      }
      const created = this.db.sqlite.transaction(() => {
        const inserted = this.db.sessions.insert(session)
        if (claimAuthority !== undefined) {
          persistSessionTaskClaimAuthority(this, hostSessionId, claimAuthority, now)
        }
        this.db.continuities.upsert({
          scopeRef,
          laneRef: base.laneRef,
          activeHostSessionId: hostSessionId,
          updatedAt: now,
        })
        this.db.rosterClaims.insert({
          idempotencyKey: request.idempotencyKey,
          requestHash,
          baseScope: base.baseScopeRef,
          claimedScope: scopeRef,
          successorHostSessionId: hostSessionId,
          createdAt: now,
        })
        return inserted
      })()
      this.notifyEvent(
        this.appendEvent(created, 'session.created', {
          created: true,
          reason: 'roster-suffix-claim',
          baseScope: base.baseScopeRef,
        })
      )
      return created
    }
  )
}

export const rosterClaimHandlersMethods = {
  startSuffixRosterRuntime,
}

export type RosterClaimHandlersMethods = typeof rosterClaimHandlersMethods
