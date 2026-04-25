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

describe('harnessStringToHarnessId', () => {
  it('maps "pi" profile harness to HrcHarness "pi-cli"', () => {
    expect(harnessStringToHarnessId('pi')).toBe('pi-cli')
  })

  it('maps "codex" profile harness to HrcHarness "codex-cli"', () => {
    expect(harnessStringToHarnessId('codex')).toBe('codex-cli')
  })

  it('maps "claude" profile harness to HrcHarness "claude-code"', () => {
    expect(harnessStringToHarnessId('claude')).toBe('claude-code')
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

  it('falls back gracefully when no profile exists', () => {
    const result = resolveAgentHarness(join(tmp, 'no-profile'), 'missing')
    expect(result.provider).toBe('anthropic')
    expect(result.harness).toBeUndefined()
    expect(harnessStringToHarnessId(result.harness)).toBeUndefined()
  })
})
