/**
 * T-07899 — focused unit coverage for the `hrc resume` selection policy.
 *
 * These are NOT the frozen Phase-R bar; they pin the server-side selector
 * invariants the spec calls out: status-neutral latest-continuation selection,
 * clear/drop/end barrier neutrality, and no-continuation failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcContinuationRef, HrcSessionRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  automaticContinuationForRuntime,
  automaticContinuationForSession,
} from '../session-continuation-reuse'
import {
  LEGACY_CONTINUATION_CLEAR_BACKFILL_SOURCE,
  backfillLegacyContinuationClearBarriers,
  repairContinuationHistory,
  selectResumeContinuationCandidate,
} from '../session-resume-continuation'

type Db = ReturnType<typeof openHrcDatabase>

const SCOPE_REF = 'agent:rex:project:hrc-runtime:task:primary'
const LANE_REF = 'main'
const SESSION_REF = `${SCOPE_REF}/lane:main`

let dir: string
let db: Db

function tsAt(n: number): string {
  return `2026-06-29T00:00:${String(n).padStart(2, '0')}.000Z`
}

function insertSession(
  hostSessionId: string,
  generation: number,
  opts: {
    status?: HrcSessionRecord['status']
    continuation?: HrcContinuationRef | undefined
    priorHostSessionId?: string | undefined
  } = {}
): HrcSessionRecord {
  return db.sessions.insert({
    hostSessionId,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation,
    status: opts.status ?? 'active',
    createdAt: tsAt(generation),
    updatedAt: tsAt(generation),
    ancestorScopeRefs: [],
    ...(opts.priorHostSessionId ? { priorHostSessionId: opts.priorHostSessionId } : {}),
    ...(opts.continuation ? { continuation: opts.continuation } : {}),
  })
}

function appendContextCleared(
  hostSessionId: string,
  generation: number,
  payload: { dropContinuation: boolean; reason?: string }
): void {
  db.hrcEvents.append({
    ts: tsAt(generation),
    hostSessionId,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation,
    category: 'context',
    eventKind: 'context.cleared',
    transport: 'tmux',
    payload,
  })
}

function appendLegacyBrokerContinuationCleared(hostSessionId: string, generation: number): number {
  const runtimeId = `rt-${hostSessionId}`
  const invocationId = `inv-${hostSessionId}`
  db.runtimes.insert({
    runtimeId,
    hostSessionId,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'terminated',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    createdAt: tsAt(generation),
    updatedAt: tsAt(generation),
  })
  db.brokerInvocations.insert({
    invocationId,
    operationId: `op-${hostSessionId}`,
    runtimeId,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    invocationState: 'exited',
    capabilitiesJson: '{}',
    specHash: 'sha256:spec',
    startRequestHash: 'sha256:request',
    selectedProfileHash: 'sha256:profile',
    createdAt: tsAt(generation),
    updatedAt: tsAt(generation),
  })
  const raw = db.events.append({
    ts: tsAt(generation),
    hostSessionId,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation,
    runtimeId,
    source: 'broker',
    eventKind: 'broker.continuation.cleared',
    eventJson: {
      invocationId,
      seq: 9,
      type: 'continuation.cleared',
      time: tsAt(generation),
      payload: { reason: 'prompt_input_exit' },
    },
  })
  return raw.seq
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-resume-selector-'))
  db = openHrcDatabase(join(dir, 'test.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('selectResumeContinuationCandidate', () => {
  const continuation: HrcContinuationRef = { provider: 'anthropic', key: 'session-uuid-A' }

  it('selects the live continuation when the newest active session carries one', () => {
    insertSession('hs-1', 1, { continuation })
    const result = selectResumeContinuationCandidate(db, { sessionRef: SESSION_REF })
    expect(result.outcome).toBe('ok')
    expect(result.outcome === 'ok' && result.session.hostSessionId).toBe('hs-1')
  })

  it('keeps default selection on the newest key-bearing generation', () => {
    insertSession('hs-1', 1, { continuation: { ...continuation, key: 'older-key' } })
    insertSession('hs-2', 2, {
      continuation: { ...continuation, key: 'newer-key' },
      priorHostSessionId: 'hs-1',
    })

    const result = selectResumeContinuationCandidate(db, { sessionRef: SESSION_REF })
    expect(result.outcome).toBe('ok')
    expect(result.outcome === 'ok' && result.session.hostSessionId).toBe('hs-2')
  })

  it('pins an exact older key-bearing host session when requested', () => {
    insertSession('hs-1', 1, { continuation: { ...continuation, key: 'older-key' } })
    insertSession('hs-2', 2, {
      continuation: { ...continuation, key: 'newer-key' },
      priorHostSessionId: 'hs-1',
    })

    const result = selectResumeContinuationCandidate(db, {
      sessionRef: SESSION_REF,
      priorHostSessionId: 'hs-1',
    })
    expect(result.outcome).toBe('ok')
    expect(result.outcome === 'ok' && result.session.hostSessionId).toBe('hs-1')
  })

  it('selects an archived/dormant continuation status-neutrally', () => {
    insertSession('hs-1', 1, { status: 'archived', continuation })
    const result = selectResumeContinuationCandidate(db, { sessionRef: SESSION_REF })
    expect(result.outcome).toBe('ok')
    expect(result.outcome === 'ok' && result.session.hostSessionId).toBe('hs-1')
  })

  it('skips a stale-generation auto-rotation no-key successor to reach the prior continuation', () => {
    insertSession('hs-1', 1, { status: 'archived', continuation })
    insertSession('hs-2', 2, { priorHostSessionId: 'hs-1' }) // no continuation copied
    appendContextCleared('hs-1', 1, {
      dropContinuation: true,
      reason: 'stale-generation-auto-rotate',
    })

    const result = selectResumeContinuationCandidate(db, { sessionRef: SESSION_REF })
    expect(result.outcome).toBe('ok')
    expect(result.outcome === 'ok' && result.session.hostSessionId).toBe('hs-1')
  })

  it('resumes past an explicit clear-context-with-drop audit event', () => {
    insertSession('hs-1', 1, { status: 'archived', continuation })
    insertSession('hs-2', 2, { priorHostSessionId: 'hs-1' })
    appendContextCleared('hs-1', 1, { dropContinuation: true, reason: 'clear-context' })

    const result = selectResumeContinuationCandidate(db, { sessionRef: SESSION_REF })
    expect(result.outcome).toBe('ok')
    expect(result.outcome === 'ok' && result.session.hostSessionId).toBe('hs-1')
  })

  it('resumes when an in-place continuation_dropped audit event exists', () => {
    insertSession('hs-1', 1, { status: 'active', continuation })
    db.hrcEvents.append({
      ts: tsAt(1),
      hostSessionId: 'hs-1',
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      category: 'session',
      eventKind: 'session.continuation_dropped',
      transport: 'tmux',
      payload: { hostSessionId: 'hs-1', previousContinuationKey: 'session-uuid-A' },
    })

    const result = selectResumeContinuationCandidate(db, { sessionRef: SESSION_REF })
    expect(result.outcome).toBe('ok')
    expect(result.outcome === 'ok' && result.session.hostSessionId).toBe('hs-1')
  })

  it('resumes past a broker continuation.cleared (/quit) audit event', () => {
    insertSession('hs-1', 1, { status: 'active', continuation })
    const rawEventSeq = appendLegacyBrokerContinuationCleared('hs-1', 1)

    expect(backfillLegacyContinuationClearBarriers(db)).toBe(1)
    expect(backfillLegacyContinuationClearBarriers(db)).toBe(0)
    const [backfilled] = db.brokerInvocationEvents.listBySourceRef(
      LEGACY_CONTINUATION_CLEAR_BACKFILL_SOURCE
    )
    expect(backfilled).toMatchObject({
      invocationId: 'inv-hs-1',
      seq: 9,
      type: 'continuation.cleared',
      hrcEventSeq: rawEventSeq,
      projectionStatus: 'imported',
      sourceRef: LEGACY_CONTINUATION_CLEAR_BACKFILL_SOURCE,
      originSeq: rawEventSeq,
    })
    expect(JSON.parse(backfilled!.brokerEventJson)).toEqual({ reason: 'prompt_input_exit' })

    db.sqlite.query('DELETE FROM events').run()

    const result = selectResumeContinuationCandidate(db, { sessionRef: SESSION_REF })
    expect(result.outcome).toBe('ok')
    expect(result.outcome === 'ok' && result.session.hostSessionId).toBe('hs-1')
  })

  it('reports none when there is no captured continuation', () => {
    insertSession('hs-1', 1, {})
    const result = selectResumeContinuationCandidate(db, { sessionRef: SESSION_REF })
    expect(result.outcome).toBe('none')
  })

  it('reports none for an unknown target', () => {
    const result = selectResumeContinuationCandidate(db, {
      sessionRef: 'agent:nobody:project:hrc-runtime:task:primary/lane:main',
    })
    expect(result.outcome).toBe('none')
  })
})

describe('continuation history retention', () => {
  it('suppresses only automatic reuse and re-enables it on a later update', () => {
    const session = insertSession('hs-auto', 1, {
      continuation: { provider: 'anthropic', key: 'key-before-drop' },
    })
    const runtime = db.runtimes.insert({
      runtimeId: 'rt-auto',
      hostSessionId: session.hostSessionId,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'headless',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'terminated',
      continuation: session.continuation,
      supportsInflightInput: false,
      adopted: false,
      createdAt: tsAt(1),
      updatedAt: tsAt(1),
    })

    expect(automaticContinuationForSession(db, session)?.key).toBe('key-before-drop')
    expect(automaticContinuationForRuntime(db, session, runtime)?.key).toBe('key-before-drop')

    db.sessions.setContinuationReuseDisabled(session.hostSessionId, true, tsAt(2))
    const retained = db.sessions.getByHostSessionId(session.hostSessionId)!
    expect(retained.continuation?.key).toBe('key-before-drop')
    expect(automaticContinuationForSession(db, retained)).toBeUndefined()
    expect(automaticContinuationForRuntime(db, retained, runtime)).toBeUndefined()

    db.sessions.updateContinuation(
      session.hostSessionId,
      { provider: 'anthropic', key: 'key-after-fresh-start' },
      tsAt(3)
    )
    const updated = db.sessions.getByHostSessionId(session.hostSessionId)!
    expect(db.sessions.isContinuationReuseDisabled(session.hostSessionId)).toBe(false)
    expect(automaticContinuationForSession(db, updated)?.key).toBe('key-after-fresh-start')
  })

  it('repairs NULL session/runtime keys from the latest event time and is idempotent', () => {
    const session = insertSession('hs-repair', 1)
    db.runtimes.insert({
      runtimeId: 'rt-repair',
      hostSessionId: session.hostSessionId,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'headless',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'terminated',
      supportsInflightInput: false,
      adopted: false,
      createdAt: tsAt(1),
      updatedAt: tsAt(1),
    })
    // Insert the newer provider event first so row id and event time disagree.
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inv-repair-new',
      seq: 1,
      time: tsAt(8),
      type: 'continuation.updated',
      runtimeId: 'rt-repair',
      payload: { provider: 'anthropic', kind: 'session', key: 'latest-by-time' },
    })
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inv-repair-old',
      seq: 1,
      time: tsAt(4),
      type: 'continuation.updated',
      runtimeId: 'rt-repair',
      payload: { provider: 'anthropic', kind: 'session', key: 'later-row-id' },
    })

    expect(repairContinuationHistory(db)).toEqual({ sessions: 1, runtimes: 1 })
    expect(db.sessions.getByHostSessionId(session.hostSessionId)?.continuation).toEqual({
      provider: 'anthropic',
      kind: 'session',
      key: 'latest-by-time',
    })
    expect(db.runtimes.getByRuntimeId('rt-repair')?.continuation?.key).toBe('latest-by-time')
    expect(db.sessions.isContinuationReuseDisabled(session.hostSessionId)).toBe(true)
    expect(repairContinuationHistory(db)).toEqual({ sessions: 0, runtimes: 0 })
  })
})
