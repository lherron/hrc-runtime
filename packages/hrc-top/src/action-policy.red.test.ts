import { describe, expect, it } from 'bun:test'
import type { HrcTargetOperatorDisplayState } from 'hrc-core'
import type { HrcTargetView } from 'hrc-core'

import { recommendPrimaryAction, type HrcTopActionInput } from './action-policy.js'

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
    runtime: {
      runtimeId: 'rt-live-1',
      transport: 'tmux',
      status: 'ready',
      supportsLiteralSend: true,
      supportsCapture: true,
      operatorAttachable: true,
    },
    capabilities,
    ...overrides,
  }
}

function actionInput(
  displayState: HrcTargetOperatorDisplayState,
  overrides: Partial<HrcTopActionInput> = {}
): HrcTopActionInput {
  return {
    handle: 'cody@hrc-runtime:T-05404',
    target: target(),
    displayState,
    operatorAttachable: true,
    hasValidContinuation: false,
    ...overrides,
  }
}

describe('hrc-top primary action policy contract', () => {
  it.each(['ready', 'busy', 'input'] as const)(
    'recommends attach by concrete runtime id for live attachable %s targets',
    (displayState) => {
      // Ph2 contract export:
      // recommendPrimaryAction(input) returns a non-mutating recommendation object with
      // kind, command argv, reason, and concrete ids where the command requires them.
      const recommendation = recommendPrimaryAction(actionInput(displayState))

      expect(recommendation).toMatchObject({
        kind: 'attach',
        command: ['hrc', 'attach', 'rt-live-1'],
        runtimeId: 'rt-live-1',
      })
      expect(recommendation.reason.length).toBeGreaterThan(0)
    }
  )

  it('recommends focus/wait for starting and focus for live non-attachable headless targets', () => {
    expect(
      recommendPrimaryAction(actionInput('starting', { operatorAttachable: false }))
    ).toMatchObject({
      kind: 'focus',
      waitForAttachable: true,
      command: undefined,
    })

    expect(
      recommendPrimaryAction(actionInput('headless', { operatorAttachable: false }))
    ).toMatchObject({
      kind: 'focus',
      waitForAttachable: false,
      command: undefined,
    })
  })

  it('recommends explicit resume for dormant or stale targets only with a valid continuation', () => {
    expect(
      recommendPrimaryAction(
        actionInput('dormant', {
          hasValidContinuation: true,
          target: target({ state: 'dormant', continuation: { provider: 'openai', key: 'conv-1' } }),
        })
      )
    ).toMatchObject({
      kind: 'resume',
      command: ['hrc', 'resume', 'cody@hrc-runtime:T-05404'],
    })

    expect(
      recommendPrimaryAction(
        actionInput('stale', {
          hasValidContinuation: true,
          target: target({
            continuation: { provider: 'openai', key: 'conv-1' },
            runtime: { ...target().runtime!, status: 'dead' },
          }),
        })
      )
    ).toMatchObject({
      kind: 'resume',
      command: ['hrc', 'resume', 'cody@hrc-runtime:T-05404'],
    })
  })

  it('fails clearly instead of falling back to a fresh launch when resume has no valid continuation', () => {
    const recommendation = recommendPrimaryAction(
      actionInput('dormant', {
        hasValidContinuation: false,
        target: target({ state: 'dormant', continuation: undefined, runtime: undefined }),
      })
    )

    expect(recommendation.kind).toBe('unavailable')
    expect(recommendation.command).toBeUndefined()
    expect(recommendation.errorCode).toBe('missing_valid_continuation')
    expect(recommendation.reason).toContain('continuation')
  })

  it('recommends run only for active targets with no runtime and no continuation', () => {
    expect(
      recommendPrimaryAction(
        actionInput('ready', {
          operatorAttachable: false,
          target: target({ state: 'summoned', runtime: undefined, continuation: undefined }),
        })
      )
    ).toMatchObject({
      kind: 'run',
      command: ['hrc', 'run', 'cody@hrc-runtime:T-05404'],
    })

    expect(
      recommendPrimaryAction(
        actionInput('dormant', {
          hasValidContinuation: false,
          target: target({ state: 'dormant', runtime: undefined, continuation: undefined }),
        })
      ).kind
    ).not.toBe('run')
  })

  it.each(['broken', 'ambiguous'] as const)('keeps %s targets on non-mutating focus', (displayState) => {
    const recommendation = recommendPrimaryAction(actionInput(displayState))

    expect(recommendation.kind).toBe('focus')
    expect(recommendation.command).toBeUndefined()
    expect(recommendation.reason.length).toBeGreaterThan(0)
  })
})
