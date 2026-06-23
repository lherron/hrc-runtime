/**
 * H-00104 Node C (C-0004): HrcInvocationExposure builder + correlation
 * idempotency/conflict predicate.
 *
 * Covers the two contract-required tests for this node:
 *  - Conformance test 7 (attempt mapping): one HRC-backed run maps to exactly one
 *    external_run_ref; a retry/rebind that lands a NEW HRC run id is a distinct
 *    attempt ref, never a second ref for the SAME execution.
 *  - Disagreement guard: HRC correlation is opaque convenience metadata. The DTO
 *    surfaces it under a separate `correlation` field; it never overwrites the
 *    authoritative run/attempt identity (`externalRunRef`, `run.runId`).
 */
import { describe, expect, it } from 'bun:test'

import type { HrcRunRecord } from '../contracts.js'
import {
  type HrcRunCorrelation,
  buildHrcInvocationExposure,
  canonicalCorrelationJson,
  correlationConflicts,
  normalizeCorrelation,
} from '../invocation-exposure.js'

function run(overrides: Partial<HrcRunRecord> = {}): HrcRunRecord {
  return {
    runId: 'run-abc',
    hostSessionId: 'hsid-1',
    runtimeId: 'rt-1',
    scopeRef: 'agent:cody:project:wrkq',
    laneRef: 'main',
    generation: 3,
    transport: 'tmux',
    status: 'running',
    updatedAt: '2026-06-21T00:00:00Z',
    acceptedAt: '2026-06-21T00:00:00Z',
    ...overrides,
  }
}

describe('buildHrcInvocationExposure', () => {
  it('projects a run into the stable v1 DTO with one external run ref', () => {
    const exposure = buildHrcInvocationExposure({
      run: run(),
      eventHighWaterSeq: 42,
      eventsFromSeq: 7,
    })

    expect(exposure.kind).toBe('hrc.invocation_exposure.v1')
    expect(exposure.externalRunRef).toBe('hrc:run-abc')
    expect(exposure.run.runId).toBe('run-abc')
    expect(exposure.run.runtimeId).toBe('rt-1')
    expect(exposure.session.sessionRef).toBe('agent:cody:project:wrkq/lane:main')
    expect(exposure.session.selector).toBe('runtime:rt-1')
    expect(exposure.cursors).toEqual({ eventHighWaterSeq: 42, eventsFromSeq: 7 })
    expect(exposure.refs.events).toContain('--format invocation-events')
    expect(exposure.refs.events).toContain('--from-seq 7')
    expect(exposure.correlation).toBeUndefined()
  })

  it('falls back to a scope selector when the run has no runtime yet', () => {
    const exposure = buildHrcInvocationExposure({
      run: run({ runtimeId: undefined }),
      eventHighWaterSeq: 0,
      eventsFromSeq: 1,
    })
    expect(exposure.session.selector).toBe('scope:agent:cody:project:wrkq')
    expect(exposure.refs.sessionLive).toBeUndefined()
  })

  // Conformance test 7 — attempt mapping.
  it('maps one execution to exactly one external_run_ref (no double-attempt)', () => {
    const exposure = buildHrcInvocationExposure({
      run: run(),
      eventHighWaterSeq: 5,
      eventsFromSeq: 1,
    })
    // Exactly one hrc: ref is exposed for the execution. wrkf participation lives
    // on the DAG side; HRC never emits a second ref for the same run.
    expect(exposure.externalRunRef).toBe('hrc:run-abc')
    const refs = JSON.stringify(exposure).match(/hrc:run-abc/g) ?? []
    expect(refs.length).toBe(1)
  })

  it('a retry that lands a NEW hrc run id is a distinct ref, not a second ref for the same run', () => {
    const first = buildHrcInvocationExposure({ run: run(), eventHighWaterSeq: 5, eventsFromSeq: 1 })
    const retry = buildHrcInvocationExposure({
      run: run({ runId: 'run-xyz' }),
      eventHighWaterSeq: 9,
      eventsFromSeq: 6,
    })
    expect(first.externalRunRef).toBe('hrc:run-abc')
    expect(retry.externalRunRef).toBe('hrc:run-xyz')
    expect(first.externalRunRef).not.toBe(retry.externalRunRef)
  })

  // Disagreement guard — correlation is opaque convenience, never graph truth.
  it('surfaces correlation under a separate field without altering run identity', () => {
    const correlation: HrcRunCorrelation = {
      // Deliberately "disagrees" with the run: a coordinator could later decide
      // the authoritative attempt ref differs. The DTO must NOT let this metadata
      // rewrite the run's own identity.
      invocationNodeId: 'node-99',
      attemptRef: 'att-from-some-other-run',
    }
    const exposure = buildHrcInvocationExposure({
      run: run(),
      eventHighWaterSeq: 5,
      eventsFromSeq: 1,
      correlation,
    })
    expect(exposure.externalRunRef).toBe('hrc:run-abc')
    expect(exposure.run.runId).toBe('run-abc')
    expect(exposure.correlation).toEqual({
      invocationNodeId: 'node-99',
      attemptRef: 'att-from-some-other-run',
    })
  })

  it('omits an empty correlation object', () => {
    const exposure = buildHrcInvocationExposure({
      run: run(),
      eventHighWaterSeq: 1,
      eventsFromSeq: 1,
      correlation: {},
    })
    expect(exposure.correlation).toBeUndefined()
  })
})

describe('correlation idempotency / conflict', () => {
  it('treats reordered identical correlations as equal (idempotent same-write)', () => {
    const a: HrcRunCorrelation = { taskId: 'T-1', attemptRef: 'att-1' }
    const b: HrcRunCorrelation = { attemptRef: 'att-1', taskId: 'T-1' }
    expect(canonicalCorrelationJson(a)).toBe(canonicalCorrelationJson(b))
    expect(correlationConflicts(a, b)).toBe(false)
  })

  it('flags a changed field as a conflict', () => {
    const existing: HrcRunCorrelation = { taskId: 'T-1' }
    const incoming: HrcRunCorrelation = { taskId: 'T-2' }
    expect(correlationConflicts(existing, incoming)).toBe(true)
  })

  it('normalizes away undefined fields', () => {
    const normalized = normalizeCorrelation({ taskId: 'T-1', attemptRef: undefined })
    expect(normalized).toEqual({ taskId: 'T-1' })
  })
})
