/** T-08576 R-M1: monitor show can read an app-owned host without inventing agent handles. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { main } from '../cli'

type CliResult = { stdout: string; stderr: string; exitCode: number }

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
  }
}

let root: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let dbPath: string
let server: HrcServer | undefined
let priorShim: string | undefined

beforeEach(async () => {
  priorShim = process.env['HRC_ALLOW_HARNESS_SHIM']
  Reflect.deleteProperty(process.env, 'HRC_ALLOW_HARNESS_SHIM')
  root = await mkdtemp(join(tmpdir(), 't08576-mon-'))
  runtimeRoot = join(root, 'run')
  stateRoot = join(root, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  dbPath = join(stateRoot, 'state.sqlite')
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  await rm(root, { recursive: true, force: true })
  if (priorShim === undefined) Reflect.deleteProperty(process.env, 'HRC_ALLOW_HARNESS_SHIM')
  else process.env['HRC_ALLOW_HARNESS_SHIM'] = priorShim
})

function options(): HrcServerOptions {
  return {
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath: join(runtimeRoot, 'server.lock'),
    spoolDir: join(runtimeRoot, 'spool'),
    dbPath,
    tmuxSocketPath: join(runtimeRoot, 'tmux.sock'),
  }
}

function writeChunk(chunk: string | ArrayBufferView | ArrayBuffer, into: string[]): void {
  into.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as ArrayBufferView).toString())
}

async function runCli(args: string[]): Promise<CliResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const stdoutWrite = process.stdout.write
  const stderrWrite = process.stderr.write
  const exit = process.exit
  const isolatedEnv: Record<string, string | undefined> = {
    HRC_RUNTIME_DIR: runtimeRoot,
    HRC_STATE_DIR: stateRoot,
    HRC_SESSION_REF: undefined,
    HRC_RUN_ID: undefined,
    ASP_SCOPE_REF: undefined,
    ASP_TASK_ID: undefined,
    ASP_DEFAULT_TASK: undefined,
    ASP_HANDLE: undefined,
  }
  const priorEnv = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(isolatedEnv)) {
    priorEnv.set(key, process.env[key])
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer) => {
    writeChunk(chunk, stdout)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | ArrayBufferView | ArrayBuffer) => {
    writeChunk(chunk, stderr)
    return true
  }) as typeof process.stderr.write
  process.exit = ((code?: number) => {
    throw new CliExit(code ?? 0)
  }) as typeof process.exit

  try {
    await main(args)
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: 0 }
  } catch (error) {
    if (error instanceof CliExit) {
      return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: error.code }
    }
    throw error
  } finally {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
    process.exit = exit
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

function seedSession(hostSessionId: string, scopeRef: string, laneRef: string): void {
  const db = openHrcDatabase(dbPath)
  try {
    db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef,
      generation: 1,
      status: 'active',
      createdAt: '2026-09-17T06:45:00.000Z',
      updatedAt: '2026-09-17T06:45:00.000Z',
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: `rt-${hostSessionId}`,
      hostSessionId,
      scopeRef,
      laneRef,
      generation: 1,
      transport: 'headless',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      createdAt: '2026-09-17T06:45:00.000Z',
      updatedAt: '2026-09-17T06:45:00.000Z',
    })
  } finally {
    db.close()
  }
}

describe('T-08576 monitor show app session', () => {
  it('R-M1 exits zero for host:<app hsid>, emits scopeRef, and emits no agent handles', async () => {
    server = await createHrcServer(options())
    const hostSessionId = `hsid-${randomUUID()}`
    seedSession(hostSessionId, 'app:t08576', 'assistant')

    const seeded = openHrcDatabase(dbPath)
    try {
      expect(seeded.runtimes.getByRuntimeId(`rt-${hostSessionId}`)).toMatchObject({
        hostSessionId,
        scopeRef: 'app:t08576',
        laneRef: 'assistant',
        generation: 1,
      })
    } finally {
      seeded.close()
    }

    const result = await runCli(['monitor', 'show', `host:${hostSessionId}`, '--json'])

    let body: Record<string, unknown> | undefined
    try {
      body = JSON.parse(result.stdout) as Record<string, unknown>
    } catch {
      body = undefined
    }
    const serialized = body === undefined ? '' : JSON.stringify(body)
    expect({
      exitCode: result.exitCode,
      scopeRef: (body?.['scope'] as { scopeRef?: string } | undefined)?.scopeRef,
      hasScopeHandle: serialized.includes('scopeHandle'),
      hasSessionHandle: serialized.includes('sessionHandle'),
    }).toEqual({
      exitCode: 0,
      scopeRef: 'app:t08576',
      hasScopeHandle: false,
      hasSessionHandle: false,
    })
  })

  it('control preserves the existing unfiltered monitor snapshot', async () => {
    server = await createHrcServer(options())
    const result = await runCli(['monitor', 'show', '--json'])
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: '',
    })
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'monitor.snapshot' })
  })
})
