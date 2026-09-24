import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installOldEngineDaemon } from '../../__tests__/old-engine-daemon.js'
import { resolveLaunchTarget } from '../resolve-intent.js'

const oldEngineDaemon = installOldEngineDaemon()
afterAll(() => oldEngineDaemon.stop())

describe('resolveLaunchTarget', () => {
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
    await writeFile(join(localAgentRoot, 'agent-profile.toml'), 'version = 3\n', 'utf8')

    const { runtimeIntent } = await resolveLaunchTarget('localbot@project')

    expect(runtimeIntent.placement.agentRoot).toBe(localAgentRoot)
    expect(runtimeIntent.placement.cwd).toBe(projectRoot)
  })

  /**
   * T-07398 DEFECT CYCLE 1, D2 — the turn launch resolver must CARRY the
   * handle's directive block onto the runtime intent it builds.
   *
   * `agent-scope` already parses `+node=...` off the handle and hands it back as
   * `directives`; the turn runtime intent must preserve them as `provision` so
   * the daemon can validate and apply the requested pin/node directives. Without
   * this regression check, `+node=notanode` could birth silently instead of
   * returning UNKNOWN_NODE, and pin-conflicting directives could deliver.
   */
  it('carries the handle directive block onto the runtime intent (T-07398 D2)', async () => {
    const localAgentsRoot = join(projectRoot, 'agents')
    const localAgentRoot = join(localAgentsRoot, 'localbot')
    await mkdir(localAgentRoot, { recursive: true })
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 1\nagents-root = "agents"\n',
      'utf8'
    )
    await writeFile(join(localAgentRoot, 'agent-profile.toml'), 'version = 3\n', 'utf8')

    const { runtimeIntent } = await resolveLaunchTarget(
      'localbot@project:t07402smoke3+node=lab+model=sonnet'
    )

    expect(runtimeIntent.provision).toMatchObject({ node: 'lab', model: 'sonnet' })
  })

  it('reports every searched project-local and canonical agent root when an agent is missing', async () => {
    const localAgentsRoot = join(projectRoot, 'agents')
    await mkdir(localAgentsRoot, { recursive: true })
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 1\nagents-root = "agents"\n',
      'utf8'
    )

    await expect(resolveLaunchTarget('missing@project')).rejects.toThrow(
      `agent "missing" not found; searched: ${join(localAgentsRoot, 'missing')}, ${join(canonicalAgentsRoot, 'missing')}`
    )
  })
})
