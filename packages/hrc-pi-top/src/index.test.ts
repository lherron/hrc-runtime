import { describe, expect, it } from 'bun:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { HrcTargetView } from 'hrc-core'
import { type HrcTopActionExecutor, buildReadModel } from 'hrc-top'

import { HrcPiTopApp } from './index.js'

const capabilities: HrcTargetView['capabilities'] = {
  state: 'bound',
  modesSupported: ['tmux'],
  defaultMode: 'tmux',
  dmReady: true,
  sendReady: true,
  peekReady: true,
}

function target(overrides: Partial<HrcTargetView> = {}): HrcTargetView {
  return {
    sessionRef: 'agent:cody:project:hrc-runtime:task:T-05449/lane:main',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-05449',
    laneRef: 'main',
    state: 'bound',
    activeHostSessionId: 'hsid-pi-top-1',
    runtime: {
      runtimeId: 'rt-pi-top-1',
      transport: 'tmux',
      status: 'ready',
      supportsLiteralSend: true,
      supportsCapture: true,
      operatorAttachable: true,
      lastActivityAt: '2026-07-02T12:00:00.000Z',
    },
    capabilities,
    ...overrides,
  }
}

function createApp(input: { targets?: HrcTargetView[] | undefined; onQuit?: () => void } = {}): {
  app: HrcPiTopApp
  renders: () => number
  commands: string[][]
} {
  const targets = input.targets ?? [
    target({
      sessionRef: 'agent:clod:project:agent-spaces:task:primary/lane:main',
      scopeRef: 'agent:clod:project:agent-spaces:task:primary',
      state: 'dormant',
      runtime: undefined,
      continuation: { provider: 'openai', key: 'conv-pi-top-1' },
    }),
    target(),
  ]
  let renderCount = 0
  const commands: string[][] = []
  const executor: HrcTopActionExecutor = {
    async attachRuntime() {
      return { argv: ['true'] }
    },
    async spawnAttachDescriptor() {
      return { status: 'executed' }
    },
    async runCommand(argv) {
      commands.push(argv)
      return { status: 'executed' }
    },
  }
  const app = new HrcPiTopApp({
    client: {
      async listTargets() {
        return targets
      },
    },
    executor,
    initialModel: buildReadModel(targets, new Date('2026-07-02T12:05:00.000Z')),
    scope: { projectId: 'hrc-runtime' },
    viewportHeight: () => 18,
    requestRender: () => {
      renderCount += 1
    },
    onQuit: input.onQuit ?? (() => undefined),
  })
  return { app, renders: () => renderCount, commands }
}

describe('hrc-pi-top app', () => {
  it('renders the existing top screen model through a Pi component', () => {
    const { app } = createApp()
    const output = app.render(96).join('\n')

    expect(output).toContain('HRC TOP')
    expect(output).toContain('clod@agent-spaces:primary')
    expect(output).toContain('1 idle')
  })

  it('uses Pi Input for slash filtering while preserving top filter semantics', () => {
    const { app } = createApp()

    for (const key of ['/', 'c', 'o', 'd', 'y', '\r']) app.handleInput(key)

    const snapshot = app.snapshot()
    expect(snapshot.filterText).toBe('cody')
    expect(snapshot.filterMode).toBe(false)
    const output = app.render(96).join('\n')
    expect(output).toContain('cody@hrc-runtime:T-05449')
    expect(output).not.toContain('clod@agent-spaces:primary')
  })

  it('accepts single-character bracketed paste as normal-mode keypresses for ghostmux', () => {
    const { app } = createApp()

    app.handleInput('\x1b[200~/\x1b[201~')

    expect(app.snapshot().filterMode).toBe(true)
  })

  it('uses Pi Input for command mode and delegates command semantics', async () => {
    const { app } = createApp()

    for (const key of [':', 'f', 'i', 'l', 't', 'e', 'r', ' ', 'c', 'o', 'd', 'y', '\r']) {
      app.handleInput(key)
    }
    await app.whenIdle()

    expect(app.snapshot().filterText).toBe('cody')
    expect(app.render(96).join('\n')).toContain('cody@hrc-runtime:T-05449')
  })

  it('maps q to the caller-provided quit handler', () => {
    let closed = false
    const { app } = createApp({
      onQuit: () => {
        closed = true
      },
    })

    app.handleInput('q')

    expect(closed).toBe(true)
  })

  it('truncates rendered lines to the Pi TUI width contract', () => {
    const { app } = createApp()
    const width = 48

    for (const line of app.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width)
    }
  })
})
