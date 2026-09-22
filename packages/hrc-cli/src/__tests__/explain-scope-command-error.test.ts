import { describe, expect, it } from 'bun:test'

import { HrcErrorCode } from 'hrc-core'

import { explainScopeCommandError } from '../cli'

// T-02009 — the RUNTIME_UNAVAILABLE renderer must surface the broker-start root
// cause carried in `detail.message` (e.g. "Failed to connect to broker unix
// socket"), not just the generic `reason` code. Before the fix the operator saw
// only `reason: broker_start_failed` + route + runId and had to grep daemon logs.

function domainError(
  message: string,
  detail: Record<string, unknown>
): {
  code: string
  message: string
  detail: Record<string, unknown>
} {
  return { code: HrcErrorCode.RUNTIME_UNAVAILABLE, message, detail }
}

describe('explainScopeCommandError — RUNTIME_UNAVAILABLE rendering', () => {
  it('surfaces detail.message as a cause line for broker_start_failed', () => {
    const err = domainError('interactive broker start failed', {
      code: 'broker_start_failed',
      message: 'Failed to connect to broker unix socket',
      route: 'interactive-broker',
      flag: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
      runId: 'run-0241280b',
    })

    const out = explainScopeCommandError('run', err, 'clod').message

    expect(out).toContain('reason: broker_start_failed')
    expect(out).toContain('cause: Failed to connect to broker unix socket')
    expect(out).toContain('route: interactive-broker (flag HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED)')
    expect(out).toContain('runId: run-0241280b')
  })

  it('does NOT duplicate the top-line message as a cause when detail.message matches', () => {
    const err = domainError('interactive broker start failed', {
      code: 'broker_start_failed',
      message: 'interactive broker start failed',
    })

    const out = explainScopeCommandError('run', err, 'clod').message

    expect(out).not.toContain('cause:')
  })

  it('still renders admission diagnostics[] (no regression to the T-01984 path)', () => {
    const err = domainError('interactive broker compile/admission rejected', {
      code: 'broker_admission_rejected',
      route: 'interactive-broker',
      diagnostics: [{ level: 'error', code: 'E_DRIVER', message: 'driver unavailable' }],
    })

    const out = explainScopeCommandError('run', err, 'clod').message

    expect(out).toContain('reason: broker_admission_rejected')
    expect(out).toContain('• error E_DRIVER: driver unavailable')
    expect(out).not.toContain('cause:')
  })

  it('prints start-request field-diff paths from admission diagnostics', () => {
    const err = domainError('interactive broker compile/admission rejected', {
      code: 'start-request-hash-mismatch',
      route: 'interactive-broker',
      diagnostics: [
        {
          level: 'error',
          code: 'start-request-field-diff',
          message: '/spec/process/cwd: daemon="/tmp/daemon-work", CLI="/tmp/cli-work"',
        },
      ],
    })

    const out = explainScopeCommandError('start', err, 'room-coordinator').message

    expect(out).toContain('/spec/process/cwd')
  })

  // T-08712/T-08713: an HRC admission refusal of a successful ASP compile must
  // name the admission check and the differing field without --json.
  it('renders admissionCode and the HRC admission field diff', () => {
    const err = domainError('aspd preparation refused by HRC admission (ASP compile succeeded)', {
      code: 'admission-rejected',
      rejectedBy: 'hrc-admission',
      route: 'aspd',
      runId: 'run-t8712',
      admissionCode: 'execution-identity-mismatch',
      failingPhase: 'admission',
      phases: [{ id: 'admission', status: 'error', ms: 1210 }],
      aspdRelease: { releaseId: 'rel-t8712', sourceCommit: '9aff8211' },
      ids: { runId: 'run-t8712', compileId: 'cmp-t8712' },
      diagnostics: [
        {
          level: 'error',
          plane: 'hrc-admission',
          code: 'execution-identity-mismatch',
          field: 'startRequest.initialInput.inputId',
          expected: 'input-1',
          actual: null,
          message: 'startRequest.initialInput.inputId: expected "input-1", got (absent)',
        },
      ],
    })

    const out = explainScopeCommandError('start', err, 'clod@hrc-runtime:T-1').message

    expect(out).toContain('reason: admission-rejected')
    expect(out).toContain('admission: execution-identity-mismatch')
    expect(out).not.toContain('why: execution-identity-mismatch')
    expect(out).toContain('where: admission (after 1.21s)')
    expect(out).toContain('aspd: rel-t8712 @ 9aff8211')
    expect(out).toContain('ids: runId run-t8712  compileId cmp-t8712')
    expect(out).toContain(
      '• error execution-identity-mismatch: startRequest.initialInput.inputId: expected "input-1", got (absent)'
    )
  })
})
