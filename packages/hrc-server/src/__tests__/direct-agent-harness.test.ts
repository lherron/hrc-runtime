import { describe, expect, test } from 'bun:test'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import { validateInvocationSpec } from 'spaces-harness-broker-protocol'
import { buildDirectAgentHarnessPlan } from '../agent-spaces-adapter/direct-agent-harness'

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
      harness: { provider: 'openai', interactive: false, id: 'pi-sdk' },
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
  })
})
