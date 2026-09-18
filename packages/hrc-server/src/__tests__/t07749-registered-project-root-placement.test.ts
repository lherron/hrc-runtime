/**
 * T-07749 — node-local placement mapping (T-08597: policy runs in the
 * placements resolver, pinned in hrc-core placement-policy.test.ts; ASP facts
 * arrive via observation, proved by the route parity table).
 *
 * These pin resolveNodeLocalPlacement's own rules: a project-bearing scope
 * launches AT the checkout root (never the discovery cwd), unresolvable
 * projects report the candidate path (not a bogus root), and a missing agent
 * reports the searched roots. The live failure that motivated T-07749 —
 * registry-honoring for checkouts the cwd walk-up cannot reach — is covered by
 * the hrc-core registry/marker/sibling tests plus the placements route parity.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { resolveNodeLocalPlacement } from '../federation/summon-capability.js'
import type { NodeLocalPlacementObservation } from '../federation/summon-capability.js'

describe('node-local placement mapping', () => {
  let root: string
  let agentsRoot: string
  let env: Record<string, string | undefined>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't07749-'))
    agentsRoot = join(root, 'var', 'agents')
    const agentRoot = join(agentsRoot, 'probe')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(
      join(agentRoot, 'agent-profile.toml'),
      ['version = 3', '', '[identity]', '[provisioning]', 'harness = "codex"', ''].join('\n')
    )
    env = { HOME: root, ASP_AGENTS_ROOT: agentsRoot }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function observeWith(projectRoot: string | undefined): NodeLocalPlacementObservation {
    const agentRoot = join(agentsRoot, 'probe')
    return async () => ({
      agentId: 'probe',
      projectId: 'agents',
      agentRoot,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      cwd: projectRoot ?? agentRoot,
      bundle: {
        kind: 'agent-project',
        agentName: 'probe',
        ...(projectRoot !== undefined ? { projectRoot } : {}),
      },
      bundleIdentity: 'test-identity',
      harness: { provider: 'openai', frontend: 'codex-cli', effectiveHarness: 'codex' },
      provision: { scalars: {} },
      policy: { claimsTask: false, placement: { pins: {}, homes: {} } },
      identity: { operator: false },
      agentSources: { agentsRoot, provenance: 'caller' },
      searchedAgentRoots: [agentRoot],
      source: {
        agentProfile: 'valid',
        projectTargets: 'valid',
        selectedTarget: 'absent',
        priming: 'valid',
      },
      resolution: { source: 'wrkq-registry', reason: 'test' },
      warnings: [],
      release: { releaseId: 'r', sourceCommit: 'c' },
    })
  }

  test('a project-bearing scope launches AT the checkout root, never the discovery cwd', async () => {
    const resolution = await resolveNodeLocalPlacement('agent:probe:project:agents:task:T-07749', {
      env,
      cwd: root,
      observe: observeWith(agentsRoot),
    })

    expect(resolution.unresolvableProjectPath).toBeUndefined()
    expect(resolution.placement?.projectRoot).toBe(agentsRoot)
    expect(resolution.placement?.cwd).toBe(agentsRoot)
    expect(resolution.placement?.agentRoot).toBe(join(agentsRoot, 'probe'))
    expect(resolution.effectiveHarness).toBe('codex')
  })

  test('an observation failure reports the unresolvable path, not a bogus root', async () => {
    const resolution = await resolveNodeLocalPlacement('agent:probe:project:agents:task:T-07749', {
      env,
      cwd: root,
      observe: async () => {
        throw new Error('project root unknown for agents')
      },
    })

    expect(resolution.placement).toBeUndefined()
    expect(resolution.unresolvableProjectPath).toBe(join(root, 'agents'))
  })

  test('an unknown agent reports the searched roots', async () => {
    const resolution = await resolveNodeLocalPlacement('agent:probe:project:agents:task:T-07749', {
      env,
      cwd: root,
      observe: async () => {
        throw new HrcDomainError(HrcErrorCode.DECLARATION_INVALID, 'agent "probe" was not found', {
          source: 'agent-profile',
          producerCode: 'agent_not_found',
          searchedAgentRoots: [join(agentsRoot, 'probe')],
        })
      },
    })

    expect(resolution.placement).toBeUndefined()
    expect(resolution.missingAgentPath).toBe(join(agentsRoot, 'probe'))
  })
})
