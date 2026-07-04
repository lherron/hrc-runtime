import { describe, expect, it } from 'bun:test'
import type { HrcTargetView } from 'hrc-core'

import { createNavState } from './nav-state.js'
import { buildReadModel } from './read-model.js'
import { buildTopScreenModel } from './render.js'

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
    sessionRef: 'agent:cody:project:hrc-runtime:task:T-05460/lane:main',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-05460',
    laneRef: 'main',
    state: 'bound',
    activeHostSessionId: 'hsid-ambiguity-1',
    generation: 1,
    runtime: {
      runtimeId: 'rt-ambiguity-1',
      transport: 'tmux',
      status: 'ready',
      supportsLiteralSend: true,
      supportsCapture: true,
      operatorAttachable: true,
      lastActivityAt: '2026-07-04T18:05:00.000Z',
    },
    capabilities,
    ...overrides,
  }
}

describe('hrc-top shared ambiguity model', () => {
  it('marks duplicate-handle concrete runtimes ambiguous and feeds focus candidates without guessing', () => {
    const model = buildReadModel(
      [
        target({
          activeHostSessionId: 'hsid-ambiguity-newer',
          generation: 3,
          runtime: {
            ...target().runtime!,
            runtimeId: 'rt-ambiguity-newer',
            status: 'busy',
            lastActivityAt: '2026-07-04T18:07:00.000Z',
          },
        }),
        target({
          activeHostSessionId: 'hsid-ambiguity-older',
          generation: 2,
          runtime: {
            ...target().runtime!,
            runtimeId: 'rt-ambiguity-older',
            lastActivityAt: '2026-07-04T18:06:00.000Z',
          },
        }),
        target({
          sessionRef: 'agent:cody:project:hrc-runtime:task:T-05460/lane:side',
          scopeRef: 'agent:cody:project:hrc-runtime:task:T-05460',
          laneRef: 'side',
          activeHostSessionId: 'hsid-non-ambiguous-side',
          generation: 1,
          runtime: {
            ...target().runtime!,
            runtimeId: 'rt-non-ambiguous-side',
          },
        }),
      ],
      new Date('2026-07-04T18:08:00.000Z')
    )
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 16 })

    // T-05460 red bar: ambiguity is derived by the shared hrc-top model from
    // producer-owned concrete rows with the same handle. The side-lane row is a
    // negative guard: matching agent/project/task outside the handle boundary
    // must not be marked ambiguous or folded into the candidate set.
    const screen = buildTopScreenModel({
      model,
      navState,
      viewportHeight: 16,
      width: 120,
      showAll: true,
      focusMode: true,
    })

    const mainRows = screen.rows.filter((row) => row.handle === 'cody@hrc-runtime:T-05460')
    expect(mainRows).toHaveLength(2)
    expect(mainRows.map((row) => row.displayState)).toEqual(['ambiguous', 'ambiguous'])
    expect(mainRows.map((row) => row.action.kind)).toEqual(['focus', 'focus'])

    expect(screen.focus?.handle).toBe('cody@hrc-runtime:T-05460')
    expect(screen.focus?.commandPreview).toBeUndefined()
    expect(screen.focus?.ambiguityCandidates).toEqual([
      {
        runtimeId: 'rt-ambiguity-newer',
        label: expect.stringContaining('rt-ambiguity-newer'),
        command: ['hrc', 'attach', 'rt-ambiguity-newer'],
      },
      {
        runtimeId: 'rt-ambiguity-older',
        label: expect.stringContaining('rt-ambiguity-older'),
        command: ['hrc', 'attach', 'rt-ambiguity-older'],
      },
    ])

    const sideRow = screen.rows.find((row) => row.handle === 'cody@hrc-runtime:T-05460~side')
    expect(sideRow?.displayState).toBe('ready')
    expect(sideRow?.action.kind).toBe('attach')
  })
})
