import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import {
  APP_IDENTITY_ENV_KEYS,
  HrcConflictError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
  type HrcRuntimeIntent,
  type HrcSessionRecord,
  HrcUnprocessableEntityError,
  appSessionSelectorKey,
  parseAppSessionScopeRef,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { hasInitialUserTurn } from './agent-spaces-adapter/compile-adapter.js'

/**
 * T-08576 D8.0 — per-daemon, per-selector app identity ownership.
 *
 * Every write, birth or input for one app selector runs under a single FIFO
 * owner. Entries acquire it; inner shared functions only assert it. Acquisition
 * is non-reentrant: a context that already holds a key cannot wait on itself.
 * The owner is released only after the entry's own work and every launch it
 * tracked have settled. No SQLite transaction spans an await.
 */

type AppIdentityOwner = {
  readonly key: string
  readonly token: string
  readonly tracked: Set<Promise<unknown>>
  readonly releaseHooks: Array<() => void>
  readonly grants: Map<string, AppBirthRunGrant>
  released: boolean
}

type OwnerFrame = { readonly held: ReadonlyMap<string, AppIdentityOwner> }

const ownerContext = new AsyncLocalStorage<OwnerFrame>()
const ownerTails = new WeakMap<HrcDatabase, Map<string, Promise<void>>>()

export type AppSelectorKeyInput = { appId: string; appSessionKey: string }

export function appSelectorForSession(
  session: Pick<HrcSessionRecord, 'scopeRef' | 'laneRef'>
): AppSelectorKeyInput | null {
  const app = parseAppSessionScopeRef(session.scopeRef)
  return app === null ? null : { appId: app.appId, appSessionKey: session.laneRef }
}

export function isAppScopedSession(session: Pick<HrcSessionRecord, 'scopeRef'>): boolean {
  return parseAppSessionScopeRef(session.scopeRef) !== null
}

function currentOwner(key: string): AppIdentityOwner | undefined {
  return ownerContext.getStore()?.held.get(key)
}

export async function withAppIdentityOwner<T>(
  db: HrcDatabase,
  selector: AppSelectorKeyInput,
  run: () => Promise<T>
): Promise<T> {
  const key = appSessionSelectorKey(selector)
  if (currentOwner(key) !== undefined) {
    throw new HrcInternalError('app identity owner re-entry', {
      appId: selector.appId,
      appSessionKey: selector.appSessionKey,
    })
  }

  let tails = ownerTails.get(db)
  if (tails === undefined) {
    tails = new Map()
    ownerTails.set(db, tails)
  }
  const previous = tails.get(key) ?? Promise.resolve()
  let releaseSlot!: () => void
  const slot = new Promise<void>((resolve) => {
    releaseSlot = resolve
  })
  const tail = previous.then(() => slot)
  tails.set(key, tail)
  await previous

  const owner: AppIdentityOwner = {
    key,
    token: randomUUID(),
    tracked: new Set(),
    releaseHooks: [],
    grants: new Map(),
    released: false,
  }
  const held = new Map(ownerContext.getStore()?.held ?? [])
  held.set(key, owner)
  try {
    return await ownerContext.run({ held }, run)
  } finally {
    while (owner.tracked.size > 0) {
      const pending = [...owner.tracked]
      owner.tracked.clear()
      await Promise.allSettled(pending)
    }
    owner.released = true
    for (const hook of owner.releaseHooks.splice(0)) {
      try {
        hook()
      } catch {
        // A release hook must never keep the selector owned.
      }
    }
    if (tails.get(key) === tail) tails.delete(key)
    releaseSlot()
  }
}

/** Run `hook` when the current owner of `selector` releases; no-op without one. */
export function onAppIdentityOwnerRelease(selector: AppSelectorKeyInput, hook: () => void): void {
  currentOwner(appSessionSelectorKey(selector))?.releaseHooks.push(hook)
}

/** Register a launch that must settle before this owner is released. */
export function trackAppIdentityOperation(
  session: Pick<HrcSessionRecord, 'scopeRef' | 'laneRef'>,
  operation: Promise<unknown>
): void {
  const selector = appSelectorForSession(session)
  if (selector === null) return
  currentOwner(appSessionSelectorKey(selector))?.tracked.add(operation.catch(() => undefined))
}

/** Inner shared functions assert, never acquire. Agent sessions pass through. */
export function assertAppIdentityOwner(
  session: Pick<HrcSessionRecord, 'scopeRef' | 'laneRef'>
): void {
  const selector = appSelectorForSession(session)
  if (selector === null) return
  if (currentOwner(appSessionSelectorKey(selector)) === undefined) {
    throw new HrcInternalError('app identity owner required', {
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
    })
  }
}

/** D8.0 fence: the session must be the managed, continuity-active incarnation. */
export function assertAppIdentityCurrent(db: HrcDatabase, session: HrcSessionRecord): void {
  const selector = appSelectorForSession(session)
  if (selector === null) return
  const managed = db.appManagedSessions.findByKey(selector.appId, selector.appSessionKey)
  if (managed === null) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_APP_SESSION,
      `unknown app session "${selector.appId}/${selector.appSessionKey}"`,
      { ...selector, hostSessionId: session.hostSessionId }
    )
  }
  if (managed.status === 'removed') {
    throw new HrcConflictError(
      HrcErrorCode.APP_SESSION_REMOVED,
      `app session "${selector.appId}/${selector.appSessionKey}" has been removed`,
      selector
    )
  }
  const continuity = db.continuities.getByKey(session.scopeRef, session.laneRef)
  if (
    managed.activeHostSessionId !== session.hostSessionId ||
    continuity?.activeHostSessionId !== session.hostSessionId ||
    managed.generation !== session.generation ||
    session.status === 'archived'
  ) {
    throw new HrcConflictError(
      HrcErrorCode.STALE_CONTEXT,
      `app session "${selector.appId}/${selector.appSessionKey}" identity moved`,
      {
        reason: 'app-session-identity-moved',
        expected: { hostSessionId: session.hostSessionId, generation: session.generation },
        actual: {
          hostSessionId: managed.activeHostSessionId,
          continuityHostSessionId: continuity?.activeHostSessionId,
          generation: managed.generation,
        },
      }
    )
  }
}

/** D8.2: generic session-addressed handlers refuse app sessions at entry. */
export function refuseAppScopedSession(
  session: Pick<HrcSessionRecord, 'scopeRef'> & { laneRef?: string | undefined },
  requestedOperation: string
): void {
  const app = parseAppSessionScopeRef(session.scopeRef)
  if (app === null) return
  throw new HrcUnprocessableEntityError(
    HrcErrorCode.SESSION_KIND_MISMATCH,
    `app session scope "${session.scopeRef}" must use the /v1/app-sessions routes`,
    {
      reason: 'app-session-route-required',
      requestedOperation,
      appId: app.appId,
      ...(session.laneRef === undefined ? {} : { appSessionKey: session.laneRef }),
    }
  )
}

const FORBIDDEN_IDENTITY_KEYS: ReadonlySet<string> = new Set(APP_IDENTITY_ENV_KEYS)

/**
 * D1/D5: identity-class keys in caller- or store-supplied placement env channels
 * are refused. The refusal is a 422 carried by the existing
 * `unsupported_capability` arm; the discriminating fact is `detail.reason`.
 */
export function assertAppIntentIdentityEnv(
  intent: HrcRuntimeIntent | undefined,
  field: string
): void {
  if (intent === undefined) return
  const placement = intent.placement as unknown as Record<string, unknown> | undefined
  if (placement === undefined) return
  const keys: string[] = []
  for (const channel of ['lockedEnv', 'env', 'dispatchEnv'] as const) {
    const env = placement[channel]
    if (env === null || typeof env !== 'object') continue
    for (const key of Object.keys(env)) {
      if (FORBIDDEN_IDENTITY_KEYS.has(key) && !keys.includes(key)) keys.push(key)
    }
  }
  if (keys.length === 0) return
  throw new HrcUnprocessableEntityError(
    HrcErrorCode.UNSUPPORTED_CAPABILITY,
    `app session intents may not supply identity environment (${keys.join(', ')})`,
    { reason: 'app-session-identity-env-forbidden', field, keys }
  )
}

/**
 * D5 step 4 — a single-use birth run grant, issued under the selector owner for
 * a run id the daemon's run-id ownership registry has reserved. Grants are
 * process-local objects; nothing a caller sends can carry one.
 */
export type AppBirthRunGrant = {
  readonly runId: string
  readonly hostSessionId: string
  readonly generation: number
  readonly token: string
  consumed: boolean
}

function runIdReused(runId: string): HrcConflictError {
  return new HrcConflictError(
    HrcErrorCode.RUN_MISMATCH,
    `run id "${runId}" is already named and cannot identify a new app turn`,
    { reason: 'app-session-run-id-reused', runId }
  )
}

/** Entry and backstop refusal: an app run id that is already named is refused. */
export function assertAppRunIdUnused(db: HrcDatabase, runId: string | undefined): void {
  if (runId === undefined) return
  if (db.runIdOwnership.isNamed(runId)) throw runIdReused(runId)
}

export function issueAppBirthRunGrant(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runId: string
): AppBirthRunGrant | undefined {
  const selector = appSelectorForSession(session)
  if (selector === null) return undefined
  const owner = currentOwner(appSessionSelectorKey(selector))
  if (owner === undefined) {
    throw new HrcInternalError('app identity owner required', {
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
    })
  }
  const existing = owner.grants.get(runId)
  if (existing !== undefined) return existing
  const token = randomUUID()
  const outcome = db.runIdOwnership.reserveRunId(
    runId,
    token,
    session.hostSessionId,
    session.generation
  )
  if (outcome !== 'reserved') throw runIdReused(runId)
  const grant: AppBirthRunGrant = {
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    token,
    consumed: false,
  }
  owner.grants.set(runId, grant)
  owner.releaseHooks.push(() => {
    db.runIdOwnership.releaseRunId(runId, token)
  })
  return grant
}

/**
 * D5 issuance rule (rev 8): a birth is granted exactly when its compile identity
 * allocates a run id, which is the compiler's own initial-turn predicate.
 */
export function issueAppBirthRunGrantForCompile(
  db: HrcDatabase,
  session: HrcSessionRecord,
  compileIntent: HrcRuntimeIntent,
  runId: string
): void {
  if (!isAppScopedSession(session) || !hasInitialUserTurn(compileIntent)) return
  issueAppBirthRunGrant(db, session, runId)
}

/**
 * D5 ALS carriage (rev 8): the reservation token for `runId`, only from a still
 * held owner frame that holds a grant for exactly that run id whose reservation
 * is live. No fallback: any other context, id or released owner gets nothing.
 * The store still binds the result to the exact birth tuple and refuses it once
 * the run is sealed.
 */
export function currentAppBirthRunReservationToken(
  db: HrcDatabase,
  runId: string
): string | undefined {
  const frame = ownerContext.getStore()
  if (frame === undefined) return undefined
  for (const owner of frame.held.values()) {
    if (owner.released) continue
    const grant = owner.grants.get(runId)
    if (grant === undefined) continue
    if (db.runIdOwnership.reservationFor(runId) !== grant.token) return undefined
    // Sealed (row bound to a runtime): the persisted tuple is the only authority.
    if (db.runs.getByRunId(runId)?.runtimeId !== undefined) return undefined
    return grant.token
  }
  return undefined
}

function invalidGrant(runId: string | undefined): HrcConflictError {
  return new HrcConflictError(
    HrcErrorCode.STALE_CONTEXT,
    `app birth run grant for "${runId ?? '(none)'}" is not valid for this birth`,
    { reason: 'app-birth-run-grant-invalid', ...(runId === undefined ? {} : { runId }) }
  )
}

/**
 * Consume the grant for a birth whose compile identity allocates a run id.
 * A birth without an initial turn is grantless: any grant stays unconsumed.
 */
function consumeAppBirthRunGrant(
  db: HrcDatabase,
  session: HrcSessionRecord,
  birthRunId: string,
  compilesInitialTurn: boolean
): string | undefined {
  if (!compilesInitialTurn) return undefined
  const selector = appSelectorForSession(session)
  if (selector === null) return undefined
  const owner = currentOwner(appSessionSelectorKey(selector))
  const grant = owner?.released === false ? owner.grants.get(birthRunId) : undefined
  if (
    grant === undefined ||
    grant.consumed ||
    grant.hostSessionId !== session.hostSessionId ||
    grant.generation !== session.generation ||
    db.runIdOwnership.reservationFor(grant.runId) !== grant.token
  ) {
    throw invalidGrant(birthRunId)
  }
  grant.consumed = true
  return grant.runId
}

/**
 * D5 compile-identity backstop at start-graph persistence: an app start graph
 * whose compile identity carries a run id must hold that run's live token.
 */
export function assertAppStartGraphRunIdentity(
  db: HrcDatabase,
  session: Pick<HrcSessionRecord, 'scopeRef'>,
  runId: string | undefined
): void {
  if (runId === undefined || !isAppScopedSession(session)) return
  if (currentAppBirthRunReservationToken(db, runId) === undefined) throw invalidGrant(runId)
}

/**
 * D5 chokepoint for broker births of app sessions: assert ownership and fence,
 * refuse forbidden identity env, and rebind correlation to HRC-owned identity
 * (host session, generation, and a run only through a consumed grant). Caller
 * launch env can neither set nor unset identity keys. Agent sessions pass
 * through unchanged.
 */
export function bindAppHarnessBirthIntent(
  db: HrcDatabase,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  birthRunId: string,
  compilesInitialTurn: boolean
): HrcRuntimeIntent {
  if (!isAppScopedSession(session)) return intent
  assertAppIdentityOwner(session)
  assertAppIdentityCurrent(db, session)
  assertAppIntentIdentityEnv(intent, 'stored-or-supplied intent')
  const runId = consumeAppBirthRunGrant(db, session, birthRunId, compilesInitialTurn)

  const launch = intent.launch
  const boundLaunch =
    launch === undefined
      ? undefined
      : {
          ...launch,
          ...(launch.env === undefined
            ? {}
            : {
                env: Object.fromEntries(
                  Object.entries(launch.env).filter(([key]) => !FORBIDDEN_IDENTITY_KEYS.has(key))
                ),
              }),
          ...(launch.unsetEnv === undefined
            ? {}
            : { unsetEnv: launch.unsetEnv.filter((key) => !FORBIDDEN_IDENTITY_KEYS.has(key)) }),
        }

  return {
    ...intent,
    placement: {
      ...intent.placement,
      correlation: {
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        ...(runId === undefined ? {} : { runId }),
      },
    },
    ...(boundLaunch === undefined ? {} : { launch: boundLaunch }),
  }
}
