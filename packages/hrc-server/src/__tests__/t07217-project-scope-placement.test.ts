/**
 * T-07217 — node-local project placement uses the checkout root as cwd
 * (T-08597: mapping pinned here with a stubbed observation; policy pinned in
 * hrc-core placement-policy.test.ts; end-to-end scope→placement proved by the
 * placements route parity table).
 */

import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resolveNodeLocalPlacement } from '../federation/summon-capability.js'
import type { NodeLocalPlacementObservation } from '../federation/summon-capability.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const PROJECT_ID = 't07217-fixture'
const SCOPE_REF = `agent:mable:project:${PROJECT_ID}:task:primary`

describe('T-07217 project-scoped spawn placement', () => {
  let fixture: HrcServerTestFixture
  let originalCwd: string
  let originalAgentsRoot: string | undefined
  let workspaceRoot: string
  let projectRoot: string
  let agentRoot: string

  beforeEach(async () => {
    fixture = await createHrcTestFixture('h7217-')
    originalCwd = process.cwd()
    originalAgentsRoot = process.env['ASP_AGENTS_ROOT']
    workspaceRoot = join(fixture.tmpDir, 'collective')
    projectRoot = join(workspaceRoot, PROJECT_ID)
    agentRoot = join(workspaceRoot, 'var', 'agents', 'mable')

    await mkdir(join(projectRoot, '.git'), { recursive: true })
    await mkdir(join(projectRoot, 'packages', 'hrc-server'), { recursive: true })
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(agentRoot, 'agent-profile.toml'), 'version = 3\n')

    workspaceRoot = await realpath(workspaceRoot)
    projectRoot = join(workspaceRoot, PROJECT_ID)
    agentRoot = join(workspaceRoot, 'var', 'agents', 'mable')

    process.chdir(workspaceRoot)
    process.env['ASP_AGENTS_ROOT'] = join(workspaceRoot, 'var', 'agents')
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    if (originalAgentsRoot === undefined) {
      process.env['ASP_AGENTS_ROOT'] = undefined
    } else {
      process.env['ASP_AGENTS_ROOT'] = originalAgentsRoot
    }
    await fixture.cleanup()
  })

  function observe(): NodeLocalPlacementObservation {
    return async () => ({
      agentId: 'mable',
      projectId: PROJECT_ID,
      agentRoot,
      projectRoot,
      cwd: projectRoot,
      bundle: { kind: 'agent-project', agentName: 'mable', projectRoot },
      bundleIdentity: 'test-identity',
      harness: { provider: 'anthropic', frontend: 'claude-code', effectiveHarness: 'claude' },
      provision: { scalars: {} },
      policy: { claimsTask: false, placement: { pins: {}, homes: {} } },
      identity: { operator: false },
      agentSources: { agentsRoot: join(workspaceRoot, 'var', 'agents'), provenance: 'caller' },
      searchedAgentRoots: [agentRoot],
      source: {
        agentProfile: 'valid',
        projectTargets: 'valid',
        selectedTarget: 'absent',
        priming: 'valid',
      },
      resolution: { source: 'marker-scan', reason: 'test' },
      warnings: [],
      release: { releaseId: 'r', sourceCommit: 'c' },
    })
  }

  test('node-local project placement always uses the checkout root as cwd', async () => {
    const resolved = await resolveNodeLocalPlacement(SCOPE_REF, {
      cwd: join(projectRoot, 'packages', 'hrc-server'),
      env: { ASP_AGENTS_ROOT: join(workspaceRoot, 'var', 'agents') },
      observe: observe(),
    })

    expect(resolved.placement).toMatchObject({
      agentRoot,
      projectRoot,
      cwd: projectRoot,
    })
  })
})
