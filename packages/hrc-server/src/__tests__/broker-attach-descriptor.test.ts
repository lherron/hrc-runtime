import { describe, expect, it } from 'bun:test'
import { basename, isAbsolute } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'

import { attachRuntime } from '../runtime-io-handlers'
import { createTmuxManager } from '../tmux'

describe('broker tmux attach descriptors', () => {
  it('targets the operator TUI window and fences the TUI pane identity', async () => {
    const runtime = {
      runtimeId: 'rt-broker-attach',
      hostSessionId: 'hsid-broker-attach',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-01751',
      laneRef: 'main',
      generation: 3,
      transport: 'tmux',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'starting',
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      tmuxJson: {
        socketPath: '/tmp/hrc-btmux/codex-cli-tmux-rt-broker-attach.sock',
        sessionName: 'hrc-codex-cli-tmux-rt-broker-attach',
        windowName: 'tui',
        windowId: '@8',
        paneId: '%9',
        brokerDriver: 'codex-cli-tmux',
      },
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    } as HrcRuntimeSnapshot

    const response = attachRuntime.call(
      { tmux: createTmuxManager({ socketPath: '/tmp/unused-default.sock' }) } as never,
      runtime
    )
    const body = (await response.json()) as {
      argv: string[]
      bindingFence: { windowId?: string; paneId?: string }
    }

    expect(isAbsolute(body.argv[0] ?? '')).toBe(true)
    expect(basename(body.argv[0] ?? '')).toBe('tmux')
    expect(body.argv.slice(1)).toEqual([
      '-S',
      '/tmp/hrc-btmux/codex-cli-tmux-rt-broker-attach.sock',
      'attach-session',
      '-t',
      'hrc-codex-cli-tmux-rt-broker-attach:tui',
    ])
    expect(body.bindingFence.windowId).toBe('@8')
    expect(body.bindingFence.paneId).toBe('%9')
  })
})
