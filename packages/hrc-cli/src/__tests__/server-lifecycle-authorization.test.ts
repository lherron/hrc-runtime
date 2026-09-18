import { describe, expect, it } from 'bun:test'

import { evaluateServerLifecycleAuthorization } from '../cli-runtime'

const PRIMARY_SCOPE = 'agent:cody:project:hrc-runtime:task:primary'
const PRIMARY_SESSION = `${PRIMARY_SCOPE}/lane:main`
const TASK_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06007'
const TASK_SESSION = `${TASK_SCOPE}/lane:main`
const CHIEF_TASK_SCOPE = 'agent:chief:project:hcs:task:T-07943'
const CHIEF_TASK_SESSION = `${CHIEF_TASK_SCOPE}/lane:main`

describe('server lifecycle authorization', () => {
  it('denies a task-scoped runtime with escalation guidance even when force is intended', async () => {
    const result = await evaluateServerLifecycleAuthorization(
      {
        HRC_SESSION_REF: TASK_SESSION,
        HRC_RUN_ID: 'run-task',
        ASP_SCOPE_REF: TASK_SCOPE,
        ASP_TASK_ID: 'T-06007',
        ASP_DEFAULT_TASK: 'T-06007',
      },
      'force requested'
    )

    expect(result).toEqual({
      allowed: false,
      message:
        'task-scoped runtime agent:cody:project:hrc-runtime:task:T-06007 may not stop or restart the HRC server; escalate to the project primary or an operator shell',
    })
  })

  it('requires a nonblank reason from primary scope', async () => {
    const env = {
      HRC_SESSION_REF: PRIMARY_SESSION,
      ASP_SCOPE_REF: PRIMARY_SCOPE,
      ASP_TASK_ID: 'primary',
      ASP_DEFAULT_TASK: 'primary',
    }

    expect(await evaluateServerLifecycleAuthorization(env, undefined)).toEqual({
      allowed: false,
      message: 'primary-scoped server lifecycle mutations require --reason <text>',
    })
    expect(await evaluateServerLifecycleAuthorization(env, '   ')).toEqual({
      allowed: false,
      message: 'primary-scoped server lifecycle mutations require --reason <text>',
    })
  })

  it('allows a daemon-observed operator agent from a task scope with mandatory reason', async () => {
    const env = {
      HRC_SESSION_REF: CHIEF_TASK_SESSION,
      HRC_RUN_ID: 'run-chief-task',
      ASP_SCOPE_REF: CHIEF_TASK_SCOPE,
      ASP_TASK_ID: 'T-07943',
      ASP_DEFAULT_TASK: 'T-07943',
    }
    const resolveOperator = async () => true

    expect(await evaluateServerLifecycleAuthorization(env, undefined, { resolveOperator })).toEqual(
      {
        allowed: false,
        message: 'operator-agent server lifecycle mutations require --reason <text>',
      }
    )
    expect(
      await evaluateServerLifecycleAuthorization(env, '  governed activation  ', {
        resolveOperator,
      })
    ).toEqual({
      allowed: true,
      callerKind: 'operator-agent',
      requestedBy: CHIEF_TASK_SESSION,
      reason: 'governed activation',
    })
  })

  it('fails closed to non-operator when the daemon observation is unreachable', async () => {
    const env = {
      HRC_SESSION_REF: CHIEF_TASK_SESSION,
      HRC_RUN_ID: 'run-chief-task',
      ASP_SCOPE_REF: CHIEF_TASK_SCOPE,
      ASP_TASK_ID: 'T-07943',
      ASP_DEFAULT_TASK: 'T-07943',
    }
    const resolveOperator = async () => {
      throw new Error('socket gone')
    }

    expect(
      await evaluateServerLifecycleAuthorization(env, 'governed activation', { resolveOperator })
    ).toEqual({
      allowed: false,
      message: expect.stringContaining('may not stop or restart'),
    })
  })

  it('applies envelope-conflict refusal before operator-agent authorization', async () => {
    expect(
      await evaluateServerLifecycleAuthorization(
        {
          HRC_SESSION_REF: CHIEF_TASK_SESSION,
          ASP_SCOPE_REF: CHIEF_TASK_SCOPE,
          ASP_TASK_ID: 'T-08009',
        },
        'governed activation',
        { resolveOperator: async () => true }
      )
    ).toEqual({
      allowed: false,
      message: 'refusing server lifecycle mutation: ASP_TASK_ID conflicts with caller scope',
    })
  })

  it('allows primary scope and preserves its full session ref and normalized reason', async () => {
    expect(
      await evaluateServerLifecycleAuthorization(
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

  it('allows an envelope-free operator shell with an optional reason', async () => {
    expect(await evaluateServerLifecycleAuthorization({}, undefined)).toEqual({
      allowed: true,
      callerKind: 'operator',
      requestedBy: null,
      reason: null,
    })
    expect(await evaluateServerLifecycleAuthorization({}, 'maintenance')).toEqual({
      allowed: true,
      callerKind: 'operator',
      requestedBy: null,
      reason: 'maintenance',
    })
  })

  it('fails closed for partial, malformed, inconsistent, and non-primary envelopes', async () => {
    expect(
      (await evaluateServerLifecycleAuthorization({ HRC_RUN_ID: 'run-orphan' }, 'x')).allowed
    ).toBe(false)
    expect(
      (await evaluateServerLifecycleAuthorization({ HRC_SESSION_REF: 'agent:cody:broken' }, 'x'))
        .allowed
    ).toBe(false)
    expect(
      (
        await evaluateServerLifecycleAuthorization(
          {
            HRC_SESSION_REF: PRIMARY_SESSION,
            ASP_SCOPE_REF: TASK_SCOPE,
          },
          'x'
        )
      ).allowed
    ).toBe(false)
  })

  it('T-07215: a standing node-seat scope is a lifecycle authority with mandatory reason', async () => {
    const seatSession = 'agent:mable:project:agent-control-plane:task:minisvc/lane:main'
    // Without a reason: refused at the same bar as primary.
    const withoutReason = await evaluateServerLifecycleAuthorization(
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
      await evaluateServerLifecycleAuthorization(
        { HRC_SESSION_REF: seatSession },
        'steer stack cutover'
      )
    ).toEqual({
      allowed: true,
      callerKind: 'seat',
      requestedBy: seatSession,
      reason: 'steer stack cutover',
    })
  })

  it('accepts a canonical primary ASP scope as clearly primary when no session ref exists', async () => {
    expect(
      await evaluateServerLifecycleAuthorization(
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
