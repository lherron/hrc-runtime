/**
 * T-04751 — CHARACTERIZATION TESTS (gates extraction of finalizeActiveRun + settleInvocation)
 *
 * Pins the CURRENT observable behavior of the three public terminal-mutation
 * functions in startup-reconcile/runtime-mutations.ts.  curly's planned
 * extraction of shared private helpers must not break any assertion here.
 *
 * ── Pinned contract ───────────────────────────────────────────────────────────
 *
 *  markRuntimeDead(db, session, runtime, source, eventJson) → void
 *    • runtime.status  → 'dead'
 *    • runtimeStateJson  NOT updated (no staleReason/terminationReason keys written)
 *    • activeRun (if present): cleared from runtime + run.status → 'failed',
 *        errorCode 'runtime_unavailable',
 *        errorMessage "<runtimeId> is dead after startup reconciliation"
 *    • NO broker-invocation settlement (no settleInvocation step)
 *    • event → db.events (raw EventRepository, NOT db.hrcEvents), kind 'runtime.dead'
 *    • returns void (undefined)
 *
 *  markRuntimeStale(db, session, runtime, eventJson) → HrcLifecycleEvent
 *    • runtime.status  → 'stale'
 *    • runtimeStateJson set: { status:'stale', staleReason:eventJson.reason,
 *        stalePayload:eventJson, [terminalInvocation if invocationId present] }
 *    • activeRun (if present): cleared + run.status → 'failed',
 *        errorCode 'runtime_unavailable',
 *        errorMessage "<runtimeId> is stale after startup reconciliation"
 *    • non-terminal broker invocation → 'disposed' (NOT 'exited')
 *    • already-terminal invocation NOT updated
 *    • runtimeStateJson.terminalInvocation.eventType = 'hrc.runtime.stale'
 *    • event → db.hrcEvents (HrcLifecycleEventRepository, NOT db.events), kind 'runtime.stale'
 *    • event payload = eventJson (passed through as-is)
 *    • returns HrcLifecycleEvent
 *
 *  markRuntimeTerminatedAfterUserExit(db, session, runtime, eventJson) → HrcLifecycleEvent
 *    • runtime.status  → 'terminated'
 *    • runtimeStateJson set: { status:'terminated',
 *        terminationReason:'user_initiated_session_end',
 *        userExitReason:eventJson.userExitReason,
 *        terminationPayload:eventJson, [terminalInvocation if invocationId present] }
 *    • activeRun (if present): cleared + run.status → 'failed',
 *        errorCode 'runtime_unavailable',
 *        errorMessage "<runtimeId> was terminated by user exit"
 *    • non-terminal broker invocation → 'exited' (NOT 'disposed')
 *    • already-terminal invocation NOT updated
 *    • runtimeStateJson.terminalInvocation.eventType = 'hrc.runtime.terminated'
 *    • event → db.hrcEvents, kind 'runtime.terminated'
 *    • event payload = { ...eventJson, reason:'user_initiated_session_end' } (merged)
 *    • returns HrcLifecycleEvent
 *
 * ── Key divergences (must be preserved byte-for-byte after extraction) ────────
 *  Property                      | markRuntimeDead | markRuntimeStale | markRuntimeTerminated
 *  runtime.status                | 'dead'          | 'stale'          | 'terminated'
 *  runtimeStateJson updated      | NO              | YES              | YES
 *  stateJson extra keys          | —               | staleReason/Payload | terminationReason/userExitReason
 *  terminalInvocation.eventType  | —               | 'hrc.runtime.stale' | 'hrc.runtime.terminated'
 *  invocation settled to         | (none)          | 'disposed'       | 'exited'
 *  event store                   | db.events       | db.hrcEvents     | db.hrcEvents
 *  event payload                 | eventJson       | eventJson        | {...eventJson, reason:'user_initiated_session_end'}
 *  errorMessage fragment         | 'is dead after' | 'is stale after' | 'was terminated by user exit'
 *  return type                   | void            | HrcLifecycleEvent| HrcLifecycleEvent
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  HrcBrokerInvocationRecord,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  markRuntimeDead,
  markRuntimeStale,
  markRuntimeTerminatedAfterUserExit,
} from '../startup-reconcile/runtime-mutations.js'

// ────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ────────────────────────────────────────────────────────────────────────────

let dir: string
let db: HrcDatabase

const HOST_SESSION_ID = 'hsid-char-mutations'
const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-04751'
const LANE_REF = 'main'
const GENERATION = 1

function nowTs(): string {
  return '2026-06-15T00:00:00.000Z'
}

function seedSession(): HrcSessionRecord {
  const now = nowTs()
  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  return {
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  }
}

type SeedRuntimeOpts = {
  runtimeId: string
  status?: string
  activeRunId?: string | undefined
  controllerKind?: string | undefined
  activeInvocationId?: string | undefined
  runtimeStateJson?: Record<string, unknown> | undefined
}

function seedRuntime(opts: SeedRuntimeOpts): HrcRuntimeSnapshot {
  const now = nowTs()
  db.runtimes.insert({
    runtimeId: opts.runtimeId,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: opts.status ?? 'busy',
    supportsInflightInput: false,
    adopted: false,
    activeRunId: opts.activeRunId,
    controllerKind: opts.controllerKind,
    activeInvocationId: opts.activeInvocationId,
    runtimeStateJson: opts.runtimeStateJson,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  })
  return db.runtimes.getByRuntimeId(opts.runtimeId)!
}

function seedRun(runId: string, runtimeId: string): HrcRunRecord {
  const now = nowTs()
  db.runs.insert({
    runId,
    hostSessionId: HOST_SESSION_ID,
    runtimeId,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    status: 'started',
    acceptedAt: now,
    startedAt: now,
    updatedAt: now,
  })
  return db.runs.getByRunId(runId)!
}

function seedBrokerInvocation(
  invocationId: string,
  runtimeId: string,
  invocationState: HrcBrokerInvocationRecord['invocationState'] = 'ready'
): HrcBrokerInvocationRecord {
  const now = nowTs()
  return db.brokerInvocations.insert({
    invocationId,
    operationId: `op-${invocationId}`,
    runtimeId,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'claude-code-tmux',
    invocationState,
    capabilitiesJson: JSON.stringify({ input: true }),
    specHash: `spec-${invocationId}`,
    startRequestHash: `sr-${invocationId}`,
    selectedProfileHash: `pf-${invocationId}`,
    createdAt: now,
    updatedAt: now,
  })
}

function getRun(runId: string): HrcRunRecord | null {
  return db.runs.getByRunId(runId)
}

function getRuntime(runtimeId: string): HrcRuntimeSnapshot | null {
  return db.runtimes.getByRuntimeId(runtimeId)
}

function getInvocation(invocationId: string): HrcBrokerInvocationRecord | null {
  return db.brokerInvocations.getByInvocationId(invocationId)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-runtime-mutations-char-'))
  db = openHrcDatabase(join(dir, 'test.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

// ════════════════════════════════════════════════════════════════════════════
//  markRuntimeDead
// ════════════════════════════════════════════════════════════════════════════

describe('characterization: markRuntimeDead', () => {
  it('marks runtime status dead — no activeRunId branch (no run mutation)', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-dead-no-run', status: 'busy' })

    const result = markRuntimeDead(db, session, runtime, 'hrc', { reason: 'test' })

    // returns void
    expect(result).toBeUndefined()

    const rt = getRuntime('rt-dead-no-run')
    expect(rt?.status).toBe('dead')
    expect(rt?.activeRunId).toBeUndefined()

    // No run table touched — no runs in DB
    expect(db.runs.listByRuntimeId('rt-dead-no-run')).toHaveLength(0)
  })

  it('marks runtime status dead and clears activeRunId when a run is active', () => {
    const session = seedSession()
    const runtime = seedRuntime({
      runtimeId: 'rt-dead-run',
      status: 'busy',
      activeRunId: 'run-dead',
    })
    seedRun('run-dead', 'rt-dead-run')

    markRuntimeDead(db, session, runtime, 'hrc', { reason: 'test-dead' })

    // runtime cleared of activeRunId and set to dead
    const rt = getRuntime('rt-dead-run')
    expect(rt?.status).toBe('dead')
    expect(rt?.activeRunId).toBeUndefined()

    // run is failed with runtime_unavailable
    const run = getRun('run-dead')
    expect(run?.status).toBe('failed')
    expect(run?.errorCode).toBe('runtime_unavailable')
    expect(run?.completedAt).toBeDefined()
  })

  it('run errorMessage contains runtimeId + "is dead after startup reconciliation"', () => {
    const session = seedSession()
    const runtime = seedRuntime({
      runtimeId: 'rt-dead-msg',
      activeRunId: 'run-dead-msg',
    })
    seedRun('run-dead-msg', 'rt-dead-msg')

    markRuntimeDead(db, session, runtime, 'hrc', {})

    const run = getRun('run-dead-msg')
    expect(run?.errorMessage).toBe(
      'runtime rt-dead-msg is dead after startup reconciliation'
    )
  })

  it('appends event to db.events (raw EventRepository) with eventKind=runtime.dead', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-dead-evt', status: 'busy' })

    const eventJson = { reason: 'orphan_probe', extra: 'data' }
    markRuntimeDead(db, session, runtime, 'tmux', eventJson)

    // Event is in db.events (raw table)
    const rawEvents = db.events.listFromSeq(1).filter((e) => e.eventKind === 'runtime.dead')
    expect(rawEvents).toHaveLength(1)
    expect(rawEvents[0]?.source).toBe('tmux')
    expect(rawEvents[0]?.runtimeId).toBe('rt-dead-evt')
    expect(rawEvents[0]?.eventJson).toMatchObject(eventJson)

    // NOT in db.hrcEvents
    const hrcEvents = db.hrcEvents
      .listFromHrcSeq(1)
      .filter((e) => e.eventKind === 'runtime.dead')
    expect(hrcEvents).toHaveLength(0)
  })

  it('does NOT update runtimeStateJson (key divergence from markRuntimeStale/Terminated)', () => {
    const session = seedSession()
    const initialStateJson = { schemaVersion: 'runtime-state/v1', kind: 'existing' }
    const runtime = seedRuntime({
      runtimeId: 'rt-dead-stateJson',
      runtimeStateJson: initialStateJson,
    })

    markRuntimeDead(db, session, runtime, 'hrc', { reason: 'test' })

    const rt = getRuntime('rt-dead-stateJson')
    // runtimeStateJson unchanged — dead does NOT write status/staleReason/terminationReason
    expect(rt?.runtimeStateJson).toMatchObject(initialStateJson)
    expect((rt?.runtimeStateJson as Record<string, unknown>)?.['status']).toBeUndefined()
    expect((rt?.runtimeStateJson as Record<string, unknown>)?.['staleReason']).toBeUndefined()
    expect(
      (rt?.runtimeStateJson as Record<string, unknown>)?.['terminationReason']
    ).toBeUndefined()
  })

  it('does NOT settle broker invocation (no settleInvocation step, diverges from markRuntimeStale)', () => {
    const session = seedSession()
    const invocationId = 'inv-dead-no-settle'
    const runtime = seedRuntime({
      runtimeId: 'rt-dead-broker',
      controllerKind: 'harness-broker',
      activeInvocationId: invocationId,
    })
    seedBrokerInvocation(invocationId, 'rt-dead-broker', 'ready')

    markRuntimeDead(db, session, runtime, 'hrc', {})

    // invocation state must NOT be changed — markRuntimeDead has no settlement step
    const inv = getInvocation(invocationId)
    expect(inv?.invocationState).toBe('ready')
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  markRuntimeStale
// ════════════════════════════════════════════════════════════════════════════

describe('characterization: markRuntimeStale', () => {
  it('marks runtime status stale — no activeRunId branch (no run mutation)', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-stale-no-run', status: 'busy' })

    const result = markRuntimeStale(db, session, runtime, { reason: 'test_stale' })

    // returns HrcLifecycleEvent (not void)
    expect(result).not.toBeUndefined()
    expect(typeof result).toBe('object')

    const rt = getRuntime('rt-stale-no-run')
    expect(rt?.status).toBe('stale')
    expect(rt?.activeRunId).toBeUndefined()

    expect(db.runs.listByRuntimeId('rt-stale-no-run')).toHaveLength(0)
  })

  it('marks runtime stale and clears activeRunId when a run is active', () => {
    const session = seedSession()
    const runtime = seedRuntime({
      runtimeId: 'rt-stale-run',
      activeRunId: 'run-stale',
    })
    seedRun('run-stale', 'rt-stale-run')

    markRuntimeStale(db, session, runtime, { reason: 'idle_ttl' })

    const rt = getRuntime('rt-stale-run')
    expect(rt?.status).toBe('stale')
    expect(rt?.activeRunId).toBeUndefined()

    const run = getRun('run-stale')
    expect(run?.status).toBe('failed')
    expect(run?.errorCode).toBe('runtime_unavailable')
    expect(run?.completedAt).toBeDefined()
  })

  it('run errorMessage contains runtimeId + "is stale after startup reconciliation"', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-stale-msg', activeRunId: 'run-stale-msg' })
    seedRun('run-stale-msg', 'rt-stale-msg')

    markRuntimeStale(db, session, runtime, {})

    const run = getRun('run-stale-msg')
    expect(run?.errorMessage).toBe(
      'runtime rt-stale-msg is stale after startup reconciliation'
    )
  })

  it('sets runtimeStateJson with staleReason and stalePayload from eventJson', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-stale-json', status: 'busy' })
    const eventJson = { reason: 'broker_stale_probe', source: 'unit-test' }

    markRuntimeStale(db, session, runtime, eventJson)

    const rt = getRuntime('rt-stale-json')
    const stateJson = rt?.runtimeStateJson as Record<string, unknown>
    expect(stateJson?.['status']).toBe('stale')
    expect(stateJson?.['staleReason']).toBe('broker_stale_probe')
    expect(stateJson?.['stalePayload']).toMatchObject(eventJson)
    // terminationReason must NOT be present — stale uses staleReason, not terminationReason
    expect(stateJson?.['terminationReason']).toBeUndefined()
  })

  it('preserves existing runtimeStateJson keys when merging stale state', () => {
    const session = seedSession()
    const existingJson = { schemaVersion: 'runtime-state/v1', kind: 'harness-broker', extra: 42 }
    const runtime = seedRuntime({
      runtimeId: 'rt-stale-merge',
      runtimeStateJson: existingJson,
    })

    markRuntimeStale(db, session, runtime, { reason: 'merge-test' })

    const rt = getRuntime('rt-stale-merge')
    const stateJson = rt?.runtimeStateJson as Record<string, unknown>
    // Existing keys preserved via spread
    expect(stateJson?.['schemaVersion']).toBe('runtime-state/v1')
    expect(stateJson?.['kind']).toBe('harness-broker')
    expect(stateJson?.['extra']).toBe(42)
    // New keys written
    expect(stateJson?.['status']).toBe('stale')
    expect(stateJson?.['staleReason']).toBe('merge-test')
  })

  it('does NOT set terminalInvocation in runtimeStateJson when no invocationId', () => {
    const session = seedSession()
    // non-broker runtime (no controllerKind/invocationId)
    const runtime = seedRuntime({ runtimeId: 'rt-stale-no-inv', status: 'busy' })

    markRuntimeStale(db, session, runtime, { reason: 'no-inv' })

    const stateJson = getRuntime('rt-stale-no-inv')?.runtimeStateJson as Record<string, unknown>
    expect(stateJson?.['terminalInvocation']).toBeUndefined()
  })

  it('sets runtimeStateJson.terminalInvocation when invocationId present', () => {
    const session = seedSession()
    const invocationId = 'inv-stale-term-inv'
    const runtime = seedRuntime({
      runtimeId: 'rt-stale-term-inv',
      controllerKind: 'harness-broker',
      activeInvocationId: invocationId,
    })
    seedBrokerInvocation(invocationId, 'rt-stale-term-inv', 'ready')

    markRuntimeStale(db, session, runtime, { reason: 'with-inv' })

    const stateJson = getRuntime('rt-stale-term-inv')?.runtimeStateJson as Record<
      string,
      unknown
    >
    expect(stateJson?.['terminalInvocation']).toMatchObject({
      invocationId,
      // diverges from markRuntimeTerminatedAfterUserExit which writes 'hrc.runtime.terminated'
      eventType: 'hrc.runtime.stale',
    })
  })

  it('settles non-terminal broker invocation → disposed (NOT exited)', () => {
    const session = seedSession()
    const invocationId = 'inv-stale-disposed'
    const runtime = seedRuntime({
      runtimeId: 'rt-stale-disposed',
      controllerKind: 'harness-broker',
      activeInvocationId: invocationId,
    })
    seedBrokerInvocation(invocationId, 'rt-stale-disposed', 'turn_active')

    markRuntimeStale(db, session, runtime, { reason: 'probe' })

    const inv = getInvocation(invocationId)
    expect(inv?.invocationState).toBe('disposed')
  })

  it('does NOT update already-terminal broker invocation (skips when terminal)', () => {
    const session = seedSession()
    const invocationId = 'inv-stale-already-exited'
    const runtime = seedRuntime({
      runtimeId: 'rt-stale-skip-settle',
      controllerKind: 'harness-broker',
      activeInvocationId: invocationId,
    })
    // already exited — must NOT be changed to 'disposed'
    seedBrokerInvocation(invocationId, 'rt-stale-skip-settle', 'exited')

    markRuntimeStale(db, session, runtime, { reason: 'probe' })

    const inv = getInvocation(invocationId)
    // must remain 'exited', NOT be flipped to 'disposed'
    expect(inv?.invocationState).toBe('exited')
  })

  it('does NOT update broker invocation when controllerKind is not harness-broker', () => {
    const session = seedSession()
    const invocationId = 'inv-stale-non-broker'
    const runtime = seedRuntime({
      runtimeId: 'rt-stale-non-broker',
      // controllerKind explicitly absent — non-broker runtime
      activeInvocationId: invocationId,
    })
    seedBrokerInvocation(invocationId, 'rt-stale-non-broker', 'ready')

    markRuntimeStale(db, session, runtime, { reason: 'non-broker' })

    // no settlement because controllerKind !== 'harness-broker'
    const inv = getInvocation(invocationId)
    expect(inv?.invocationState).toBe('ready')
  })

  it('appends event to db.hrcEvents (NOT db.events) with kind runtime.stale', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-stale-evt', status: 'busy' })
    const eventJson = { reason: 'stale-evt-test', extra: true }

    markRuntimeStale(db, session, runtime, eventJson)

    // in hrcEvents
    const hrcEvents = db.hrcEvents
      .listFromHrcSeq(1)
      .filter((e) => e.eventKind === 'runtime.stale')
    expect(hrcEvents).toHaveLength(1)
    expect(hrcEvents[0]?.runtimeId).toBe('rt-stale-evt')
    expect(hrcEvents[0]?.payload).toMatchObject(eventJson)

    // NOT in raw db.events
    const rawEvents = db.events.listFromSeq(1).filter((e) => e.eventKind === 'runtime.stale')
    expect(rawEvents).toHaveLength(0)
  })

  it('event payload is eventJson passed through as-is (no extra reason merge)', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-stale-payload', status: 'busy' })
    const eventJson = { reason: 'idle_ttl', customField: 'value' }

    markRuntimeStale(db, session, runtime, eventJson)

    const evt = db.hrcEvents
      .listFromHrcSeq(1)
      .find((e) => e.eventKind === 'runtime.stale')
    expect(evt?.payload).toMatchObject({ reason: 'idle_ttl', customField: 'value' })
    // payload must NOT have 'user_initiated_session_end' injected (that's only markRuntimeTerminated)
    expect((evt?.payload as Record<string, unknown>)?.['terminationReason']).toBeUndefined()
  })

  it('returns an HrcLifecycleEvent with eventKind=runtime.stale and correct runtimeId', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-stale-return' })

    const evt = markRuntimeStale(db, session, runtime, { reason: 'return-test' })

    expect(evt.eventKind).toBe('runtime.stale')
    expect(evt.runtimeId).toBe('rt-stale-return')
    expect(evt.category).toBe('runtime')
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  markRuntimeTerminatedAfterUserExit
// ════════════════════════════════════════════════════════════════════════════

describe('characterization: markRuntimeTerminatedAfterUserExit', () => {
  it('marks runtime status terminated — no activeRunId branch (no run mutation)', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-term-no-run', status: 'busy' })

    const result = markRuntimeTerminatedAfterUserExit(db, session, runtime, {
      userExitReason: '/quit',
    })

    expect(result).not.toBeUndefined()
    expect(typeof result).toBe('object')

    const rt = getRuntime('rt-term-no-run')
    expect(rt?.status).toBe('terminated')
    expect(rt?.activeRunId).toBeUndefined()

    expect(db.runs.listByRuntimeId('rt-term-no-run')).toHaveLength(0)
  })

  it('marks runtime terminated and clears activeRunId when a run is active', () => {
    const session = seedSession()
    const runtime = seedRuntime({
      runtimeId: 'rt-term-run',
      activeRunId: 'run-term',
    })
    seedRun('run-term', 'rt-term-run')

    markRuntimeTerminatedAfterUserExit(db, session, runtime, { userExitReason: '/quit' })

    const rt = getRuntime('rt-term-run')
    expect(rt?.status).toBe('terminated')
    expect(rt?.activeRunId).toBeUndefined()

    const run = getRun('run-term')
    expect(run?.status).toBe('failed')
    expect(run?.errorCode).toBe('runtime_unavailable')
    expect(run?.completedAt).toBeDefined()
  })

  it('run errorMessage contains runtimeId + "was terminated by user exit"', () => {
    const session = seedSession()
    const runtime = seedRuntime({
      runtimeId: 'rt-term-msg',
      activeRunId: 'run-term-msg',
    })
    seedRun('run-term-msg', 'rt-term-msg')

    markRuntimeTerminatedAfterUserExit(db, session, runtime, {})

    const run = getRun('run-term-msg')
    expect(run?.errorMessage).toBe('runtime rt-term-msg was terminated by user exit')
  })

  it('sets runtimeStateJson with terminationReason=user_initiated_session_end (always)', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-term-json', status: 'busy' })
    const eventJson = { userExitReason: '/quit', source: 'unit-test' }

    markRuntimeTerminatedAfterUserExit(db, session, runtime, eventJson)

    const stateJson = getRuntime('rt-term-json')?.runtimeStateJson as Record<string, unknown>
    expect(stateJson?.['status']).toBe('terminated')
    // terminationReason is ALWAYS 'user_initiated_session_end', not from eventJson
    expect(stateJson?.['terminationReason']).toBe('user_initiated_session_end')
    expect(stateJson?.['userExitReason']).toBe('/quit')
    expect(stateJson?.['terminationPayload']).toMatchObject(eventJson)
    // stale-specific keys must NOT appear
    expect(stateJson?.['staleReason']).toBeUndefined()
    expect(stateJson?.['stalePayload']).toBeUndefined()
  })

  it('preserves existing runtimeStateJson keys when merging terminated state', () => {
    const session = seedSession()
    const existingJson = { schemaVersion: 'runtime-state/v1', kind: 'harness-broker', seq: 7 }
    const runtime = seedRuntime({
      runtimeId: 'rt-term-merge',
      runtimeStateJson: existingJson,
    })

    markRuntimeTerminatedAfterUserExit(db, session, runtime, { userExitReason: 'bye' })

    const stateJson = getRuntime('rt-term-merge')?.runtimeStateJson as Record<string, unknown>
    expect(stateJson?.['schemaVersion']).toBe('runtime-state/v1')
    expect(stateJson?.['kind']).toBe('harness-broker')
    expect(stateJson?.['seq']).toBe(7)
    expect(stateJson?.['status']).toBe('terminated')
  })

  it('does NOT set terminalInvocation in runtimeStateJson when no invocationId', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-term-no-inv', status: 'busy' })

    markRuntimeTerminatedAfterUserExit(db, session, runtime, {})

    const stateJson = getRuntime('rt-term-no-inv')?.runtimeStateJson as Record<string, unknown>
    expect(stateJson?.['terminalInvocation']).toBeUndefined()
  })

  it('sets runtimeStateJson.terminalInvocation.eventType=hrc.runtime.terminated when invocationId present', () => {
    const session = seedSession()
    const invocationId = 'inv-term-inv'
    const runtime = seedRuntime({
      runtimeId: 'rt-term-term-inv',
      controllerKind: 'harness-broker',
      activeInvocationId: invocationId,
    })
    seedBrokerInvocation(invocationId, 'rt-term-term-inv', 'ready')

    markRuntimeTerminatedAfterUserExit(db, session, runtime, {})

    const stateJson = getRuntime('rt-term-term-inv')?.runtimeStateJson as Record<string, unknown>
    expect(stateJson?.['terminalInvocation']).toMatchObject({
      invocationId,
      // diverges from markRuntimeStale which writes 'hrc.runtime.stale'
      eventType: 'hrc.runtime.terminated',
    })
  })

  it('settles non-terminal broker invocation → exited (NOT disposed — key divergence from markRuntimeStale)', () => {
    const session = seedSession()
    const invocationId = 'inv-term-exited'
    const runtime = seedRuntime({
      runtimeId: 'rt-term-exited',
      controllerKind: 'harness-broker',
      activeInvocationId: invocationId,
    })
    seedBrokerInvocation(invocationId, 'rt-term-exited', 'turn_active')

    markRuntimeTerminatedAfterUserExit(db, session, runtime, { userExitReason: '/quit' })

    const inv = getInvocation(invocationId)
    // must be 'exited', NOT 'disposed'
    expect(inv?.invocationState).toBe('exited')
  })

  it('does NOT update already-terminal broker invocation', () => {
    const session = seedSession()
    const invocationId = 'inv-term-already-disposed'
    const runtime = seedRuntime({
      runtimeId: 'rt-term-skip-settle',
      controllerKind: 'harness-broker',
      activeInvocationId: invocationId,
    })
    // already disposed — must NOT be changed to 'exited'
    seedBrokerInvocation(invocationId, 'rt-term-skip-settle', 'disposed')

    markRuntimeTerminatedAfterUserExit(db, session, runtime, {})

    const inv = getInvocation(invocationId)
    // must remain 'disposed', NOT be flipped to 'exited'
    expect(inv?.invocationState).toBe('disposed')
  })

  it('does NOT settle invocation when controllerKind is not harness-broker', () => {
    const session = seedSession()
    const invocationId = 'inv-term-non-broker'
    const runtime = seedRuntime({
      runtimeId: 'rt-term-non-broker',
      activeInvocationId: invocationId,
    })
    seedBrokerInvocation(invocationId, 'rt-term-non-broker', 'ready')

    markRuntimeTerminatedAfterUserExit(db, session, runtime, {})

    const inv = getInvocation(invocationId)
    expect(inv?.invocationState).toBe('ready')
  })

  it('appends event to db.hrcEvents (NOT db.events) with kind runtime.terminated', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-term-evt', status: 'busy' })

    markRuntimeTerminatedAfterUserExit(db, session, runtime, { userExitReason: '/quit' })

    // in hrcEvents
    const hrcEvents = db.hrcEvents
      .listFromHrcSeq(1)
      .filter((e) => e.eventKind === 'runtime.terminated')
    expect(hrcEvents).toHaveLength(1)
    expect(hrcEvents[0]?.runtimeId).toBe('rt-term-evt')

    // NOT in raw db.events
    const rawEvents = db.events
      .listFromSeq(1)
      .filter((e) => e.eventKind === 'runtime.terminated')
    expect(rawEvents).toHaveLength(0)
  })

  it('event payload merges reason=user_initiated_session_end into eventJson (diverges from markRuntimeStale)', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-term-payload', status: 'busy' })
    const eventJson = { userExitReason: '/quit', customField: 'foo' }

    markRuntimeTerminatedAfterUserExit(db, session, runtime, eventJson)

    const evt = db.hrcEvents
      .listFromHrcSeq(1)
      .find((e) => e.eventKind === 'runtime.terminated')
    const payload = evt?.payload as Record<string, unknown>

    // reason IS merged into the payload (unlike markRuntimeStale which passes eventJson as-is)
    expect(payload?.['reason']).toBe('user_initiated_session_end')
    // original eventJson fields preserved
    expect(payload?.['userExitReason']).toBe('/quit')
    expect(payload?.['customField']).toBe('foo')
  })

  it('returns an HrcLifecycleEvent with eventKind=runtime.terminated and correct runtimeId', () => {
    const session = seedSession()
    const runtime = seedRuntime({ runtimeId: 'rt-term-return' })

    const evt = markRuntimeTerminatedAfterUserExit(db, session, runtime, {})

    expect(evt.eventKind).toBe('runtime.terminated')
    expect(evt.runtimeId).toBe('rt-term-return')
    expect(evt.category).toBe('runtime')
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  Cross-function divergence guard — one test that explicitly diffs all three
//  so a future typo-in-extraction (wrong status/invocationState/eventType) is
//  caught in a single obvious place.
// ════════════════════════════════════════════════════════════════════════════

describe('characterization: cross-function divergence guard', () => {
  it('all three functions write distinct runtime statuses, error messages, and invocation states', () => {
    const session = seedSession()

    // ── markRuntimeDead ──────────────────────────────────────────────────────
    const rtDead = seedRuntime({ runtimeId: 'rt-div-dead', activeRunId: 'run-div-dead' })
    seedRun('run-div-dead', 'rt-div-dead')
    seedBrokerInvocation('inv-div-dead', 'rt-div-dead', 'ready')
    // Note: markRuntimeDead does NOT accept invocationId in the runtime snapshot
    // unless controllerKind===harness-broker, but here we seed without it
    // to confirm it ignores it anyway:
    markRuntimeDead(db, session, rtDead, 'hrc', {})

    // ── markRuntimeStale ─────────────────────────────────────────────────────
    const invStaleId = 'inv-div-stale'
    const rtStale = seedRuntime({
      runtimeId: 'rt-div-stale',
      activeRunId: 'run-div-stale',
      controllerKind: 'harness-broker',
      activeInvocationId: invStaleId,
    })
    seedRun('run-div-stale', 'rt-div-stale')
    seedBrokerInvocation(invStaleId, 'rt-div-stale', 'turn_active')
    markRuntimeStale(db, session, rtStale, { reason: 'div-test' })

    // ── markRuntimeTerminatedAfterUserExit ───────────────────────────────────
    const invTermId = 'inv-div-term'
    const rtTerm = seedRuntime({
      runtimeId: 'rt-div-term',
      activeRunId: 'run-div-term',
      controllerKind: 'harness-broker',
      activeInvocationId: invTermId,
    })
    seedRun('run-div-term', 'rt-div-term')
    seedBrokerInvocation(invTermId, 'rt-div-term', 'turn_active')
    markRuntimeTerminatedAfterUserExit(db, session, rtTerm, { userExitReason: '/quit' })

    // ── Assert divergences ───────────────────────────────────────────────────

    // runtime statuses — all three are different
    expect(getRuntime('rt-div-dead')?.status).toBe('dead')
    expect(getRuntime('rt-div-stale')?.status).toBe('stale')
    expect(getRuntime('rt-div-term')?.status).toBe('terminated')

    // run error messages — distinct per function
    expect(getRun('run-div-dead')?.errorMessage).toContain('is dead after')
    expect(getRun('run-div-stale')?.errorMessage).toContain('is stale after')
    expect(getRun('run-div-term')?.errorMessage).toContain('was terminated by user exit')

    // invocation states — markRuntimeDead: unchanged, stale: disposed, terminated: exited
    expect(getInvocation('inv-div-dead')?.invocationState).toBe('ready') // unchanged
    expect(getInvocation(invStaleId)?.invocationState).toBe('disposed')
    expect(getInvocation(invTermId)?.invocationState).toBe('exited')

    // event store routing — dead → db.events; stale/terminated → db.hrcEvents
    const rawEvents = db.events.listFromSeq(1)
    expect(rawEvents.find((e) => e.eventKind === 'runtime.dead')).toBeDefined()
    expect(rawEvents.find((e) => e.eventKind === 'runtime.stale')).toBeUndefined()
    expect(rawEvents.find((e) => e.eventKind === 'runtime.terminated')).toBeUndefined()

    const hrcEvents = db.hrcEvents.listFromHrcSeq(1)
    expect(hrcEvents.find((e) => e.eventKind === 'runtime.stale')).toBeDefined()
    expect(hrcEvents.find((e) => e.eventKind === 'runtime.terminated')).toBeDefined()
    expect(hrcEvents.find((e) => e.eventKind === 'runtime.dead')).toBeUndefined()

    // runtimeStateJson — dead: no status key; stale: status='stale'; terminated: status='terminated'
    const deadStateJson = getRuntime('rt-div-dead')?.runtimeStateJson as
      | Record<string, unknown>
      | undefined
    expect(deadStateJson?.['status']).toBeUndefined()

    const staleStateJson = getRuntime('rt-div-stale')?.runtimeStateJson as Record<
      string,
      unknown
    >
    expect(staleStateJson?.['status']).toBe('stale')
    expect(staleStateJson?.['staleReason']).toBe('div-test')

    const termStateJson = getRuntime('rt-div-term')?.runtimeStateJson as Record<string, unknown>
    expect(termStateJson?.['status']).toBe('terminated')
    expect(termStateJson?.['terminationReason']).toBe('user_initiated_session_end')

    // terminalInvocation.eventType divergence
    expect(
      (staleStateJson?.['terminalInvocation'] as Record<string, unknown>)?.['eventType']
    ).toBe('hrc.runtime.stale')
    expect(
      (termStateJson?.['terminalInvocation'] as Record<string, unknown>)?.['eventType']
    ).toBe('hrc.runtime.terminated')
  })
})
