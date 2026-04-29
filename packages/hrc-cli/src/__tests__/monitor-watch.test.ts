import { describe, expect, test } from 'bun:test'
import { MonitorEventSchema } from 'hrc-events'

import { cmdMonitorWatch } from '../monitor-watch'

type MonitorCondition =
  | 'turn-finished'
  | 'idle'
  | 'busy'
  | 'response'
  | 'response-or-idle'
  | 'runtime-dead'

type MonitorWatchArgs = {
  selector?: string | undefined
  json?: boolean | undefined
  pretty?: boolean | undefined
  format?: 'tree' | 'compact' | 'verbose' | 'json' | 'ndjson' | undefined
  follow?: boolean | undefined
  fromSeq?: number | undefined
  last?: number | undefined
  until?: MonitorCondition | undefined
  timeoutMs?: number | undefined
  stallAfterMs?: number | undefined
  maxLines?: number | undefined
  scopeWidth?: number | undefined
  signal?: AbortSignal | undefined
}

type MonitorFixtureState = {
  daemon: {
    pid: number
    status: 'healthy'
    startedAt: string
  }
  socket: {
    path: string
    responsive: boolean
  }
  tmux: {
    socketPath: string
    sessionCount: number
    windowCount: number
    paneCount: number
  }
  sessions: Array<{
    sessionRef: string
    scopeRef: string
    laneRef: string
    hostSessionId: string
    generation: number
    runtimeId: string
    status: 'active'
    activeTurnId: string | null
  }>
  runtimes: Array<{
    runtimeId: string
    hostSessionId: string
    status: 'busy' | 'idle' | 'ready' | 'dead'
    transport: 'tmux'
    activeTurnId: string | null
  }>
  messages: Array<{
    messageId: string
    messageSeq: number
    sessionRef: string
    hostSessionId: string
    runtimeId: string
    runId: string
  }>
  events: MonitorFixtureEvent[]
}

type MonitorFixtureEvent = {
  seq: number
  hrcSeq?: number | undefined
  streamSeq?: number | undefined
  ts: string
  event: string
  eventKind?: string | undefined
  sessionRef: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
  category?: string | undefined
  runtimeId: string
  turnId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  transport?: string | undefined
  messageId?: string | undefined
  messageSeq?: number | undefined
  result?: string | undefined
  reason?: string | undefined
  failureKind?: string | undefined
  payload?: unknown
}

type InvokeResult = {
  stdout: string
  stderr: string
  exitCode: number
  events: Array<Record<string, unknown>>
}

const SESSION_REF = 'agent:cody:project:agent-spaces:task:T-01290/lane:main'
const SCOPE_REF = 'agent:cody:project:agent-spaces:task:T-01290'
const SELECTOR = `session:${SESSION_REF}`
const MSG_SELECTOR = 'msg:msg-f2b'
const HOST_SESSION_ID = 'host-session-f2b'
const RUNTIME_ID = 'runtime-f2b'
const TURN_ID = 'turn-f2b'
const MESSAGE_ID = 'msg-f2b'
const TS = '2026-04-27T17:00:00.000Z'

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
  }
}

async function invokeWatch(
  args: MonitorWatchArgs,
  state: MonitorFixtureState
): Promise<InvokeResult> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit

  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stdout.write

  process.stderr.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stderr.write

  process.exit = ((code?: number) => {
    throw new CliExit(code ?? 0)
  }) as typeof process.exit

  let exitCode = 0
  try {
    const result = await (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        json: true,
        ...args,
      },
      {
        buildMonitorState: async () => state,
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: {
          write(chunk: string) {
            stderrChunks.push(chunk)
            return true
          },
        },
      }
    )
    exitCode = typeof result === 'number' ? result : 0
  } catch (error) {
    if (error instanceof CliExit) {
      exitCode = error.code
    } else {
      throw error
    }
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
  }

  const stdout = stdoutChunks.join('')
  return {
    stdout,
    stderr: stderrChunks.join(''),
    exitCode,
    events: parseJsonLines(stdout),
  }
}

async function invokeWatchText(
  args: MonitorWatchArgs,
  state: MonitorFixtureState
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const result = await (
    cmdMonitorWatch as unknown as (
      args: MonitorWatchArgs,
      deps: {
        buildMonitorState: () => Promise<MonitorFixtureState>
        stdout: { write(chunk: string): boolean }
        stderr: { write(chunk: string): boolean }
      }
    ) => Promise<number | undefined>
  )(args, {
    buildMonitorState: async () => state,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk)
        return true
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk)
        return true
      },
    },
  })
  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode: result ?? 0,
  }
}

function createFixtureState(
  overrides: {
    runtimeStatus?: MonitorFixtureState['runtimes'][number]['status'] | undefined
    activeTurnId?: string | null | undefined
    events?: MonitorFixtureEvent[] | undefined
  } = {}
): MonitorFixtureState {
  const activeTurnId = overrides.activeTurnId === undefined ? TURN_ID : overrides.activeTurnId

  return {
    daemon: {
      pid: 91290,
      status: 'healthy',
      startedAt: '2026-04-27T16:55:00.000Z',
    },
    socket: {
      path: '/tmp/hrc-monitor-f2b.sock',
      responsive: true,
    },
    tmux: {
      socketPath: '/tmp/hrc-monitor-f2b-tmux.sock',
      sessionCount: 1,
      windowCount: 1,
      paneCount: 1,
    },
    sessions: [
      {
        sessionRef: SESSION_REF,
        scopeRef: SCOPE_REF,
        laneRef: 'main',
        hostSessionId: HOST_SESSION_ID,
        generation: 12,
        runtimeId: RUNTIME_ID,
        status: 'active',
        activeTurnId,
      },
    ],
    runtimes: [
      {
        runtimeId: RUNTIME_ID,
        hostSessionId: HOST_SESSION_ID,
        status: overrides.runtimeStatus ?? (activeTurnId === null ? 'idle' : 'busy'),
        transport: 'tmux',
        activeTurnId,
      },
    ],
    messages: [
      {
        messageId: MESSAGE_ID,
        messageSeq: 1290,
        sessionRef: SESSION_REF,
        hostSessionId: HOST_SESSION_ID,
        runtimeId: RUNTIME_ID,
        runId: TURN_ID,
      },
    ],
    events: overrides.events ?? [event(100, 'turn.started', { turnId: TURN_ID })],
  }
}

function event(
  seq: number,
  name: string,
  overrides: Partial<MonitorFixtureEvent> = {}
): MonitorFixtureEvent {
  return {
    seq,
    hrcSeq: seq,
    streamSeq: seq,
    ts: TS,
    event: name,
    eventKind: name,
    sessionRef: SESSION_REF,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    hostSessionId: HOST_SESSION_ID,
    generation: 12,
    category: name.split('.')[0],
    runtimeId: RUNTIME_ID,
    ...overrides,
  }
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function expectValidMonitorEvent(payload: Record<string, unknown>): void {
  expect(() => MonitorEventSchema.parse(payload)).not.toThrow()
  expect(payload).toEqual(
    expect.objectContaining({
      event: expect.any(String),
      selector: expect.any(String),
      replayed: expect.any(Boolean),
      ts: expect.any(String),
    })
  )
}

describe('hrc monitor watch CLI acceptance (T-01290 / F2b)', () => {
  test('non-follow replay defaults to the last 100 matching events and marks them replayed', async () => {
    const events = Array.from({ length: 150 }, (_, index) =>
      event(index + 1, 'runtime.idle', { result: 'idle' })
    )
    const result = await invokeWatch({ selector: SELECTOR }, createFixtureState({ events }))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.events).toHaveLength(100)
    expect(result.events[0]).toMatchObject({ seq: 51, replayed: true })
    expect(result.events.at(-1)).toMatchObject({ seq: 150, replayed: true })
    for (const payload of result.events) {
      expectValidMonitorEvent(payload)
    }
  })

  test('--last replays the last n matching events and marks them replayed', async () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      event(index + 1, index % 2 === 0 ? 'runtime.idle' : 'runtime.busy', {
        result: index % 2 === 0 ? 'idle' : 'busy',
      })
    )
    const result = await invokeWatch(
      { selector: SELECTOR, last: 3 },
      createFixtureState({ events })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.events.map((payload) => payload.seq)).toEqual([10, 11, 12])
    expect(result.events.every((payload) => payload.replayed === true)).toBe(true)
  })

  test('non-follow replay exits 0 when zero events match', async () => {
    const state = createFixtureState({
      events: [event(101, 'runtime.idle', { runtimeId: 'other-runtime' })],
    })
    const result = await invokeWatch({ selector: 'runtime:missing-runtime' }, state)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('')
    expect(result.events).toEqual([])
  })

  test('--from-seq replays matching events from that sequence number', async () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      event(index + 1, 'runtime.busy', { result: 'busy' })
    )
    const result = await invokeWatch(
      { selector: SELECTOR, fromSeq: 8 },
      createFixtureState({ events })
    )

    expect(result.exitCode).toBe(0)
    expect(result.events.map((payload) => payload.seq)).toEqual([8, 9, 10, 11, 12])
    expect(result.events.every((payload) => payload.replayed === true)).toBe(true)
  })

  test('--last and --from-seq are mutually exclusive', async () => {
    const result = await invokeWatch(
      { selector: SELECTOR, last: 3, fromSeq: 8 },
      createFixtureState()
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--last cannot be used with --from-seq')
  })

  test('--follow emits initial monitor.snapshot from the high-water mark and streams live events', async () => {
    const result = await invokeWatch(
      {
        selector: SELECTOR,
        follow: true,
        until: 'idle',
        timeoutMs: 25,
      },
      createFixtureState({
        runtimeStatus: 'busy',
        events: [
          event(100, 'turn.started', { turnId: TURN_ID }),
          event(101, 'runtime.idle', { turnId: TURN_ID, result: 'idle' }),
        ],
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.events[0]).toMatchObject({
      event: 'monitor.snapshot',
      selector: SELECTOR,
      replayed: false,
    })
    expect(result.events).toContainEqual(
      expect.objectContaining({
        event: 'runtime.idle',
        selector: SELECTOR,
        replayed: false,
      })
    )
    expect(result.events.at(-1)).toMatchObject({
      event: 'monitor.completed',
      result: 'idle',
      condition: 'idle',
      exitCode: 0,
    })
  })

  test.each([
    [
      'turn-finished',
      event(101, 'turn.finished', { turnId: TURN_ID, result: 'turn_succeeded' }),
      0,
      'turn_succeeded',
    ],
    ['idle', event(101, 'runtime.idle', { turnId: TURN_ID, result: 'idle' }), 0, 'idle'],
    ['busy', event(101, 'runtime.busy', { turnId: TURN_ID, result: 'busy' }), 0, 'busy'],
    [
      'runtime-dead',
      event(101, 'runtime.dead', {
        turnId: TURN_ID,
        result: 'runtime_dead',
        failureKind: 'runtime',
      }),
      2,
      'runtime_dead',
    ],
  ] as const)(
    '--until %s resolves through the F1b condition engine',
    async (condition, terminalEvent, exitCode, result) => {
      const state = createFixtureState({
        runtimeStatus: condition === 'busy' ? 'idle' : 'busy',
        events: [event(100, 'turn.started', { turnId: TURN_ID }), terminalEvent],
      })

      const cli = await invokeWatch(
        { selector: SELECTOR, follow: true, until: condition, timeoutMs: 25 },
        state
      )

      expect(cli.exitCode).toBe(exitCode)
      expect(cli.events.at(-1)).toMatchObject({
        event: 'monitor.completed',
        condition,
        result,
        exitCode,
      })
    }
  )

  test.each(['response', 'response-or-idle'] as const)(
    '--until %s resolves for a msg: selector on message.response',
    async (condition) => {
      const state = createFixtureState({
        events: [
          event(100, 'turn.started', { turnId: TURN_ID }),
          event(101, 'message.response', {
            turnId: TURN_ID,
            messageId: MESSAGE_ID,
            messageSeq: 1290,
            result: 'response',
          }),
        ],
      })

      const cli = await invokeWatch(
        { selector: MSG_SELECTOR, follow: true, until: condition, timeoutMs: 25 },
        state
      )

      expect(cli.exitCode).toBe(0)
      expect(cli.events.at(-1)).toMatchObject({
        event: 'monitor.completed',
        selector: MSG_SELECTOR,
        condition,
        result: 'response',
        exitCode: 0,
      })
    }
  )

  test.each(['response', 'response-or-idle'] as const)(
    'Q4 frozen: --until %s rejects session selectors with cli-kit usage exit 2',
    async (condition) => {
      const cli = await invokeWatch(
        { selector: SELECTOR, follow: true, until: condition, timeoutMs: 25 },
        createFixtureState()
      )

      expect(cli.exitCode).toBe(2)
      expect(cli.stdout).toBe('')
      expect(cli.stderr).toContain(`${condition} requires a msg: selector`)
    }
  )

  test.each([
    ['finite replay completed', { selector: SELECTOR }, createFixtureState({ events: [] }), 0],
    [
      'timeout without condition satisfaction',
      { selector: SELECTOR, follow: true, until: 'turn-finished', timeoutMs: 1 },
      createFixtureState({ events: [event(100, 'turn.started', { turnId: TURN_ID })] }),
      1,
    ],
    [
      'usage error',
      { selector: SELECTOR, follow: true, until: 'response', timeoutMs: 1 },
      createFixtureState(),
      2,
    ],
    [
      'monitor infrastructure failure',
      { selector: SELECTOR, follow: true, until: 'turn-finished' },
      createFixtureState({ events: [event(100, 'turn.started', { turnId: TURN_ID })] }),
      3,
    ],
    [
      'condition impossible',
      { selector: SELECTOR, follow: true, until: 'turn-finished', timeoutMs: 25 },
      createFixtureState({
        events: [
          event(100, 'turn.started', { turnId: TURN_ID }),
          event(101, 'session.cleared', { result: 'context_changed', reason: 'cleared' }),
        ],
      }),
      4,
    ],
    [
      'SIGINT',
      { selector: SELECTOR, follow: true, until: 'turn-finished', signal: AbortSignal.abort() },
      createFixtureState(),
      130,
    ],
  ] as const)('uses cli-kit exit code %i for %s', async (_label, args, state, exitCode) => {
    const cli = await invokeWatch(args as MonitorWatchArgs, state)

    expect(cli.exitCode).toBe(exitCode)
  })

  test('JSON output validates against MonitorEventSchema and preserves optional fields', async () => {
    const state = createFixtureState({
      events: [
        event(100, 'turn.started', { turnId: TURN_ID }),
        event(101, 'turn.finished', {
          turnId: TURN_ID,
          result: 'turn_failed',
          failureKind: 'tool',
        }),
      ],
    })
    const cli = await invokeWatch(
      { selector: SELECTOR, follow: true, until: 'turn-finished', timeoutMs: 25 },
      state
    )

    expect(cli.exitCode).toBe(2)
    for (const payload of cli.events) {
      expectValidMonitorEvent(payload)
    }
    expect(cli.events.at(-1)).toMatchObject({
      event: 'monitor.completed',
      runtimeId: RUNTIME_ID,
      turnId: TURN_ID,
      result: 'turn_failed',
      failureKind: 'tool',
      exitCode: 2,
    })
  })

  test('--pretty uses the tree renderer with lifecycle payload details', async () => {
    const state = createFixtureState({
      events: [
        event(100, 'turn.message', {
          turnId: TURN_ID,
          runId: TURN_ID,
          payload: {
            type: 'message_end',
            message: { role: 'assistant', content: 'pretty restored' },
          },
        }),
      ],
    })

    const stdoutChunks: string[] = []
    const exitCode = await (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        selector: SELECTOR,
        pretty: true,
      },
      {
        buildMonitorState: async () => state,
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: {
          write() {
            return true
          },
        },
      }
    )

    const output = stdoutChunks.join('')
    expect(exitCode).toBe(0)
    expect(output).toContain('assistant')
    expect(output).toContain('pretty restored')
    expect(output).toContain('cody@agent-spaces:T-01290')
    expect(() => JSON.parse(output.split('\n')[0] ?? '')).toThrow()
  })

  test('--pretty renders orphan Bash result stdout as structured output', async () => {
    const state = createFixtureState({
      events: [
        event(100, 'turn.tool_result', {
          payload: {
            type: 'tool_execution_end',
            toolUseId: 'toolu-bash',
            toolName: 'Bash',
            result: {
              content: [
                {
                  type: 'text',
                  text: '{"event":"monitor.completed","condition":"response-or-idle","result":"response","exitCode":0}',
                },
              ],
              details: {
                stdout:
                  '{"event":"monitor.completed","condition":"response-or-idle","result":"response","exitCode":0}',
                stderr: '',
                interrupted: false,
              },
            },
            isError: false,
          },
        }),
      ],
    })

    const stdoutChunks: string[] = []
    const exitCode = await (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        selector: SELECTOR,
        pretty: true,
      },
      {
        buildMonitorState: async () => state,
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: {
          write() {
            return true
          },
        },
      }
    )

    const output = stdoutChunks.join('')
    expect(exitCode).toBe(0)
    expect(output).toContain('Bash result')
    expect(output).toContain('stdout')
    expect(output).toContain('event')
    expect(output).toContain('monitor.completed')
    expect(output).toContain('exitCode')
    expect(output).not.toContain('{"event":"monitor.completed"')
  })

  test('--pretty renders tool descriptions and compact edit inputs', async () => {
    const state = createFixtureState({
      events: [
        event(100, 'turn.tool_call', {
          payload: {
            type: 'tool_execution_start',
            toolUseId: 'toolu-bash',
            toolName: 'Bash',
            input: {
              command: 'bun test',
              description: 'Run focused unit tests',
            },
          },
        }),
        event(101, 'turn.tool_result', {
          payload: {
            type: 'tool_execution_end',
            toolUseId: 'toolu-bash',
            toolName: 'Bash',
            result: { content: [{ type: 'text', text: 'ok' }] },
            isError: false,
          },
        }),
        event(102, 'turn.tool_call', {
          payload: {
            type: 'tool_execution_start',
            toolUseId: 'toolu-edit',
            toolName: 'Edit',
            input: {
              file_path: '/Users/lherron/praesidium/agent-spaces/JOB_E2E_PLAN.md',
              old_string: 'old text',
              new_string: 'new text',
            },
          },
        }),
      ],
    })

    const result = await invokeWatchText({ selector: SELECTOR, pretty: true }, state)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Bash - Run focused unit tests')
    expect(result.stdout).toContain('$ bun test')
    expect(result.stdout).toContain('-> ok')
    expect(result.stdout).toContain('Edit - ')
    expect(result.stdout).toContain('JOB_E2E_PLAN.md')
    expect(result.stdout).toContain('replace one block')
    expect(result.stdout).toContain('old: 1 line')
    expect(result.stdout).not.toContain('"old_string"')
  })

  test('--pretty includes event sequence and replay marker', async () => {
    const state = createFixtureState({
      events: [
        event(100, 'turn.message', {
          payload: {
            type: 'message_end',
            message: { role: 'assistant', content: 'sequenced' },
          },
        }),
      ],
    })

    const result = await invokeWatchText({ selector: SELECTOR, pretty: true }, state)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('#100 replayed')
  })

  test('emits final monitor.completed before exiting when --until resolves', async () => {
    const cli = await invokeWatch(
      { selector: SELECTOR, follow: true, until: 'turn-finished', timeoutMs: 25 },
      createFixtureState({
        events: [
          event(100, 'turn.started', { turnId: TURN_ID }),
          event(101, 'turn.finished', { turnId: TURN_ID, result: 'turn_succeeded' }),
        ],
      })
    )

    expect(cli.exitCode).toBe(0)
    expect(cli.events.at(-1)).toMatchObject({
      event: 'monitor.completed',
      result: 'turn_succeeded',
      exitCode: 0,
      condition: 'turn-finished',
    })
  })

  test('--timeout exits 1 and emits monitor.completed with result=timeout', async () => {
    const cli = await invokeWatch(
      { selector: SELECTOR, follow: true, until: 'turn-finished', timeoutMs: 1 },
      createFixtureState({ events: [event(100, 'turn.started', { turnId: TURN_ID })] })
    )

    expect(cli.exitCode).toBe(1)
    expect(cli.events.at(-1)).toMatchObject({
      event: 'monitor.completed',
      result: 'timeout',
      exitCode: 1,
      condition: 'turn-finished',
    })
  })

  test('--stall-after exits 1 and emits monitor.stalled', async () => {
    const cli = await invokeWatch(
      { selector: SELECTOR, follow: true, until: 'turn-finished', stallAfterMs: 1 },
      createFixtureState({ events: [event(100, 'turn.started', { turnId: TURN_ID })] })
    )

    expect(cli.exitCode).toBe(1)
    expect(cli.events.at(-1)).toMatchObject({
      event: 'monitor.stalled',
      result: 'stalled',
      exitCode: 1,
      condition: 'turn-finished',
    })
  })
})

// -- Polling condition reader (T-01297) ----------------------------------------

describe('polling condition reader for --follow --until with deadline (T-01297)', () => {
  test('plain --follow polls for events after the initial snapshot', async () => {
    const initialState = createFixtureState({
      events: [event(100, 'turn.started', { turnId: TURN_ID })],
    })
    const nextState = createFixtureState({
      events: [
        event(100, 'turn.started', { turnId: TURN_ID }),
        event(101, 'turn.message', {
          turnId: TURN_ID,
          messageId: MESSAGE_ID,
          messageSeq: 1290,
        }),
      ],
    })

    const abort = new AbortController()
    let callCount = 0
    const stdoutChunks: string[] = []

    const exitPromise = (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        json: true,
        selector: SELECTOR,
        follow: true,
        signal: abort.signal,
      },
      {
        buildMonitorState: async () => {
          callCount++
          return callCount <= 1 ? initialState : nextState
        },
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            if (stdoutChunks.some((line) => line.includes('"seq":101'))) {
              abort.abort()
            }
            return true
          },
        },
        stderr: {
          write() {
            return true
          },
        },
      }
    )

    const exitCode = await exitPromise
    const events = parseJsonLines(stdoutChunks.join(''))

    expect(exitCode).toBe(130)
    expect(callCount).toBeGreaterThan(1)
    expect(events[0]).toMatchObject({
      event: 'monitor.snapshot',
      selector: SELECTOR,
      replayed: false,
      seq: 100,
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.message',
        selector: SELECTOR,
        replayed: false,
        seq: 101,
      })
    )
  })

  test('--follow --last replays the last n events before polling live events', async () => {
    const initialState = createFixtureState({
      events: [
        event(100, 'turn.started', { turnId: TURN_ID }),
        event(101, 'turn.tool_call', { turnId: TURN_ID }),
        event(102, 'turn.tool_result', { turnId: TURN_ID }),
      ],
    })
    const nextState = createFixtureState({
      events: [
        event(100, 'turn.started', { turnId: TURN_ID }),
        event(101, 'turn.tool_call', { turnId: TURN_ID }),
        event(102, 'turn.tool_result', { turnId: TURN_ID }),
        event(103, 'turn.message', {
          turnId: TURN_ID,
          messageId: MESSAGE_ID,
          messageSeq: 1290,
        }),
      ],
    })

    const abort = new AbortController()
    let callCount = 0
    const stdoutChunks: string[] = []

    const exitPromise = (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        json: true,
        selector: SELECTOR,
        follow: true,
        last: 2,
        signal: abort.signal,
      },
      {
        buildMonitorState: async () => {
          callCount++
          return callCount <= 1 ? initialState : nextState
        },
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            if (stdoutChunks.some((line) => line.includes('"seq":103'))) {
              abort.abort()
            }
            return true
          },
        },
        stderr: {
          write() {
            return true
          },
        },
      }
    )

    const exitCode = await exitPromise
    const events = parseJsonLines(stdoutChunks.join(''))

    expect(exitCode).toBe(130)
    expect(callCount).toBeGreaterThan(1)
    expect(events.map((payload) => payload.seq)).toEqual([102, 101, 102, 103])
    expect(events[0]).toMatchObject({ event: 'monitor.snapshot', replayed: false })
    expect(events[1]).toMatchObject({ event: 'turn.tool_call', replayed: true })
    expect(events[2]).toMatchObject({ event: 'turn.tool_result', replayed: true })
    expect(events[3]).toMatchObject({ event: 'turn.message', replayed: false })
  })

  test('--pretty --follow --last marks replay and live boundary', async () => {
    const initialState = createFixtureState({
      events: [
        event(100, 'turn.message', {
          turnId: TURN_ID,
          payload: {
            type: 'message_end',
            message: { role: 'assistant', content: 'replayed reply' },
          },
        }),
      ],
    })
    const nextState = createFixtureState({
      events: [
        event(100, 'turn.message', {
          turnId: TURN_ID,
          payload: {
            type: 'message_end',
            message: { role: 'assistant', content: 'replayed reply' },
          },
        }),
        event(101, 'turn.message', {
          turnId: TURN_ID,
          payload: {
            type: 'message_end',
            message: { role: 'assistant', content: 'live reply' },
          },
        }),
      ],
    })

    const abort = new AbortController()
    let callCount = 0
    const stdoutChunks: string[] = []

    const exitPromise = (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        selector: SELECTOR,
        pretty: true,
        follow: true,
        last: 1,
        signal: abort.signal,
      },
      {
        buildMonitorState: async () => {
          callCount++
          return callCount <= 1 ? initialState : nextState
        },
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            if (chunk.includes('live reply')) {
              abort.abort()
            }
            return true
          },
        },
        stderr: {
          write() {
            return true
          },
        },
      }
    )

    const exitCode = await exitPromise
    const output = stdoutChunks.join('')

    expect(exitCode).toBe(130)
    expect(output).toContain('#100 replayed')
    expect(output).toContain('live events')
    expect(output).toContain('#101')
    expect(output).toContain('live reply')
  })

  /**
   * Exercises the polling path: buildMonitorState is called multiple times and
   * the idle event appears only on a subsequent poll cycle. Without the polling
   * reader this would exit 3 (monitor_error) because the static reader drains
   * immediately and never sees the new event.
   */
  test('--follow --until idle with --timeout polls for new events and exits 0', async () => {
    const busyState = createFixtureState({
      runtimeStatus: 'busy',
      activeTurnId: TURN_ID,
      events: [event(100, 'turn.started', { turnId: TURN_ID })],
    })

    const idleState = createFixtureState({
      runtimeStatus: 'idle',
      activeTurnId: null,
      events: [
        event(100, 'turn.started', { turnId: TURN_ID }),
        event(101, 'runtime.idle', { turnId: TURN_ID, result: 'idle' }),
      ],
    })

    // First call returns busy (no idle event yet).
    // Subsequent calls return the idle state with the runtime.idle event.
    let callCount = 0
    const dynamicBuildState = async () => {
      callCount++
      return callCount <= 1 ? busyState : idleState
    }

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    const exitCode = await (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        json: true,
        selector: SELECTOR,
        follow: true,
        until: 'idle',
        timeoutMs: 5000,
      },
      {
        buildMonitorState: dynamicBuildState,
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: {
          write(chunk: string) {
            stderrChunks.push(chunk)
            return true
          },
        },
      }
    )

    expect(exitCode).toBe(0)
    expect(stderrChunks.join('')).toBe('')

    const events = parseJsonLines(stdoutChunks.join(''))

    // Should have polled buildMonitorState more than once
    expect(callCount).toBeGreaterThan(1)

    // First event should be monitor.snapshot (follow mode always starts with snapshot)
    expect(events[0]).toMatchObject({
      event: 'monitor.snapshot',
      selector: SELECTOR,
      replayed: false,
    })

    // Final event should be monitor.completed with idle
    expect(events.at(-1)).toMatchObject({
      event: 'monitor.completed',
      result: 'idle',
      condition: 'idle',
      exitCode: 0,
    })

    // Validate non-terminal events against schema (terminal events use
    // condition-engine result values like 'idle' which are outside MonitorResult)
    for (const payload of events) {
      const ev = payload['event'] as string
      if (ev !== 'monitor.completed' && ev !== 'monitor.stalled') {
        expectValidMonitorEvent(payload)
      }
    }
  })

  test('--follow --until idle against an already-idle ready runtime exits already_idle quickly', async () => {
    const alreadyIdleState = createFixtureState({
      runtimeStatus: 'ready',
      activeTurnId: null,
      events: [event(100, 'turn.finished', { turnId: TURN_ID, result: 'turn_succeeded' })],
    })

    const startedAt = performance.now()
    const cli = await invokeWatch(
      {
        selector: SELECTOR,
        follow: true,
        until: 'idle',
        timeoutMs: 250,
      },
      alreadyIdleState
    )
    const elapsedMs = performance.now() - startedAt

    expect(cli.exitCode).toBe(0)
    expect(cli.events.at(-1)).toMatchObject({
      event: 'monitor.completed',
      selector: SELECTOR,
      condition: 'idle',
      result: 'already_idle',
      exitCode: 0,
    })
    expect(elapsedMs).toBeLessThan(1000)
  })

  test('polling reader still respects --timeout when condition never satisfies', async () => {
    // State never transitions to idle — polls forever until timeout fires
    const busyState = createFixtureState({
      runtimeStatus: 'busy',
      activeTurnId: TURN_ID,
      events: [event(100, 'turn.started', { turnId: TURN_ID })],
    })

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    const exitCode = await (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        json: true,
        selector: SELECTOR,
        follow: true,
        until: 'idle',
        timeoutMs: 200,
      },
      {
        buildMonitorState: async () => busyState,
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: {
          write(chunk: string) {
            stderrChunks.push(chunk)
            return true
          },
        },
      }
    )

    expect(exitCode).toBe(1)

    const events = parseJsonLines(stdoutChunks.join(''))
    expect(events.at(-1)).toMatchObject({
      event: 'monitor.completed',
      result: 'timeout',
      exitCode: 1,
      condition: 'idle',
    })
  })
})
