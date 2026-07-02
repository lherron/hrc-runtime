import { describe, expect, it } from 'bun:test'
import type { HrcTargetView } from 'hrc-core'

import { runHrcTop } from './index.js'
import { createNavState } from './nav-state.js'
import { buildReadModel } from './read-model.js'
import { buildTopScreenModel, renderTopScreen } from './render.js'

const capabilities: HrcTargetView['capabilities'] = {
  state: 'bound',
  modesSupported: ['headless'],
  defaultMode: 'headless',
  dmReady: true,
  sendReady: true,
  peekReady: true,
}

function target(overrides: Partial<HrcTargetView> = {}): HrcTargetView {
  return {
    sessionRef: 'agent:cody:project:hrc-runtime:task:T-05405/lane:main',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-05405',
    laneRef: 'main',
    state: 'bound',
    activeHostSessionId: 'hsid-render-1',
    runtime: {
      runtimeId: 'rt-render-1',
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

describe('hrc-top renderer', () => {
  it('renders the MVP screen from a pure view model', () => {
    const model = buildReadModel(
      [
        target(),
        target({
          sessionRef: 'agent:clod:project:agent-spaces:task:primary/lane:main',
          scopeRef: 'agent:clod:project:agent-spaces:task:primary',
          state: 'dormant',
          runtime: undefined,
          continuation: { provider: 'openai', key: 'conv-render-2' },
        }),
      ],
      new Date('2026-07-02T12:05:00.000Z')
    )
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 16 })

    // showAll reveals the idle tail so both rows render (color off for legible
    // snapshot assertions).
    const output = renderTopScreen({
      model,
      navState,
      viewportHeight: 16,
      width: 90,
      filterText: '',
      showAll: true,
    })

    // Triage strip replaces the "healthy N live" header.
    expect(output).toContain('HRC TOP')
    expect(output).toContain('need you')
    expect(output).toContain('resumable')
    expect(output).toContain('idle')
    // Urgency-grouped sections.
    expect(output).toContain('RESUMABLE')
    expect(output).toContain('IDLE')
    // Rows: state on the state column, action on the action column.
    expect(output).toContain('cody@hrc-runtime:T-05405')
    expect(output).toContain('clod@agent-spaces:primary')
    expect(output).toContain('ready')
    expect(output).toContain('dormant')
    expect(output).toContain('attach')
    expect(output).toContain('resume')
    // Footer + key hints.
    expect(output).toContain('filter: none')
    expect(output).toContain('j/k move')
    expect(output).toContain('q quit')
  })

  it('collapses the idle tail in the default view', () => {
    const model = buildReadModel(
      [
        target(),
        target({
          sessionRef: 'agent:clod:project:agent-spaces:task:primary/lane:main',
          scopeRef: 'agent:clod:project:agent-spaces:task:primary',
          state: 'dormant',
          runtime: undefined,
          continuation: { provider: 'openai', key: 'conv-render-2' },
        }),
      ],
      new Date('2026-07-02T12:05:00.000Z')
    )
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 16 })

    // Default view (no showAll): the ready row (cody) is idle and collapses.
    const output = renderTopScreen({
      model,
      navState,
      viewportHeight: 16,
      width: 90,
      filterText: '',
    })

    expect(output).toContain('1 idle · press . to show')
    expect(output).not.toContain('cody@hrc-runtime:T-05405')
    // The resumable row still glows out of the collapsed sea.
    expect(output).toContain('clod@agent-spaces:primary')
  })

  it('does not fabricate a last-activity value when the read-model lacks one', () => {
    const model = buildReadModel(
      [
        target({
          sessionRef: 'agent:clod:project:agent-spaces:task:primary/lane:main',
          scopeRef: 'agent:clod:project:agent-spaces:task:primary',
          state: 'dormant',
          runtime: undefined,
          continuation: { provider: 'openai', key: 'conv-render-3' },
        }),
      ],
      new Date('2026-07-02T12:05:00.000Z')
    )
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 16 })
    const output = renderTopScreen({
      model,
      navState,
      viewportHeight: 16,
      width: 90,
      filterText: '',
    })

    // No runtime.lastActivityAt → last renders BLANK, never "unknown".
    expect(output).not.toContain('unknown')
  })

  it('projects focus detail without executing commands', () => {
    const model = buildReadModel([target()], new Date('2026-07-02T12:05:00.000Z'))
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 16 })
    const screen = buildTopScreenModel({
      model,
      navState,
      viewportHeight: 16,
      width: 90,
      focusMode: true,
      showAll: true,
    })

    expect(screen.focus).toMatchObject({
      handle: 'cody@hrc-runtime:T-05405',
      sessionRef: 'agent:cody:project:hrc-runtime:task:T-05405/lane:main',
      lane: 'main',
      hostSessionId: 'hsid-render-1',
      latestRuntimeId: 'rt-render-1',
      commandPreview: ['hrc', 'attach', 'rt-render-1'],
    })
  })

  it('renders command mode entry when active', () => {
    const model = buildReadModel([target()], new Date('2026-07-02T12:05:00.000Z'))
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 16 })

    const output = renderTopScreen({
      model,
      navState,
      viewportHeight: 16,
      width: 90,
      commandMode: true,
      commandText: 'filter cody',
    })

    expect(output).toContain(':filter cody█')
  })

  it('uses only listTargets in the non-interactive launch path', async () => {
    const calls: string[] = []
    const output = new MemoryOutput()
    const client = {
      async listTargets(): Promise<HrcTargetView[]> {
        calls.push('listTargets')
        return [target()]
      },
      async attach(): Promise<never> {
        throw new Error('attach must not be called')
      },
      async resume(): Promise<never> {
        throw new Error('resume must not be called')
      },
      async run(): Promise<never> {
        throw new Error('run must not be called')
      },
    }

    await runHrcTop({ client, output })

    expect(calls).toEqual(['listTargets'])
    expect(output.text).toContain('HRC TOP')
    expect(output.text).toContain('cody@hrc-runtime:T-05405')
  })
})

class MemoryOutput {
  readonly isTTY = false
  readonly chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  get text(): string {
    return this.chunks.join('')
  }
}
