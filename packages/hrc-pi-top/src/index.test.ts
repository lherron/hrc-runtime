import { describe, expect, it } from 'bun:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { HrcLifecycleEvent, HrcTargetView } from 'hrc-core'
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
    generation: 7,
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
  executorCalls: string[]
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
  const executorCalls: string[] = []
  const executor: HrcTopActionExecutor = {
    async attachRuntime() {
      executorCalls.push('attachRuntime')
      return { argv: ['true'] }
    },
    async spawnAttachDescriptor() {
      executorCalls.push('spawnAttachDescriptor')
      return { status: 'executed' }
    },
    async runCommand(argv) {
      executorCalls.push('runCommand')
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
  return { app, renders: () => renderCount, commands, executorCalls }
}

function lifecycleEvent(overrides: Partial<HrcLifecycleEvent> = {}): HrcLifecycleEvent {
  return {
    hrcSeq: 41,
    streamSeq: 41,
    ts: '2026-07-02T12:04:30.000Z',
    hostSessionId: 'hsid-pi-top-1',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-05449',
    laneRef: 'main',
    generation: 7,
    runtimeId: 'rt-pi-top-1',
    runId: 'run-pi-top-1',
    category: 'turn',
    eventKind: 'turn.started',
    transport: 'tmux',
    replayed: true,
    payload: { promptPreview: 'inspect the queue state' },
    ...overrides,
  }
}

function createTailApp(input: {
  events: HrcLifecycleEvent[]
  target?: HrcTargetView | undefined
}): {
  app: HrcPiTopApp
  watchCalls: unknown[]
  commands: string[][]
} {
  const selected = input.target ?? target({ state: 'busy' })
  const watchCalls: unknown[] = []
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
  const client = {
    async listTargets() {
      return [selected]
    },
    async *watch(options: unknown) {
      watchCalls.push(options)
      for (const event of input.events) yield event
    },
  }

  const app = new HrcPiTopApp({
    client,
    executor,
    initialModel: buildReadModel([selected], new Date('2026-07-02T12:05:00.000Z')),
    scope: { projectId: 'hrc-runtime' },
    viewportHeight: () => 18,
    requestRender: () => undefined,
    onQuit: () => undefined,
  })

  return { app, watchCalls, commands }
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

  it('opens a Pi-native help overlay with normal, filter, command, and action semantics', () => {
    const { app } = createApp()

    // T-05458 red bar: `?` should be a modal Pi overlay, not one more footer
    // hint line delegated to the text renderer.
    app.handleInput('?')

    const output = app.render(96).join('\n')
    expect(output).toContain('HELP')
    expect(output).toContain('NORMAL MODE')
    expect(output).toContain('gg')
    expect(output).toContain('m<char>')
    expect(output).toContain('FILTER MODE')
    expect(output).toContain('Enter')
    expect(output).toContain('COMMAND MODE')
    expect(output).toContain(':filter')
    expect(output).toContain(':tail')
    expect(output).toContain('ACTIONS')
    expect(output).toContain('a attach')
    expect(output).toContain('r resume')
    expect(output).toContain('R run')
    expect(output).toContain('e tail')
    expect(output).toContain('c capture')
    expect(output).not.toContain('gg/G top/bottom · Ctrl-d/u half-page')
  })

  it('opens an explicit run confirmation overlay for a continuation-bearing target', async () => {
    const { app, commands } = createApp()

    // T-05459 red bar: Pi must replace the hidden hrc-top double-press state
    // with an explicit overlay that explains the fresh-run/resume tradeoff and
    // displays the canonical handle that the confirmed command will run.
    app.handleInput('R')
    await app.whenIdle()

    const output = app.render(96).join('\n')
    expect(output).toContain('RUN CONFIRMATION')
    expect(output).toContain('clod@agent-spaces:primary')
    expect(output).toContain('hrc run')
    expect(output).toContain('bypasses resume semantics')
    expect(output).toContain('R or Enter')
    expect(output).toContain('Esc or q')
    expect(commands).toEqual([])
  })

  it('cancels the run confirmation overlay without executing a run', async () => {
    for (const cancelKey of ['\x1b', 'q']) {
      let closed = false
      const { app, commands } = createApp({
        onQuit: () => {
          closed = true
        },
      })

      app.handleInput('R')
      await app.whenIdle()
      expect(app.render(96).join('\n')).toContain('RUN CONFIRMATION')

      app.handleInput(cancelKey)
      await app.whenIdle()

      const output = app.render(96).join('\n')
      expect(closed).toBe(false)
      expect(commands).toEqual([])
      expect(output).toContain('HRC TOP')
      expect(output).not.toContain('RUN CONFIRMATION')
    }
  })

  it('keeps navigation keys from changing the confirmation target before confirm', async () => {
    const { app, commands } = createApp()

    // A matching-looking second row is in scope as the negative guard: while
    // confirmation is open, `j` must not move selection and let R run the
    // wrong target through the stale confirmation state.
    app.handleInput('.')
    app.handleInput('R')
    await app.whenIdle()
    const selectedBeforeOverlay = app.snapshot().selectedRowId

    app.handleInput('j')
    app.handleInput('R')
    await app.whenIdle()

    expect(app.snapshot().selectedRowId).toBe(selectedBeforeOverlay)
    expect(commands).toEqual([['hrc', 'run', 'clod@agent-spaces:primary']])
  })

  it('dismisses the help overlay with ?, Esc, or q without quitting or losing board state', () => {
    for (const dismissKey of ['?', '\x1b', 'q']) {
      let closed = false
      const { app } = createApp({
        onQuit: () => {
          closed = true
        },
      })

      for (const key of ['/', 'c', 'o', 'd', 'y', '\r']) app.handleInput(key)
      const selectedBeforeHelp = app.snapshot().selectedRowId
      app.handleInput('?')

      expect(app.render(96).join('\n')).toContain('HELP')

      app.handleInput(dismissKey)

      const snapshot = app.snapshot()
      const output = app.render(96).join('\n')
      expect(closed).toBe(false)
      expect(snapshot.filterText).toBe('cody')
      expect(snapshot.selectedRowId).toBe(selectedBeforeHelp)
      expect(output).toContain('HRC TOP')
      expect(output).toContain('cody@hrc-runtime:T-05449')
      expect(output).not.toContain('HELP')
      expect(output).not.toContain('clod@agent-spaces:primary')
    }
  })

  it('truncates rendered lines to the Pi TUI width contract', () => {
    const { app } = createApp()
    const width = 48

    for (const line of app.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  it('renders focus action affordances from the same availability facts as dispatch', () => {
    const focusOutput = (focusedTarget: HrcTargetView): string => {
      const { app } = createApp({ targets: [focusedTarget] })
      app.handleInput('.')
      app.handleInput('\r')
      return app.render(120).join('\n')
    }
    const expectActionEnabled = (output: string, action: string): void => {
      const enabledLine = output.split('\n').find((line) => line.includes(action))
      expect(enabledLine).toBeDefined()
      expect(enabledLine).not.toContain('unavailable')
    }
    const expectActionDisabled = (output: string, action: string, reason: string): void => {
      expect(output).toContain(reason)
      for (const line of output.split('\n')) {
        if (line.includes(action)) expect(line).toContain(reason)
      }
    }

    // Regression: a row can have a captured continuation without any runtime
    // capture surface. The focus lens must not advertise `c capture` as enabled.
    const noRuntimeWithContinuation = focusOutput(
      target({
        state: 'bound',
        runtime: undefined,
        continuation: { provider: 'openai', key: 'conv-pi-top-captured' },
      })
    )
    expectActionDisabled(
      noRuntimeWithContinuation,
      'c capture',
      'Capture is unavailable: no runtime capture surface exists.'
    )
    expectActionEnabled(noRuntimeWithContinuation, 'r resume')
    expectActionDisabled(
      noRuntimeWithContinuation,
      'R run',
      'Run is unavailable: policy does not allow a fresh launch for this row.'
    )

    const noContinuation = focusOutput(
      target({
        state: 'dormant',
        runtime: undefined,
        continuation: undefined,
      })
    )
    expectActionDisabled(
      noContinuation,
      'r resume',
      'Resume is unavailable: no captured, non-invalidated continuation exists.'
    )
    expectActionDisabled(
      noContinuation,
      'c capture',
      'Capture is unavailable: no runtime capture surface exists.'
    )

    const liveAttachableWithoutCapture = focusOutput(
      target({
        runtime: {
          runtimeId: 'rt-pi-top-no-capture',
          transport: 'tmux',
          status: 'ready',
          supportsLiteralSend: true,
          supportsCapture: false,
          operatorAttachable: true,
          lastActivityAt: '2026-07-02T12:00:00.000Z',
        },
        continuation: undefined,
      })
    )
    expectActionEnabled(liveAttachableWithoutCapture, 'a attach')
    expectActionDisabled(
      liveAttachableWithoutCapture,
      'c capture',
      'Capture is unavailable: no runtime capture surface exists.'
    )

    const captureSupported = focusOutput(target({ continuation: undefined }))
    expectActionEnabled(captureSupported, 'a attach')
    expectActionEnabled(captureSupported, 'c capture')
  })

  it('opens inspect from i and :inspect without reusing focus or mutating runtime state', async () => {
    for (const openInspect of [
      (app: HrcPiTopApp) => app.handleInput('i'),
      (app: HrcPiTopApp) => {
        for (const key of [':', 'i', 'n', 's', 'p', 'e', 'c', 't', '\r']) app.handleInput(key)
      },
    ]) {
      let closed = false
      const { app, commands, executorCalls } = createApp({
        targets: [
          target({
            state: 'busy',
            activeHostSessionId: 'hsid-pi-inspect-1',
            generation: 12,
            runtime: {
              runtimeId: 'rt-pi-inspect-1',
              transport: 'tmux',
              status: 'busy',
              supportsLiteralSend: true,
              supportsCapture: false,
              operatorAttachable: true,
              activeRunId: 'run-pi-inspect-1',
              lastActivityAt: '2026-07-02T12:00:00.000Z',
            },
            continuation: { provider: 'anthropic', key: 'conv-pi-inspect-1' },
            capabilities: {
              state: 'bound',
              modesSupported: ['tmux', 'headless'],
              defaultMode: 'tmux',
              dmReady: true,
              sendReady: true,
              peekReady: false,
            },
          }),
        ],
        onQuit: () => {
          closed = true
        },
      })

      // T-05457 red bar: inspect is its own read-only diagnostic surface. It
      // must not fall through to the Enter/focus lens or any mutating executor.
      openInspect(app)
      await app.whenIdle()

      const inspectOutput = app.render(120).join('\n')
      expect(inspectOutput).toContain('INSPECT')
      expect(inspectOutput).not.toContain('FOCUS')
      expect(inspectOutput).toContain('cody@hrc-runtime:T-05449')
      expect(inspectOutput).toContain('hsid-pi-inspect-1')
      expect(inspectOutput).toContain('rt-pi-inspect-1')
      expect(inspectOutput).toContain('busy')
      expect(inspectOutput).toContain('tmux')
      expect(inspectOutput).toContain('anthropic')
      expect(inspectOutput).toContain('conv-pi-inspect-1')
      expect(inspectOutput).toContain('dmReady')
      expect(inspectOutput).toContain('peekReady')
      expect(commands).toEqual([])
      expect(executorCalls).toEqual([])

      app.handleInput('q')

      const boardOutput = app.render(120).join('\n')
      expect(closed).toBe(false)
      expect(boardOutput).toContain('HRC TOP')
      expect(boardOutput).not.toContain('INSPECT')

      app.handleInput('\r')

      const focusOutput = app.render(120).join('\n')
      expect(focusOutput).toContain('FOCUS')
      expect(focusOutput).not.toContain('INSPECT')
    }
  })

  it('opens a read-only event tail preview from e and returns to the board with q', async () => {
    const { app, watchCalls, commands } = createTailApp({
      events: [
        lifecycleEvent(),
        lifecycleEvent({
          hrcSeq: 42,
          streamSeq: 42,
          ts: '2026-07-02T12:04:40.000Z',
          category: 'runtime',
          eventKind: 'runtime.ready',
          payload: { status: 'ready' },
        }),
      ],
    })

    // T-05456 red bar: e must render a selected target event-tail panel, not
    // just a footer notice, and it must read existing monitor events without
    // spawning shell commands or mutating target state.
    app.handleInput('e')
    await app.whenIdle()

    const tailOutput = app.render(120).join('\n')
    expect(tailOutput).toContain('EVENT TAIL')
    expect(tailOutput).toContain('cody@hrc-runtime:T-05449')
    expect(tailOutput).toContain('turn.started')
    expect(tailOutput).toContain('runtime.ready')
    expect(tailOutput).not.toContain('Show the selected target event tail preview.')
    expect(commands).toEqual([])
    expect(watchCalls).toHaveLength(1)
    expect(watchCalls[0]).toMatchObject({
      follow: false,
      hostSessionId: 'hsid-pi-top-1',
      generation: 7,
    })

    app.handleInput('q')

    const boardOutput = app.render(120).join('\n')
    expect(boardOutput).toContain('HRC TOP')
    expect(boardOutput).not.toContain('EVENT TAIL')
  })

  it('gives :tail the same event-present semantics as e', async () => {
    const { app, commands } = createTailApp({
      events: [
        lifecycleEvent({
          eventKind: 'turn.completed',
          payload: { outcome: 'ok' },
        }),
      ],
    })

    for (const key of [':', 't', 'a', 'i', 'l', '\r']) app.handleInput(key)
    await app.whenIdle()

    const output = app.render(120).join('\n')
    expect(output).toContain('EVENT TAIL')
    expect(output).toContain('turn.completed')
    expect(output).not.toContain('Show the selected target event tail preview.')
    expect(commands).toEqual([])
  })

  it('renders an explicit non-fatal empty state when the selected target has no tail events', async () => {
    const { app, commands } = createTailApp({ events: [] })

    app.handleInput('e')
    await app.whenIdle()

    const output = app.render(120).join('\n')
    expect(output).toContain('EVENT TAIL')
    expect(output).toContain('No recent events')
    expect(output).toContain('cody@hrc-runtime:T-05449')
    expect(commands).toEqual([])
  })
})
