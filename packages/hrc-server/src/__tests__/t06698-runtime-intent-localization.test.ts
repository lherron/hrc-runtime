import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'

import { localizeFederatedRuntimeIntent } from '../federation/runtime-intent-localization.js'

const SCOPE = 'agent:clod:project:hrc-runtime:task:t06698-localize'

describe('T-06698 federated runtime intent localization', () => {
  test('rebuilds origin placement from the accepting node and preserves a project-relative cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'h98-localize-'))
    try {
      const agentsRoot = join(root, 'agents')
      await mkdir(join(agentsRoot, 'clod'), { recursive: true })
      await writeFile(join(agentsRoot, 'clod', 'agent-profile.toml'), 'schemaVersion = 2\n')
      const localProjectRoot = join(import.meta.dir, '..', '..', '..', '..')
      const intent: HrcRuntimeIntent = {
        placement: {
          agentRoot: '/origin/praesidium/var/agents/clod',
          projectRoot: '/origin/praesidium/hrc-runtime',
          cwd: '/origin/praesidium/hrc-runtime/packages/hrc-server',
          runMode: 'task',
          bundle: {
            kind: 'agent-project',
            agentName: 'clod',
            projectRoot: '/origin/praesidium/hrc-runtime',
          },
          dryRun: false,
        },
        harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
        execution: { preferredMode: 'interactive' },
      }

      const localized = localizeFederatedRuntimeIntent(SCOPE, intent, {
        cwd: localProjectRoot,
        env: { ...process.env, ASP_AGENTS_ROOT: agentsRoot },
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
