import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROVISIONING_SCALAR_KEYS } from 'agent-scope'
import { buildHrcRuntimeIntent, resolveAgentHarness } from './runtime-intent-assembly.js'

const tempRoots: string[] = []

function makeAgentDir(harness: string): { agentRoot: string; agentId: string } {
  const root = mkdtempSync(join(tmpdir(), 'hrc-sdk-resolve-intent-'))
  tempRoots.push(root)
  writeFileSync(
    join(root, 'agent-profile.toml'),
    `version = 3\n\n[provisioning]\nharness = "${harness}"\n`
  )
  return { agentRoot: root, agentId: 'fixture-agent' }
}

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('resolveAgentHarness — provider/harness derived from the agent profile', () => {
  test('codex profile resolves to openai', () => {
    const { agentRoot, agentId } = makeAgentDir('codex')
    expect(resolveAgentHarness({ agentRoot, agentId })).toMatchObject({
      provider: 'openai',
      harness: 'codex',
    })
  })

  test('claude-code profile resolves to anthropic', () => {
    const { agentRoot, agentId } = makeAgentDir('claude-code')
    expect(resolveAgentHarness({ agentRoot, agentId })).toMatchObject({
      provider: 'anthropic',
      harness: 'claude-code',
    })
  })

  test('agent-harness profile resolves to the canonical direct harness', () => {
    const { agentRoot, agentId } = makeAgentDir('agent-harness')
    expect(resolveAgentHarness({ agentRoot, agentId })).toMatchObject({
      provider: 'openai',
      harness: 'agent-harness',
    })
  })

  test('missing profile falls back to anthropic', () => {
    const root = mkdtempSync(join(tmpdir(), 'hrc-sdk-resolve-intent-empty-'))
    tempRoots.push(root)
    expect(resolveAgentHarness({ agentRoot: root, agentId: 'x' })).toMatchObject({
      provider: 'anthropic',
      harness: undefined,
    })
  })

  test('missing profile keeps the target-only provisioning branch structural', () => {
    const agentRoot = mkdtempSync(join(tmpdir(), 'hrc-sdk-resolve-target-only-agent-'))
    const projectRoot = mkdtempSync(join(tmpdir(), 'hrc-sdk-resolve-target-only-project-'))
    tempRoots.push(agentRoot, projectRoot)
    writeFileSync(
      join(projectRoot, 'asp-targets.toml'),
      ['schema = 1', '', '[targets.x]', '', '[targets.x.provisioning]', 'node = "svc"', ''].join(
        '\n'
      )
    )

    expect(resolveAgentHarness({ agentRoot, agentId: 'x', projectRoot })).toMatchObject({
      provider: 'anthropic',
      harness: undefined,
      provision: { node: 'svc' },
    })
  })
})

describe('buildHrcRuntimeIntent — single authority for scoperef → HrcRuntimeIntent', () => {
  test('codex agent → openai + codex-cli harness id', () => {
    const { agentRoot, agentId } = makeAgentDir('codex')
    const intent = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      cwd: '/repo',
      runMode: 'task',
      interactive: false,
      preferredMode: 'headless',
    })
    expect(intent.harness).toMatchObject({
      provider: 'openai',
      id: 'codex-cli',
      interactive: false,
    })
    expect(intent.execution).toEqual({ preferredMode: 'headless' })
    expect(intent.placement).toMatchObject({ agentRoot, cwd: '/repo', runMode: 'task' })
  })

  test('claude-code agent → anthropic + claude-code harness id', () => {
    const { agentRoot, agentId } = makeAgentDir('claude-code')
    const intent = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      cwd: '/repo',
      runMode: 'task',
      interactive: false,
      preferredMode: 'headless',
    })
    expect(intent.harness).toMatchObject({
      provider: 'anthropic',
      id: 'claude-code',
      interactive: false,
    })
  })

  test('agent-harness agent → canonical first-party harness id', () => {
    const { agentRoot, agentId } = makeAgentDir('agent-harness')
    const intent = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      interactive: false,
      preferredMode: 'headless',
    })
    expect(intent.harness).toMatchObject({
      provider: 'openai',
      id: 'agent-harness',
      interactive: false,
    })
  })

  test('caller-supplied interaction semantics pass through; only provider/harness derive', () => {
    const { agentRoot, agentId } = makeAgentDir('codex')
    const intent = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      interactive: false,
      preferredMode: 'nonInteractive',
    })
    expect(intent.execution).toEqual({ preferredMode: 'nonInteractive' })
    expect(intent.harness.interactive).toBe(false)
  })

  test('T-05177: allowInteractiveSurfaceReuse threads into execution only when supplied', () => {
    const { agentRoot, agentId } = makeAgentDir('claude-code')
    const off = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      interactive: false,
      preferredMode: 'headless',
      allowInteractiveSurfaceReuse: false,
    })
    expect(off.execution).toEqual({
      preferredMode: 'headless',
      allowInteractiveSurfaceReuse: false,
    })

    // Omitted ⇒ field absent (HRC treats absence as the default-allow reuse).
    const omitted = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      interactive: false,
      preferredMode: 'headless',
    })
    expect(omitted.execution).toEqual({ preferredMode: 'headless' })
  })
})

/**
 * T-07398 Wave 2b — the directive overlay is the FINAL step of intent assembly.
 *
 * The profile (plus any project-target overlay) supplies the `[provisioning]`
 * baseline; a per-summon directive block overlays it last, so a directive can
 * change what the merge concluded — including the harness, which the provider
 * and harness id must then follow. The overlaid result is what rides the intent
 * as `provision`, verbatim.
 */
describe('T-07398 buildHrcRuntimeIntent — provisioning directive overlay', () => {
  function makeProvisioningAgentDir(): { agentRoot: string; agentId: string } {
    const root = mkdtempSync(join(tmpdir(), 'hrc-sdk-provision-'))
    tempRoots.push(root)
    writeFileSync(
      join(root, 'agent-profile.toml'),
      [
        'version = 3',
        'priming = "private system prompt"',
        '',
        '[provisioning]',
        'harness = "claude-code"',
        'model = "opus"',
        'reasoning = "high"',
        'approval = "never"',
        'remote = true',
        'node = "agent-node"',
        'viewer = "none"',
        '',
      ].join('\n')
    )
    return { agentRoot: root, agentId: 'fixture-agent' }
  }

  function makeProjectTarget(source: string): string {
    const root = mkdtempSync(join(tmpdir(), 'hrc-sdk-provision-project-'))
    tempRoots.push(root)
    writeFileSync(join(root, 'asp-targets.toml'), source)
    return root
  }

  test('directives overlay the merged profile baseline and re-resolve the harness', () => {
    const { agentRoot, agentId } = makeProvisioningAgentDir()

    // No directives: the intent carries the merged profile baseline verbatim.
    const baseline = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      interactive: false,
      preferredMode: 'headless',
    })
    expect(baseline.provision).toMatchObject({
      harness: 'claude-code',
      model: 'opus',
      reasoning: 'high',
      approval: 'never',
      remote: true,
      node: 'agent-node',
      viewer: 'none',
    })
    expect(
      Object.keys(baseline.provision ?? {}).filter(
        (key) => !(PROVISIONING_SCALAR_KEYS as readonly string[]).includes(key)
      )
    ).toEqual([])

    // Directives applied LAST: they win over the merge, and the harness id and
    // provider follow the overlaid harness rather than the profile's.
    const directed = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      interactive: false,
      preferredMode: 'headless',
      provision: { harness: 'codex', model: 'gpt-5.6-sol', reasoning: 'low' },
    })
    expect(directed.provision).toMatchObject({
      harness: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'low',
      // Untouched keys survive the overlay.
      approval: 'never',
      remote: true,
      node: 'agent-node',
      viewer: 'none',
    })
    expect(directed.harness).toMatchObject({ provider: 'openai', id: 'codex-cli' })
  })

  test('canonical merge bag preserves target precedence for node and remote', () => {
    const { agentRoot, agentId } = makeProvisioningAgentDir()
    const projectRoot = makeProjectTarget(
      [
        'schema = 1',
        '',
        '[targets.fixture-agent]',
        'description = "must not become a provisioning scalar"',
        '',
        '[targets.fixture-agent.provisioning]',
        'node = "target-node"',
        'remote = false',
        '',
      ].join('\n')
    )

    const intent = buildHrcRuntimeIntent({ agentId, agentRoot, projectRoot })

    expect(intent.provision).toMatchObject({
      harness: 'claude-code',
      node: 'target-node',
      remote: false,
      viewer: 'none',
    })
    expect(
      Object.keys(intent.provision ?? {}).filter(
        (key) => !(PROVISIONING_SCALAR_KEYS as readonly string[]).includes(key)
      )
    ).toEqual([])
  })

  test('undeclared harness keeps its default while remote keeps its false default', () => {
    const agentRoot = mkdtempSync(join(tmpdir(), 'hrc-sdk-provision-defaults-'))
    tempRoots.push(agentRoot)
    writeFileSync(join(agentRoot, 'agent-profile.toml'), 'version = 3\n')

    const intent = buildHrcRuntimeIntent({ agentId: 'fixture-agent', agentRoot })

    expect(intent.provision).toEqual({
      remote: false,
      harness: 'claude-code',
    })
    expect(Object.hasOwn(intent.provision ?? {}, 'viewer')).toBe(false)
  })
})
