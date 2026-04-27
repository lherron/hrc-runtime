import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'
import { main } from '../cli'

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

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-cli-smoke-'))
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
  await rm(tmpDir, { recursive: true, force: true })
})

describe('hrc-cli commander migration smoke fixtures', () => {
  it('monitor show --json exposes snapshot counters', async () => {
    server = await createHrcServer(serverOpts())

    const result = await runCli(['monitor', 'show', '--json'], cliEnv())

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: 'monitor.snapshot',
      daemon: { status: 'healthy' },
      counts: {
        sessions: expect.any(Number),
        runtimes: expect.any(Number),
      },
    })
  })

  it('top-level --help is human-readable and lists the command groups', async () => {
    const result = await runCli(['--help'], cliEnv())
    const output = result.stdout + result.stderr

    expect(result.exitCode).toBe(0)
    expect(output).toMatch(/usage:\s+hrc/i)
    for (const command of [
      'server',
      'session',
      'monitor',
      'runtime',
      'launch',
      'start',
      'run',
      'turn',
      'surface',
      'bridge',
    ]) {
      expect(output).toContain(command)
    }
  })

  it('monitor watch validates replay cursor before reading monitor state', async () => {
    const result = await runCli(['monitor', 'watch', '--from-seq', '-1'], cliEnv())

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('positive integer')
  })

  it('runtime list accepts duration filters', async () => {
    server = await createHrcServer(serverOpts())

    const result = await runCli(['runtime', 'list', '--older-than', '5m', '--json'], cliEnv())

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual([])
  })

  it('bad integer flags exit non-zero with the usage error message intact', async () => {
    const result = await runCli(['server', 'stop', '--timeout-ms', '0'], cliEnv())

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('--timeout-ms must be an integer >= 1')
  })

  it('unknown verbs exit non-zero and report the unknown command', async () => {
    const result = await runCli(['definitely-not-a-command'], cliEnv())

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('unknown command: definitely-not-a-command')
  })
})
