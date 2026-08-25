import { expect } from 'bun:test'
import { MonitorEventSchema } from 'hrc-events'
import { cmdMonitorWatch } from '../../monitor-watch'

export type MonitorCondition = 'turn-finished' | 'idle' | 'busy' | 'response' | 'runtime-dead'

export type MonitorWatchArgs = {
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
  kind?: string | undefined
}

export type MonitorFixtureState = {
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

export type MonitorFixtureEvent = {
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

export type InvokeResult = {
  stdout: string
  stderr: string
  exitCode: number
  events: Array<Record<string, unknown>>
}

export const SESSION_REF = 'agent:cody:project:agent-spaces:task:T-01290/lane:main'
export const SCOPE_REF = 'agent:cody:project:agent-spaces:task:T-01290'
export const SELECTOR = `session:${SESSION_REF}`
export const HOST_SESSION_ID = 'host-session-f2b'
export const RUNTIME_ID = 'runtime-f2b'
export const TURN_ID = 'turn-f2b'
export const MESSAGE_ID = 'msg-f2b'
export const TS = '2026-04-27T17:00:00.000Z'

export class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
  }
}

export async function invokeWatch(
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

export async function invokeWatchText(
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

export function createFixtureState(
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

export function event(
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

export function apiDiagnosticEvent(seq = 205): MonitorFixtureEvent {
  return event(seq, 'broker.diagnostic', {
    category: 'runtime',
    runId: TURN_ID,
    turnId: 'turn-api-error',
    transport: 'tmux',
    payload: {
      level: 'error',
      source: 'harness',
      message: 'API Error: overloaded upstream',
      data: {
        code: 'api_error',
        rawType: 'assistant',
        isApiErrorMessage: true,
        requestId: 'req_05096',
      },
      invocationId: 'invocation-05096',
      seq: 51,
      time: '2026-04-27T17:01:00.000Z',
      turnId: 'turn-api-error',
      inputId: 'input-api-error',
      itemId: 'item-api-error',
      correlation: { requestId: 'req_05096' },
      driver: { kind: 'claude-code-tmux', rawType: 'assistant' },
      runId: TURN_ID,
    },
  })
}

export function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

export function expectValidMonitorEvent(payload: Record<string, unknown>): void {
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
