import { describe, expect, it } from 'bun:test'

import type { HrcTargetView } from '../hrcchat-contracts.js'
import {
  type HrcTargetOperatorDisplayState,
  type HrcTargetOperatorProjectionFacts,
  projectTargetOperatorState,
} from '../target-operator-projection.js'

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
    sessionRef: 'agent:cody:project:hrc-runtime:task:T-05404/lane:main',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-05404',
    laneRef: 'main',
    state: 'bound',
    generation: 4,
    runtime: {
      runtimeId: 'rt-live-1',
      transport: 'tmux',
      status: 'ready',
      supportsLiteralSend: true,
      supportsCapture: true,
      activeRunId: 'run-1',
      presentation: 'none',
    },
    capabilities,
    ...overrides,
  }
}

function expectDisplayState(
  view: HrcTargetView,
  facts: HrcTargetOperatorProjectionFacts | undefined,
  displayState: HrcTargetOperatorDisplayState
): void {
  expect(projectTargetOperatorState(view, facts).displayState).toBe(displayState)
}

describe('target operator projection contract', () => {
  it('preserves busy, dormant, and broken from HrcTargetView.state before applying refinements', () => {
    // Ph2 contract export:
    // projectTargetOperatorState(target, facts?) returns display state for operator rows.
    // busy/dormant/broken are target-truth states and must not be re-derived from runtime history.
    const contradictoryFacts: HrcTargetOperatorProjectionFacts = {
      ambiguous: true,
      hasValidContinuation: true,
      operatorAttachable: true,
      runtimeStatus: 'awaiting_input',
    }

    expectDisplayState(
      target({ state: 'busy', runtime: { ...target().runtime!, status: 'dead' } }),
      contradictoryFacts,
      'busy'
    )
    expectDisplayState(
      target({ state: 'dormant', runtime: { ...target().runtime!, status: 'ready' } }),
      contradictoryFacts,
      'dormant'
    )
    expectDisplayState(
      target({ state: 'broken', continuation: { provider: 'openai', key: 'conv-1' } }),
      contradictoryFacts,
      'broken'
    )
  })

  it('refines non-terminal target views into input, ready, starting, headless, stale, and ambiguous', () => {
    expectDisplayState(target(), { runtimeStatus: 'awaiting_input' }, 'input')
    expectDisplayState(target(), { operatorAttachable: true, runtimeStatus: 'ready' }, 'ready')
    expectDisplayState(target(), { runtimeStatus: 'starting' }, 'starting')
    expectDisplayState(target(), { operatorAttachable: false, runtimeStatus: 'busy' }, 'headless')
    expectDisplayState(
      target({
        continuation: { provider: 'openai', key: 'conv-1' },
        runtime: { ...target().runtime!, status: 'terminated' },
      }),
      { hasValidContinuation: true },
      'stale'
    )
    expectDisplayState(target(), { ambiguous: true, operatorAttachable: true }, 'ambiguous')
  })

  it('computes attachability from descriptor or presentation, not transport alone', () => {
    expect(
      projectTargetOperatorState(
        target({ runtime: { ...target().runtime!, transport: 'tmux', presentation: 'none' } })
      ).operatorAttachable
    ).toBe(false)

    expect(
      projectTargetOperatorState(
        target({
          runtime: { ...target().runtime!, transport: 'headless', presentation: 'tmux-tui' },
        })
      ).operatorAttachable
    ).toBe(true)

    expect(
      projectTargetOperatorState(
        target({
          runtime: {
            ...target().runtime!,
            transport: 'headless',
            operatorAttachable: true,
            presentation: 'none',
          },
        })
      ).operatorAttachable
    ).toBe(true)
  })
})
