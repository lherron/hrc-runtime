import { describe, expect, test } from 'bun:test'

import type {
  EnsureWindowRequest,
  EnsureWindowResponse,
  SendWindowLiteralInputRequest,
} from '../index.js'

describe('windows companion contracts', () => {
  test('exports a sessionRef-keyed ensure request for command windows', () => {
    const request: EnsureWindowRequest = {
      sessionRef: 'agent:larry:project:agent-spaces:task:T-01082/lane:main',
      command: {
        launchMode: 'exec',
        argv: ['/bin/cat'],
      },
      restartStyle: 'reuse_pty',
    }

    expect(request.sessionRef).toContain('/lane:')
    expect(request.command.argv).toEqual(['/bin/cat'])
    expect(request.restartStyle).toBe('reuse_pty')
  })

  test('exports runtime-scoped literal input requests and window ensure responses', () => {
    const input: SendWindowLiteralInputRequest = {
      runtimeId: 'rt-window-001',
      text: 'hello window',
      enter: true,
    }
    const response: EnsureWindowResponse = {
      hostSessionId: 'hsid-window-001',
      generation: 2,
      runtimeId: 'rt-window-001',
      transport: 'tmux',
      status: 'ready',
      supportsInFlightInput: false,
      tmux: {
        sessionId: '$1',
        windowId: '@1',
        paneId: '%1',
      },
    }

    expect(input.runtimeId).toBe('rt-window-001')
    expect(input.enter).toBe(true)
    expect(response.generation).toBe(2)
    expect(response.tmux.paneId).toBe('%1')
  })
})
