import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import type { HrcServerOptions } from '../../index'

export type ResolveSessionResult = {
  hostSessionId: string
  generation: number
}

export type SeedRuntimeResult = ResolveSessionResult & {
  runtimeId: string
}

export type SeedTmuxRuntimePatch = {
  status: string
  launchId?: string | undefined
  activeRunId?: string | undefined
  adopted?: boolean | undefined
}

export type HrcServerTestFixture = {
  tmpDir: string
  runtimeRoot: string
  stateRoot: string
  socketPath: string
  lockPath: string
  spoolDir: string
  dbPath: string
  tmuxSocketPath: string
  now(): string
  fetchSocket(path: string, init?: RequestInit | undefined): Promise<Response>
  postJson(path: string, body: unknown): Promise<Response>
  serverOpts(overrides?: Partial<HrcServerOptions> | undefined): HrcServerOptions
  resolveSession(scopeRef: string): Promise<ResolveSessionResult>
  ensureRuntime(scopeRef: string): Promise<SeedRuntimeResult>
  seedSession(hostSessionId: string, scopeRef: string): void
  seedTmuxRuntime(
    hostSessionId: string,
    scopeRef: string,
    runtimeId: string,
    patch: SeedTmuxRuntimePatch
  ): void
  cleanup(): Promise<void>
}

export async function createHrcTestFixture(prefix: string): Promise<HrcServerTestFixture> {
  const tmpDir = await mkdtemp(join(tmpdir(), prefix))
  const runtimeRoot = join(tmpDir, 'runtime')
  const stateRoot = join(tmpDir, 'state')
  const socketPath = join(runtimeRoot, 'hrc.sock')
  const lockPath = join(runtimeRoot, 'server.lock')
  const spoolDir = join(runtimeRoot, 'spool')
  const dbPath = join(stateRoot, 'state.sqlite')
  const tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })

  function now(): string {
    return new Date().toISOString()
  }

  async function fetchSocket(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://localhost${path}`, {
      ...init,
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

  function toCanonicalScopeRef(input: string): string {
    return input.startsWith('agent:') ? input : `agent:${input}`
  }

  async function resolveSession(scopeRef: string): Promise<ResolveSessionResult> {
    const canonical = toCanonicalScopeRef(scopeRef)
    const res = await postJson('/v1/sessions/resolve', {
      sessionRef: `${canonical}/lane:default`,
    })
    return (await res.json()) as ResolveSessionResult
  }

  async function ensureRuntime(scopeRef: string): Promise<SeedRuntimeResult> {
    const canonical = toCanonicalScopeRef(scopeRef)
    const resolved = await resolveSession(canonical)
    const runtimeId = `rt-test-${randomUUID()}`
    const db = openHrcDatabase(dbPath)
    const timestamp = now()

    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId: resolved.hostSessionId,
        scopeRef: canonical,
        laneRef: 'default',
        generation: resolved.generation,
        transport: 'sdk',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    return { ...resolved, runtimeId }
  }

  function seedSession(hostSessionId: string, scopeRef: string): void {
    const canonical = toCanonicalScopeRef(scopeRef)
    const db = openHrcDatabase(dbPath)
    const timestamp = now()

    try {
      db.sessions.insert({
        hostSessionId,
        scopeRef: canonical,
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
        ancestorScopeRefs: [],
      })
    } finally {
      db.close()
    }
  }

  function seedTmuxRuntime(
    hostSessionId: string,
    scopeRef: string,
    runtimeId: string,
    patch: SeedTmuxRuntimePatch
  ): void {
    const db = openHrcDatabase(dbPath)
    const timestamp = now()

    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef: toCanonicalScopeRef(scopeRef),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: patch.status,
        tmuxJson: {
          socketPath: tmuxSocketPath,
          sessionName: 'hrc-missing-session',
          windowName: 'main',
          sessionId: '$dead',
          windowId: '@dead',
          paneId: '%dead',
        },
        supportsInflightInput: false,
        adopted: patch.adopted ?? false,
        ...(patch.launchId ? { launchId: patch.launchId } : {}),
        ...(patch.activeRunId ? { activeRunId: patch.activeRunId } : {}),
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }
  }

  async function cleanup(): Promise<void> {
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine when no tmux server exists
    }

    await rm(tmpDir, { recursive: true, force: true })
  }

  return {
    tmpDir,
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    tmuxSocketPath,
    now,
    fetchSocket,
    postJson,
    serverOpts,
    resolveSession,
    ensureRuntime,
    seedSession,
    seedTmuxRuntime,
    cleanup,
  }
}
