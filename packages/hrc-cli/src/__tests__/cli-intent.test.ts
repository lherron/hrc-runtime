/**
 * Intent builder tests for harness.id population from agent profiles.
 *
 * Defect (T-01264): an agent profile with `harness = "pi"` was routed to
 * frontend `codex-cli` because the intent builder did not populate
 * `intent.harness.id`. The HRC frontend resolver checks `intent.harness.id`
 * first, then falls back to provider — so a missing id silently lost the
 * harness specificity.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { harnessStringToHarnessId, resolveAgentHarness } from '../cli'
import { executeManagedStart } from '../cli/handlers-scope-cmd'
import { buildManagedStartIntent, parseScopePrompt, resolveManagedScopeContext } from '../cli/scope'

describe('harnessStringToHarnessId', () => {
  it('preserves the canonical "agent-harness" selector', () => {
    expect(harnessStringToHarnessId('agent-harness')).toBe('agent-harness')
  })

  it('maps "pi" profile harness to HrcHarness "pi-cli"', () => {
    expect(harnessStringToHarnessId('pi')).toBe('pi-cli')
  })

  it('maps "codex" profile harness to HrcHarness "codex-cli"', () => {
    expect(harnessStringToHarnessId('codex')).toBe('codex-cli')
  })

  it('maps "claude" profile harness to HrcHarness "claude-code"', () => {
    expect(harnessStringToHarnessId('claude')).toBe('claude-code')
    expect(harnessStringToHarnessId('claude-code')).toBe('claude-code')
  })

  it('returns undefined for unknown / undefined harness names', () => {
    expect(harnessStringToHarnessId(undefined)).toBeUndefined()
    expect(harnessStringToHarnessId('not-a-harness')).toBeUndefined()
  })
})

describe('resolveAgentHarness', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'hrc-cli-intent-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('reads harness=pi from agent-profile.toml', async () => {
    const agentRoot = join(tmp, 'pi-agent')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(
      join(agentRoot, 'agent-profile.toml'),
      [
        'version = 3',
        'priming = "test"',
        '',
        '[identity]',
        'display = "Pi"',
        'role = "coder"',
        '[provisioning]',
        'harness = "pi"',
      ].join('\n')
    )

    const result = resolveAgentHarness(agentRoot, 'pi-agent')
    expect(result.provider).toBe('openai')
    expect(result.harness).toBe('pi')
    expect(harnessStringToHarnessId(result.harness)).toBe('pi-cli')
  })

  it('reads harness=codex from agent-profile.toml', async () => {
    const agentRoot = join(tmp, 'codex-agent')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(
      join(agentRoot, 'agent-profile.toml'),
      [
        'version = 3',
        'priming = "test"',
        '',
        '[identity]',
        'display = "Codex"',
        'role = "coder"',
        '[provisioning]',
        'harness = "codex"',
      ].join('\n')
    )

    const result = resolveAgentHarness(agentRoot, 'codex-agent')
    expect(result.provider).toBe('openai')
    expect(result.harness).toBe('codex')
    expect(harnessStringToHarnessId(result.harness)).toBe('codex-cli')
  })

  it('reads harness=claude-code from agent-profile.toml', async () => {
    const agentRoot = join(tmp, 'claude-agent')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(
      join(agentRoot, 'agent-profile.toml'),
      [
        'version = 3',
        'priming = "test"',
        '',
        '[identity]',
        'display = "Claude"',
        'role = "coder"',
        '[provisioning]',
        'harness = "claude-code"',
      ].join('\n')
    )

    const result = resolveAgentHarness(agentRoot, 'claude-agent')
    expect(result.provider).toBe('anthropic')
    expect(result.harness).toBe('claude-code')
    expect(harnessStringToHarnessId(result.harness)).toBe('claude-code')
  })

  it('falls back gracefully when no profile exists', () => {
    const result = resolveAgentHarness(join(tmp, 'no-profile'), 'missing')
    expect(result.provider).toBe('anthropic')
    expect(result.harness).toBeUndefined()
    expect(harnessStringToHarnessId(result.harness)).toBeUndefined()
  })
})

describe('buildManagedStartIntent', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'hrc-cli-start-intent-'))
    await mkdir(join(projectRoot, 'agents', 'codex-agent'), { recursive: true })
    await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')
    await writeFile(
      join(projectRoot, 'agents', 'codex-agent', 'agent-profile.toml'),
      'version = 3\n\n[provisioning]\nharness = "codex"\n'
    )
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  const scope = () => ({
    agentId: 'codex-agent',
    scopeRef: 'agent:codex-agent',
    laneRef: 'main',
    sessionRef: 'agent:codex-agent/lane:main',
    projectRootOverride: projectRoot,
  })

  /**
   * T-07398 DEFECT CYCLE 1, D2 — the `hrc start` sender must CARRY the handle's
   * directive block through to the intent.
   *
   * `resolveManagedScopeContext` destructures only parsed/scopeRef/laneRef/
   * placement out of the shared resolver and throws `directives` away, and
   * `buildManagedRuntimeIntent` assembles the intent by hand with no
   * `provision`. So `hrc start "<agent>@<proj>:<task>+node=notanode"` reaches
   * the daemon with nothing to validate and is born locally instead of
   * returning typed UNKNOWN_NODE (C-15413 D2). The gate's registry check is
   * already correct — the directive simply never arrives.
   */
  it('carries the handle directive block onto the start intent as provision (T-07398 D2)', () => {
    const scopeContext = resolveManagedScopeContext(
      'codex-agent@fixture-project:t07402smoke3+node=notanode+model=sonnet',
      { projectRootOverride: projectRoot, registerPolicy: 'never' }
    )

    expect(buildManagedStartIntent(scopeContext).provision).toMatchObject({
      node: 'notanode',
      model: 'sonnet',
    })
  })

  it('classifies prompt-bearing detached start as non-interactive headless', () => {
    const intent = buildManagedStartIntent(scope(), { prompt: 'wake up' })

    expect(intent.harness).toMatchObject({
      provider: 'openai',
      id: 'codex-cli',
      interactive: false,
    })
    expect(intent.execution?.preferredMode).toBe('headless')
    expect(intent.initialPrompt).toBe('wake up')
  })

  it('leaves promptless detached start classification unchanged', () => {
    expect(buildManagedStartIntent(scope()).harness.interactive).toBe(true)
  })

  it('assembles an explicit execution cwd without changing the resolved project root', async () => {
    const executionCwd = join(projectRoot, 'target-checkout')
    await mkdir(executionCwd)
    const scopeContext = resolveManagedScopeContext('codex-agent@fixture-project:T-07731', {
      projectRootOverride: projectRoot,
      cwdOverride: executionCwd,
      registerPolicy: 'never',
    })

    expect(buildManagedStartIntent(scopeContext).placement).toMatchObject({
      projectRoot,
      cwd: executionCwd,
    })
  })

  // T-07118: the viewer placement hint is a presentation field only — an absent
  // flag must leave the intent byte-identical to today's.
  it('threads --viewer-window into presentation.viewerWindow', () => {
    expect(buildManagedStartIntent(scope(), { viewerWindow: 'console' }).presentation).toEqual({
      viewerWindow: 'console',
    })
  })

  it('omits presentation entirely when no viewer window is requested', () => {
    expect(buildManagedStartIntent(scope()).presentation).toBeUndefined()
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
        // T-07236: a local CLI start states its own provenance. The KIND is
        // what any consumer policy reads and is known even when the OS cannot
        // name the invoking user, so the actor is asserted loosely.
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

/**
 * T-07118 regression: a value-taking passthrough flag missing from the parser's
 * value set does not fail loudly — its VALUE is read as a positional prompt.
 * `hrc start <scope> --viewer-window console --on-conflict suffix` reported
 * "start accepts at most one positional prompt", which names neither flag.
 */
describe('parseScopePrompt value-taking passthrough flags', () => {
  const startFlags = [
    '--force-restart',
    '--new-session',
    '--dry-run',
    '--debug',
    '--no-register',
    '--json',
    '--wait',
    '--idempotency-key',
    '--project-id',
    '--project-root',
    '--cwd',
    '--viewer-window',
    '--on-conflict',
  ]

  it('consumes --viewer-window / --on-conflict values instead of reading them as prompts', async () => {
    const prompt = await parseScopePrompt(
      [
        'mable@hrc-runtime',
        '--viewer-window',
        'console',
        '--cwd',
        '/tmp',
        '--on-conflict',
        'suffix',
        '--dry-run',
      ],
      { command: 'start', passthroughFlags: startFlags }
    )
    expect(prompt).toBeUndefined()
  })

  it('still reads a real positional prompt alongside those flags', async () => {
    const prompt = await parseScopePrompt(
      ['mable@hrc-runtime', '--viewer-window', 'console', 'wake up', '--on-conflict', 'suffix'],
      { command: 'start', passthroughFlags: startFlags }
    )
    expect(prompt).toBe('wake up')
  })
})
