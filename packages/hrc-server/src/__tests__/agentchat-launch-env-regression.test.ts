import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcServer, HrcServerOptions } from '../index'
import { createHrcServer } from '../index'
import { readLaunchArtifact } from '../launch/launch-artifact'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string

function serverOpts(overrides: Partial<HrcServerOptions> = {}): HrcServerOptions {
  return {
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    tmuxSocketPath,
    ...overrides,
  }
}

async function fetchSocket(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    // @ts-expect-error Bun supports unix sockets on fetch
    unix: socketPath,
  })
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetchSocket(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function resolveSession(scopeRef: string): Promise<{
  hostSessionId: string
  generation: number
}> {
  const resolveRes = await postJson('/v1/sessions/resolve', {
    sessionRef: `${scopeRef}/lane:default`,
  })

  expect(resolveRes.status).toBe(200)
  return (await resolveRes.json()) as { hostSessionId: string; generation: number }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-agentchat-launch-env-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })
})

afterEach(async () => {
  try {
    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited
  } catch {
    // fine when the tmux server was never created
  }

  await rm(tmpDir, { recursive: true, force: true })
})

describe('agentchat launch env regression', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) {
      await server.stop()
    }
  })

  it('writes canonical tmux agentchat transport env into launch artifacts', async () => {
    server = await createHrcServer(serverOpts())

    const session = await resolveSession('agent:larry:project:agent-spaces')

    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId: session.hostSessionId,
      intent: {
        placement: {
          agentRoot: '/tmp/larry',
          projectRoot: '/tmp/agent-spaces',
          cwd: '/tmp/agent-spaces',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: {
          provider: 'anthropic',
          interactive: true,
        },
      },
      restartStyle: 'reuse_pty',
    })

    expect(ensureRes.status).toBe(200)

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: session.hostSessionId,
      prompt: 'diagnostic prompt',
    })

    expect(turnRes.status).toBe(200)

    const launchDir = join(runtimeRoot, 'launches')
    const launchFiles = (await readdir(launchDir)).filter((entry) => entry.endsWith('.json'))
    expect(launchFiles).toHaveLength(1)

    const artifact = await readLaunchArtifact(join(launchDir, launchFiles[0]!))
    expect(artifact.env['AGENTCHAT_ID']).toBe('larry')
    expect(artifact.env['ASP_PROJECT']).toBe('agent-spaces')
    expect(artifact.env['AGENTCHAT_TRANSPORT']).toBe('tmux')
    expect(artifact.env['AGENTCHAT_TARGET']).toBe(
      `sock=${tmuxSocketPath};session=hrc-${session.hostSessionId.slice(0, 12)}`
    )
  })
})
