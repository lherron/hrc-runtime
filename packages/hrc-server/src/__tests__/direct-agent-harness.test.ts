import { describe, expect, test } from 'bun:test'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import { validateInvocationSpec } from 'spaces-harness-broker-protocol'
import {
  buildDirectAgentHarnessPlan,
  buildDirectInteractiveAgentHarnessPlan,
} from '../agent-spaces-adapter/direct-agent-harness'
import { runtimeHarness } from '../broker/runtime-state'

describe('direct agent-harness plan', () => {
  test('lowers semantic agent identity without an ASPC process plan', async () => {
    const intent = {
      placement: {
        agentRoot: '/agents/cody',
        projectRoot: '/projects/agent-spaces',
        cwd: '/projects/agent-spaces',
        bundle: {
          kind: 'agent-project',
          agentName: 'cody',
          projectRoot: '/projects/agent-spaces',
        },
      },
      harness: { provider: 'openai', interactive: false, id: 'agent-harness' },
      provision: { model: 'gpt-5.6-sol', reasoning: 'high' },
      initialPrompt: 'Reply with the active agent id.',
    } satisfies HrcRuntimeIntent
    const session = {
      hostSessionId: 'host-cody',
      scopeRef: 'agent:cody:project:agent-spaces',
      laneRef: 'main',
      generation: 3,
    } as HrcSessionRecord
    const built = await buildDirectAgentHarnessPlan({
      intent,
      session,
      runtimeId: 'runtime-cody',
      runId: 'run-cody',
      dispatchEnv: { ASP_PROJECT: 'agent-spaces' },
      now: '2026-08-24T12:00:00.000Z',
      resolveProfileYolo: async () => true,
    })

    expect(() => validateInvocationSpec(built.startRequest.spec)).not.toThrow()
    expect(built.profile.brokerDriver).toBe('agent-harness')
    expect(built.startRequest.spec.agent).toEqual(
      expect.objectContaining({
        agentId: 'cody',
        projectId: 'agent-spaces',
        scopeRef: session.scopeRef,
        generation: 3,
      })
    )
    expect(built.startRequest.spec.sdk).toEqual(
      expect.objectContaining({
        provider: 'openai-codex',
        modelId: 'openai-codex/gpt-5.6-sol',
        thinkingLevel: 'high',
      })
    )
    expect(built.plan.artifacts.materializedBundleRoot).toBeUndefined()
    expect(built.plan.artifacts.systemPromptFile).toBeUndefined()
    expect(built.profile.policy.permissionPolicy.mode).toBe('allow')
    expect(runtimeHarness(built.plan.harness.runtime, built.profile.brokerDriver)).toBe(
      'agent-harness'
    )
  })

  test('builds the interactive SDK-backed tmux variant without semantic argv', async () => {
    const intent = {
      placement: {
        agentRoot: '/agents/sparky',
        projectRoot: '/projects/agent-spaces',
        cwd: '/projects/agent-spaces',
        bundle: {
          kind: 'agent-project',
          agentName: 'sparky',
          projectRoot: '/projects/agent-spaces',
        },
      },
      harness: { provider: 'openai', interactive: true, id: 'agent-harness' },
      provision: { model: 'gpt-5.6-sol', reasoning: 'high' },
      initialPrompt: 'Reply with the active agent id.',
    } satisfies HrcRuntimeIntent
    const session = {
      hostSessionId: 'host-sparky',
      scopeRef: 'agent:sparky:project:agent-spaces',
      laneRef: 'main',
      generation: 2,
    } as HrcSessionRecord
    const command = '/release/node_modules/.bin/agent-harness'

    const built = await buildDirectInteractiveAgentHarnessPlan({
      intent,
      session,
      runtimeId: 'runtime-sparky',
      runId: 'run-sparky',
      dispatchEnv: { ASP_PROJECT: 'agent-spaces' },
      now: '2026-08-26T00:00:00.000Z',
      resolveProfileYolo: async () => false,
      agentHarnessCommand: command,
    })

    expect(() => validateInvocationSpec(built.startRequest.spec)).not.toThrow()
    expect(built.startRequest.spec.harness).toEqual({
      frontend: 'agent-harness',
      provider: 'openai',
      driver: 'agent-harness-tmux',
    })
    expect(built.startRequest.spec.process).toEqual(
      expect.objectContaining({
        command,
        harnessTransport: { kind: 'pty' },
      })
    )
    expect(built.startRequest.spec.process.args).toHaveLength(3)
    expect(built.startRequest.spec.process.args?.slice(0, 2)).toEqual([
      'tui',
      '--broker-control-socket',
    ])
    expect(built.startRequest.spec.process.args?.[2]).toMatch(
      /agent-harness-control\.[a-f0-9]{16}\.sock$/
    )
    expect(built.startRequest.spec.interaction.mode).toBe('interactive')
    expect(built.startRequest.spec.driver).toEqual(
      expect.objectContaining({ kind: 'agent-harness-tmux', terminalHost: 'tmux' })
    )
    expect(built.startRequest.spec.sdk).toEqual(
      expect.objectContaining({
        runtime: 'pi-sdk',
        provider: 'openai-codex',
        modelId: 'openai-codex/gpt-5.6-sol',
        thinkingLevel: 'high',
      })
    )
    expect(built.profile.interactionMode).toBe('interactive')
    expect(built.profile.brokerDriver).toBe('agent-harness-tmux')
    expect(built.profile.brokerTerminal?.host).toBe('tmux')
    expect(runtimeHarness(built.plan.harness.runtime, built.profile.brokerDriver)).toBe(
      'agent-harness'
    )
  })
})
