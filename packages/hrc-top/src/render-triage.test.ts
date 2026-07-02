import { describe, expect, it } from 'bun:test'
import type { HrcTargetView } from 'hrc-core'

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
    sessionRef: 'agent:cody:project:hrc-runtime:task:T-1/lane:main',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-1',
    laneRef: 'main',
    state: 'bound',
    activeHostSessionId: 'hsid-1',
    runtime: {
      runtimeId: 'rt-1',
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

/** A mixed fleet: one row in each triage bucket + several idle. */
function fleet() {
  return buildReadModel(
    [
      // NEEDS YOU — awaiting input.
      target({
        sessionRef: 'agent:cody:project:hrc-runtime:task:T-input/lane:main',
        scopeRef: 'agent:cody:project:hrc-runtime:task:T-input',
        runtime: {
          runtimeId: 'rt-input',
          transport: 'tmux',
          status: 'awaiting_input',
          supportsLiteralSend: true,
          supportsCapture: true,
          operatorAttachable: true,
          lastActivityAt: '2026-07-02T11:00:00.000Z',
        },
      }),
      // WORKING — busy.
      target({
        sessionRef: 'agent:smokey:project:wrkq:task:T-busy/lane:main',
        scopeRef: 'agent:smokey:project:wrkq:task:T-busy',
        state: 'busy',
        runtime: {
          runtimeId: 'rt-busy',
          transport: 'tmux',
          status: 'ready',
          supportsLiteralSend: true,
          supportsCapture: true,
          operatorAttachable: true,
          lastActivityAt: '2026-07-02T12:04:00.000Z',
        },
      }),
      // RESUMABLE — dormant with continuation.
      target({
        sessionRef: 'agent:clod:project:agent-spaces:task:T-resume/lane:main',
        scopeRef: 'agent:clod:project:agent-spaces:task:T-resume',
        state: 'dormant',
        activeHostSessionId: undefined,
        runtime: undefined,
        continuation: { provider: 'openai', key: 'conv-resume' },
      }),
      // ATTENTION — broken.
      target({
        sessionRef: 'agent:larry:project:hrc-runtime:task:T-broken/lane:main',
        scopeRef: 'agent:larry:project:hrc-runtime:task:T-broken',
        state: 'broken',
        runtime: undefined,
      }),
      // IDLE — three ready-but-quiet sessions.
      target({
        sessionRef: 'agent:idle1:project:hrc-runtime:task:primary/lane:main',
        scopeRef: 'agent:idle1:project:hrc-runtime:task:primary',
        runtime: {
          runtimeId: 'rt-idle1',
          transport: 'tmux',
          status: 'ready',
          supportsLiteralSend: true,
          supportsCapture: true,
          operatorAttachable: true,
        },
      }),
      target({
        sessionRef: 'agent:idle2:project:hrc-runtime:task:primary/lane:main',
        scopeRef: 'agent:idle2:project:hrc-runtime:task:primary',
        runtime: {
          runtimeId: 'rt-idle2',
          transport: 'tmux',
          status: 'ready',
          supportsLiteralSend: true,
          supportsCapture: true,
          operatorAttachable: true,
        },
      }),
      target({
        sessionRef: 'agent:idle3:project:hrc-runtime:task:primary/lane:main',
        scopeRef: 'agent:idle3:project:hrc-runtime:task:primary',
        runtime: {
          runtimeId: 'rt-idle3',
          transport: 'tmux',
          status: 'ready',
          supportsLiteralSend: true,
          supportsCapture: true,
          operatorAttachable: true,
        },
      }),
    ],
    new Date('2026-07-02T12:05:00.000Z')
  )
}

describe('triage board default view', () => {
  it('groups actionable rows and collapses the idle tail', () => {
    const model = fleet()
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 30 })
    const screen = buildTopScreenModel({ model, navState, viewportHeight: 30, width: 100 })

    // Sections appear in urgency order; idle is NOT a section (collapsed).
    expect(screen.sections.map((section) => section.bucket)).toEqual([
      'needsYou',
      'working',
      'resumable',
      'attention',
    ])
    expect(screen.idleCollapsed).toEqual({ count: 3 })
    // Triage strip counts reflect the whole fleet.
    expect(screen.triageCounts).toEqual({
      needsYou: 1,
      working: 1,
      resumable: 1,
      attention: 1,
      idle: 3,
    })
    // Visible rows are the four actionable ones only.
    expect(screen.rows).toHaveLength(4)
    expect(screen.rows.every((row) => !row.idle)).toBe(true)
  })

  it('renders the triage strip and the collapsed idle line', () => {
    const model = fleet()
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 30 })
    const output = renderTopScreen({ model, navState, viewportHeight: 30, width: 100 })

    expect(output).toContain('◈ 1 need you')
    expect(output).toContain('● 1 busy')
    expect(output).toContain('◇ 1 resumable')
    expect(output).toContain('○ 3 idle')
    expect(output).toContain('NEEDS YOU')
    expect(output).toContain('3 idle · press . to show')
    // Idle handles are hidden until `.`.
    expect(output).not.toContain('idle1@hrc-runtime')
  })
})

describe('. faint-show-all view', () => {
  it('reveals idle rows and paints them at the faint tier while actionable rows glow', () => {
    const model = fleet()
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 30 })
    const screen = buildTopScreenModel({ model, navState, viewportHeight: 30, width: 100, showAll: true })

    // Idle becomes a rendered section now.
    expect(screen.sections.map((section) => section.bucket)).toEqual([
      'needsYou',
      'working',
      'resumable',
      'attention',
      'idle',
    ])
    expect(screen.idleCollapsed).toBeUndefined()

    const colored = renderTopScreen({
      model,
      navState,
      viewportHeight: 30,
      width: 100,
      showAll: true,
      color: true,
    })
    // Idle rows drop to the faint tier (#464f5d => 70;79;93).
    expect(colored).toContain('38;2;70;79;93')
    expect(colored).toContain('idle1@hrc-runtime')
    // The needs-you row still glows in amber (#f2c14e => 242;193;78).
    expect(colored).toContain('38;2;242;193;78')
    // Real ESC (0x1b) prefixes every SGR — guards against a literal-code regression.
    const ESC = String.fromCharCode(27)
    expect(colored).toContain(`${ESC}[38;2;242;193;78m`)
  })

  it('opens a continuous elevated background on the selected row with a real ESC prefix', () => {
    const model = fleet()
    const navState = createNavState({
      visibleRows: model.rows,
      viewportHeight: 30,
      selectedRowId: model.rows.find((row) => row.state === 'busy')?.id,
    })
    const colored = renderTopScreen({
      model,
      navState,
      viewportHeight: 30,
      width: 100,
      showAll: true,
      color: true,
    })
    const ESC = String.fromCharCode(27)
    // Selected-row bg (#152030 => 21;32;48), a real ESC, and the soft-reset that
    // preserves bg across cells.
    expect(colored).toContain(`${ESC}[48;2;21;32;48m`)
    expect(colored).toContain(`${ESC}[22;39m`)
  })
})

describe('focus lens', () => {
  it('discloses runtime, continuation, recommended action, and disabled reasons', () => {
    const model = fleet()
    // Select the resumable (dormant + continuation) row.
    const navState = createNavState({
      visibleRows: model.rows,
      viewportHeight: 30,
      selectedRowId: model.rows.find((row) => row.state === 'dormant')?.id,
    })
    const output = renderTopScreen({
      model,
      navState,
      viewportHeight: 30,
      width: 100,
      focusMode: true,
      showAll: true,
    })

    expect(output).toContain('FOCUS')
    expect(output).toContain('clod@agent-spaces:T-resume')
    expect(output).toContain('RECOMMENDED')
    expect(output).toContain('resume')
    expect(output).toContain('openai') // continuation provider
    expect(output).toContain('conv-resume') // continuation key
    expect(output).toContain('$ hrc resume') // command preview
    expect(output).toContain('no live operator-attachable runtime exists') // disabled attach reason
    expect(output).toContain('q return')
  })

  it('stays useful for a broken target with no available action', () => {
    const model = fleet()
    const navState = createNavState({
      visibleRows: model.rows,
      viewportHeight: 30,
      selectedRowId: model.rows.find((row) => row.state === 'broken')?.id,
    })
    const output = renderTopScreen({
      model,
      navState,
      viewportHeight: 30,
      width: 100,
      focusMode: true,
      showAll: true,
    })

    expect(output).toContain('FOCUS')
    expect(output).toContain('larry@hrc-runtime:T-broken')
    expect(output).toContain('broken')
    expect(output).toContain('q return')
  })
})
