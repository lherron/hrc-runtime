import { describe, expect, it } from 'bun:test'

import { classifyBrokerInputFailure } from '../require-helpers.js'

describe('classifyBrokerInputFailure', () => {
  it('routes a missing broker binding to a transient "just retry" recommendation', () => {
    const { headline, recommendation } = classifyBrokerInputFailure({
      label: 'headless',
      errorMessage: 'no active broker client for runtime rt-abc',
      brokerBindingMissing: true,
      terminalInputFailure: false,
    })
    // The raw "no active broker client" jargon is dropped from the headline (it
    // is still preserved on the error `cause`/`error` detail at the throw site).
    expect(headline).toBe('headless broker connection was not live')
    expect(recommendation).toContain('just retry')
    expect(recommendation).not.toContain('inspect hrc server logs')
  })

  it('uses the interactive label for the interactive route', () => {
    const { headline } = classifyBrokerInputFailure({
      label: 'interactive',
      errorMessage: 'no active broker client for runtime rt-abc',
      brokerBindingMissing: true,
      terminalInputFailure: false,
    })
    expect(headline).toBe('interactive broker connection was not live')
  })

  it('keeps the stale-runtime guidance for terminal invocation failures', () => {
    const { headline, recommendation } = classifyBrokerInputFailure({
      label: 'headless',
      errorMessage: 'Cannot accept input in state: exited',
      brokerBindingMissing: false,
      terminalInputFailure: true,
    })
    expect(headline).toContain('headless broker input failed')
    expect(recommendation).toContain('marked the stale broker runtime unavailable')
  })

  it('terminal classification wins even when the binding is also missing', () => {
    const { recommendation } = classifyBrokerInputFailure({
      label: 'headless',
      errorMessage: 'Cannot accept input in state: disposed',
      brokerBindingMissing: true,
      terminalInputFailure: true,
    })
    expect(recommendation).toContain('marked the stale broker runtime unavailable')
  })

  it('falls back to the log-inspection guidance for unclassified rejections', () => {
    const { headline, recommendation } = classifyBrokerInputFailure({
      label: 'headless',
      errorMessage: 'broker rejected invocation input',
      brokerBindingMissing: false,
      terminalInputFailure: false,
    })
    expect(headline).toBe('headless broker input failed: broker rejected invocation input')
    expect(recommendation).toContain('inspect hrc server logs')
  })
})
