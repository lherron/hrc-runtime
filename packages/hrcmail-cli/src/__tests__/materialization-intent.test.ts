import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveMailDeliveryTarget } from '../identity.js'

describe('hrcmail materialization hint', () => {
  let tmp: string
  let projectRoot: string
  let agentRoot: string
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'hrcmail-materialization-'))
    projectRoot = join(tmp, 'hrc-runtime')
    agentRoot = join(projectRoot, 'agents', 'mailbot')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 1\nagents-root = "agents"\n',
      'utf8'
    )
    await writeFile(
      join(agentRoot, 'agent-profile.toml'),
      'schemaVersion = 2\n\n[identity]\nharness = "codex"\n',
      'utf8'
    )
    setEnv('ASP_PROJECT', 'hrc-runtime')
    setEnv('ASP_PROJECT_ROOT_OVERRIDE', projectRoot)
    setEnv('HRC_SESSION_REF', 'agent:cody:project:hrc-runtime:task:T-06810/lane:main')
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

  it('persists the profile-derived noninteractive intent needed for an unborn target', () => {
    const resolved = resolveMailDeliveryTarget('mailbot')

    expect(resolved.targetSessionRef).toBe(
      'agent:mailbot:project:hrc-runtime:task:T-06810/lane:main'
    )
    expect(resolved.materializationIntent).toMatchObject({
      placement: {
        agentRoot,
        projectRoot,
        cwd: projectRoot,
        runMode: 'task',
      },
      harness: {
        provider: 'openai',
        id: 'codex-cli',
        interactive: false,
      },
      execution: { preferredMode: 'nonInteractive' },
    })
  })
})
