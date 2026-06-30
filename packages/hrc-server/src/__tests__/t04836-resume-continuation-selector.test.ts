/**
 * T-04836 Part A — focused unit coverage for the `hrc resume` selection policy
 * (`selectResumeContinuationCandidate` / `detectResumeInvalidationBarrier`).
 *
 * These are NOT the frozen Phase-R bar; they pin the server-side selector
 * invariants the spec calls out: status-neutral latest-continuation selection,
 * stale-rotation skip, explicit-barrier blocking, and no-continuation failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcContinuationRef, HrcSessionRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { selectResumeContinuationCandidate } from '../session-resume-continuation'

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

  it('blocks resume past an explicit clear-context-with-drop barrier', () => {
    insertSession('hs-1', 1, { status: 'archived', continuation })
    insertSession('hs-2', 2, { priorHostSessionId: 'hs-1' })
    appendContextCleared('hs-1', 1, { dropContinuation: true, reason: 'clear-context' })

    const result = selectResumeContinuationCandidate(db, { sessionRef: SESSION_REF })
    expect(result.outcome).toBe('barrier')
    expect(result.outcome === 'barrier' && result.barrier.kind).toBe('context_cleared')
  })

  it('blocks resume when an in-place continuation_dropped barrier exists', () => {
    insertSession('hs-1', 1, { status: 'active' }) // continuation already dropped in place
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
    expect(result.outcome).toBe('barrier')
    expect(result.outcome === 'barrier' && result.barrier.kind).toBe('continuation_dropped')
  })

  it('blocks resume past a broker continuation.cleared (/quit) barrier', () => {
    insertSession('hs-1', 1, { status: 'active' })
    db.events.append({
      ts: tsAt(1),
      hostSessionId: 'hs-1',
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      source: 'broker',
      eventKind: 'broker.continuation.cleared',
      eventJson: { reason: 'prompt_input_exit' },
    })

    const result = selectResumeContinuationCandidate(db, { sessionRef: SESSION_REF })
    expect(result.outcome).toBe('barrier')
    expect(result.outcome === 'barrier' && result.barrier.kind).toBe('broker_continuation_cleared')
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
