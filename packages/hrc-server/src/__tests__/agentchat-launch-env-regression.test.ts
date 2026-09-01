import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcServer, HrcServerOptions } from '../index'
import { createHrcServer } from '../index'
import { createSocketScratch } from './fixtures/socket-scratch'

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
    create: true,
  })

  expect(resolveRes.status).toBe(200)
  return (await resolveRes.json()) as { hostSessionId: string; generation: number }
}

beforeEach(async () => {
  tmpDir = (await createSocketScratch('hrc-chat-env-')).root
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

  it('does not write legacy tmux launch artifacts during broker cutover', async () => {
    server = await createHrcServer(serverOpts())

    const session = await resolveSession('agent:larry:project:agent-spaces')
    const runtimeIntent = {
      placement: {
        agentRoot: '/tmp/larry',
        projectRoot: '/tmp/agent-spaces',
        cwd: '/tmp/agent-spaces',
        runMode: 'task' as const,
        bundle: { kind: 'compose' as const, compose: [] },
        dryRun: true,
      },
      harness: {
        provider: 'openai' as const,
        interactive: true,
      },
    }

    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId: session.hostSessionId,
      intent: runtimeIntent,
      restartStyle: 'reuse_pty',
    })

    expect(ensureRes.status).toBe(503)
    const ensureBody = (await ensureRes.json()) as { error?: { code?: string } }
    expect(ensureBody.error?.code).toBe('runtime_unavailable')

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: session.hostSessionId,
      prompt: 'diagnostic prompt',
      // T-07206 intentionally prevents a rejected ensure from becoming the
      // session's implicit plan, so carry the candidate explicitly here.
      runtimeIntent,
    })

    expect(turnRes.status).toBe(503)

    const launchDir = join(runtimeRoot, 'launches')
    const launchFiles = (await readdir(launchDir).catch(() => [])).filter((entry) =>
      entry.endsWith('.json')
    )
    expect(launchFiles).toHaveLength(0)
  }, 10_000)
})
