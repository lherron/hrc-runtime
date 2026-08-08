/**
 * T-07118 Part B — suffix collision roster.
 *
 * The roster's whole job is to never be destructive on a live session and never
 * mint a second brain on a live scope (split-brain family, T-07046/T-07047), so
 * the tests here are all about what a SECOND caller sees:
 *
 *  - concurrent same-base starts claim DISTINCT slots,
 *  - a slot whose start is still in flight reads OCCUPIED,
 *  - a duplicate retry with the same key converges on the SAME slot — including
 *    across a simulated daemon restart, where only the durable claim row is left,
 *  - the same key with a different body is rejected BEFORE the start path, so the
 *    claimed session's persisted intent is provably unmutated,
 *  - a superseded claim refuses rather than starting an archived predecessor,
 *  - a mid-start daemon death leaves the slot FREE and recyclable,
 *  - exhaustion is a typed error, never a hijack,
 *  - a recycled slot always starts a fresh conversation.
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
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  SuffixStartRuntimeRequest,
} from 'hrc-core'
import { isSuffixStartRuntimeRequest } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { appendEvent } from '../event-notification-handlers'
import { parseStartRuntimeRequest } from '../parsers/runtime'
import { ROSTER_SLOT_SUFFIXES, rosterSlotTokens, startSuffixRosterRuntime } from '../roster-claim'
import { invalidateHostContext, rotateSessionContext } from '../runtime-control-handlers'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

const NOW = '2026-08-08T12:00:00.000Z'
const BASE_SCOPE = 'agent:mable:project:hrc-runtime:task:primary'
const BASE_SESSION_REF = `${BASE_SCOPE}/lane:main`

function intent(prompt?: string): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
      correlation: { sessionRef: { scopeRef: BASE_SCOPE, laneRef: 'main' } },
    },
    harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
    execution: { preferredMode: 'headless' },
    presentation: { viewerWindow: 'console' },
    ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
  } as HrcRuntimeIntent
}

function request(overrides: Partial<SuffixStartRuntimeRequest> = {}): SuffixStartRuntimeRequest {
  return {
    baseSessionRef: BASE_SESSION_REF,
    runtimeIntent: intent(),
    conflictPolicy: 'suffix',
    idempotencyKey: 'press-1',
    ...overrides,
  }
}

type StartBehavior = {
  /**
   * Parks the NEXT start only (consumed on use), so a test can hold one slot
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
    /**
     * Faithful stand-in for the real start: reuses an existing runtime for the
     * session (as the real per-session idempotent start does), writes the
     * session's intent, registers in `runtimeStartOperations` synchronously, and
     * clears that entry only once the (possibly gated) work finishes.
     */
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
    throw new Error('expected the suffix start to reject')
  } catch (error) {
    return error as { code?: string; message?: string }
  }
}

describe('T-07118 roster shape', () => {
  it('iterates the base slot first, then the ten fixed celestial slots', () => {
    expect(ROSTER_SLOT_SUFFIXES).toHaveLength(10)
    expect(rosterSlotTokens('primary')).toEqual([
      'primary',
      'primary-nova',
      'primary-comet',
      'primary-pulsar',
      'primary-quasar',
      'primary-meteor',
      'primary-aurora',
      'primary-zenith',
      'primary-eclipse',
      'primary-orbit',
      'primary-cosmos',
    ])
  })
})

describe('T-07118 suffix START request shape', () => {
  const body = {
    baseSessionRef: BASE_SESSION_REF,
    runtimeIntent: {
      placement: 'workspace',
      harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
    },
    conflictPolicy: 'suffix',
    idempotencyKey: 'press-1',
  }

  it('accepts the alternate shape and preserves the presentation hint', () => {
    const parsed = parseStartRuntimeRequest({
      ...body,
      runtimeIntent: { ...body.runtimeIntent, presentation: { viewerWindow: 'console' } },
    })
    expect(isSuffixStartRuntimeRequest(parsed)).toBe(true)
    if (!isSuffixStartRuntimeRequest(parsed)) throw new Error('unreachable')
    expect(parsed.baseSessionRef).toBe(BASE_SESSION_REF)
    expect(parsed.runtimeIntent.presentation).toEqual({ viewerWindow: 'console' })
  })

  it('requires an idempotencyKey — without operation identity a retry walks the roster', () => {
    const { idempotencyKey: _omitted, ...withoutKey } = body
    expect(() => parseStartRuntimeRequest(withoutKey)).toThrow(/idempotencyKey is required/)
  })

  it('refuses an inbound hostSessionId — the caller never picks the slot', () => {
    expect(() => parseStartRuntimeRequest({ ...body, hostSessionId: 'hsid-x' })).toThrow(
      /hostSessionId must not be supplied/
    )
  })

  it('leaves the canonical ensure-shape untouched', () => {
    const parsed = parseStartRuntimeRequest({
      hostSessionId: 'hsid-x',
      intent: body.runtimeIntent,
    })
    expect(isSuffixStartRuntimeRequest(parsed)).toBe(false)
  })
})

describe('T-07118 suffix roster claim-and-start', () => {
  let dir: string
  let db: HrcDatabase

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hrc-t07118-roster-'))
    db = openHrcDatabase(join(dir, 'state.sqlite'))
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('claims the base slot when nothing is live and records the claim durably', async () => {
    const h = makeHarness(db)
    const result = await startSuffixRosterRuntime.call(h.instance, request())

    expect(result.claim).toMatchObject({
      slot: 'primary',
      scopeRef: BASE_SCOPE,
      sessionRef: BASE_SESSION_REF,
      idempotencyKey: 'press-1',
      replayed: false,
    })
    expect(db.rosterClaims.getByIdempotencyKey('press-1')).toMatchObject({
      baseScope: BASE_SCOPE,
      claimedScope: BASE_SCOPE,
      successorHostSessionId: result.claim.hostSessionId,
    })
    // The intent is localized onto the session actually started.
    expect(h.startedIntents[0]?.placement).toMatchObject({
      correlation: { sessionRef: { scopeRef: BASE_SCOPE, laneRef: 'main' } },
    })
  })

  it('never hijacks a live :primary — it claims the next slot instead', async () => {
    const live = seedLiveSession(db, BASE_SCOPE, 'primary')
    const h = makeHarness(db)

    const result = await startSuffixRosterRuntime.call(h.instance, request())

    expect(result.claim.slot).toBe('primary-nova')
    expect(result.claim.scopeRef).toBe(`${BASE_SCOPE}-nova`)
    // The live session is untouched: same status, same continuity, same runtime.
    const after = db.sessions.getByHostSessionId(live.hostSessionId)
    expect(after?.status).toBe('active')
    expect(db.continuities.getByKey(BASE_SCOPE, 'main')?.activeHostSessionId).toBe(
      live.hostSessionId
    )
    expect(h.started.map((s) => s.hostSessionId)).not.toContain(live.hostSessionId)
    // The claimed slot's intent carries ITS scope, not the base scope.
    expect(h.startedIntents[0]?.placement).toMatchObject({
      correlation: { sessionRef: { scopeRef: `${BASE_SCOPE}-nova`, laneRef: 'main' } },
    })
  })

  it('concurrent same-base starts claim DISTINCT slots', async () => {
    seedLiveSession(db, BASE_SCOPE, 'primary')
    const h = makeHarness(db)

    const [a, b, c] = await Promise.all([
      startSuffixRosterRuntime.call(h.instance, request({ idempotencyKey: 'press-a' })),
      startSuffixRosterRuntime.call(h.instance, request({ idempotencyKey: 'press-b' })),
      startSuffixRosterRuntime.call(h.instance, request({ idempotencyKey: 'press-c' })),
    ])

    const slots = [a.claim.slot, b.claim.slot, c.claim.slot]
    expect(new Set(slots).size).toBe(3)
    expect(new Set([a, b, c].map((r) => r.claim.hostSessionId)).size).toBe(3)
  })

  it('a slot whose start is still in flight reads OCCUPIED', async () => {
    const h = makeHarness(db)
    let release: () => void = () => undefined
    h.behavior.gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = startSuffixRosterRuntime.call(h.instance, request({ idempotencyKey: 'press-a' }))
    // The first start is parked mid-boot with NO durable runtime row yet — only
    // the in-flight registration can hold the slot here.
    const second = await startSuffixRosterRuntime.call(
      h.instance,
      request({ idempotencyKey: 'press-b' })
    )

    expect(second.claim.slot).toBe('primary-nova')
    release()
    expect((await first).claim.slot).toBe('primary')
  })

  it('a duplicate retry with the same key converges on the SAME slot and result', async () => {
    seedLiveSession(db, BASE_SCOPE, 'primary')
    const h = makeHarness(db)

    const first = await startSuffixRosterRuntime.call(h.instance, request())
    const retry = await startSuffixRosterRuntime.call(h.instance, request())

    expect(retry.claim.slot).toBe(first.claim.slot)
    expect(retry.claim.hostSessionId).toBe(first.claim.hostSessionId)
    expect(retry.claim.replayed).toBe(true)
    expect(retry.runtime.runtimeId).toBe(first.runtime.runtimeId)
    // No second slot was ever walked.
    expect(db.rosterClaims.listByBaseScope(BASE_SCOPE)).toHaveLength(1)
    expect(db.sessions.listByScopeRef(`${BASE_SCOPE}-comet`)).toHaveLength(0)
  })

  it('converges across a simulated daemon restart (durable claim is the only state left)', async () => {
    seedLiveSession(db, BASE_SCOPE, 'primary')
    const first = await startSuffixRosterRuntime.call(makeHarness(db).instance, request())

    // Fresh server instance ⇒ fresh mutex map, fresh runtimeStartOperations.
    const restarted = makeHarness(db)
    const retry = await startSuffixRosterRuntime.call(restarted.instance, request())

    expect(retry.claim.hostSessionId).toBe(first.claim.hostSessionId)
    expect(retry.claim.slot).toBe(first.claim.slot)
    expect(retry.claim.replayed).toBe(true)
    expect(db.rosterClaims.listByBaseScope(BASE_SCOPE)).toHaveLength(1)
  })

  it('same key + different body is rejected BEFORE any durable intent write', async () => {
    const h = makeHarness(db)
    const first = await startSuffixRosterRuntime.call(h.instance, request())
    const intentBefore = db.sessions.getByHostSessionId(
      first.claim.hostSessionId
    )?.lastAppliedIntentJson
    const startCountBefore = h.started.length

    const error = await errorOf(
      startSuffixRosterRuntime.call(
        h.instance,
        request({ runtimeIntent: intent('a materially different request') })
      )
    )

    expect(error.code).toBe('idempotency_key_conflict')
    expect(h.started.length).toBe(startCountBefore)
    expect(
      db.sessions.getByHostSessionId(first.claim.hostSessionId)?.lastAppliedIntentJson
    ).toEqual(intentBefore)
  })

  it('rejects a conflicting replay after a restart too, still without mutating intent', async () => {
    const first = await startSuffixRosterRuntime.call(makeHarness(db).instance, request())
    const intentBefore = db.sessions.getByHostSessionId(
      first.claim.hostSessionId
    )?.lastAppliedIntentJson

    const restarted = makeHarness(db)
    const error = await errorOf(
      startSuffixRosterRuntime.call(
        restarted.instance,
        request({ runtimeIntent: intent('different after restart') })
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
    const first = await startSuffixRosterRuntime.call(h.instance, request())

    // Simulate the only way this is reachable: the claimed session was rotated
    // away by a newer press after the original start died pre-runtime-row.
    const claimed = db.sessions.getByHostSessionId(first.claim.hostSessionId)
    if (!claimed) throw new Error('claimed session missing')
    db.runtimes.updateStatus(`rt-${claimed.hostSessionId}`, 'terminated', NOW)
    await rotateSessionContext.call(h.instance, claimed, {
      relaunch: false,
      dropContinuation: true,
      reason: 'test-supersede',
    })
    const startCountBefore = h.started.length

    const error = await errorOf(startSuffixRosterRuntime.call(h.instance, request()))

    expect(error.code).toBe('roster_claim_superseded')
    expect(h.started.length).toBe(startCountBefore)
    expect(db.sessions.getByHostSessionId(claimed.hostSessionId)?.status).toBe('archived')
  })

  it('a mid-start daemon death leaves the slot FREE and recyclable', async () => {
    const h = makeHarness(db)
    h.behavior.die = true
    await errorOf(startSuffixRosterRuntime.call(h.instance, request({ idempotencyKey: 'dead' })))

    // No runtime row was written, and the in-flight registration is gone.
    const claim = db.rosterClaims.getByIdempotencyKey('dead')
    expect(claim).not.toBeNull()
    expect(db.runtimes.listByHostSessionId(claim?.successorHostSessionId ?? '')).toHaveLength(0)

    h.behavior.die = false
    const next = await startSuffixRosterRuntime.call(
      h.instance,
      request({ idempotencyKey: 'fresh-press' })
    )
    // Recycled the SAME slot rather than burning a new one.
    expect(next.claim.slot).toBe('primary')
  })

  it('a recycled slot always starts a fresh conversation', async () => {
    // A slot that is idle (terminated runtime) but still carries a continuation.
    const idle = seedLiveSession(db, `${BASE_SCOPE}-nova`, 'nova')
    db.runtimes.updateStatus('rt-live-nova', 'terminated', NOW)
    seedLiveSession(db, BASE_SCOPE, 'primary')
    const h = makeHarness(db)

    const result = await startSuffixRosterRuntime.call(h.instance, request())

    expect(result.claim.slot).toBe('primary-nova')
    expect(result.claim.hostSessionId).not.toBe(idle.hostSessionId)
    const successor = db.sessions.getByHostSessionId(result.claim.hostSessionId)
    expect(successor?.generation).toBe(idle.generation + 1)
    expect(successor?.continuation).toBeUndefined()
    expect(db.sessions.getByHostSessionId(idle.hostSessionId)?.status).toBe('archived')
  })

  it('an exhausted roster is a typed error, never a hijack', async () => {
    for (const slot of rosterSlotTokens('primary')) {
      const scopeRef = slot === 'primary' ? BASE_SCOPE : `${BASE_SCOPE}-${slot.slice(8)}`
      seedLiveSession(db, scopeRef, slot)
    }
    const h = makeHarness(db)

    const error = await errorOf(startSuffixRosterRuntime.call(h.instance, request()))

    expect(error.code).toBe('session_roster_exhausted')
    expect(h.started).toHaveLength(0)
    // Every live session survived.
    for (const slot of rosterSlotTokens('primary')) {
      const scopeRef = slot === 'primary' ? BASE_SCOPE : `${BASE_SCOPE}-${slot.slice(8)}`
      expect(db.continuities.getByKey(scopeRef, 'main')?.activeHostSessionId).toBe(`hsid-${slot}`)
    }
  })
})
