import { describe, expect, it } from 'bun:test'

import { type PaneStatus, isQuitEligible, skipReasons } from './close-headless-ghostmux'

// Operator idle-viewer reap predicate (T-04423). Eligible iff the surface
// resolves to exactly one broker-tmux runtime that is idle-and-complete with NO
// active run. Each guard is exercised below.
function eligibleStatus(overrides: Partial<PaneStatus> = {}): PaneStatus {
  return {
    id: 'PANE0001',
    title: 'hrc headless agent:clod:project:hrc-runtime:task:reap-probe',
    agent: 'clod',
    scopeRef: 'agent:clod:project:hrc-runtime:task:reap-probe',
    runtimeId: 'rt-eligible',
    runtimeStatus: 'ready',
    transport: 'tmux',
    controllerKind: 'harness-broker',
    activeRunId: '',
    turnStatus: 'completed',
    runId: 'run-done',
    lastEventUtc: '2026-06-14T15:50:38.000Z',
    lastEventLocal: '2026-06-14 10:50:38',
    lastEventKind: 'turn.completed',
    ...overrides,
  }
}

describe('isQuitEligible (operator reap predicate)', () => {
  it('is eligible for an idle, complete broker-tmux runtime with no active run', () => {
    expect(isQuitEligible(eligibleStatus())).toBe(true)
  })

  it('skips when the surface did not resolve to a runtime', () => {
    expect(isQuitEligible(eligibleStatus({ runtimeId: '' }))).toBe(false)
  })

  it('skips a true headless/sdk runtime (only broker-tmux is reapable here)', () => {
    expect(isQuitEligible(eligibleStatus({ transport: 'headless' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ transport: 'sdk' }))).toBe(false)
  })

  it('skips a non-broker tmux pane', () => {
    expect(isQuitEligible(eligibleStatus({ controllerKind: '' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ controllerKind: 'none' }))).toBe(false)
  })

  it('skips a runtime that is not ready (busy/terminated/etc.)', () => {
    expect(isQuitEligible(eligibleStatus({ runtimeStatus: 'busy' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ runtimeStatus: 'terminated' }))).toBe(false)
  })

  it('skips a runtime with an active run (HIGH-severity guard)', () => {
    expect(isQuitEligible(eligibleStatus({ activeRunId: 'run-live' }))).toBe(false)
    // ready + active run is exactly the corrupt state that would otherwise have
    // its live run failed by finalizeRuntimeTermination.
    expect(
      isQuitEligible(eligibleStatus({ runtimeStatus: 'ready', activeRunId: 'run-live' }))
    ).toBe(false)
  })

  it('skips when the latest turn is not completed', () => {
    expect(isQuitEligible(eligibleStatus({ turnStatus: 'running' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ turnStatus: 'failed' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ turnStatus: 'none' }))).toBe(false)
  })
})

describe('skipReasons (per-pane skip explanations)', () => {
  it('returns no reasons for an eligible pane', () => {
    expect(skipReasons(eligibleStatus())).toEqual([])
  })

  it('reports a single root reason when the surface resolves to no runtime', () => {
    const reasons = skipReasons(eligibleStatus({ runtimeId: '' }))
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/no HRC runtime resolved/i)
  })

  it('reports a single root reason when the runtime is absent from the DB', () => {
    const reasons = skipReasons(
      eligibleStatus({ runtimeStatus: 'unknown', runtimeId: 'rt-ghost123' })
    )
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/not found in the HRC DB/i)
    expect(reasons[0]).toContain('rt-ghost123')
  })

  it('explains an already-terminated runtime (the leftover-viewer case)', () => {
    const reasons = skipReasons(eligibleStatus({ runtimeStatus: 'terminated' }))
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/already terminated/i)
    expect(reasons[0]).toMatch(/ghostmux/i)
  })

  it('explains a busy runtime as a wait-and-retry case', () => {
    expect(skipReasons(eligibleStatus({ runtimeStatus: 'busy' }))[0]).toMatch(/wait until/i)
  })

  it('explains a failed/dead runtime as do-not-reap', () => {
    expect(skipReasons(eligibleStatus({ runtimeStatus: 'failed' }))[0]).toMatch(/do not reap/i)
  })

  it('explains a non-broker / non-tmux runtime', () => {
    expect(skipReasons(eligibleStatus({ controllerKind: 'sdk' }))[0]).toMatch(/not harness-broker/i)
    expect(skipReasons(eligibleStatus({ transport: 'headless' }))[0]).toMatch(/not tmux/i)
  })

  it('flags the HIGH-severity active-run case with the run id', () => {
    const reasons = skipReasons(eligibleStatus({ activeRunId: 'run-live9999' }))
    expect(reasons[0]).toMatch(/active run/i)
    expect(reasons[0]).toMatch(/would fail the live run/i)
    expect(reasons[0]).toContain('run-live9')
  })

  it('explains an incomplete latest turn', () => {
    expect(skipReasons(eligibleStatus({ turnStatus: 'started' }))[0]).toMatch(/in progress/i)
    expect(skipReasons(eligibleStatus({ turnStatus: 'failed' }))[0]).toMatch(/not completed/i)
    expect(skipReasons(eligibleStatus({ turnStatus: 'none' }))[0]).toMatch(/nothing has run/i)
  })

  it('lists every failed guard when several are wrong at once', () => {
    const reasons = skipReasons(
      eligibleStatus({ transport: 'sdk', activeRunId: 'run-x', turnStatus: 'none' })
    )
    expect(reasons.length).toBeGreaterThanOrEqual(3)
    expect(reasons.some((r) => /not tmux/i.test(r))).toBe(true)
    expect(reasons.some((r) => /active run/i.test(r))).toBe(true)
    expect(reasons.some((r) => /nothing has run/i.test(r))).toBe(true)
  })
})
