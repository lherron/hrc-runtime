import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRuntimeIntentForTarget } from '../resolve-intent.js'

describe('resolveRuntimeIntentForTarget', () => {
  let tmp: string
  let canonicalAgentsRoot: string
  let projectRoot: string
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'hrcchat-resolve-intent-'))
    canonicalAgentsRoot = join(tmp, 'canonical-agents')
    projectRoot = join(tmp, 'project')
    await mkdir(canonicalAgentsRoot, { recursive: true })
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\n', 'utf8')
    setEnv('ASP_AGENTS_ROOT', canonicalAgentsRoot)
    setEnv('ASP_PROJECT_ROOT_OVERRIDE', projectRoot)
  })

  afterEach(async () => {
    for (const [key, value] of savedEnv.entries()) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
    savedEnv.clear()
    await rm(tmp, { recursive: true, force: true })
  })

  function setEnv(key: string, value: string): void {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
    process.env[key] = value
  }

  it('uses the resolver-selected project-local agent root', async () => {
    const localAgentsRoot = join(projectRoot, 'agents')
    const localAgentRoot = join(localAgentsRoot, 'localbot')
    await mkdir(localAgentRoot, { recursive: true })
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 1\nagents-root = "agents"\n',
      'utf8'
    )
    await writeFile(
      join(localAgentRoot, 'agent-profile.toml'),
      'schemaVersion = 2\n',
      'utf8'
    )

    const intent = resolveRuntimeIntentForTarget('localbot@project')

    expect(intent.placement.agentRoot).toBe(localAgentRoot)
    expect(intent.placement.cwd).toBe(projectRoot)
  })

  it('reports every searched project-local and canonical agent root when an agent is missing', async () => {
    const localAgentsRoot = join(projectRoot, 'agents')
    await mkdir(localAgentsRoot, { recursive: true })
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 1\nagents-root = "agents"\n',
      'utf8'
    )

    expect(() => resolveRuntimeIntentForTarget('missing@project')).toThrow(
      `agent "missing" not found; searched: ${join(localAgentsRoot, 'missing')}, ${join(canonicalAgentsRoot, 'missing')}`
    )
  })
})
