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

/**
 * T-08128. A profile that exists but cannot be parsed degrades to the SAME
 * value an absent profile degrades to, so the returned object cannot carry the
 * proof — these tests assert on the emission, which is the only place the two
 * states are still distinguishable.
 *
 * The must-not-fire half is load-bearing. A change that warns on both states is
 * indistinguishable from one that warns on neither to anyone reading a busy
 * log, so "absent stays silent" is pinned as hard as "broken speaks up".
 */
function captureStderr(run: () => void): { warnings: string[] } {
  const original = console.error
  const warnings: string[] = []
  console.error = (...parts: unknown[]) => {
    warnings.push(parts.map((part) => String(part)).join(' '))
  }
  try {
    run()
  } finally {
    console.error = original
  }
  return { warnings }
}

function makeAgentDirWithProfile(source: string, label: string): string {
  const root = mkdtempSync(join(tmpdir(), `hrc-core-profile-${label}-`))
  tempRoots.push(root)
  writeFileSync(join(root, 'agent-profile.toml'), source)
  return root
}

const BROKEN_PROFILE = 'version = 3\n\n[provisioning\nharness = "claude-code"\nmodel = "sonnet"\n'
const VALID_PROFILE = 'version = 3\n\n[provisioning]\nharness = "claude-code"\nmodel = "sonnet"\n'

describe('resolveAgentHarness — an unparseable profile degrades LOUDLY (T-08128)', () => {
  test('a profile with a syntax error warns, naming agent, path and error', () => {
    const agentRoot = makeAgentDirWithProfile(BROKEN_PROFILE, 'broken')
    let resolved: ReturnType<typeof resolveAgentHarness> | undefined
    const { warnings } = captureStderr(() => {
      resolved = resolveAgentHarness({ agentRoot, agentId: 'slugger' })
    })

    expect(warnings).toHaveLength(1)
    const line = warnings[0] ?? ''
    expect(line).toContain('agent.provisioning.stripped')
    expect(line).toContain('slugger')
    expect(line).toContain(join(agentRoot, 'agent-profile.toml'))
    // The error itself has to travel: without it the reader knows an edit broke
    // the profile but not which edit.
    expect(line).toMatch(/error=\S/)

    // The birth still proceeds — degrading, not failing closed.
    expect(resolved).toMatchObject({ provider: 'anthropic', harness: undefined, provision: {} })
  })

  test('the warning names the CONSEQUENCE, not just the cause', () => {
    const agentRoot = makeAgentDirWithProfile(BROKEN_PROFILE, 'consequence')
    const { warnings } = captureStderr(() => {
      resolveAgentHarness({ agentRoot, agentId: 'slugger' })
    })

    // "failed to parse profile" reads as recoverable and gets skimmed past. The
    // line has to say what the reader actually lost.
    const line = warnings[0] ?? ''
    expect(line).toContain('NO provisioning')
    expect(line).toContain('no model pin')
  })

  test('a broken profile with a project target reports what SURVIVED, not a blanket nothing', () => {
    const agentRoot = makeAgentDirWithProfile(BROKEN_PROFILE, 'partial')
    const projectRoot = mkdtempSync(join(tmpdir(), 'hrc-core-profile-partial-project-'))
    tempRoots.push(projectRoot)
    writeFileSync(
      join(projectRoot, 'asp-targets.toml'),
      [
        'schema = 1',
        '',
        '[targets.slugger]',
        '',
        '[targets.slugger.provisioning]',
        'node = "svc"',
        '',
      ].join('\n')
    )

    let resolved: ReturnType<typeof resolveAgentHarness> | undefined
    const { warnings } = captureStderr(() => {
      resolved = resolveAgentHarness({ agentRoot, agentId: 'slugger', projectRoot })
    })

    const line = warnings[0] ?? ''
    expect(line).toContain('WITHOUT')
    expect(line).toContain('node')
    // A verdict that read "NO provisioning at all" here would be false: the
    // target's pins are still on the agent.
    expect(line).not.toContain('NO provisioning at all')
    expect(resolved).toMatchObject({ provision: { node: 'svc' } })
  })

  test('an ABSENT profile stays silent — the quiet path is preserved', () => {
    const agentRoot = mkdtempSync(join(tmpdir(), 'hrc-core-profile-absent-'))
    tempRoots.push(agentRoot)

    const { warnings } = captureStderr(() => {
      resolveAgentHarness({ agentRoot, agentId: 'slugger' })
    })

    expect(warnings).toEqual([])
  })

  test('an absent profile stays silent even with a project target supplying provisioning', () => {
    const agentRoot = mkdtempSync(join(tmpdir(), 'hrc-core-profile-absent-target-'))
    const projectRoot = mkdtempSync(join(tmpdir(), 'hrc-core-profile-absent-target-project-'))
    tempRoots.push(agentRoot, projectRoot)
    writeFileSync(
      join(projectRoot, 'asp-targets.toml'),
      [
        'schema = 1',
        '',
        '[targets.slugger]',
        '',
        '[targets.slugger.provisioning]',
        'node = "svc"',
        '',
      ].join('\n')
    )

    const { warnings } = captureStderr(() => {
      resolveAgentHarness({ agentRoot, agentId: 'slugger', projectRoot })
    })

    expect(warnings).toEqual([])
  })

  test('a profile that parses cleanly stays silent', () => {
    const agentRoot = makeAgentDirWithProfile(VALID_PROFILE, 'valid')

    let resolved: ReturnType<typeof resolveAgentHarness> | undefined
    const { warnings } = captureStderr(() => {
      resolved = resolveAgentHarness({ agentRoot, agentId: 'slugger' })
    })

    expect(warnings).toEqual([])
    expect(resolved).toMatchObject({ harness: 'claude-code', provision: { model: 'sonnet' } })
  })

  test('the emission is what separates the two states — the return value does not', () => {
    const brokenRoot = makeAgentDirWithProfile(BROKEN_PROFILE, 'twin-broken')
    const absentRoot = mkdtempSync(join(tmpdir(), 'hrc-core-profile-twin-absent-'))
    tempRoots.push(absentRoot)

    let broken: ReturnType<typeof resolveAgentHarness> | undefined
    let absent: ReturnType<typeof resolveAgentHarness> | undefined
    const { warnings } = captureStderr(() => {
      broken = resolveAgentHarness({ agentRoot: brokenRoot, agentId: 'slugger' })
      absent = resolveAgentHarness({ agentRoot: absentRoot, agentId: 'slugger' })
    })

    // This is the defect in one assertion: the two situations are byte-identical
    // downstream, which is why no caller could ever have caught this.
    expect(JSON.stringify(broken)).toEqual(JSON.stringify(absent))
    // ...and exactly one of them speaks.
    expect(warnings).toHaveLength(1)
  })
})

describe('the T-08128 warning stays readable in a busy log', () => {
  test('a multi-line parse error is collapsed onto ONE line', () => {
    // TOML parse errors carry an embedded source excerpt across several lines.
    // Emitted raw, the WARN greps as one hit plus orphaned noise.
    const agentRoot = makeAgentDirWithProfile(BROKEN_PROFILE, 'oneline')
    const { warnings } = captureStderr(() => {
      resolveAgentHarness({ agentRoot, agentId: 'slugger' })
    })

    const line = warnings[0] ?? ''
    expect(line).not.toContain('\n')
    // The error text still has to survive the collapsing.
    expect(line).toContain('TOML')
  })
})
