import { describe, expect, it } from 'bun:test'

import {
  type SelectedExecutionHosting,
  hostingAllocationKind,
  validateSelectedExecutionHosting,
} from '../broker/selected-execution.js'

const brokerProcessHeadless: SelectedExecutionHosting = {
  executionTransport: 'jsonrpc-stdio',
  processExecution: 'broker-process',
  terminalRequired: false,
}

describe('selected execution hosting', () => {
  it('allocates only the producer-declared terminal surface', () => {
    expect(hostingAllocationKind(brokerProcessHeadless)).toBe('headless-substrate')
    expect(
      hostingAllocationKind({
        executionTransport: 'pty',
        processExecution: 'broker-process',
        terminalRequired: true,
        terminalHost: 'tmux',
      })
    ).toBe('terminal-surface')
  })

  it('refuses an extra, missing, or unsupported terminal declaration before allocation', () => {
    expect(
      validateSelectedExecutionHosting({
        ...brokerProcessHeadless,
        terminalHost: 'tmux',
      })
    ).toEqual({ ok: false, code: 'terminal-host-without-requirement' })
    expect(
      validateSelectedExecutionHosting({
        executionTransport: 'pty',
        processExecution: 'broker-process',
        terminalRequired: true,
      })
    ).toEqual({ ok: false, code: 'terminal-host-required' })
    expect(
      validateSelectedExecutionHosting({
        executionTransport: 'native-worker',
        processExecution: 'native-worker',
        terminalRequired: true,
        terminalHost: 'screen',
      } as SelectedExecutionHosting)
    ).toEqual({ ok: false, code: 'terminal-host-unsupported' })
  })

  it('refuses unsupported process/transport pairs rather than deriving a driver route', () => {
    expect(
      validateSelectedExecutionHosting({
        executionTransport: 'jsonrpc-stdio',
        processExecution: 'native-worker',
        terminalRequired: false,
      })
    ).toEqual({ ok: false, code: 'transport-process-mismatch' })
  })
})
