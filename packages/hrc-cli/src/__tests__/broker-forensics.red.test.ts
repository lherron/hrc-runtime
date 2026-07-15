/**
 * RED acceptance tests for the broker post-mortem forensics surface.
 *
 * These tests exercise the operator commands against a real hrc-server and a
 * persisted broker ledger. They intentionally avoid importing proposed
 * implementation helpers so the contract remains the CLI behavior described
 * by the task: filtered raw events, interleaved transcripts, stats, runtime
 * discovery, and scope-selector resolution (including terminated runtimes).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createHrcServer } from 'hrc-server'
import type { HrcServer } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcTestFixture } from '../../../hrc-server/src/__tests__/fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from '../../../hrc-server/src/__tests__/fixtures/hrc-test-fixture'
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

function captureChunk(chunk: string | ArrayBufferView | ArrayBuffer, chunks: string[]): void {
  if (typeof chunk === 'string') {
    chunks.push(chunk)
    return
  }
  chunks.push(Buffer.from(chunk as ArrayBufferView).toString('utf8'))
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit
  const originalEnv = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(env)) {
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
        process.env[key] = undefined
      } else {
        process.env[key] = value
      }
    }
  }
}

const SCOPE_REF = 'agent:room-coordinator:project:agent-control-plane:task:T-05091:role:coordinator'
const SCOPE_HANDLE = 'room-coordinator@agent-control-plane:T-05091/coordinator'
const HOST_SESSION_ID = 'hs-forensics-main'
const RUNTIME_ID = 'rt-forensics-main'
const RUN_ID = 'run-forensics-main'
const INVOCATION_ID = 'inv-forensics-main'
const FIRST_ACTIVITY = '2026-07-01T00:00:01.000Z'
const LAST_ACTIVITY = '2026-07-01T00:00:12.000Z'
const LONG_TAIL = 'END-OF-LONG-MESSAGE'
const LONG_MESSAGE = `${'large-message '.repeat(120)}${LONG_TAIL}`

type SeedRuntimeGraphOptions = {
  hostSessionId: string
  runtimeId: string
  runId: string
  invocationId: string
  scopeRef: string
  laneRef?: string
  status?: string
  createdAt?: string
}

function seedRuntimeGraph(fixture: HrcServerTestFixture, options: SeedRuntimeGraphOptions): void {
  const db = openHrcDatabase(fixture.dbPath)
  const createdAt = options.createdAt ?? '2026-07-01T00:00:00.000Z'
  const laneRef = options.laneRef ?? 'main'

  try {
    if (!db.sessions.getByHostSessionId(options.hostSessionId)) {
      db.sessions.insert({
        hostSessionId: options.hostSessionId,
        scopeRef: options.scopeRef,
        laneRef,
        generation: 1,
        status: 'terminated',
        createdAt,
        updatedAt: createdAt,
        ancestorScopeRefs: [],
      })
    }

    db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId: options.hostSessionId,
      scopeRef: options.scopeRef,
      laneRef,
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: options.status ?? 'terminated',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: `op-${options.runtimeId}`,
      lastActivityAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    })

    db.runs.insert({
      runId: options.runId,
      hostSessionId: options.hostSessionId,
      runtimeId: options.runtimeId,
      scopeRef: options.scopeRef,
      laneRef,
      generation: 1,
      transport: 'headless',
      status: 'completed',
      acceptedAt: createdAt,
      completedAt: createdAt,
      updatedAt: createdAt,
      operationId: `op-${options.runtimeId}`,
      invocationId: options.invocationId,
    })

    db.brokerInvocations.insert({
      invocationId: options.invocationId,
      operationId: `op-${options.runtimeId}`,
      runtimeId: options.runtimeId,
      runId: options.runId,
      brokerProtocol: 'harness-broker/0.1',
      brokerDriver: 'codex-app-server',
      invocationState: 'terminated',
      capabilitiesJson: JSON.stringify({ turns: 'multi' }),
      specHash: `sha256:spec-${options.runtimeId}`,
      startRequestHash: `sha256:req-${options.runtimeId}`,
      selectedProfileHash: `sha256:profile-${options.runtimeId}`,
      createdAt,
      updatedAt: createdAt,
    })
  } finally {
    db.close()
  }
}

function appendEvent(
  fixture: HrcServerTestFixture,
  input: {
    seq: number
    type: string
    payload: unknown
    turnId?: string
    runtimeId?: string
    runId?: string
    invocationId?: string
    time?: string
  }
): void {
  const db = openHrcDatabase(fixture.dbPath)
  const invocationId = input.invocationId ?? INVOCATION_ID
  const runtimeId = input.runtimeId ?? RUNTIME_ID
  const runId = input.runId ?? RUN_ID
  const time = input.time ?? `2026-07-01T00:00:${String(input.seq).padStart(2, '0')}.000Z`
  const envelope = {
    invocationId,
    seq: input.seq,
    time,
    type: input.type,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    payload: input.payload,
  }

  try {
    db.brokerInvocationEvents.appendEvent({
      invocationId,
      seq: input.seq,
      time,
      type: input.type as never,
      runtimeId,
      runId,
      payload: input.payload,
      envelopeJson: JSON.stringify(envelope),
    })
  } finally {
    db.close()
  }
}

function seedForensicsLedger(fixture: HrcServerTestFixture): void {
  seedRuntimeGraph(fixture, {
    hostSessionId: HOST_SESSION_ID,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    scopeRef: SCOPE_REF,
  })

  appendEvent(fixture, { seq: 1, type: 'turn.started', turnId: 'turn-1', payload: {} })
  appendEvent(fixture, {
    seq: 2,
    type: 'tool.call.started',
    turnId: 'turn-1',
    payload: {
      toolCallId: 'tool-1',
      name: 'Bash',
      input: { command: 'bun test packages/hrc-cli' },
    },
  })
  appendEvent(fixture, {
    seq: 3,
    type: 'assistant.message.completed',
    turnId: 'turn-1',
    payload: { content: [{ type: 'text', text: 'nested assistant message' }] },
  })
  appendEvent(fixture, {
    seq: 4,
    type: 'driver.notice',
    turnId: 'turn-1',
    payload: { notice: 'driver recovered its session' },
  })
  appendEvent(fixture, {
    seq: 5,
    type: 'tool.call.started',
    turnId: 'turn-1',
    payload: {
      toolCallId: 'tool-2',
      name: 'Read',
      input: { file_path: '/tmp/forensics.ts' },
    },
  })
  appendEvent(fixture, {
    seq: 6,
    type: 'assistant.message.completed',
    turnId: 'turn-1',
    payload: { content: [{ type: 'text', text: LONG_MESSAGE }] },
  })
  appendEvent(fixture, {
    seq: 7,
    type: 'driver.notice',
    turnId: 'turn-1',
    payload: { notice: 'this row will be corrupted below' },
  })
  appendEvent(fixture, {
    seq: 8,
    type: 'tool.call.started',
    turnId: 'turn-1',
    payload: {
      toolCallId: 'tool-3',
      name: 'AskUserQuestion',
      input: { prompt: 'Which runtime should be inspected?' },
    },
  })
  appendEvent(fixture, { seq: 9, type: 'turn.completed', turnId: 'turn-1', payload: {} })
  appendEvent(fixture, { seq: 10, type: 'turn.started', turnId: 'turn-2', payload: {} })
  appendEvent(fixture, {
    seq: 11,
    type: 'tool.call.started',
    turnId: 'turn-2',
    payload: {
      toolCallId: 'tool-4',
      name: 'Bash',
      input: { command: 'hrc broker stats rt-forensics-main' },
    },
  })
  appendEvent(fixture, {
    seq: 12,
    type: 'turn.completed',
    turnId: 'turn-2',
    payload: {},
    time: LAST_ACTIVITY,
  })

  // Reproduce the older persisted shape where broker_event_json contains an
  // envelope-like object with payload nested under `payload`.
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sqlite
      .query(
        `UPDATE broker_invocation_events
           SET broker_event_json = ?
         WHERE invocation_id = ? AND seq = 3`
      )
      .run(
        JSON.stringify({
          payload: { content: [{ type: 'text', text: 'nested assistant message' }] },
        }),
        INVOCATION_ID
      )

    // A damaged historical row must remain inspectable rather than aborting
    // the entire event or transcript command.
    db.sqlite
      .query(
        `UPDATE broker_invocation_events
           SET broker_event_json = ?
         WHERE invocation_id = ? AND seq = 7`
      )
      .run('{not valid json', INVOCATION_ID)
  } finally {
    db.close()
  }
}

function cliEnv(fixture: HrcServerTestFixture): Record<string, string> {
  return {
    HRC_RUNTIME_DIR: fixture.runtimeRoot,
    HRC_STATE_DIR: fixture.stateRoot,
  }
}

function parseNdjson(text: string): Array<Record<string, unknown>> {
  if (text === '') return []
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-broker-forensics-')
  seedForensicsLedger(fixture)
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

describe('hrc broker events', () => {
  it('applies CSV type and inclusive seq-range filters and emits only matching NDJSON rows', async () => {
    const result = await runCli(
      [
        'broker',
        'events',
        RUNTIME_ID,
        '--type',
        'tool.call.started,driver.notice',
        '--seq',
        '2..5',
        '--ndjson',
      ],
      cliEnv(fixture)
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const rows = parseNdjson(result.stdout)
    expect(rows.map((row) => row['seq'])).toEqual([2, 4, 5])
    expect(rows.map((row) => row['type'])).toEqual([
      'tool.call.started',
      'driver.notice',
      'tool.call.started',
    ])
    expect(rows[0]).toMatchObject({
      seq: 2,
      time: '2026-07-01T00:00:02.000Z',
      type: 'tool.call.started',
      payload: { name: 'Bash', input: { command: 'bun test packages/hrc-cli' } },
    })
  })

  it('accepts an invocationId, unwraps nested payload rows, and never clips NDJSON', async () => {
    const result = await runCli(
      ['broker', 'events', INVOCATION_ID, '--type', 'assistant.message.completed', '--ndjson'],
      cliEnv(fixture)
    )

    expect(result.exitCode).toBe(0)
    const rows = parseNdjson(result.stdout)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      seq: 3,
      payload: { content: [{ type: 'text', text: 'nested assistant message' }] },
    })
    expect(result.stdout).toContain(LONG_TAIL)
  })

  it('prints an explicit marker for an unparseable payload row and continues', async () => {
    const result = await runCli(['broker', 'events', RUNTIME_ID, '--seq', '6..8'], cliEnv(fixture))

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^6\s/m)
    expect(result.stdout).toMatch(/^7\s/m)
    expect(result.stdout).toMatch(/^8\s/m)
    expect(result.stdout).toMatch(/unparseable/i)
  })

  it('emits no NDJSON lines for an empty filter result', async () => {
    const result = await runCli(
      ['broker', 'events', RUNTIME_ID, '--type', 'permission.requested', '--ndjson'],
      cliEnv(fixture)
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('')
  })
})

describe('hrc broker transcript', () => {
  it('renders a seq-ordered, pipe-safe interleaving with command/file/prompt summaries', async () => {
    const result = await runCli(
      ['broker', 'transcript', RUNTIME_ID, '--seq', '2..8'],
      cliEnv(fixture)
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('\u001B[')
    expect(result.stdout).toMatch(/^2 EXEC Bash \| .*bun test packages\/hrc-cli/m)
    expect(result.stdout).toMatch(/^3 SAYS \| nested assistant message/m)
    expect(result.stdout).toMatch(/^4 NOTE \| driver recovered its session/m)
    expect(result.stdout).toMatch(/^5 EXEC Read \| .*\/tmp\/forensics\.ts/m)
    expect(result.stdout).toMatch(
      /^8 EXEC AskUserQuestion \| .*Which runtime should be inspected\?/m
    )

    const seqs = result.stdout
      .split('\n')
      .filter((line) => /^\d+ (?:EXEC|SAYS|NOTE) /.test(line))
      .map((line) => Number.parseInt(line, 10))
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('clips large human messages with a stable marker unless --full is supplied', async () => {
    const clipped = await runCli(
      ['broker', 'transcript', RUNTIME_ID, '--seq', '6..6'],
      cliEnv(fixture)
    )
    const full = await runCli(
      ['broker', 'transcript', RUNTIME_ID, '--seq', '6..6', '--full'],
      cliEnv(fixture)
    )

    expect(clipped.exitCode).toBe(0)
    expect(clipped.stdout).not.toContain(LONG_TAIL)
    expect(clipped.stdout).toMatch(/\[clipped(?:[^\]]*)\]/i)
    expect(full.exitCode).toBe(0)
    expect(full.stdout).toContain(LONG_TAIL)
    expect(full.stdout).not.toMatch(/\[clipped(?:[^\]]*)\]/i)
  })

  it('honors --kinds and returns an empty stream when no selected rows match', async () => {
    const filtered = await runCli(
      ['broker', 'transcript', RUNTIME_ID, '--seq', '2..4', '--kinds', 'exec,notice'],
      cliEnv(fixture)
    )
    const empty = await runCli(
      ['broker', 'transcript', RUNTIME_ID, '--seq', '1..1', '--kinds', 'exec'],
      cliEnv(fixture)
    )

    expect(filtered.exitCode).toBe(0)
    expect(filtered.stdout).toMatch(/^2 EXEC /m)
    expect(filtered.stdout).toMatch(/^4 NOTE /m)
    expect(filtered.stdout).not.toMatch(/ SAYS /)
    expect(empty.exitCode).toBe(0)
    expect(empty.stderr).toBe('')
    expect(empty.stdout).toBe('')
  })
})

describe('hrc broker stats and selector convenience', () => {
  it('reports histogram, turn/tool counts, activity bounds, and per-turn tool breakdown', async () => {
    // This runtime is terminated; post-mortem selectors must not be limited to
    // the live broker controller registry.
    const result = await runCli(['broker', 'stats', SCOPE_HANDLE], cliEnv(fixture))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatch(/tool\.call\.started\s*(?:\||:)?\s*4/m)
    expect(result.stdout).toMatch(/turn(?: count|s)\s*(?:\||:)?\s*2/i)
    expect(result.stdout).toMatch(/tool(?:-call| call)s?\s*(?:\||:)?\s*4/i)
    expect(result.stdout).toContain(FIRST_ACTIVITY)
    expect(result.stdout).toContain(LAST_ACTIVITY)
    expect(result.stdout).toMatch(/turn-1.*3/)
    expect(result.stdout).toMatch(/turn-2.*1/)
  })

  it('lists every ambiguous runtime candidate and --latest selects the newest', async () => {
    const latestRuntimeId = 'rt-forensics-latest'
    const latestInvocationId = 'inv-forensics-latest'
    seedRuntimeGraph(fixture, {
      hostSessionId: HOST_SESSION_ID,
      runtimeId: latestRuntimeId,
      runId: 'run-forensics-latest',
      invocationId: latestInvocationId,
      scopeRef: SCOPE_REF,
      laneRef: 'repair',
      createdAt: '2026-07-02T00:00:00.000Z',
    })
    appendEvent(fixture, {
      invocationId: latestInvocationId,
      runtimeId: latestRuntimeId,
      runId: 'run-forensics-latest',
      seq: 1,
      type: 'latest.only',
      payload: {},
      time: '2026-07-02T00:00:01.000Z',
    })

    const ambiguous = await runCli(['broker', 'stats', SCOPE_HANDLE], cliEnv(fixture))
    expect(ambiguous.exitCode).not.toBe(0)
    expect(ambiguous.stderr).toContain(RUNTIME_ID)
    expect(ambiguous.stderr).toContain(latestRuntimeId)

    const latest = await runCli(
      ['broker', 'stats', SCOPE_HANDLE, '--latest', '--json'],
      cliEnv(fixture)
    )
    expect(latest.exitCode).toBe(0)
    expect(latest.stdout).toContain(latestRuntimeId)
    expect(latest.stdout).toContain('latest.only')
    expect(latest.stdout).not.toContain('tool.call.started')
  })
})

describe('hrc ls runtimes post-mortem discovery filters', () => {
  function seedDistractorRuntime(): void {
    seedRuntimeGraph(fixture, {
      hostSessionId: 'hs-forensics-distractor',
      runtimeId: 'rt-forensics-distractor',
      runId: 'run-forensics-distractor',
      invocationId: 'inv-forensics-distractor',
      scopeRef: 'agent:other:project:agent-control-plane:task:T-05091',
    })
  }

  it('filters hrc ls runtimes by --session hostSessionId', async () => {
    seedDistractorRuntime()

    const result = await runCli(
      ['ls', 'runtimes', '--session', HOST_SESSION_ID, '--json'],
      cliEnv(fixture)
    )

    expect(result.exitCode).toBe(0)
    const rows = JSON.parse(result.stdout) as Array<{ runtimeId: string }>
    expect(rows.map((row) => row.runtimeId)).toEqual([RUNTIME_ID])
  })

  it('accepts monitor-selector grammar for the --scope filter', async () => {
    seedDistractorRuntime()

    const result = await runCli(
      ['ls', 'runtimes', '--scope', SCOPE_HANDLE, '--json'],
      cliEnv(fixture)
    )

    expect(result.exitCode).toBe(0)
    const rows = JSON.parse(result.stdout) as Array<{ runtimeId: string }>
    expect(rows.map((row) => row.runtimeId)).toEqual([RUNTIME_ID])
  })
})
