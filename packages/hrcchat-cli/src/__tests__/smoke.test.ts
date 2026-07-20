import { afterEach, describe, expect, it } from 'bun:test'
import {
  type DispatchTurnBySelectorResponse,
  HrcDomainError,
  type HrcMessageRecord,
  type SemanticDmRequest,
  type SemanticDmResponse,
  parseSelector,
} from 'hrc-core'
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
  HRC_BIRTH_CREDENTIAL: process.env['HRC_BIRTH_CREDENTIAL'],
}

afterEach(() => {
  restoreEnv('ASP_PROJECT', savedEnv.ASP_PROJECT)
  restoreEnv('HRC_SESSION_REF', savedEnv.HRC_SESSION_REF)
  restoreEnv('HRC_BIRTH_CREDENTIAL', savedEnv.HRC_BIRTH_CREDENTIAL)
})

describe('hrcchat CLI smoke fixture', () => {
  it('hrcchat info exits 0 and prints command help', async () => {
    const result = await runMain(['info'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('COMMANDS')
    expect(result.stdout).toContain('dm')
    expect(result.stdout).toContain('hrc monitor wait')
    expect(result.stdout).not.toContain('\n  watch             ')
    expect(result.stdout).not.toContain('\n  wait              ')
    expect(result.stdout).not.toContain('\n  status            ')
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

  it('does not turn an ambient runtime credential into DM child-birth authority', async () => {
    process.env['HRC_BIRTH_CREDENTIAL'] = 'rt-ambient-parent'
    const client = createDmClient()

    const result = await runCommand(() =>
      cmdDm(client.client, { json: true }, ['cody@agent-spaces:T-06674', 'ordinary dm'])
    )

    expect(result.exitCode).toBe(0)
    expect(client.requests).toHaveLength(1)
    expect(client.requests[0]).not.toHaveProperty('birthCredential')
  })

  it('hrcchat dm --json emits required monitor handoff fields at top level', async () => {
    const sessionRef = 'agent:cody:project:agent-spaces:task:T-01293/lane:main'
    const client = createDmClient({
      requestExecution: {
        state: 'started',
        sessionRef,
        runtimeId: 'rt-json-handoff',
        runId: 'turn-json-handoff',
      },
    })
    const result = await runCommand(() =>
      cmdDm(client.client, { json: true }, ['cody@agent-spaces:T-01293', 'hello'])
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.json).toBeObject()

    const payload = result.json as Record<string, unknown>
    expect(Object.hasOwn(payload, 'messageId')).toBe(true)
    expect(Object.hasOwn(payload, 'seq')).toBe(true)
    expect(Object.hasOwn(payload, 'to')).toBe(true)
    expect(Object.hasOwn(payload, 'sessionRef')).toBe(true)

    expect(payload.messageId).toBe('msg-request')
    expect(payload.seq).toBe(42)
    expect(payload.to).toBe('cody@agent-spaces:T-01293')
    expect(payload.sessionRef).toBe(sessionRef)
    expect(payload.runtimeId).toBe('rt-json-handoff')
    expect(payload.turnId).toBe('turn-json-handoff')
  })

  it('hrcchat dm --json sessionRef parses through F0 monitor selector grammar', async () => {
    const sessionRef = 'agent:cody:project:agent-spaces:task:T-01293/lane:main'
    const client = createDmClient({
      requestExecution: {
        state: 'accepted',
        sessionRef,
      },
    })
    const result = await runCommand(() =>
      cmdDm(client.client, { json: true }, ['cody@agent-spaces:T-01293', 'hello'])
    )

    const payload = result.json as Record<string, unknown>
    expect(typeof payload.sessionRef).toBe('string')
    expect(() => parseSelector(`session:${payload.sessionRef}`)).not.toThrow()
    expect(parseSelector(`session:${payload.sessionRef}`)).toMatchObject({
      kind: 'session',
      sessionRef,
    })
  })

  it('hrcchat dm --json includes runtimeId for live summoned targets', async () => {
    const sessionRef = 'agent:cody:project:agent-spaces:task:T-01298/lane:main'
    const client = createDmClient({
      requestExecution: {
        state: 'started',
        sessionRef,
        runtimeId: 'rt-live-summoned',
      },
    })
    const result = await runCommand(() =>
      cmdDm(client.client, { json: true }, ['cody@agent-spaces:T-01298', 'hello'])
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')

    const payload = result.json as Record<string, unknown>
    expect(payload.runtimeId).toBeString()
    expect(payload.runtimeId).toBe('rt-live-summoned')
  })

  it('hrcchat dm --json populates runtimeId from request.execution for live summoned target', async () => {
    // Simulates the tmux-delivery path: no top-level execution response, but the
    // server re-reads the record so request.execution.runtimeId is populated.
    const sessionRef = 'agent:cody:project:agent-spaces:task:T-01298/lane:main'
    const client = createDmClient({
      requestExecution: {
        state: 'completed',
        sessionRef,
        hostSessionId: 'hsid-live-target',
        generation: 4,
        runtimeId: 'rt-live-summoned',
        transport: 'tmux',
      },
    })
    const result = await runCommand(() =>
      cmdDm(client.client, { json: true }, ['cody@agent-spaces:T-01298', 'hello'])
    )

    expect(result.exitCode).toBe(0)
    const payload = result.json as Record<string, unknown>
    expect(payload.runtimeId).toBe('rt-live-summoned')
    expect(payload.turnId).toBeNull() // turnId not assigned at message-create time
  })

  it('hrcchat dm --json populates runtimeId from execution response (SDK dispatch)', async () => {
    // Simulates the SDK dispatch path: request.execution has no runtimeId,
    // but the top-level execution response provides it.
    const sessionRef = 'agent:cody:project:agent-spaces:task:T-01298/lane:main'
    const client = createDmClient({
      requestExecution: {
        state: 'started',
        sessionRef,
      },
      execution: {
        runId: 'run-sdk-dispatch',
        sessionRef,
        hostSessionId: 'hsid-sdk-dispatch',
        generation: 2,
        runtimeId: 'rt-sdk-dispatch',
        transport: 'sdk',
        mode: 'headless',
        status: 'started',
        continuationUpdated: false,
      },
    })
    const result = await runCommand(() =>
      cmdDm(client.client, { json: true }, ['cody@agent-spaces:T-01298', 'hello'])
    )

    expect(result.exitCode).toBe(0)
    const payload = result.json as Record<string, unknown>
    expect(payload.runtimeId).toBe('rt-sdk-dispatch')
    expect(payload.turnId).toBe('run-sdk-dispatch')
  })

  it('hrcchat dm --json includes null runtimeId and turnId for unsummoned targets', async () => {
    const sessionRef = 'agent:cody:project:agent-spaces:task:T-01293/lane:main'
    const client = createDmClient({
      requestExecution: {
        state: 'accepted',
        sessionRef,
      },
    })
    const result = await runCommand(() =>
      cmdDm(client.client, { json: true }, ['cody@agent-spaces:T-01293', 'hello'])
    )

    const payload = result.json as Record<string, unknown>
    expect(Object.hasOwn(payload, 'runtimeId')).toBe(true)
    expect(Object.hasOwn(payload, 'turnId')).toBe(true)
    expect(payload.runtimeId).toBeNull()
    expect(payload.turnId).toBeNull()
  })

  it('hrcchat dm --json emits one parseable envelope line for multi-line bodies', async () => {
    const sessionRef = 'agent:cody:project:agent-spaces:task:T-01301/lane:main'
    const states: HrcMessageRecord['execution'][] = [
      { state: 'started', sessionRef, runtimeId: 'rt-started', runId: 'run-started' },
      { state: 'failed', sessionRef, errorMessage: 'fixture dispatch failure' },
      { state: 'accepted', sessionRef },
    ]

    for (const execution of states) {
      const client = createDmClient({ requestExecution: execution })
      const result = await runCommand(() =>
        cmdDm(client.client, { json: true }, ['cody@agent-spaces:T-01301', 'line one\nline two\n'])
      )

      expect(result.exitCode).toBe(execution.state === 'failed' ? 4 : 0)
      expect(result.stderr).toBe('')
      expect(result.stdout.endsWith('\n')).toBe(true)
      expect(result.stdout.slice(0, -1)).not.toContain('\n')
      expect(result.json).toMatchObject({
        request: {
          body: 'line one\nline two\n',
          execution,
        },
      })
    }
  })

  it('hrcchat dm --json surfaces structured rejection codes at top level', async () => {
    const sessionRef = 'agent:cody:project:agent-spaces:task:T-01573/lane:main'
    const client = createDmClient({
      requestExecution: {
        state: 'failed',
        sessionRef,
        runtimeId: 'rt-busy-headless',
        runId: 'run-busy-headless',
        transport: 'headless',
        errorCode: 'runtime_busy_dm_rejected',
        errorMessage: 'target session has a busy headless runtime',
      },
    })
    const result = await runCommand(() =>
      cmdDm(client.client, { json: true }, ['cody@agent-spaces:T-01573', 'hello'])
    )

    expect(result.exitCode).toBe(4)
    expect(result.stderr).toBe('')
    expect(result.json).toMatchObject({
      errorCode: 'runtime_busy_dm_rejected',
      errorMessage: 'target session has a busy headless runtime',
      runtimeId: 'rt-busy-headless',
      turnId: 'run-busy-headless',
    })
  })

  it('hrcchat dm exits nonzero and names an input the server could not deliver', async () => {
    const sessionRef = 'agent:cody:project:hrc-runtime:task:T-06408/lane:main'
    const client = createDmClient({
      requestExecution: {
        state: 'failed',
        sessionRef,
        errorCode: 'delivery_not_guaranteed',
        errorMessage: 'input msg-request was not delivered: forced broker rejection',
      },
    })

    const result = await runCommand(() =>
      cmdDm(client.client, {}, [
        'cody@hrc-runtime:T-06408',
        'this exact input must not be reported as sent',
      ])
    )

    expect(result.exitCode).toBe(4)
    expect(result.stdout).not.toContain('dm sent')
    expect(result.stderr).toContain('msg-request')
    expect(result.stderr).toContain('not delivered')
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

  it('dm --wait now takes a <mode> argument (T-04961 final-only wait)', async () => {
    // The legacy boolean `--wait` was removed in a2e6ecd; T-04961 reintroduces
    // it as the Codex-friendly final-only mode flag `--wait <mode>`. A bare
    // `--wait` is therefore a missing-argument usage error, not unknown-option.
    const result = await runMain(['dm', 'human', 'hello', '--wait'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('argument missing')
    expect(result.stderr).toContain('--wait')
  })

  it('dm --wait with an unsupported mode exits 2 with a clear message', async () => {
    const result = await runMain(['dm', 'human', 'hello', '--wait', 'bogus'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('unsupported --wait mode')
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

  it('hrcchat dm --reply-to self-heals on an unknown anchor (T-01744)', async () => {
    const seenReplyTo: (string | undefined)[] = []
    const client = {
      async semanticDm(request: SemanticDmRequest): Promise<SemanticDmResponse> {
        seenReplyTo.push(request.replyToMessageId)
        if (request.replyToMessageId !== undefined) {
          throw new HrcDomainError(
            'malformed_request',
            `unknown replyToMessageId "${request.replyToMessageId}"`,
            { field: 'replyToMessageId', replyToMessageId: request.replyToMessageId }
          )
        }
        return {
          request: makeMessageRecord({ body: request.body, from: request.from, to: request.to }),
        }
      },
    } as HrcClient

    const result = await runCommand(() => cmdDm(client, { replyTo: 'msg-gone' }, ['human', 'hi']))

    expect(result.exitCode).toBe(0)
    // First attempt with the anchor, second (retry) without it.
    expect(seenReplyTo).toEqual(['msg-gone', undefined])
    expect(result.stderr).toContain('--reply-to anchor "msg-gone" is unknown')
    expect(result.stdout).toContain('dm sent to')
  })

  it('hrcchat dm does NOT retry on an unrelated malformed_request', async () => {
    process.env['ASP_PROJECT'] = 'agent-spaces'
    Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')
    let calls = 0
    const client = {
      async semanticDm(_request: SemanticDmRequest): Promise<SemanticDmResponse> {
        calls += 1
        throw new HrcDomainError('malformed_request', 'body too long', { field: 'body' })
      },
    } as HrcClient

    let caught: unknown
    try {
      await cmdDm(client, { replyTo: 'msg-x' }, ['human', 'hi'])
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HrcDomainError)
    expect(calls).toBe(1)
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
  const originalExitCode = process.exitCode

  process.exitCode = undefined

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
    if (typeof process.exitCode === 'number' && exitCode === 0) {
      exitCode = process.exitCode
    }
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
    process.exitCode = originalExitCode
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

function createDmClient(
  options: {
    requestExecution?: HrcMessageRecord['execution']
    execution?: DispatchTurnBySelectorResponse
  } = {}
): {
  client: HrcClient
  requests: SemanticDmRequest[]
} {
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
            execution: options.requestExecution,
          }),
          ...(options.execution ? { execution: options.execution } : {}),
        }
      },
    } as HrcClient,
  }
}

function makeMessageRecord(
  overrides: Pick<HrcMessageRecord, 'body' | 'from' | 'to'> & {
    execution?: HrcMessageRecord['execution'] | undefined
  }
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
    execution: overrides.execution ?? { status: 'queued' },
  }
}
