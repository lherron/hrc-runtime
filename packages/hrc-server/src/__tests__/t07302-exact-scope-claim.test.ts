/**
 * T-07302 — exact-scope claim-and-start (`conflictPolicy: 'reject'`).
 *
 * The suffix roster's job is to always find you SOMEWHERE. This path's job is
 * the opposite: give you the scope you actually typed, or nothing. So the tests
 * here are about the two things that must never happen —
 *
 *  - the caller lands in a conversation that was already live, and
 *  - a suffix claim and an exact claim rotate the SAME continuity because they
 *    were looking at it through different locks.
 *
 * The overlap cases run in both winner orders and again after a simulated
 * daemon restart, because the in-memory in-flight map and the durable runtime
 * row are two different halves of the FREE predicate and only one of them
 * survives a restart.
 *
 * `startRuntimeForSession` is stubbed so the tests exercise the claim protocol
 * rather than a real harness launch, but it registers/deregisters in the real
 * `runtimeStartOperations` map — that map IS predicate (b), so stubbing it away
 * would test nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  ExactStartRuntimeRequest,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  SuffixStartRuntimeRequest,
} from 'hrc-core'
import { isExactStartRuntimeRequest } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { appendEvent } from '../event-notification-handlers'
import { exactStartRequestHash, startExactScopeRuntime } from '../exact-claim'
import { parseStartRuntimeRequest } from '../parsers/runtime'
import { startSuffixRosterRuntime, suffixStartRequestHash } from '../roster-claim'
import { invalidateHostContext, rotateSessionContext } from '../runtime-control-handlers'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

const NOW = '2026-08-18T12:00:00.000Z'
const BASE_SCOPE = 'agent:mable:project:hrc-runtime:task:primary'
const BASE_SESSION_REF = `${BASE_SCOPE}/lane:main`
const EXACT_SCOPE = 'agent:mable:project:hrc-runtime:task:hrcdev'
const EXACT_SESSION_REF = `${EXACT_SCOPE}/lane:main`
const NOVA_SCOPE = `${BASE_SCOPE}-nova`
const NOVA_SESSION_REF = `${NOVA_SCOPE}/lane:main`

function intent(scopeRef: string, prompt?: string): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
      correlation: { sessionRef: { scopeRef, laneRef: 'main' } },
    },
    harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
    execution: { preferredMode: 'headless' },
    presentation: { viewerWindow: 'console' },
    ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
  } as HrcRuntimeIntent
}

function exactRequest(overrides: Partial<ExactStartRuntimeRequest> = {}): ExactStartRuntimeRequest {
  return {
    sessionRef: EXACT_SESSION_REF,
    runtimeIntent: intent(EXACT_SCOPE),
    conflictPolicy: 'reject',
    summonIntent: 'implicit',
    idempotencyKey: 'exact-1',
    ...overrides,
  }
}

function suffixRequest(
  overrides: Partial<SuffixStartRuntimeRequest> = {}
): SuffixStartRuntimeRequest {
  return {
    baseSessionRef: BASE_SESSION_REF,
    runtimeIntent: intent(BASE_SCOPE),
    conflictPolicy: 'suffix',
    idempotencyKey: 'suffix-1',
    ...overrides,
  }
}

type StartBehavior = {
  /**
   * Parks the NEXT start only (consumed on use), so a test can hold one scope
   * mid-boot while a second claim runs to completion.
   */
  gate?: Promise<void> | undefined
  /** When true, the start throws instead of writing a runtime row. */
  die?: boolean | undefined
}

type Harness = {
  instance: HrcServerInstanceForHandlers
  db: HrcDatabase
  started: HrcSessionRecord[]
  startedIntents: HrcRuntimeIntent[]
  behavior: StartBehavior
}

function makeHarness(db: HrcDatabase): Harness {
  const started: HrcSessionRecord[] = []
  const startedIntents: HrcRuntimeIntent[] = []
  const behavior: StartBehavior = {}
  const runtimeStartOperations = new Map<string, Promise<HrcRuntimeSnapshot>>()

  const instance = {
    db,
    options: {},
    runtimeStartOperations,
    notifyEvent: () => {},
    appendEvent,
    invalidateHostContext,
    rotateSessionContext,
    startRuntimeForSession: (
      session: HrcSessionRecord,
      runtimeIntent: HrcRuntimeIntent
    ): Promise<HrcRuntimeSnapshot> => {
      started.push(session)
      startedIntents.push(runtimeIntent)
      db.sessions.updateIntent(session.hostSessionId, runtimeIntent, NOW)
      const gate = behavior.gate
      behavior.gate = undefined
      const operation = (async () => {
        await (gate ?? Promise.resolve())
        if (behavior.die) throw new Error('simulated mid-start daemon death')
        const runtimeId = `rt-${session.hostSessionId}`
        const existing = db.runtimes.getByRuntimeId(runtimeId)
        if (existing) return existing
        db.runtimes.insert({
          runtimeId,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          transport: 'headless',
          harness: 'claude-code',
          provider: 'anthropic',
          status: 'ready',
          supportsInflightInput: true,
          adopted: false,
          createdAt: NOW,
          updatedAt: NOW,
        })
        const runtime = db.runtimes.getByRuntimeId(runtimeId)
        if (!runtime) throw new Error('failed to seed runtime')
        return runtime
      })().finally(() => {
        runtimeStartOperations.delete(session.hostSessionId)
      })
      runtimeStartOperations.set(session.hostSessionId, operation)
      return operation
    },
  } as unknown as HrcServerInstanceForHandlers

  return { instance, db, started, startedIntents, behavior }
}

function seedLiveSession(db: HrcDatabase, scopeRef: string, suffix: string): HrcSessionRecord {
  const hostSessionId = `hsid-${suffix}`
  db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
    continuation: { key: `cont-${suffix}`, provider: 'anthropic' },
  })
  db.continuities.upsert({
    scopeRef,
    laneRef: 'main',
    activeHostSessionId: hostSessionId,
    updatedAt: NOW,
  })
  db.runtimes.insert({
    runtimeId: `rt-live-${suffix}`,
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const session = db.sessions.getByHostSessionId(hostSessionId)
  if (!session) throw new Error('failed to seed live session')
  return session
}

async function errorOf(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise
    throw new Error('expected the exact start to reject')
  } catch (error) {
    return error as { code?: string; message?: string }
  }
}

describe('T-07302 exact START request shape', () => {
  const body = {
    sessionRef: EXACT_SESSION_REF,
    runtimeIntent: {
      placement: 'workspace',
      harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
    },
    conflictPolicy: 'reject',
    summonIntent: 'implicit',
    idempotencyKey: 'exact-1',
  }

  it('accepts the exact shape and preserves the presentation hint', () => {
    const parsed = parseStartRuntimeRequest({
      ...body,
      runtimeIntent: { ...body.runtimeIntent, presentation: { viewerWindow: 'console' } },
    })
    expect(isExactStartRuntimeRequest(parsed)).toBe(true)
    if (!isExactStartRuntimeRequest(parsed)) throw new Error('unreachable')
    expect(parsed.sessionRef).toBe(EXACT_SESSION_REF)
    expect(parsed.summonIntent).toBe('implicit')
    expect(parsed.runtimeIntent.presentation).toEqual({ viewerWindow: 'console' })
  })

  it('refuses an inbound hostSessionId — the caller never picks the session', () => {
    expect(() => parseStartRuntimeRequest({ ...body, hostSessionId: 'hsid-x' })).toThrow(
      /hostSessionId must not be supplied/
    )
  })

  it('refuses a baseSessionRef — exact is not a roster base', () => {
    expect(() => parseStartRuntimeRequest({ ...body, baseSessionRef: BASE_SESSION_REF })).toThrow(
      /baseSessionRef must not be supplied/
    )
  })

  it('requires an idempotencyKey — without operation identity a retry rotates twice', () => {
    const { idempotencyKey: _omitted, ...withoutKey } = body
    expect(() => parseStartRuntimeRequest(withoutKey)).toThrow(/idempotencyKey is required/)
  })

  it('requires summonIntent "implicit" — the caller never declares placement', () => {
    const { summonIntent: _omitted, ...withoutIntent } = body
    expect(() => parseStartRuntimeRequest(withoutIntent)).toThrow(/summonIntent must be "implicit"/)
    expect(() => parseStartRuntimeRequest({ ...body, summonIntent: 'explicit_local' })).toThrow(
      /summonIntent must be "implicit"/
    )
  })

  it('names both policies in the conflictPolicy refusal', () => {
    expect(() => parseStartRuntimeRequest({ ...body, conflictPolicy: 'clobber' })).toThrow(
      /conflictPolicy must be "suffix" or "reject"/
    )
  })

  it('hashes the policy, so one key replayed across policies is a conflict', () => {
    expect(exactStartRequestHash(exactRequest())).not.toBe(
      suffixStartRequestHash(suffixRequest({ summonIntent: 'implicit' }))
    )
    expect(exactStartRequestHash(exactRequest())).toBe(exactStartRequestHash(exactRequest()))
    expect(
      exactStartRequestHash(exactRequest({ runtimeIntent: intent(EXACT_SCOPE, 'different') }))
    ).not.toBe(exactStartRequestHash(exactRequest()))
  })
})

describe('T-07302 exact-scope claim-and-start', () => {
  let dir: string
  let db: HrcDatabase

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hrc-t07302-exact-'))
    db = openHrcDatabase(join(dir, 'state.sqlite'))
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('claims a virgin exact scope and records the claim durably', async () => {
    const h = makeHarness(db)
    const result = await startExactScopeRuntime.call(h.instance, exactRequest())

    expect(result.claim).toMatchObject({
      slot: 'hrcdev',
      scopeRef: EXACT_SCOPE,
      sessionRef: EXACT_SESSION_REF,
      idempotencyKey: 'exact-1',
      replayed: false,
      conflictPolicy: 'reject',
    })
    expect(db.rosterClaims.getByIdempotencyKey('exact-1')).toMatchObject({
      baseScope: EXACT_SCOPE,
      claimedScope: EXACT_SCOPE,
      successorHostSessionId: result.claim.hostSessionId,
    })
    expect(h.startedIntents[0]?.placement).toMatchObject({
      correlation: {
        sessionRef: { scopeRef: EXACT_SCOPE, laneRef: 'main' },
        hostSessionId: result.claim.hostSessionId,
        generation: result.runtime.generation,
      },
    })
  })

  it('recycles a FREE existing continuity into a fresh conversation', async () => {
    const idle = seedLiveSession(db, EXACT_SCOPE, 'hrcdev')
    db.runtimes.updateStatus('rt-live-hrcdev', 'terminated', NOW)
    const h = makeHarness(db)

    const result = await startExactScopeRuntime.call(h.instance, exactRequest())

    expect(result.claim.scopeRef).toBe(EXACT_SCOPE)
    expect(result.claim.hostSessionId).not.toBe(idle.hostSessionId)
    const successor = db.sessions.getByHostSessionId(result.claim.hostSessionId)
    expect(successor?.generation).toBe(idle.generation + 1)
    expect(successor?.continuation).toBeUndefined()
    expect(db.sessions.getByHostSessionId(idle.hostSessionId)?.status).toBe('archived')
  })

  it('refuses an OCCUPIED exact scope with no mutation at all', async () => {
    const live = seedLiveSession(db, EXACT_SCOPE, 'hrcdev')
    const h = makeHarness(db)

    const error = await errorOf(startExactScopeRuntime.call(h.instance, exactRequest()))

    expect(error.code).toBe('session_scope_occupied')
    expect(h.started).toHaveLength(0)
    expect(db.rosterClaims.getByIdempotencyKey('exact-1')).toBeNull()
    const after = db.sessions.getByHostSessionId(live.hostSessionId)
    expect(after?.status).toBe('active')
    expect(after?.generation).toBe(live.generation)
    expect(after?.continuation).toEqual(live.continuation)
    expect(db.continuities.getByKey(EXACT_SCOPE, 'main')?.activeHostSessionId).toBe(
      live.hostSessionId
    )
  })

  it('reads a scope whose start is still in flight as OCCUPIED', async () => {
    const h = makeHarness(db)
    let release: () => void = () => undefined
    h.behavior.gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = startExactScopeRuntime.call(h.instance, exactRequest())
    const error = await errorOf(
      startExactScopeRuntime.call(h.instance, exactRequest({ idempotencyKey: 'exact-2' }))
    )

    expect(error.code).toBe('session_scope_occupied')
    release()
    expect((await first).claim.scopeRef).toBe(EXACT_SCOPE)
  })

  it('concurrent distinct keys: exactly one succeeds, the other is refused', async () => {
    const h = makeHarness(db)

    const settled = await Promise.allSettled([
      startExactScopeRuntime.call(h.instance, exactRequest({ idempotencyKey: 'press-a' })),
      startExactScopeRuntime.call(h.instance, exactRequest({ idempotencyKey: 'press-b' })),
    ])

    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled')
    const rejected = settled.filter((entry) => entry.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'session_scope_occupied',
    })
    expect(db.sessions.listByScopeRef(EXACT_SCOPE)).toHaveLength(1)
  })

  it('a duplicate retry with the same key converges on the SAME successor', async () => {
    const h = makeHarness(db)
    const first = await startExactScopeRuntime.call(h.instance, exactRequest())
    const retry = await startExactScopeRuntime.call(h.instance, exactRequest())

    expect(retry.claim.hostSessionId).toBe(first.claim.hostSessionId)
    expect(retry.claim.replayed).toBe(true)
    expect(retry.runtime.runtimeId).toBe(first.runtime.runtimeId)
    expect(db.rosterClaims.listByBaseScope(EXACT_SCOPE)).toHaveLength(1)
    expect(db.sessions.listByScopeRef(EXACT_SCOPE)).toHaveLength(1)
  })

  it('converges across a simulated daemon restart (durable claim is the only state left)', async () => {
    const first = await startExactScopeRuntime.call(makeHarness(db).instance, exactRequest())

    const restarted = makeHarness(db)
    const retry = await startExactScopeRuntime.call(restarted.instance, exactRequest())

    expect(retry.claim.hostSessionId).toBe(first.claim.hostSessionId)
    expect(retry.claim.replayed).toBe(true)
    expect(db.rosterClaims.listByBaseScope(EXACT_SCOPE)).toHaveLength(1)
  })

  it('same key + different body is rejected BEFORE any durable intent write', async () => {
    const h = makeHarness(db)
    const first = await startExactScopeRuntime.call(h.instance, exactRequest())
    const intentBefore = db.sessions.getByHostSessionId(
      first.claim.hostSessionId
    )?.lastAppliedIntentJson
    const startCountBefore = h.started.length

    const error = await errorOf(
      startExactScopeRuntime.call(
        h.instance,
        exactRequest({ runtimeIntent: intent(EXACT_SCOPE, 'a materially different request') })
      )
    )

    expect(error.code).toBe('idempotency_key_conflict')
    expect(h.started.length).toBe(startCountBefore)
    expect(
      db.sessions.getByHostSessionId(first.claim.hostSessionId)?.lastAppliedIntentJson
    ).toEqual(intentBefore)
  })

  it('rejects a conflicting replay after a restart too, still without mutating intent', async () => {
    const first = await startExactScopeRuntime.call(makeHarness(db).instance, exactRequest())
    const intentBefore = db.sessions.getByHostSessionId(
      first.claim.hostSessionId
    )?.lastAppliedIntentJson

    const restarted = makeHarness(db)
    const error = await errorOf(
      startExactScopeRuntime.call(
        restarted.instance,
        exactRequest({ runtimeIntent: intent(EXACT_SCOPE, 'different after restart') })
      )
    )

    expect(error.code).toBe('idempotency_key_conflict')
    expect(restarted.started).toHaveLength(0)
    expect(
      db.sessions.getByHostSessionId(first.claim.hostSessionId)?.lastAppliedIntentJson
    ).toEqual(intentBefore)
  })

  it('a superseded claim refuses and never starts the archived predecessor', async () => {
    const h = makeHarness(db)
    const first = await startExactScopeRuntime.call(h.instance, exactRequest())

    const claimed = db.sessions.getByHostSessionId(first.claim.hostSessionId)
    if (!claimed) throw new Error('claimed session missing')
    db.runtimes.updateStatus(`rt-${claimed.hostSessionId}`, 'terminated', NOW)
    await rotateSessionContext.call(h.instance, claimed, {
      relaunch: false,
      dropContinuation: true,
      reason: 'test-supersede',
    })
    const startCountBefore = h.started.length

    const error = await errorOf(startExactScopeRuntime.call(h.instance, exactRequest()))

    expect(error.code).toBe('roster_claim_superseded')
    expect(h.started.length).toBe(startCountBefore)
    expect(db.sessions.getByHostSessionId(claimed.hostSessionId)?.status).toBe('archived')
  })

  it('a mid-start daemon death leaves the exact scope FREE and recyclable', async () => {
    const h = makeHarness(db)
    h.behavior.die = true
    await errorOf(startExactScopeRuntime.call(h.instance, exactRequest({ idempotencyKey: 'dead' })))

    const claim = db.rosterClaims.getByIdempotencyKey('dead')
    expect(claim).not.toBeNull()
    expect(db.runtimes.listByHostSessionId(claim?.successorHostSessionId ?? '')).toHaveLength(0)

    h.behavior.die = false
    const next = await startExactScopeRuntime.call(
      h.instance,
      exactRequest({ idempotencyKey: 'fresh-press' })
    )
    expect(next.claim.scopeRef).toBe(EXACT_SCOPE)
  })
})

/**
 * The regression Daedalus rejected revision 1 over: a typed exact token can be a
 * live suffix roster member, so separate locks could both see it free.
 */
describe('T-07302 exact/suffix namespace overlap', () => {
  let dir: string
  let db: HrcDatabase

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hrc-t07302-overlap-'))
    db = openHrcDatabase(join(dir, 'state.sqlite'))
    // `primary` live ⇒ the suffix walk's next candidate is exactly `primary-nova`,
    // which is also the scope the exact request names.
    seedLiveSession(db, BASE_SCOPE, 'primary')
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  const novaExact = () =>
    exactRequest({
      sessionRef: NOVA_SESSION_REF,
      runtimeIntent: intent(NOVA_SCOPE),
      idempotencyKey: 'exact-nova',
    })

  it('winner order A — exact claims primary-nova mid-boot, suffix walks past it', async () => {
    const h = makeHarness(db)
    let release: () => void = () => undefined
    h.behavior.gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const exact = startExactScopeRuntime.call(h.instance, novaExact())
    // No durable runtime row exists yet — only the shared in-flight registration
    // can hold `primary-nova` against the suffix walk here.
    const suffix = await startSuffixRosterRuntime.call(h.instance, suffixRequest())

    expect(suffix.claim.slot).toBe('primary-comet')
    release()
    const exactResult = await exact
    expect(exactResult.claim.scopeRef).toBe(NOVA_SCOPE)
    // One claimant per continuity.
    expect(db.sessions.listByScopeRef(NOVA_SCOPE)).toHaveLength(1)
    expect(db.continuities.getByKey(NOVA_SCOPE, 'main')?.activeHostSessionId).toBe(
      exactResult.claim.hostSessionId
    )
  })

  it('winner order B — suffix claims primary-nova mid-boot, exact is refused', async () => {
    const h = makeHarness(db)
    let release: () => void = () => undefined
    h.behavior.gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const suffix = startSuffixRosterRuntime.call(h.instance, suffixRequest())
    const error = await errorOf(startExactScopeRuntime.call(h.instance, novaExact()))

    expect(error.code).toBe('session_scope_occupied')
    release()
    const suffixResult = await suffix
    expect(suffixResult.claim.slot).toBe('primary-nova')
    expect(db.sessions.listByScopeRef(NOVA_SCOPE)).toHaveLength(1)
    expect(db.continuities.getByKey(NOVA_SCOPE, 'main')?.activeHostSessionId).toBe(
      suffixResult.claim.hostSessionId
    )
    expect(db.rosterClaims.getByIdempotencyKey('exact-nova')).toBeNull()
  })

  it('winner order A survives a daemon restart — the durable runtime row still holds the slot', async () => {
    const exact = await startExactScopeRuntime.call(makeHarness(db).instance, novaExact())

    const restarted = makeHarness(db)
    const suffix = await startSuffixRosterRuntime.call(restarted.instance, suffixRequest())

    expect(suffix.claim.slot).toBe('primary-comet')
    expect(db.continuities.getByKey(NOVA_SCOPE, 'main')?.activeHostSessionId).toBe(
      exact.claim.hostSessionId
    )
    expect(db.sessions.listByScopeRef(NOVA_SCOPE)).toHaveLength(1)
  })

  it('winner order B survives a daemon restart — exact still refuses the live slot', async () => {
    const suffix = await startSuffixRosterRuntime.call(makeHarness(db).instance, suffixRequest())
    expect(suffix.claim.slot).toBe('primary-nova')

    const restarted = makeHarness(db)
    const error = await errorOf(startExactScopeRuntime.call(restarted.instance, novaExact()))

    expect(error.code).toBe('session_scope_occupied')
    expect(restarted.started).toHaveLength(0)
    expect(db.continuities.getByKey(NOVA_SCOPE, 'main')?.activeHostSessionId).toBe(
      suffix.claim.hostSessionId
    )
  })

  it('serializes exact and suffix issued together — one claimant per continuity', async () => {
    const h = makeHarness(db)

    const [exactSettled, suffixSettled] = await Promise.allSettled([
      startExactScopeRuntime.call(h.instance, novaExact()),
      startSuffixRosterRuntime.call(h.instance, suffixRequest()),
    ])

    // The suffix walk always finds a slot; the exact claim either won
    // `primary-nova` first or found it taken. Either way exactly one session
    // exists on that continuity and nobody rotated the other's successor.
    expect(suffixSettled.status).toBe('fulfilled')
    expect(db.sessions.listByScopeRef(NOVA_SCOPE)).toHaveLength(1)
    if (exactSettled.status === 'fulfilled') {
      expect(exactSettled.value.claim.scopeRef).toBe(NOVA_SCOPE)
      expect(
        (suffixSettled as PromiseFulfilledResult<{ claim: { slot: string } }>).value.claim.slot
      ).toBe('primary-comet')
      expect(db.continuities.getByKey(NOVA_SCOPE, 'main')?.activeHostSessionId).toBe(
        exactSettled.value.claim.hostSessionId
      )
    } else {
      expect(exactSettled.reason).toMatchObject({ code: 'session_scope_occupied' })
      expect(
        (suffixSettled as PromiseFulfilledResult<{ claim: { slot: string } }>).value.claim.slot
      ).toBe('primary-nova')
    }
  })
})
