import { describe, expect, it } from 'bun:test'
import { type HrcTopActionExecutor, buildReadModel } from 'hrc-top'

import { HrcPiTopApp } from './index.js'

import {
  ambiguousTargets,
  createApp,
  createTailApp,
  lifecycleEvent,
  target,
} from './__tests__/pi-top.fixture.js'
describe('hrc-pi-top app', () => {
  it('opens an ambiguity resolver for attach inputs and cancels without executor calls', async () => {
    for (const openAttach of [
      (app: HrcPiTopApp) => app.handleInput('a'),
      (app: HrcPiTopApp) => app.handleInput('o'),
      (app: HrcPiTopApp) => {
        for (const key of [':', 'a', 't', 't', 'a', 'c', 'h', '\r']) app.handleInput(key)
      },
    ]) {
      const { app, executorCalls } = createApp({ targets: ambiguousTargets() })

      openAttach(app)
      await app.whenIdle()

      const output = app.render(120).join('\n')
      expect(output).toContain('ATTACH RESOLVER')
      expect(output).toContain('rt-ambiguity-newer')
      expect(output).toContain('rt-ambiguity-older')
      expect(executorCalls).toEqual([])

      app.handleInput('q')
      await app.whenIdle()

      expect(app.render(120).join('\n')).not.toContain('ATTACH RESOLVER')
      expect(executorCalls).toEqual([])
    }
  })

  it('attaches the explicitly selected second ambiguity candidate by runtime id', async () => {
    const { app, executorCalls, attachRuntimeIds } = createApp({ targets: ambiguousTargets() })

    app.handleInput('a')
    await app.whenIdle()
    app.handleInput('j')
    app.handleInput('\r')
    await app.whenIdle()

    expect(attachRuntimeIds).toEqual(['rt-ambiguity-older'])
    expect(executorCalls).toEqual(['attachRuntime', 'spawnAttachDescriptor'])
    expect(app.render(120).join('\n')).not.toContain('ATTACH RESOLVER')
  })

  it('opens inspect resolver from i and :inspect, then renders the selected concrete candidate', async () => {
    for (const openInspect of [
      (app: HrcPiTopApp) => app.handleInput('i'),
      (app: HrcPiTopApp) => {
        for (const key of [':', 'i', 'n', 's', 'p', 'e', 'c', 't', '\r']) app.handleInput(key)
      },
    ]) {
      const { app, executorCalls } = createApp({ targets: ambiguousTargets() })

      openInspect(app)
      await app.whenIdle()
      expect(app.render(120).join('\n')).toContain('INSPECT RESOLVER')

      app.handleInput('j')
      app.handleInput('\r')
      await app.whenIdle()

      const output = app.render(120).join('\n')
      expect(output).toContain('INSPECT')
      expect(output).toContain('rt-ambiguity-older')
      expect(output).toContain('hsid-ambiguity-older')
      expect(output).not.toContain('INSPECT RESOLVER')
      expect(executorCalls).toEqual([])
    }
  })

  it('rejects a stale ambiguity selection after refresh without attaching', async () => {
    let targets = ambiguousTargets()
    const commands: string[][] = []
    const attachRuntimeIds: string[] = []
    const executor: HrcTopActionExecutor = {
      async attachRuntime(runtimeId) {
        attachRuntimeIds.push(runtimeId)
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
      requestRender: () => undefined,
      onQuit: () => undefined,
    })

    app.handleInput('a')
    await app.whenIdle()
    expect(app.render(120).join('\n')).toContain('ATTACH RESOLVER')

    targets = [ambiguousTargets()[0]!]
    await app.refresh()
    await app.whenIdle()

    expect(attachRuntimeIds).toEqual([])
    expect(commands).toEqual([])
    expect(app.render(120).join('\n')).toContain('expired')
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
      fromSeq: 1,
      hostSessionId: 'hsid-pi-top-1',
      generation: 7,
    })

    app.handleInput('q')

    const boardOutput = app.render(120).join('\n')
    expect(boardOutput).toContain('HRC TOP')
    expect(boardOutput).not.toContain('EVENT TAIL')
  })

  it('holds the event-tail cursor between refresh ticks', async () => {
    const { app, watchCalls } = createTailApp({
      latestHrcSeq: 1_000,
      events: [
        lifecycleEvent({ hrcSeq: 951, streamSeq: 951 }),
        lifecycleEvent({ hrcSeq: 1_000, streamSeq: 1_000 }),
      ],
      refreshEvents: [lifecycleEvent({ hrcSeq: 1_001, streamSeq: 1_001 })],
    })

    app.handleInput('e')
    await app.whenIdle()
    await app.refresh()

    expect(watchCalls).toHaveLength(2)
    expect(watchCalls[0]).toMatchObject({ follow: false, fromSeq: 951 })
    expect(watchCalls[1]).toMatchObject({ follow: false, fromSeq: 1_001 })
  })

  it('keeps action failure detail out of the footer and opens a transient detail overlay', async () => {
    const detail = {
      message: 'hrc resume cody@hrc-runtime:T-05449 failed',
      argv: ['hrc', 'resume', 'cody@hrc-runtime:T-05449'],
      exitStatus: 37,
      stderrSummary:
        'resume refused because the captured continuation is stale and the runtime requires operator review before retrying',
      targetIdentity: {
        handle: 'cody@hrc-runtime:T-05449',
        sessionRef: 'agent:cody:project:hrc-runtime:task:T-05449/lane:main',
        scopeRef: 'agent:cody:project:hrc-runtime:task:T-05449',
        laneRef: 'main',
        hostSessionId: 'hsid-pi-top-1',
        generation: 7,
        runtimeId: 'rt-pi-top-1',
      },
    }
    const commands: string[][] = []
    const resumeTarget = target({
      continuation: { provider: 'openai', key: 'conv-pi-top-resume-detail' },
    })
    const executor: HrcTopActionExecutor = {
      async attachRuntime() {
        return { argv: ['true'] }
      },
      async spawnAttachDescriptor() {
        return { status: 'executed' }
      },
      async runCommand(argv) {
        commands.push(argv)
        return {
          status: 'disabled',
          reason: 'hrc resume cody@hrc-runtime:T-05449 failed',
          detail,
        } as Awaited<ReturnType<HrcTopActionExecutor['runCommand']>>
      },
    }
    const app = new HrcPiTopApp({
      client: {
        async listTargets() {
          return [resumeTarget]
        },
      },
      executor,
      initialModel: buildReadModel([resumeTarget], new Date('2026-07-02T12:05:00.000Z')),
      scope: { projectId: 'hrc-runtime' },
      viewportHeight: () => 18,
      requestRender: () => undefined,
      onQuit: () => undefined,
    })

    // T-05461 red bar: command-backed failures keep the footer concise and
    // expose argv/exit/stderr/target identity through a dismissible overlay.
    app.handleInput('.')
    app.handleInput('r')
    await app.whenIdle()

    const footerOutput = app.render(96).join('\n')
    expect(commands).toEqual([['hrc', 'resume', 'cody@hrc-runtime:T-05449']])
    expect(footerOutput).toContain('press ! for details')
    expect(footerOutput).not.toContain(detail.stderrSummary)

    const selectedBeforeOverlay = app.snapshot().selectedRowId
    for (const key of ['/', 'c', 'o', 'd', 'y', '\r']) app.handleInput(key)
    const filterTextBeforeDismiss = app.snapshot().filterText

    app.handleInput('!')

    const overlayOutput = app.render(120).join('\n')
    expect(overlayOutput).toContain('ACTION DETAIL')
    expect(overlayOutput).toContain('resume')
    expect(overlayOutput).toContain('disabled')
    expect(overlayOutput).toContain('hrc resume cody@hrc-runtime:T-05449')
    expect(overlayOutput).toContain('exit status: 37')
    expect(overlayOutput).toContain(detail.stderrSummary)
    expect(overlayOutput).toContain('sessionRef')
    expect(overlayOutput).toContain('agent:cody:project:hrc-runtime:task:T-05449/lane:main')
    expect(overlayOutput).toContain('runtimeId')
    expect(overlayOutput).toContain('rt-pi-top-1')

    app.handleInput('q')

    const dismissedOutput = app.render(120).join('\n')
    expect(app.snapshot().selectedRowId).toBe(selectedBeforeOverlay)
    expect(app.snapshot().filterText).toBe(filterTextBeforeDismiss)
    expect(commands).toEqual([['hrc', 'resume', 'cody@hrc-runtime:T-05449']])
    expect(dismissedOutput).toContain('HRC TOP')
    expect(dismissedOutput).not.toContain('ACTION DETAIL')
  })

  it('offers transient details for an intentionally disabled action without spawning commands', async () => {
    const noCaptureTarget = target({
      runtime: {
        ...target().runtime!,
        supportsCapture: false,
      },
    })
    const { app, commands } = createApp({ targets: [noCaptureTarget] })

    // Disabled policy actions have no argv/stderr, but they should still expose
    // the selected target identity and short reason behind the same detail key.
    app.handleInput('.')
    app.handleInput('c')
    await app.whenIdle()

    const footerOutput = app.render(96).join('\n')
    expect(commands).toEqual([])
    expect(footerOutput).toContain('Capture is unavailable: no runtime capture surface exists.')
    expect(footerOutput).toContain('press ! for details')

    app.handleInput('!')

    const overlayOutput = app.render(120).join('\n')
    expect(overlayOutput).toContain('ACTION DETAIL')
    expect(overlayOutput).toContain('capture')
    expect(overlayOutput).toContain('disabled')
    expect(overlayOutput).toContain('cody@hrc-runtime:T-05449')
    expect(overlayOutput).toContain('rt-pi-top-1')
    expect(overlayOutput).not.toContain('argv')
    expect(overlayOutput).not.toContain('stderr')
    expect(commands).toEqual([])
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
