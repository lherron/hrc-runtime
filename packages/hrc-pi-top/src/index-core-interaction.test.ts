import { describe, expect, it } from 'bun:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { HrcTargetView } from 'hrc-core'

import {
  createApp,
  createMessageApp,
  createRestoreHarness,
  deliverRestoreInput,
  loadSpawnRestoreCoordinatorFactory,
  target,
} from './__tests__/pi-top.fixture.js'
describe('hrc-pi-top app', () => {
  it('restores a spawned action through the Pi lifecycle once before accepting input', async () => {
    const createCoordinator = await loadSpawnRestoreCoordinatorFactory()
    if (!createCoordinator) return
    const { calls, coordinator } = createRestoreHarness(createCoordinator)

    // T-05464 red bar: spawned attach/resume/run must stop the running TUI,
    // install restore filtering before restart, and redraw through Pi exactly
    // once for each spawn attempt whose beforeSpawn hook completed.
    coordinator.beforeSpawn()
    coordinator.beforeSpawn()
    expect(coordinator.isSuspended()).toBe(true)
    expect(calls).toEqual(['tui.stop'])

    coordinator.afterSpawn()
    coordinator.afterSpawn()

    expect(coordinator.isSuspended()).toBe(false)
    expect(calls).toEqual([
      'tui.stop',
      'tui.addInputListener',
      'tui.start',
      'app.invalidate',
      'tui.requestRender:true',
    ])

    coordinator.beforeSpawn()
    coordinator.afterSpawn()

    expect(calls.filter((call) => call === 'tui.addInputListener')).toHaveLength(2)
    expect(calls.filter((call) => call === 'tui.start')).toHaveLength(2)
    expect(calls.filter((call) => call === 'tui.requestRender:true')).toHaveLength(2)
  })

  it('filters terminal reports during restore while forwarding immediate printable quit', async () => {
    const createCoordinator = await loadSpawnRestoreCoordinatorFactory()
    if (!createCoordinator) return
    const harness = createRestoreHarness(createCoordinator)
    harness.coordinator.beforeSpawn()
    harness.coordinator.afterSpawn()

    const terminalReports = [
      '\x1b[?1;2c', // DA with action-looking digit bytes.
      '\x1b[>41;400;0c', // secondary DA.
      '\x1b[12;34R', // cursor position report containing R.
      '\x1b[I',
      '\x1b[O',
      '\x1bOP',
      '\x1b]10;rgb:aa/bb/cc\x07', // OSC reply.
      '\x1b[8;24;80t', // terminal cell-size report.
      '\x1b[200~arRcq\x1b[201~', // bracketed-paste wrapper with only action-looking bytes.
      '\x1b[M ar', // legacy mouse packet containing attach/resume-looking bytes.
    ]

    for (const report of terminalReports) deliverRestoreInput(harness, report)

    expect(harness.forwardedInput).toEqual([])

    deliverRestoreInput(harness, 'q')

    expect(harness.forwardedInput).toEqual(['q'])
    expect(harness.closed).toBe(true)
    expect(harness.calls).toContain('restoreListener.dispose')
  })

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

  it('shows message affordances only when the selected row has concrete message context', () => {
    const noContext = createMessageApp({ includeMessage: false }).app
    noContext.handleInput('\r')
    const noContextOutput = noContext.render(120).join('\n')

    // T-05462 red bar: absent message context must not create misleading
    // preview/show/reply copy in the focus surface.
    expect(noContextOutput).not.toContain('message preview')
    expect(noContextOutput).not.toContain('message show')
    expect(noContextOutput).not.toContain('message reply')

    const withContext = createMessageApp({ includeMessage: true }).app
    withContext.handleInput('\r')
    const withContextOutput = withContext.render(120).join('\n')

    expect(withContextOutput).toContain('p message preview')
    expect(withContextOutput).toContain('s message show')
    expect(withContextOutput).toContain('y message reply')
  })

  it('opens Pi-native message preview read-only and delegates show/reply through hrcchat', async () => {
    const { app, commands } = createMessageApp({ includeMessage: true })

    app.handleInput('p')
    await app.whenIdle()

    const previewOutput = app.render(120).join('\n')
    expect(previewOutput).toContain('MESSAGE PREVIEW')
    expect(previewOutput).toContain('msg-pi-top-1')
    expect(previewOutput).toContain('seq 73')
    expect(previewOutput).toContain('confirm the target can reply')
    expect(commands).toEqual([])

    app.handleInput('q')
    app.handleInput('s')
    await app.whenIdle()
    app.handleInput('y')
    await app.whenIdle()

    expect(commands).toEqual([
      ['hrcchat', 'show', 'msg-pi-top-1'],
      ['hrcchat', 'dm', 'cody@hrc-runtime:T-05449', '--reply-to', 'msg-pi-top-1', '-'],
    ])
  })
})
