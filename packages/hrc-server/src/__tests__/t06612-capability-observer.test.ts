import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createSummonCapabilityObserver } from '../federation/summon-capability.js'
import type { SummonCapabilityHint } from '../federation/summon-gate.js'

const SCOPE = 'agent:probe:project:fixture-project:task:T-06612'

describe('node materialization capability observer', () => {
  let root: string
  let projectRoot: string
  let agentRoot: string
  let userHome: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hrc-t06612-capability-'))
    projectRoot = join(root, 'fixture-project')
    agentRoot = join(root, 'agents', 'probe')
    userHome = join(root, 'home')
    await mkdir(projectRoot, { recursive: true })
    await mkdir(agentRoot, { recursive: true })
    await mkdir(userHome, { recursive: true })
    await writeFile(join(agentRoot, 'SOUL.md'), '# Probe\n')
    await writeFile(
      join(agentRoot, 'agent-profile.toml'),
      [
        'schemaVersion = 2',
        '',
        '[identity]',
        'harness = "codex"',
        '',
        '[spaces]',
        'base = []',
        '',
      ].join('\n')
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function hint(overrides: Partial<SummonCapabilityHint> = {}): SummonCapabilityHint {
    return {
      placement: {
        agentRoot,
        projectRoot,
        cwd: projectRoot,
        runMode: 'task',
        bundle: { kind: 'agent-project', agentName: 'probe', projectRoot },
      },
      harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
      ...overrides,
    }
  }

  test('capable when checkout, agent composition, credentials, and harness are present', async () => {
    await mkdir(join(userHome, '.codex'), { recursive: true })
    await writeFile(join(userHome, '.codex', 'auth.json'), '{}')
    const observer = createSummonCapabilityObserver({
      env: {},
      userHome,
      detectHarness: async () => ({ available: true }),
    })

    expect(await observer(SCOPE, hint())).toEqual({ outcome: 'capable' })
  })

  test('missing project checkout names the exact path and fix without consulting wrkq', async () => {
    const missing = join(root, 'unregistered-but-absent')
    const observer = createSummonCapabilityObserver({
      env: { OPENAI_API_KEY: 'present-but-never-logged' },
      userHome,
      detectHarness: async () => ({ available: true }),
    })

    const result = await observer(
      SCOPE,
      hint({
        placement: {
          agentRoot,
          projectRoot: missing,
          cwd: missing,
          runMode: 'task',
          bundle: { kind: 'agent-project', agentName: 'probe', projectRoot: missing },
        },
      })
    )

    expect(result).toMatchObject({
      outcome: 'incapable',
      capability: 'project-checkout',
      capabilitySource: 'presence-heuristic',
    })
    if (result.outcome !== 'incapable') throw new Error('unreachable')
    expect(result.diagnostic).toContain(missing)
    expect(result.diagnostic).toContain('clone or sync')
    expect(result.diagnostic).not.toContain('wrkq')
  })

  test('missing agent home names the searched home and fix', async () => {
    const missing = join(root, 'agents', 'absent-probe')
    const observer = createSummonCapabilityObserver({
      env: { OPENAI_API_KEY: 'present-but-never-logged' },
      userHome,
      detectHarness: async () => ({ available: true }),
    })

    const result = await observer(
      SCOPE,
      hint({
        placement: {
          agentRoot: missing,
          projectRoot,
          cwd: projectRoot,
          runMode: 'task',
          bundle: { kind: 'agent-project', agentName: 'probe', projectRoot },
        },
      })
    )

    expect(result).toMatchObject({ outcome: 'incapable', capability: 'agent-home-skills' })
    if (result.outcome !== 'incapable') throw new Error('unreachable')
    expect(result.diagnostic).toContain(missing)
    expect(result.diagnostic).toContain('agent home/skills')
  })

  test('missing credentials names the artifact and operator action without leaking values', async () => {
    const observer = createSummonCapabilityObserver({
      env: {},
      userHome,
      detectHarness: async () => ({ available: true }),
    })

    const result = await observer(SCOPE, hint())

    expect(result).toMatchObject({ outcome: 'incapable', capability: 'credentials' })
    if (result.outcome !== 'incapable') throw new Error('unreachable')
    expect(result.diagnostic).toContain('OPENAI_API_KEY')
    expect(result.diagnostic).toContain('~/.codex/auth.json')
    expect(result.diagnostic).toContain('codex login')
  })

  test('anthropic onboarding marker is read only as a boolean presence heuristic', async () => {
    await writeFile(
      join(userHome, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true })
    )
    const observer = createSummonCapabilityObserver({
      env: {},
      userHome,
      detectHarness: async () => ({ available: true }),
    })
    const anthropic = hint({
      harness: { provider: 'anthropic', interactive: false, id: 'claude-code' },
    })

    expect(await observer(SCOPE, anthropic)).toEqual({ outcome: 'capable' })
  })

  test('missing harness names the selected harness and detector detail', async () => {
    await mkdir(join(userHome, '.codex'), { recursive: true })
    await writeFile(join(userHome, '.codex', 'auth.json'), '{}')
    const observer = createSummonCapabilityObserver({
      env: {},
      userHome,
      detectHarness: async () => ({ available: false, error: 'binary not found' }),
    })

    const result = await observer(SCOPE, hint())

    expect(result).toMatchObject({ outcome: 'incapable', capability: 'harness' })
    if (result.outcome !== 'incapable') throw new Error('unreachable')
    expect(result.diagnostic).toContain('codex')
    expect(result.diagnostic).toContain('binary not found')
    expect(result.diagnostic).toContain('install')
  })
})
