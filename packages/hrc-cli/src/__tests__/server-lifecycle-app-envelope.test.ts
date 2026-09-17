/**
 * T-08576 D11 server-lifecycle envelope reds.
 *
 * These classifier-only cases stay separate from R-B6, which feeds the classifier the real
 * composed env captured at the app birth boundary. The four correlation aliases are presence
 * markers only: valid scoped envelopes retain their existing authority and parse behavior.
 */
import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluateServerLifecycleAuthorization } from '../cli-runtime'

const PARTIAL_ENVELOPE_MESSAGE =
  'refusing server lifecycle mutation: partial HRC/ASP session envelope; ' +
  'run from a clean operator shell or a recognized primary scope'
const MALFORMED_ENVELOPE_MESSAGE =
  'refusing server lifecycle mutation: malformed HRC/ASP session envelope; ' +
  'run from a clean operator shell or a recognized primary scope'
const INCONSISTENT_ENVELOPE_MESSAGE =
  'refusing server lifecycle mutation: inconsistent HRC_SESSION_REF and ASP_SCOPE_REF'

const PRIMARY_SCOPE = 'agent:smokey:project:hrc-runtime:task:primary'
const PRIMARY_SESSION = `${PRIMARY_SCOPE}/lane:main`
const SEAT_SCOPE = 'agent:smokey:project:hrc-runtime:task:minisvc'
const SEAT_SESSION = `${SEAT_SCOPE}/lane:main`
const TASK_SCOPE = 'agent:smokey:project:hrc-runtime:task:T-08576'
const TASK_SESSION = `${TASK_SCOPE}/lane:main`
const OPERATOR_SCOPE = 'agent:chief:project:hrc-runtime:task:T-08576'
const OPERATOR_SESSION = `${OPERATOR_SCOPE}/lane:main`

const APP_CORRELATION_ENV = {
  AGENT_HOST_SESSION_ID: 'hsid-t08576-app',
  HRC_HOST_SESSION_ID: 'hsid-t08576-app',
  AGENT_GENERATION: '1',
  HRC_GENERATION: '1',
} as const

async function withAgentProfile<T>(
  agentId: string,
  profile: string,
  run: (agentsRoot: string) => T | Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'hrc-lifecycle-app-envelope-'))
  const agentsRoot = join(root, 'agents')
  await mkdir(join(agentsRoot, agentId), { recursive: true })
  await writeFile(join(agentsRoot, agentId, 'agent-profile.toml'), profile)
  try {
    return await run(agentsRoot)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function expectPartialEnvelopeRefusal(
  env: Readonly<Record<string, string>>,
  reason?: string
): void {
  expect(evaluateServerLifecycleAuthorization(env, reason)).toEqual({
    allowed: false,
    message: PARTIAL_ENVELOPE_MESSAGE,
  })
}

describe('T-08576 app correlation server-lifecycle envelope', () => {
  for (const key of [
    'HRC_HOST_SESSION_ID',
    'AGENT_HOST_SESSION_ID',
    'HRC_GENERATION',
    'AGENT_GENERATION',
  ] as const) {
    for (const reason of [undefined, 'governed maintenance'] as const) {
      it(`R-L1 refuses ${key} alone ${reason === undefined ? 'without' : 'with'} --reason`, () => {
        expectPartialEnvelopeRefusal({ [key]: APP_CORRELATION_ENV[key] }, reason)
      })
    }
  }

  for (const reason of [undefined, 'governed maintenance'] as const) {
    it(`R-L2 refuses the grantless app composite ${reason === undefined ? 'without' : 'with'} --reason`, () => {
      expectPartialEnvelopeRefusal(APP_CORRELATION_ENV, reason)
    })
  }

  it('R-L3 keeps the granted app composite refused', () => {
    expectPartialEnvelopeRefusal({ ...APP_CORRELATION_ENV, HRC_RUN_ID: 'run-t08576-granted' })
  })

  it('R-L4 keeps a clean shell operator-authorized with an optional reason', () => {
    expect(evaluateServerLifecycleAuthorization({}, undefined)).toEqual({
      allowed: true,
      callerKind: 'operator',
      requestedBy: null,
      reason: null,
    })
    expect(evaluateServerLifecycleAuthorization({}, '  planned maintenance  ')).toEqual({
      allowed: true,
      callerKind: 'operator',
      requestedBy: null,
      reason: 'planned maintenance',
    })
  })

  it('R-L4 keeps primary authority and its mandatory reason', () => {
    const env = {
      ...APP_CORRELATION_ENV,
      HRC_SESSION_REF: PRIMARY_SESSION,
      ASP_SCOPE_REF: PRIMARY_SCOPE,
      ASP_TASK_ID: 'primary',
      ASP_DEFAULT_TASK: 'primary',
    }
    expect(evaluateServerLifecycleAuthorization(env, undefined)).toEqual({
      allowed: false,
      message: 'primary-scoped server lifecycle mutations require --reason <text>',
    })
    expect(evaluateServerLifecycleAuthorization(env, '  primary maintenance  ')).toEqual({
      allowed: true,
      callerKind: 'primary',
      requestedBy: PRIMARY_SESSION,
      reason: 'primary maintenance',
    })
  })

  it('R-L4 keeps standing-seat authority and its mandatory reason', () => {
    const env = {
      ...APP_CORRELATION_ENV,
      HRC_SESSION_REF: SEAT_SESSION,
      ASP_SCOPE_REF: SEAT_SCOPE,
      ASP_TASK_ID: 'minisvc',
      ASP_DEFAULT_TASK: 'minisvc',
    }
    expect(evaluateServerLifecycleAuthorization(env, undefined)).toEqual({
      allowed: false,
      message: 'seat-scoped server lifecycle mutations require --reason <text>',
    })
    expect(evaluateServerLifecycleAuthorization(env, '  node maintenance  ')).toEqual({
      allowed: true,
      callerKind: 'seat',
      requestedBy: SEAT_SESSION,
      reason: 'node maintenance',
    })
  })

  it('R-L4 keeps profile-declared operator-agent authority and its mandatory reason', async () => {
    await withAgentProfile('chief', 'version = 3\noperator = true\n', (agentsRoot) => {
      const env = {
        ...APP_CORRELATION_ENV,
        ASP_AGENTS_ROOT: agentsRoot,
        HRC_SESSION_REF: OPERATOR_SESSION,
        ASP_SCOPE_REF: OPERATOR_SCOPE,
        ASP_TASK_ID: 'T-08576',
        ASP_DEFAULT_TASK: 'T-08576',
      }
      expect(evaluateServerLifecycleAuthorization(env, undefined)).toEqual({
        allowed: false,
        message: 'operator-agent server lifecycle mutations require --reason <text>',
      })
      expect(evaluateServerLifecycleAuthorization(env, '  governed activation  ')).toEqual({
        allowed: true,
        callerKind: 'operator-agent',
        requestedBy: OPERATOR_SESSION,
        reason: 'governed activation',
      })
    })
  })

  it('R-L4 keeps ordinary task scopes denied with escalation guidance', () => {
    expect(
      evaluateServerLifecycleAuthorization(
        {
          ...APP_CORRELATION_ENV,
          HRC_SESSION_REF: TASK_SESSION,
          ASP_SCOPE_REF: TASK_SCOPE,
          ASP_TASK_ID: 'T-08576',
          ASP_DEFAULT_TASK: 'T-08576',
        },
        'force requested'
      )
    ).toEqual({
      allowed: false,
      message: `task-scoped runtime ${TASK_SCOPE} may not stop or restart the HRC server; escalate to the project primary or an operator shell`,
    })
  })

  it('R-L4 keeps malformed envelopes refused with the existing message', () => {
    expect(
      evaluateServerLifecycleAuthorization(
        { ...APP_CORRELATION_ENV, HRC_SESSION_REF: 'agent:smokey:broken' },
        'maintenance'
      )
    ).toEqual({ allowed: false, message: MALFORMED_ENVELOPE_MESSAGE })
  })

  it('R-L4 keeps inconsistent envelopes refused with the existing message', () => {
    expect(
      evaluateServerLifecycleAuthorization(
        {
          ...APP_CORRELATION_ENV,
          HRC_SESSION_REF: PRIMARY_SESSION,
          ASP_SCOPE_REF: TASK_SCOPE,
        },
        'maintenance'
      )
    ).toEqual({ allowed: false, message: INCONSISTENT_ENVELOPE_MESSAGE })
  })
})
