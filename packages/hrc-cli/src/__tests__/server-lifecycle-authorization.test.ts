import { describe, expect, it } from 'bun:test'

import { evaluateServerLifecycleAuthorization } from '../cli-runtime'

const PRIMARY_SCOPE = 'agent:cody:project:hrc-runtime:task:primary'
const PRIMARY_SESSION = `${PRIMARY_SCOPE}/lane:main`
const TASK_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06007'
const TASK_SESSION = `${TASK_SCOPE}/lane:main`

describe('server lifecycle authorization', () => {
  it('denies a task-scoped runtime with escalation guidance even when force is intended', () => {
    const result = evaluateServerLifecycleAuthorization(
      {
        HRC_SESSION_REF: TASK_SESSION,
        HRC_RUN_ID: 'run-task',
        ASP_SCOPE_REF: TASK_SCOPE,
        ASP_TASK_ID: 'T-06007',
        ASP_DEFAULT_TASK: 'T-06007',
      },
      'force requested'
    )

    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.message).toContain('task-scoped runtime')
      expect(result.message).toContain('escalate')
    }
  })

  it('requires a nonblank reason from primary scope', () => {
    const env = {
      HRC_SESSION_REF: PRIMARY_SESSION,
      ASP_SCOPE_REF: PRIMARY_SCOPE,
      ASP_TASK_ID: 'primary',
      ASP_DEFAULT_TASK: 'primary',
    }

    expect(evaluateServerLifecycleAuthorization(env, undefined)).toEqual({
      allowed: false,
      message: 'primary-scoped server lifecycle mutations require --reason <text>',
    })
    expect(evaluateServerLifecycleAuthorization(env, '   ')).toEqual({
      allowed: false,
      message: 'primary-scoped server lifecycle mutations require --reason <text>',
    })
  })

  it('allows primary scope and preserves its full session ref and normalized reason', () => {
    expect(
      evaluateServerLifecycleAuthorization(
        {
          HRC_SESSION_REF: PRIMARY_SESSION,
          HRC_RUN_ID: 'run-primary',
          ASP_SCOPE_REF: PRIMARY_SCOPE,
          ASP_TASK_ID: 'primary',
        },
        '  coordinated deploy  '
      )
    ).toEqual({
      allowed: true,
      callerKind: 'primary',
      requestedBy: PRIMARY_SESSION,
      reason: 'coordinated deploy',
    })
  })

  it('allows an envelope-free operator shell with an optional reason', () => {
    expect(evaluateServerLifecycleAuthorization({}, undefined)).toEqual({
      allowed: true,
      callerKind: 'operator',
      requestedBy: null,
      reason: null,
    })
    expect(evaluateServerLifecycleAuthorization({}, 'maintenance')).toEqual({
      allowed: true,
      callerKind: 'operator',
      requestedBy: null,
      reason: 'maintenance',
    })
  })

  it('fails closed for partial, malformed, inconsistent, and non-primary envelopes', () => {
    expect(evaluateServerLifecycleAuthorization({ HRC_RUN_ID: 'run-orphan' }, 'x').allowed).toBe(
      false
    )
    expect(
      evaluateServerLifecycleAuthorization({ HRC_SESSION_REF: 'agent:cody:broken' }, 'x').allowed
    ).toBe(false)
    expect(
      evaluateServerLifecycleAuthorization(
        {
          HRC_SESSION_REF: PRIMARY_SESSION,
          ASP_SCOPE_REF: TASK_SCOPE,
        },
        'x'
      ).allowed
    ).toBe(false)
  })

  it('T-07215: a standing node-seat scope is a lifecycle authority with mandatory reason', () => {
    const seatSession = 'agent:mable:project:agent-control-plane:task:minisvc/lane:main'
    // Without a reason: refused at the same bar as primary.
    const withoutReason = evaluateServerLifecycleAuthorization(
      { HRC_SESSION_REF: seatSession },
      undefined
    )
    expect(withoutReason.allowed).toBe(false)
    if (!withoutReason.allowed) {
      expect(withoutReason.message).toContain('seat-scoped')
      expect(withoutReason.message).toContain('--reason')
    }
    // With a reason: allowed, attributed as a seat.
    expect(
      evaluateServerLifecycleAuthorization({ HRC_SESSION_REF: seatSession }, 'steer stack cutover')
    ).toEqual({
      allowed: true,
      callerKind: 'seat',
      requestedBy: seatSession,
      reason: 'steer stack cutover',
    })
  })

  it('accepts a canonical primary ASP scope as clearly primary when no session ref exists', () => {
    expect(
      evaluateServerLifecycleAuthorization(
        {
          ASP_SCOPE_REF: PRIMARY_SCOPE,
          ASP_TASK_ID: 'primary',
        },
        'primary maintenance'
      )
    ).toEqual({
      allowed: true,
      callerKind: 'primary',
      requestedBy: PRIMARY_SCOPE,
      reason: 'primary maintenance',
    })
  })
})
