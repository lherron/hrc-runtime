import { describe, expect, it } from 'bun:test'

import { isQuitEligible, type PaneStatus } from './close-headless-ghostmux'

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
    expect(isQuitEligible(eligibleStatus({ runtimeStatus: 'ready', activeRunId: 'run-live' }))).toBe(
      false
    )
  })

  it('skips when the latest turn is not completed', () => {
    expect(isQuitEligible(eligibleStatus({ turnStatus: 'running' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ turnStatus: 'failed' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ turnStatus: 'none' }))).toBe(false)
  })
})
