/**
 * Intent builder tests (T-08597 daemon-backed).
 *
 * Harness/provider/provisioning facts are observed from the installed daemon;
 * these pin the CLI-side shaping with an injected declarations client:
 * directive carry-through, detached-start overrides, presentation threading,
 * session correlation, and debug launch. Population parity against the local
 * assembler is proved by the route parity table, not here.
 */
import { describe, expect, it } from 'bun:test'

import {
  normalizeClaudeInteractiveBrokerIntent,
  shouldRedirectClaudeToInteractiveBroker,
} from 'hrc-server'

import { harnessStringToHarnessId } from '../cli'
import { executeManagedStart } from '../cli/handlers-scope-cmd'
import { buildManagedStartIntent } from '../cli/scope'
import type { ManagedIntentClient, ManagedScopeContext } from '../cli/scope'

describe('harnessStringToHarnessId (T-08597 frontend allowlist)', () => {
  it('passes admitted frontends through', () => {
    expect(harnessStringToHarnessId('pi-cli')).toBe('pi-cli')
    expect(harnessStringToHarnessId('codex-cli')).toBe('codex-cli')
    expect(harnessStringToHarnessId('claude-code')).toBe('claude-code')
  })

  it('no longer normalizes bare catalog ids — observations are frontend form', () => {
    expect(harnessStringToHarnessId('pi')).toBeUndefined()
    expect(harnessStringToHarnessId('codex')).toBeUndefined()
    expect(harnessStringToHarnessId('claude')).toBeUndefined()
  })

  it('returns undefined for unknown / undefined harness names', () => {
    expect(harnessStringToHarnessId(undefined)).toBeUndefined()
    expect(harnessStringToHarnessId('not-a-harness')).toBeUndefined()
  })
})

function fakeDeclarationsClient(
  seen: unknown[],
  overrides: Record<string, unknown> = {}
): ManagedIntentClient {
  return {
    resolveRuntimeIntent: async (request: Record<string, unknown>) => {
      seen.push(request)
      return {
        intent: {
          placement: {
            agentRoot: '/agents/codex-agent',
            projectRoot: '/projects/fixture',
            cwd: '/projects/fixture',
            runMode: 'task',
            bundle: { kind: 'agent-project', agentName: 'codex-agent' },
            dryRun: false,
          },
          harness: {
            provider: 'openai',
            interactive: request['interactive'] ?? true,
            id: 'codex-cli',
          },
          execution: { preferredMode: request['preferredMode'] ?? 'headless' },
          provision: { harness: 'codex-cli', model: 'gpt' },
          ...(typeof request['initialPrompt'] === 'string'
            ? { initialPrompt: request['initialPrompt'] }
            : {}),
          ...overrides,
        },
        declaration: {
          release: { releaseId: 'r', sourceCommit: 'c' },
          agentSources: { provenance: 'daemon-default' },
          source: {
            agentProfile: 'valid',
            projectTargets: 'valid',
            selectedTarget: 'absent',
            priming: 'valid',
          },
          warnings: [],
        },
      } as never
    },
  }
}

const scope = (): ManagedScopeContext => ({
  agentId: 'codex-agent',
  projectId: 'fixture-project',
  projectOrigin: 'explicit',
  scopeRef: 'agent:codex-agent:project:fixture-project:task:primary',
  laneRef: 'main',
  sessionRef: 'agent:codex-agent:project:fixture-project:task:primary/lane:main',
  placement: {
    agentRoot: '/agents/codex-agent',
    projectRoot: '/projects/fixture',
    cwd: '/projects/fixture',
    resolution: { source: 'wrkq-registry', reason: 'test' },
  },
})

describe('buildManagedStartIntent (daemon-backed shaping)', () => {
  it('carries the handle directive block to the route as provision (T-07398 D2)', async () => {
    const seen: unknown[] = []
    const intent = await buildManagedStartIntent(
      {
        ...scope(),
        directives: { node: 'notanode', model: 'sonnet' },
      },
      { client: fakeDeclarationsClient(seen) }
    )

    expect(seen[0]).toMatchObject({ provision: { node: 'notanode', model: 'sonnet' } })
    expect(intent.provision).toMatchObject({ harness: 'codex-cli', model: 'gpt' })
  })

  it('classifies prompt-bearing detached start as non-interactive headless', async () => {
    const seen: unknown[] = []
    const intent = await buildManagedStartIntent(scope(), {
      prompt: 'wake up',
      client: fakeDeclarationsClient(seen),
    })

    expect(seen[0]).toMatchObject({ interactive: true, initialPrompt: 'wake up' })
    expect(intent.harness).toMatchObject({
      provider: 'openai',
      id: 'codex-cli',
      interactive: false,
    })
    expect(intent.execution?.preferredMode).toBe('headless')
    expect(intent.initialPrompt).toBe('wake up')
  })

  it('stamps session correlation onto the placement', async () => {
    const seen: unknown[] = []
    const context = scope()
    const intent = await buildManagedStartIntent(context, {
      client: fakeDeclarationsClient(seen),
    })

    expect(intent.placement).toMatchObject({
      correlation: {
        sessionRef: { scopeRef: context.scopeRef, laneRef: context.laneRef },
      },
    })
  })

  it('keeps promptless Claude start redirected to the interactive Claude broker', async () => {
    const seen: unknown[] = []
    const startIntent = await buildManagedStartIntent(scope(), {
      client: fakeDeclarationsClient(seen, {
        harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
      }),
    })

    expect(startIntent.harness).toMatchObject({
      provider: 'anthropic',
      id: 'claude-code',
      interactive: false,
    })
    expect(shouldRedirectClaudeToInteractiveBroker(startIntent)).toBe(true)

    const normalized = normalizeClaudeInteractiveBrokerIntent(startIntent)
    expect(normalized.harness).toMatchObject({
      provider: 'anthropic',
      id: 'claude-code',
      interactive: true,
    })
    expect(normalized.execution?.preferredMode).toBe('interactive')
  })

  // T-07118: the viewer placement hint is a presentation field only.
  it('threads --viewer-window into presentation.viewerWindow', async () => {
    const seen: unknown[] = []
    expect(
      (
        await buildManagedStartIntent(scope(), {
          viewerWindow: 'console',
          client: fakeDeclarationsClient(seen),
        })
      ).presentation
    ).toEqual({ viewerWindow: 'console' })
  })

  it('omits presentation entirely when no viewer window is requested', async () => {
    const seen: unknown[] = []
    expect(
      (await buildManagedStartIntent(scope(), { client: fakeDeclarationsClient(seen) }))
        .presentation
    ).toBeUndefined()
  })

  it('threads --no-viewer into presentation.operator none on a headless start intent', async () => {
    const seen: unknown[] = []
    const intent = await buildManagedStartIntent(scope(), {
      operatorPresentation: 'none',
      client: fakeDeclarationsClient(seen),
    })
    expect(intent.presentation).toEqual({ operator: 'none' })
    expect(intent.harness.interactive).toBe(false)
  })

  it('threads --app-server-viewer into presentation.operator tmux-tui', async () => {
    const seen: unknown[] = []
    const intent = await buildManagedStartIntent(scope(), {
      operatorPresentation: 'tmux-tui',
      viewerWindow: 'work',
      client: fakeDeclarationsClient(seen),
    })
    expect(intent.presentation).toEqual({ viewerWindow: 'work', operator: 'tmux-tui' })
    expect(intent.harness.interactive).toBe(false)
  })
})

describe('executeManagedStart', () => {
  const intent = {
    harness: { provider: 'openai' as const, id: 'codex-cli' as const, interactive: false },
    initialPrompt: 'wake up',
  }

  it('uses semantic turn dispatch and acknowledges durable prompt acceptance', async () => {
    const startCalls: unknown[] = []
    const dispatchCalls: unknown[] = []
    const client = {
      startRuntime: async (input: unknown) => {
        startCalls.push(input)
        return { runtimeId: 'rt-start' }
      },
      dispatchTurn: async (input: unknown) => {
        dispatchCalls.push(input)
        return { runtimeId: 'rt-turn', runId: 'run-turn' }
      },
    } as unknown as ManagedStartClientForTest

    const result = await executeManagedStart(client, {
      hostSessionId: 'hs-test',
      intent,
      prompt: 'wake up',
      restartStyle: 'reuse_pty',
    })

    expect(startCalls).toHaveLength(0)
    expect(dispatchCalls).toEqual([
      {
        hostSessionId: 'hs-test',
        prompt: 'wake up',
        runtimeIntent: intent,
        idempotencyKey: expect.any(String),
        waitFor: 'accepted',
        waitForCompletion: false,
        origin: { actor: expect.any(String), kind: 'human' },
      },
    ])
    expect(result).toEqual({ runtimeId: 'rt-turn', runId: 'run-turn' })
  })

  it('fails loudly when prompt dispatch reports that the start input was not delivered', async () => {
    const prompt = 'wake up exactly once'
    const client = {
      startRuntime: async () => ({ runtimeId: 'rt-start' }),
      dispatchTurn: async () => ({
        runtimeId: 'rt-failed-delivery',
        runId: 'run-failed-delivery',
        execution: {
          state: 'failed',
          errorCode: 'delivery_not_guaranteed',
          errorMessage: `input "${prompt}" was not delivered: forced broker rejection`,
        },
      }),
    } as unknown as ManagedStartClientForTest

    let result: unknown
    let failure: unknown
    try {
      result = await executeManagedStart(client, {
        hostSessionId: 'hs-failed-delivery',
        intent: { ...intent, initialPrompt: prompt },
        prompt,
        restartStyle: 'reuse_pty',
      })
    } catch (error) {
      failure = error
    }

    expect(result).toBeUndefined()
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(prompt)
    expect((failure as Error).message).toContain('not delivered')
  })

  it('keeps promptless start on the lifecycle API', async () => {
    const startCalls: unknown[] = []
    const dispatchCalls: unknown[] = []
    const client = {
      startRuntime: async (input: unknown) => {
        startCalls.push(input)
        return { runtimeId: 'rt-start' }
      },
      dispatchTurn: async (input: unknown) => {
        dispatchCalls.push(input)
        return { runtimeId: 'rt-turn' }
      },
    } as unknown as ManagedStartClientForTest

    await executeManagedStart(client, {
      hostSessionId: 'hs-test',
      intent: { ...intent, initialPrompt: undefined },
      restartStyle: 'reuse_pty',
    })

    expect(startCalls).toHaveLength(1)
    expect(dispatchCalls).toHaveLength(0)
  })
})

type ManagedStartClientForTest = Parameters<typeof executeManagedStart>[0]
