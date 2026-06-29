/**
 * T-05358 — broker input-failure classification for transient non-dispatchable
 * states (`starting`/`stopping`).
 *
 * The interactive and headless dispatch handlers compute, on an input failure:
 *
 *   reprovisionRequired =
 *     runtimeReapedByReattach ||
 *     isTerminalBrokerInvocationState(invocation?.invocationState) ||
 *     isTransitionalBrokerInvocationState(invocation?.invocationState) ||
 *     isTerminalBrokerInputFailure(errorMessage) ||
 *     isTransientBrokerInputStateFailure(errorMessage)
 *   runtime.status = reprovisionRequired ? 'stale' : 'ready'
 *
 * These tests lock the predicate semantics and the resulting status decision so a
 * `Cannot accept input in state: stopping|starting` rejection marks the runtime
 * stale (forcing a fresh provision) instead of writing it back to `ready` and
 * looping the identical failure — without misclassifying terminal-only or
 * genuinely unclassified rejections.
 */
import { describe, expect, it } from 'bun:test'

import {
  classifyBrokerInputFailure,
  isTerminalBrokerInputFailure,
  isTerminalBrokerInvocationState,
  isTransientBrokerInputStateFailure,
  isTransitionalBrokerInvocationState,
} from '../require-helpers.js'

// Mirror of the handler aggregate (interactive + headless are identical).
function reprovisionRequired(opts: {
  runtimeReapedByReattach?: boolean
  invocationState?: string | undefined
  errorMessage: string
}): boolean {
  return (
    (opts.runtimeReapedByReattach ?? false) ||
    isTerminalBrokerInvocationState(opts.invocationState) ||
    isTransitionalBrokerInvocationState(opts.invocationState) ||
    isTerminalBrokerInputFailure(opts.errorMessage) ||
    isTransientBrokerInputStateFailure(opts.errorMessage)
  )
}
const statusDecision = (o: Parameters<typeof reprovisionRequired>[0]) =>
  reprovisionRequired(o) ? 'stale' : 'ready'

describe('T-05358 transient broker input-state predicates', () => {
  it('isTransientBrokerInputStateFailure matches ONLY starting/stopping rejections', () => {
    expect(isTransientBrokerInputStateFailure('Cannot accept input in state: stopping')).toBe(true)
    expect(isTransientBrokerInputStateFailure('Cannot accept input in state: starting')).toBe(true)
    expect(isTransientBrokerInputStateFailure('Cannot accept input in state: exited')).toBe(false)
    expect(isTransientBrokerInputStateFailure('no active broker client for runtime rt-x')).toBe(
      false
    )
  })

  it('isTerminalBrokerInputFailure stays terminal-ONLY (does not absorb starting/stopping)', () => {
    expect(isTerminalBrokerInputFailure('Cannot accept input in state: exited')).toBe(true)
    expect(isTerminalBrokerInputFailure('Cannot accept input in state: failed')).toBe(true)
    expect(isTerminalBrokerInputFailure('Cannot accept input in state: disposed')).toBe(true)
    expect(isTerminalBrokerInputFailure('Cannot accept input in state: stopping')).toBe(false)
    expect(isTerminalBrokerInputFailure('Cannot accept input in state: starting')).toBe(false)
  })

  it('isTransitionalBrokerInvocationState covers starting/stopping, not ready/turn_active/terminal', () => {
    expect(isTransitionalBrokerInvocationState('starting')).toBe(true)
    expect(isTransitionalBrokerInvocationState('stopping')).toBe(true)
    expect(isTransitionalBrokerInvocationState('ready')).toBe(false)
    expect(isTransitionalBrokerInvocationState('turn_active')).toBe(false)
    expect(isTransitionalBrokerInvocationState('exited')).toBe(false)
    expect(isTransitionalBrokerInvocationState(undefined)).toBe(false)
  })
})

describe('T-05358 handler status decision on input failure', () => {
  it('a `stopping` rejection marks the runtime STALE (not ready)', () => {
    expect(statusDecision({ errorMessage: 'Cannot accept input in state: stopping' })).toBe('stale')
  })

  it('a `starting` rejection marks the runtime STALE (not ready)', () => {
    expect(statusDecision({ errorMessage: 'Cannot accept input in state: starting' })).toBe('stale')
  })

  it('a `stopping` ACTIVE-INVOCATION (even with an unrelated message) marks the runtime STALE', () => {
    expect(
      statusDecision({ invocationState: 'stopping', errorMessage: 'some transport hiccup' })
    ).toBe('stale')
  })

  it('a terminal rejection keeps existing STALE behavior', () => {
    expect(statusDecision({ errorMessage: 'Cannot accept input in state: exited' })).toBe('stale')
  })

  it('an UNCLASSIFIED rejection on a live invocation stays READY (no false reprovision)', () => {
    expect(
      statusDecision({ invocationState: 'ready', errorMessage: 'inspect hrc server logs' })
    ).toBe('ready')
  })
})

describe('T-05358 classifyBrokerInputFailure messaging for transient reprovision', () => {
  it('a stopping reprovision yields the stale-runtime guidance, not the "logs" fallback', () => {
    const { headline, recommendation } = classifyBrokerInputFailure({
      label: 'interactive',
      errorMessage: 'Cannot accept input in state: stopping',
      brokerBindingMissing: false,
      reprovisionRequired: true,
    })
    expect(headline).toContain('interactive broker input failed')
    expect(recommendation).toContain('marked the stale broker runtime unavailable')
    expect(recommendation).not.toContain('inspect hrc server logs')
  })
})
