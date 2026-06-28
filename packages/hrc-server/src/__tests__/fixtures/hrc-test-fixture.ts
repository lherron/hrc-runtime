import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
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
  const ghostmuxSurfaces = new Map<string, Record<string, unknown>>()
  const ghostmuxMetadata = new Map<string, Record<string, unknown>>()
  const ghostmuxWindowMetadata = new Map<string, Record<string, unknown>>()
  let ghostmuxSurfaceSeq = 0

  function createGhostmuxSurface(title: string, cwd: string): Record<string, unknown> {
    ghostmuxSurfaceSeq += 1
    const id = `surface-test-${ghostmuxSurfaceSeq}`
    const surface = {
      id,
      short_id: id.slice(0, 12),
      title,
      name: title,
      working_directory: cwd,
      columns: 120,
      rows: 40,
      focused: false,
    }
    ghostmuxSurfaces.set(id, surface)
    return surface
  }

  function ghostmuxArgAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }

  async function runFakeGhostmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const command = args[0]
    if (command === 'status') return { stdout: JSON.stringify({ ok: true }), stderr: '' }
    if (command === 'list-surfaces') {
      return {
        stdout: JSON.stringify({ terminals: Array.from(ghostmuxSurfaces.values()) }),
        stderr: '',
      }
    }
    if (command === 'new') {
      const cwd = ghostmuxArgAfter(args, '--cwd') ?? tmpDir
      const title = ghostmuxArgAfter(args, '--title') ?? 'Ghostty Test'
      return { stdout: JSON.stringify(createGhostmuxSurface(title, cwd)), stderr: '' }
    }
    if (command === 'new-pane') {
      const cwd = ghostmuxArgAfter(args, '--cwd') ?? tmpDir
      return { stdout: JSON.stringify(createGhostmuxSurface(cwd, cwd)), stderr: '' }
    }
    if (command === 'metadata') {
      const action = args[1]
      const target = ghostmuxArgAfter(args, '-t') ?? ''
      const window = args.includes('--window')
      const store = window ? ghostmuxWindowMetadata : ghostmuxMetadata
      if (action === 'get') {
        return { stdout: JSON.stringify(store.get(target) ?? {}), stderr: '' }
      }
      if (action === 'set') {
        const jsonArg = args.find((arg, index) => index > 1 && arg.startsWith('{')) ?? '{}'
        store.set(target, JSON.parse(jsonArg) as Record<string, unknown>)
        return { stdout: JSON.stringify({ ok: true }), stderr: '' }
      }
    }
    if (command === 'set-title') {
      const target = ghostmuxArgAfter(args, '-t') ?? ''
      const title = args.at(-1) ?? ''
      const surface = ghostmuxSurfaces.get(target)
      if (surface) surface['title'] = title
      return { stdout: JSON.stringify({ ok: true }), stderr: '' }
    }
    if (command === 'kill-surface') {
      const target = ghostmuxArgAfter(args, '-t') ?? ''
      ghostmuxSurfaces.delete(target)
      ghostmuxMetadata.delete(target)
      ghostmuxWindowMetadata.delete(target)
      return { stdout: JSON.stringify({ ok: true }), stderr: '' }
    }
    if (
      command === 'equalize-panes' ||
      command === 'send-keys' ||
      command === 'send-key' ||
      command === 'resize-pane'
    ) {
      return { stdout: JSON.stringify({ ok: true }), stderr: '' }
    }
    if (command === 'capture-pane') return { stdout: 'fake ghostmux capture', stderr: '' }
    return { stdout: JSON.stringify({ ok: true }), stderr: '' }
  }

  // Opt tests into the integration-test harness shim so buildDispatchInvocation
  // can fall back when the real claude/codex binaries aren't on PATH. Production
  // contexts must leave this unset so failures surface instead of silently
  // running a placeholder.
  process.env['HRC_ALLOW_HARNESS_SHIM'] = '1'

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
    const commandRunExitFromStdin = [
      process.execPath,
      '-e',
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const p=d.trim().length>0?JSON.parse(d):{};if(typeof p.stderr==='string')process.stderr.write(p.stderr);process.exit(Number.isInteger(p.expectedExit)?p.expectedExit:0)})",
    ]
    const commandRunWaitForReleaseFile = [
      process.execPath,
      '-e',
      "const fs=require('node:fs');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const p=d.trim().length>0?JSON.parse(d):{};const release=String(p.releasePath||'');const poll=()=>{if(release&&fs.existsSync(release))process.exit(0);setTimeout(poll,10)};poll()})",
    ]
    return {
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath,
      spoolDir,
      dbPath,
      tmuxSocketPath,
      commandRunTargets: {
        'test-command-run-success': {
          launchMode: 'exec',
          argv: commandRunExitFromStdin,
        },
        'test-command-run-failure': {
          launchMode: 'exec',
          argv: commandRunExitFromStdin,
        },
        'test-command-run-wait': {
          launchMode: 'exec',
          argv: commandRunWaitForReleaseFile,
        },
      },
      ghostmuxOptions: { runner: runFakeGhostmux },
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
      create: true,
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
    // Kill the fixture's main tmux server AND every per-runtime broker tmux
    // server under runtimeRoot/btmux. Broker dispatches allocate one tmux
    // server per runtime (allocateBrokerSubstrate); without kill-server here
    // the rm below only unlinks the sockets and the servers — plus the
    // harness panes they host (broker, launch runner, claude) — outlive the
    // test and leak ptys until the machine-wide pty pool is exhausted.
    const tmuxSockets = [tmuxSocketPath]
    try {
      const btmuxDir = join(runtimeRoot, 'btmux')
      for (const entry of await readdir(btmuxDir)) {
        if (entry.endsWith('.sock')) {
          tmuxSockets.push(join(btmuxDir, entry))
        }
      }
    } catch {
      // fine when no broker tmux allocations happened
    }
    for (const socket of tmuxSockets) {
      try {
        const { exited } = Bun.spawn(['tmux', '-S', socket, 'kill-server'], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        await exited
      } catch {
        // fine when no tmux server exists
      }
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
