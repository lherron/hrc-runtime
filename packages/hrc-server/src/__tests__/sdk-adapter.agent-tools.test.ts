import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import type { RunTurnNonInteractiveRequest, RunTurnNonInteractiveResponse } from 'agent-spaces'
import type { HrcRuntimeIntent } from 'hrc-core'
import { getProjectStorageId } from 'spaces-config'

import { runSdkTurn } from '../agent-spaces-adapter/sdk-adapter'

const tmpDirs: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

async function writeTool(agentRoot: string, name: string): Promise<void> {
  const toolsBinDir = join(agentRoot, 'tools', 'bin')
  await mkdir(toolsBinDir, { recursive: true })
  const toolPath = join(toolsBinDir, name)
  await writeFile(toolPath, '#!/bin/sh\nprintf tool-ok\\n')
  await chmod(toolPath, 0o755)
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('runSdkTurn agent tool env', () => {
  test('injects agent tool runtime env before calling the SDK runner', async () => {
    const agentRoot = await createTempDir('hrc-sdk-agent-')
    const projectRoot = await createTempDir('hrc-sdk-project-')
    await writeTool(agentRoot, 'sparky-spark')

    const intent: HrcRuntimeIntent = {
      placement: {
        agentRoot,
        projectRoot,
        cwd: projectRoot,
        runMode: 'task',
        dryRun: true,
        bundle: { kind: 'agent-default' },
        correlation: {
          sessionRef: {
            scopeRef: 'agent:sparky:project:agent-spaces:task:tool-env-test',
            laneRef: 'main',
          },
        },
      },
      harness: {
        provider: 'anthropic',
        interactive: false,
      },
      launch: {
        env: {
          CUSTOM_SDK_ENV: 'from-launch',
        },
        pathPrepend: ['/custom/bin'],
      },
    }
    let captured: RunTurnNonInteractiveRequest | undefined

    await runSdkTurn({
      intent,
      hostSessionId: 'hs-tool-env-test',
      runId: 'run-tool-env-test',
      runtimeId: 'rt-tool-env-test',
      prompt: 'check env',
      scopeRef: 'agent:sparky:project:agent-spaces:task:tool-env-test',
      laneRef: 'main',
      generation: 1,
      runner: async (request): Promise<RunTurnNonInteractiveResponse> => {
        captured = request
        return {
          provider: 'anthropic',
          frontend: request.frontend,
          model: request.model,
          result: { success: true, finalOutput: 'ok' },
        }
      },
    })

    if (!captured) {
      throw new Error('SDK runner was not called')
    }

    const toolsBinDir = join(agentRoot, 'tools', 'bin')
    const projectId = getProjectStorageId(projectRoot)

    expect(captured.env).toMatchObject({
      ASP_AGENT_ROOT: agentRoot,
      ASP_AGENT_NAME: agentRoot.split('/').at(-1),
      ASP_AGENT_TOOLS_DIR: join(agentRoot, 'tools'),
      ASP_AGENT_TOOLS_BIN: toolsBinDir,
      ASP_AGENT_STATE_DIR: join(agentRoot, 'var', 'state'),
      ASP_AGENT_CACHE_DIR: join(agentRoot, 'var', 'cache'),
      ASP_AGENT_LOG_DIR: join(agentRoot, 'var', 'logs'),
      ASP_PROJECT_ROOT: projectRoot,
      ASP_PROJECT_ID: projectId,
      ASP_PROJECT_STATE_DIR: join(agentRoot, 'var', 'state', 'projects', projectId),
      HRC_SESSION_REF: 'agent:sparky:project:agent-spaces:task:tool-env-test/main',
      CUSTOM_SDK_ENV: 'from-launch',
    })
    expect(captured.env?.['PATH']?.split(delimiter).slice(0, 2)).toEqual([
      toolsBinDir,
      '/custom/bin',
    ])
  })
})
