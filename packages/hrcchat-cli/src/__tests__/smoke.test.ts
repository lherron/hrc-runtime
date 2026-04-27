import { afterEach, describe, expect, it } from 'bun:test'
import type { HrcMessageRecord, SemanticDmRequest, SemanticDmResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { join } from 'node:path'
import { CliUsageError } from 'cli-kit'

import { cmdDm } from '../commands/dm.js'
import type { DmOptions } from '../commands/dm.js'

const MAIN_TS = join(import.meta.dir, '..', 'main.ts')

type CliResult = {
  exitCode: number
  stdout: string
  stderr: string
  json?: unknown
}

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

const savedEnv = {
  ASP_PROJECT: process.env['ASP_PROJECT'],
  HRC_SESSION_REF: process.env['HRC_SESSION_REF'],
}

afterEach(() => {
  restoreEnv('ASP_PROJECT', savedEnv.ASP_PROJECT)
  restoreEnv('HRC_SESSION_REF', savedEnv.HRC_SESSION_REF)
})

describe('hrcchat CLI smoke fixture', () => {
  it('hrcchat info exits 0 and prints command help', async () => {
    const result = await runMain(['info'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('COMMANDS')
    expect(result.stdout).toContain('dm')
    expect(result.stdout).toContain('wait')
  })

  it('hrcchat dm <target> "msg" exits 0 with a structured response', async () => {
    const client = createDmClient()
    const opts: DmOptions = { json: true }
    const result = await runCommand(() => cmdDm(client.client, opts, ['human', 'hello']))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.json).toMatchObject({
      request: {
        messageId: 'msg-request',
        messageSeq: 42,
        body: 'hello',
      },
    })
    expect(client.requests[0]).toMatchObject({
      body: 'hello',
      to: { kind: 'entity', entity: 'human' },
      createIfMissing: true,
    })
  })

  it('hrcchat dm with no args exits 2 (usage error) and reports usage context', async () => {
    const client = createDmClient()
    const opts: DmOptions = {}
    const result = await runCommand(() => cmdDm(client.client, opts, []))

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('missing required argument')
    expect(result.stderr).toContain('<target>')
  })

  it('hrcchat dm <target> --timeout 30s parses duration and succeeds', async () => {
    const client = createDmClient()
    const opts: DmOptions = { timeout: 30_000, json: true }
    const result = await runCommand(() => cmdDm(client.client, opts, ['human', 'hello']))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.json).toMatchObject({ request: { body: 'hello' } })
    expect(client.requests[0]?.wait).toEqual({ enabled: true, timeoutMs: 30_000 })
  })

  it('hrcchat dm <target> --timeout invalid exits 2 (usage error) with error envelope', async () => {
    // Duration parsing now happens at the commander layer via parseDuration.
    // Invalid input throws CliUsageError which the central handler maps to exit 2.
    const result = await runMain(['dm', 'human', 'hello', '--timeout', 'invalid'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('invalid duration')
    expect(result.stderr).toContain('expected')
  })

  it('hrcchat <unknown-verb> exits 2 (usage error) and mentions the command', async () => {
    const result = await runMain(['definitely-not-a-command'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    // Commander reports "error: unknown command 'definitely-not-a-command'"
    expect(result.stderr).toContain('definitely-not-a-command')
  })

  it('hrcchat dm (no target, subprocess) exits 2 for missing required arg', async () => {
    const result = await runMain(['dm'])

    expect(result.exitCode).toBe(2)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name)
  } else {
    process.env[name] = value
  }
}

async function runMain(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: ['bun', MAIN_TS, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ASP_PROJECT: 'agent-spaces',
    },
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return withJson({ exitCode, stdout, stderr })
}

async function runCommand(fn: () => Promise<void> | void): Promise<CliResult> {
  let stdout = ''
  let stderr = ''
  let exitCode = 0

  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit

  process.env['ASP_PROJECT'] = 'agent-spaces'
  Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  process.exit = ((code?: string | number | null) => {
    const numericCode = typeof code === 'number' ? code : Number.parseInt(String(code ?? 0), 10)
    throw new CliExit(Number.isFinite(numericCode) ? numericCode : 1)
  }) as typeof process.exit

  try {
    await fn()
  } catch (err) {
    if (err instanceof CliExit) {
      exitCode = err.code
    } else if (err instanceof CliUsageError) {
      // In-process tests: handlers throw CliUsageError instead of calling fatal().
      // Mirror exitWithError behavior inline (can't call it — it calls process.exit which
      // would throw CliExit inside this catch block, escaping to the caller).
      stderr += `hrcchat: ${err.message}\n`
      exitCode = 2
    } else {
      throw err
    }
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
  }

  return withJson({ exitCode, stdout, stderr })
}

function withJson(result: Omit<CliResult, 'json'>): CliResult {
  const trimmed = result.stdout.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return result
  }
  return { ...result, json: JSON.parse(trimmed) as unknown }
}

function createDmClient(): { client: HrcClient; requests: SemanticDmRequest[] } {
  const requests: SemanticDmRequest[] = []
  return {
    requests,
    client: {
      async semanticDm(request: SemanticDmRequest): Promise<SemanticDmResponse> {
        requests.push(request)
        return {
          request: makeMessageRecord({
            body: request.body,
            from: request.from,
            to: request.to,
          }),
        }
      },
    } as HrcClient,
  }
}

function makeMessageRecord(
  overrides: Pick<HrcMessageRecord, 'body' | 'from' | 'to'>
): HrcMessageRecord {
  return {
    messageSeq: 42,
    messageId: 'msg-request',
    createdAt: '2026-04-27T00:00:00.000Z',
    kind: 'dm',
    phase: 'request',
    from: overrides.from,
    to: overrides.to,
    rootMessageId: 'msg-request',
    body: overrides.body,
    bodyFormat: 'text/plain',
    execution: { status: 'queued' },
  }
}
