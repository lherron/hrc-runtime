import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'

import { localizeFederatedRuntimeIntent } from '../federation/runtime-intent-localization.js'
import type { NodeLocalPlacementObservation } from '../federation/summon-capability.js'

const PROJECT_ID = 't06698-fixture'
const SCOPE = `agent:clod:project:${PROJECT_ID}:task:t06698-localize`

describe('T-06698 federated runtime intent localization', () => {
  test('rebuilds origin placement from the accepting node and preserves a project-relative cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'h98-localize-'))
    try {
      const agentsRoot = join(root, 'agents')
      await mkdir(join(agentsRoot, 'clod'), { recursive: true })
      await writeFile(join(agentsRoot, 'clod', 'agent-profile.toml'), 'version = 3\n')
      const checkoutRoot = join(root, 'checkouts')
      const localProjectRoot = join(checkoutRoot, PROJECT_ID)
      await mkdir(join(localProjectRoot, '.git'), { recursive: true })
      const intent: HrcRuntimeIntent = {
        placement: {
          agentRoot: '/origin/praesidium/var/agents/clod',
          projectRoot: `/origin/praesidium/${PROJECT_ID}`,
          cwd: `/origin/praesidium/${PROJECT_ID}/packages/hrc-server`,
          runMode: 'task',
          bundle: {
            kind: 'agent-project',
            agentName: 'clod',
            projectRoot: `/origin/praesidium/${PROJECT_ID}`,
          },
          dryRun: false,
        },
        harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
        execution: { preferredMode: 'interactive' },
      }

      const agentRoot = join(agentsRoot, 'clod')
      const observe: NodeLocalPlacementObservation = async () => ({
        agentId: 'clod',
        projectId: PROJECT_ID,
        agentRoot,
        projectRoot: localProjectRoot,
        cwd: localProjectRoot,
        bundle: { kind: 'agent-project', agentName: 'clod', projectRoot: localProjectRoot },
        bundleIdentity: 'test-identity',
        harness: { provider: 'anthropic', frontend: 'claude-code', effectiveHarness: 'claude' },
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
        resolution: { source: 'marker-scan', reason: 'test' },
        warnings: [],
        release: { releaseId: 'r', sourceCommit: 'c' },
      })

      const localized = await localizeFederatedRuntimeIntent(SCOPE, intent, {
        cwd: checkoutRoot,
        env: { ASP_AGENTS_ROOT: agentsRoot },
        observe,
      })

      expect(localized.placement.agentRoot).toBe(join(agentsRoot, 'clod'))
      expect(localized.placement.projectRoot).toBe(localProjectRoot)
      expect(localized.placement.cwd).toBe(join(localProjectRoot, 'packages', 'hrc-server'))
      expect(localized.placement.bundle).toMatchObject({
        agentName: 'clod',
        projectRoot: localProjectRoot,
      })
      expect(localized.harness).toEqual(intent.harness)
      expect(localized.execution).toEqual(intent.execution)
      expect(JSON.stringify(localized)).not.toContain('/origin/praesidium')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
