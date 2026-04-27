import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatScopeHandle, formatSessionHandle, resolveScopeInput } from 'agent-scope'
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { main } from '../cli'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
  }
}

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string
let server: HrcServer | null = null

function serverOpts(): HrcServerOptions {
  return { runtimeRoot, stateRoot, socketPath, lockPath, spoolDir, dbPath, tmuxSocketPath }
}

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HRC_RUNTIME_DIR: runtimeRoot,
    HRC_STATE_DIR: stateRoot,
    ...extra,
  }
}

function captureChunk(chunk: string | ArrayBufferView | ArrayBuffer, chunks: string[]): void {
  if (typeof chunk === 'string') {
    chunks.push(chunk)
    return
  }
  chunks.push(Buffer.from(chunk as ArrayBufferView).toString('utf8'))
}

async function runCli(args: string[], env?: Record<string, string>): Promise<CliResult> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit
  const originalEnv = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(env ?? {})) {
    originalEnv.set(key, process.env[key])
    process.env[key] = value
  }

  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stdoutChunks)
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stdout.write

  process.stderr.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stderrChunks)
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stderr.write

  process.exit = ((code?: number) => {
    throw new CliExit(code ?? 0)
  }) as typeof process.exit

  try {
    await main(args)
    return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode: 0 }
  } catch (error) {
    if (error instanceof CliExit) {
      return {
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode: error.code,
      }
    }
    throw error
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
    for (const [key, value] of originalEnv.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function runCliSubprocess(args: string[], env?: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn(['bun', 'run', CLI_PATH, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { stdout, stderr, exitCode: await proc.exited }
}

async function resolveSession(scopeHandle: string): Promise<{
  scopeRef: string
  scopeHandle: string
  sessionRef: string
  sessionHandle: string
  hostSessionId: string
  generation: number
  laneRef: string
}> {
  const scope = resolveScopeInput(scopeHandle)
  const result = await runCli(['session', 'resolve', '--scope', scope.scopeRef], cliEnv())
  expect(result.exitCode).toBe(0)
  const body = JSON.parse(result.stdout.trim()) as {
    hostSessionId: string
    generation: number
    session: { scopeRef: string; laneRef: string }
  }
  const sessionRef = `${body.session.scopeRef}/lane:${scope.laneId}`
  return {
    scopeRef: body.session.scopeRef,
    scopeHandle: formatScopeHandle(scope.parsed),
    sessionRef,
    sessionHandle: formatSessionHandle({ scopeRef: body.session.scopeRef, laneRef: scope.laneRef }),
    hostSessionId: body.hostSessionId,
    generation: body.generation,
    laneRef: body.session.laneRef,
  }
}

function seedHeadlessRuntime(session: {
  scopeRef: string
  hostSessionId: string
  generation: number
  laneRef: string
}): string {
  const runtimeId = `rt-monitor-show-${randomUUID()}`
  const now = '2026-04-27T15:00:00.000Z'
  const db = openHrcDatabase(dbPath)
  try {
    db.runtimes.insert({
      runtimeId,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      wrapperPid: process.pid,
      childPid: null,
      continuation: null,
      supportsInflightInput: true,
      adopted: false,
      activeRunId: null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })
    db.hrcEvents.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId,
      category: 'runtime',
      eventKind: 'runtime.ready',
      transport: 'headless',
      payload: { source: 'monitor-show-test' },
    })
  } finally {
    db.close()
  }
  return runtimeId
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-monitor-show-test-'))
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
  if (server) {
    await server.stop()
    server = null
  }
  try {
    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited
  } catch {
    // ok when tmux was never started
  }
  await rm(tmpDir, { recursive: true, force: true })
})

describe('hrc monitor show acceptance (T-01289)', () => {
  it('registers hrc monitor show under the monitor command group', async () => {
    const group = await runCli(['monitor', '--help'], cliEnv())
    expect(group.exitCode).toBe(0)
    expect(group.stdout).toMatch(/Usage:/)
    expect(group.stdout).toContain('show')

    const show = await runCli(['monitor', 'show', '--help'], cliEnv())
    expect(show.exitCode).toBe(0)
    expect(show.stdout).toMatch(/Usage:/)
    expect(show.stdout).toContain('[selector]')
    expect(show.stdout).toContain('--json')
  })

  it('prints the default snapshot with daemon, socket, event-log, tmux, runtime, and session counts', async () => {
    server = await createHrcServer(serverOpts())
    const session = await resolveSession('clod@agent-spaces')
    seedHeadlessRuntime(session)

    const result = await runCli(['monitor', 'show'], cliEnv())
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('HRC Monitor Snapshot')
    expect(result.stdout).toMatch(/daemon:\s+healthy/i)
    expect(result.stdout).toContain(socketPath)
    expect(result.stdout).toMatch(/event-log high-water:\s+\d+/i)
    expect(result.stdout).toMatch(/tmux:\s+(available|unavailable)/i)
    expect(result.stdout).toMatch(/sessions:\s+1\b/i)
    expect(result.stdout).toMatch(/runtimes:\s+1\b/i)
  })

  it('prints a selector snapshot for an agent project handle', async () => {
    server = await createHrcServer(serverOpts())
    const session = await resolveSession('clod@agent-spaces')
    const runtimeId = seedHeadlessRuntime(session)

    const result = await runCli(['monitor', 'show', 'clod@agent-spaces'], cliEnv())
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('selector: clod@agent-spaces')
    expect(result.stdout).toContain(`scope: ${session.scopeHandle}`)
    expect(result.stdout).toContain(session.scopeRef)
    expect(result.stdout).toContain(`session: ${session.sessionHandle}`)
    expect(result.stdout).toContain(session.hostSessionId)
    expect(result.stdout).toContain(`runtime: ${runtimeId}`)
  })

  it('emits JSON with canonical scope/session refs plus display handles', async () => {
    server = await createHrcServer(serverOpts())
    const session = await resolveSession('clod@agent-spaces')
    const runtimeId = seedHeadlessRuntime(session)

    const result = await runCli(['monitor', 'show', 'clod@agent-spaces', '--json'], cliEnv())
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const body = JSON.parse(result.stdout.trim()) as {
      scope: { scopeRef: string; scopeHandle: string }
      session: { sessionRef: string; sessionHandle: string }
    }

    expect(body).toMatchObject({
      kind: 'monitor.snapshot',
      selector: {
        input: 'clod@agent-spaces',
        canonical: `scope:${session.scopeRef}`,
      },
      daemon: {
        status: 'healthy',
        socketPath,
      },
      socket: {
        path: socketPath,
        responsive: true,
      },
      eventLog: {
        highWaterSeq: expect.any(Number),
      },
      counts: {
        sessions: 1,
        runtimes: 1,
      },
      scope: {
        scopeRef: session.scopeRef,
        scopeHandle: session.scopeHandle,
      },
      session: {
        scopeRef: session.scopeRef,
        scopeHandle: session.scopeHandle,
        sessionRef: session.sessionRef,
        sessionHandle: session.sessionHandle,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
      },
      runtime: {
        runtimeId,
        hostSessionId: session.hostSessionId,
      },
    })

    expect(body.scope.scopeRef).toBe('agent:clod:project:agent-spaces')
    expect(body.scope.scopeHandle).toBe('clod@agent-spaces')
    expect(body.session.sessionRef).toBe('agent:clod:project:agent-spaces/lane:main')
    expect(body.session.sessionHandle).toBe('clod@agent-spaces')
  })

  it('exits 2 for an invalid selector', async () => {
    const result = await runCli(['monitor', 'show', 'invalid-scope!!'], cliEnv())
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/invalid selector|invalid scope input|usage/i)
  })

  it('exits 3 when the daemon is down or snapshot cannot be read', async () => {
    const result = await runCliSubprocess(['monitor', 'show', '--json'], cliEnv())
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/daemon|snapshot|socket|connect/i)
  })
})
