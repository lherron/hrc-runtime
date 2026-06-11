import { describe, expect, it } from 'bun:test'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { formatHrcDomainError } from '../domain-error-format.js'

describe('formatHrcDomainError', () => {
  it('includes broker input cause, identifiers, and recommendation', () => {
    const message = formatHrcDomainError(
      new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'interactive broker input failed', {
        error:
          'no server running on /Users/lherron/praesidium/var/run/hrc/btmux/codex-cli-tm-rt-test.sock',
        runtimeId: 'rt-test',
        runId: 'run-test',
        invocationId: 'inv-test',
        route: 'interactive-broker',
        recommendation: 'retry the turn to start a fresh runtime',
      })
    )

    expect(message).toContain('[runtime_unavailable] interactive broker input failed')
    expect(message).toContain('cause: no server running on')
    expect(message).toContain('runtimeId=rt-test')
    expect(message).toContain('runId=run-test')
    expect(message).toContain('invocationId=inv-test')
    expect(message).toContain('next: retry the turn to start a fresh runtime')
  })

  it('includes broker compile/admission reason, flag, and diagnostics', () => {
    const message = formatHrcDomainError(
      new HrcDomainError(
        HrcErrorCode.RUNTIME_UNAVAILABLE,
        'interactive broker compile/admission rejected',
        {
          code: 'initial-input-id-mismatch',
          route: 'interactive-broker',
          flag: 'HRC_INTERACTIVE_BROKER',
          runId: 'run-test',
          message: 'compiled initial input id did not match allocated identity',
          diagnostics: [
            {
              level: 'error',
              code: 'profile-rejected',
              message: 'profile rejected by selector',
              profileId: 'claude-code-tmux',
            },
            {
              level: 'warn',
              message: 'secondary profile skipped',
            },
          ],
        }
      )
    )

    expect(message).toContain('[runtime_unavailable] interactive broker compile/admission rejected')
    expect(message).toContain('reason: initial-input-id-mismatch')
    expect(message).toContain('cause: compiled initial input id did not match allocated identity')
    expect(message).toContain(
      'details: runId=run-test route=interactive-broker flag=HRC_INTERACTIVE_BROKER'
    )
    expect(message).toContain(
      'diagnostic: error [claude-code-tmux] profile-rejected: profile rejected by selector'
    )
    expect(message).toContain('diagnostic: warn: secondary profile skipped')
  })
})
