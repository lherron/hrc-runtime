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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { harnessStringToHarnessId, resolveAgentHarness } from '../cli'
import { executeManagedStart } from '../cli/handlers-scope-cmd'
import { buildManagedStartIntent } from '../cli/scope'

describe('harnessStringToHarnessId', () => {
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
        'schemaVersion = 2',
        'priming_prompt = "test"',
        '',
        '[identity]',
        'display = "Pi"',
        'role = "coder"',
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
        'schemaVersion = 2',
        'priming_prompt = "test"',
        '',
        '[identity]',
        'display = "Codex"',
        'role = "coder"',
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
        'schemaVersion = 2',
        'priming_prompt = "test"',
        '',
        '[identity]',
        'display = "Claude"',
        'role = "coder"',
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

describe('hrc-cli resolve intent single authority', () => {
  it('delegates profile/target harness resolution to hrc-sdk instead of owning parser and overlay logic', async () => {
    const scopeSource = await readFile(join(import.meta.dir, '..', 'cli', 'scope.ts'), 'utf8')

    // T-05127: hrc-cli keeps the positional API, but hrc-sdk owns profile parsing,
    // project-target overlay, and provider normalization for harness resolution.
    expect(scopeSource).toContain("from 'hrc-sdk'")
    expect(scopeSource).toContain('resolveAgentHarness as resolveSdkAgentHarness')
    expect(scopeSource).toContain('harnessFrontendToHrcHarness')

    for (const duplicateAuthority of [
      'parseAgentProfile',
      'parseTargetsToml',
      'mergeAgentWithProjectTarget',
      'resolveAgentPrimingPrompt',
      'resolveHarnessProvider',
      'function loadProjectTarget',
      'function resolveProviderForHarness',
    ]) {
      expect(scopeSource).not.toContain(duplicateAuthority)
    }
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
      'schemaVersion = 2\n\n[identity]\nharness = "codex"\n'
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
})

describe('executeManagedStart', () => {
  const intent = {
    harness: { provider: 'openai' as const, id: 'codex-cli' as const, interactive: false },
    initialPrompt: 'wake up',
  }

  it('uses semantic turn dispatch and waits when a prompt is present', async () => {
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
        waitForCompletion: true,
      },
    ])
    expect(result).toEqual({ runtimeId: 'rt-turn', runId: 'run-turn' })
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
