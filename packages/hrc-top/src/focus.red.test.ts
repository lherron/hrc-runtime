import { describe, expect, it } from 'bun:test'
import type { HrcTargetOperatorDisplayState, HrcTargetView } from 'hrc-core'

import { buildFocusPanelModel } from './focus.js'
import type { HrcTopFocusInput } from './focus.js'

const capabilities: HrcTargetView['capabilities'] = {
  state: 'bound',
  modesSupported: ['headless'],
  defaultMode: 'headless',
  dmReady: true,
  sendReady: true,
  peekReady: true,
}

/**
 * T-05405 Ph3 export contract for the pure focus lens:
 *
 * type HrcTopFocusInput = {
 *   handle: string
 *   target: HrcTargetView
 *   displayState: HrcTargetOperatorDisplayState
 *   operatorAttachable: boolean
 *   hasValidContinuation: boolean
 *   disabledActions?: readonly { kind: 'attach' | 'resume' | 'run'; reason: string }[]
 *   latestEventSummary?: string
 *   ambiguityCandidates?: readonly { runtimeId: string; label: string; command?: string[] }[]
 * }
 *
 * buildFocusPanelModel(input: HrcTopFocusInput): {
 *   handle: string
 *   sessionRef: string
 *   lane: string
 *   hostSessionId?: string
 *   latestRuntimeId?: string
 *   primaryAction: ReturnType<typeof recommendPrimaryAction>
 *   disabledActions: readonly { kind: string; reason: string }[]
 *   latestEventSummary: string
 *   ambiguityCandidates: readonly { runtimeId: string; label: string; command?: string[] }[]
 *   commandPreview?: string[]
 * }
 *
 * Focus is read-only and renderer-independent. It consumes HrcTargetView plus
 * Ph2 action-policy facts and returns the information needed by the focus
 * panel, including useful explanatory text when no explicit action is available.
 */

function target(overrides: Partial<HrcTargetView> = {}): HrcTargetView {
  return {
    sessionRef: 'agent:cody:project:hrc-runtime:task:T-05405/lane:repair',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-05405',
    laneRef: 'repair',
    state: 'bound',
    activeHostSessionId: 'hsid-focus-1',
    runtime: {
      runtimeId: 'rt-focus-1',
      transport: 'tmux',
      status: 'ready',
      supportsLiteralSend: true,
      supportsCapture: true,
      operatorAttachable: true,
      lastActivityAt: '2026-07-02T12:20:00.000Z',
    },
    continuation: { provider: 'openai', key: 'conv-focus-1' },
    capabilities,
    ...overrides,
  }
}

function focusInput(
  displayState: HrcTargetOperatorDisplayState,
  overrides: Partial<HrcTopFocusInput> = {}
): HrcTopFocusInput {
  return {
    handle: 'cody@hrc-runtime:T-05405~repair',
    target: target(),
    displayState,
    operatorAttachable: true,
    hasValidContinuation: true,
    latestEventSummary: 'last event: tool completed 12s ago',
    disabledActions: [{ kind: 'resume', reason: 'runtime is live; resume is not the current semantic action' }],
    ...overrides,
  }
}

describe('hrc-top focus panel pure projection', () => {
  it('returns selected target identity, runtime facts, primary action, disabled reasons, event summary, and command preview', () => {
    const model = buildFocusPanelModel(focusInput('ready'))

    expect(model).toMatchObject({
      handle: 'cody@hrc-runtime:T-05405~repair',
      sessionRef: 'agent:cody:project:hrc-runtime:task:T-05405/lane:repair',
      lane: 'repair',
      hostSessionId: 'hsid-focus-1',
      latestRuntimeId: 'rt-focus-1',
      primaryAction: {
        kind: 'attach',
        command: ['hrc', 'attach', 'rt-focus-1'],
        runtimeId: 'rt-focus-1',
      },
      commandPreview: ['hrc', 'attach', 'rt-focus-1'],
      latestEventSummary: 'last event: tool completed 12s ago',
    })
    expect(model.primaryAction.reason.length).toBeGreaterThan(0)
    expect(model.disabledActions).toEqual([
      { kind: 'resume', reason: 'runtime is live; resume is not the current semantic action' },
    ])
  })

  it('surfaces ambiguity candidates without guessing a concrete runtime', () => {
    const model = buildFocusPanelModel(
      focusInput('ambiguous', {
        operatorAttachable: false,
        ambiguityCandidates: [
          { runtimeId: 'rt-newest', label: 'newest live runtime', command: ['hrc', 'attach', 'rt-newest'] },
          { runtimeId: 'rt-older', label: 'older live runtime', command: ['hrc', 'attach', 'rt-older'] },
        ],
      })
    )

    expect(model.primaryAction.kind).toBe('focus')
    expect(model.commandPreview).toBeUndefined()
    expect(model.ambiguityCandidates).toEqual([
      { runtimeId: 'rt-newest', label: 'newest live runtime', command: ['hrc', 'attach', 'rt-newest'] },
      { runtimeId: 'rt-older', label: 'older live runtime', command: ['hrc', 'attach', 'rt-older'] },
    ])
  })

  it('stays useful when no action is available', () => {
    const model = buildFocusPanelModel(
      focusInput('dormant', {
        hasValidContinuation: false,
        target: target({ state: 'dormant', runtime: undefined, continuation: undefined }),
        latestEventSummary: undefined,
        disabledActions: [
          { kind: 'resume', reason: 'no captured, non-invalidated continuation exists' },
          { kind: 'attach', reason: 'no live operator-attachable runtime exists' },
          { kind: 'run', reason: 'dormant targets require resume semantics, not a fresh launch' },
        ],
      })
    )

    expect(model.primaryAction).toMatchObject({
      kind: 'unavailable',
      errorCode: 'missing_valid_continuation',
      command: undefined,
    })
    expect(model.commandPreview).toBeUndefined()
    expect(model.latestEventSummary.length).toBeGreaterThan(0)
    expect(model.disabledActions.map((action) => action.reason)).toEqual([
      'no captured, non-invalidated continuation exists',
      'no live operator-attachable runtime exists',
      'dormant targets require resume semantics, not a fresh launch',
    ])
  })
})
