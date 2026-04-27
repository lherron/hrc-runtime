import { describe, expect, test } from 'bun:test'

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
    status: 'busy' | 'idle' | 'dead'
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
  ts: string
  event: string
  sessionRef: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
  runtimeId: string
  turnId?: string | undefined
  messageId?: string | undefined
  messageSeq?: number | undefined
  result?: string | undefined
  reason?: string | undefined
  failureKind?: string | undefined
}

const SESSION_REF = 'agent:cody:project:agent-spaces:task:T-01291/lane:main'
const SCOPE_REF = 'agent:cody:project:agent-spaces:task:T-01291'
const HOST_SESSION_ID = 'host-session-f2c'
const RUNTIME_ID = 'runtime-f2c'
const TURN_ID = 'turn-f2c'
const MESSAGE_ID = 'msg-f2c'

async function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
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

function fixtureEnv(state: MonitorFixtureState): Record<string, string> {
  return {
    HRC_MONITOR_FIXTURE_STATE_JSON: JSON.stringify(state),
  }
}

function createFixtureState(
  overrides: {
    activeTurnId?: string | null | undefined
    runtimeStatus?: MonitorFixtureState['runtimes'][number]['status'] | undefined
    events?: MonitorFixtureEvent[] | undefined
  } = {}
): MonitorFixtureState {
  const activeTurnId = overrides.activeTurnId === undefined ? TURN_ID : overrides.activeTurnId

  return {
    daemon: {
      pid: 91291,
      status: 'healthy',
      startedAt: '2026-04-27T16:00:00.000Z',
    },
    socket: {
      path: '/tmp/hrc-monitor-f2c.sock',
      responsive: true,
    },
    tmux: {
      socketPath: '/tmp/hrc-monitor-f2c-tmux.sock',
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
        messageSeq: 1291,
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
    ts: '2026-04-27T16:01:00.000Z',
    event: name,
    sessionRef: SESSION_REF,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    hostSessionId: HOST_SESSION_ID,
    generation: 12,
    runtimeId: RUNTIME_ID,
    ...overrides,
  }
}

function parseSingleJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0]!) as Record<string, unknown>
}

describe('monitor wait CLI acceptance (T-01291 / F2c)', () => {
  test.each([
    ['turn-finished', createFixtureState({ activeTurnId: null, events: [] }), 0, 'no_active_turn'],
    [
      'idle',
      createFixtureState({ activeTurnId: null, runtimeStatus: 'idle', events: [] }),
      0,
      'already_idle',
    ],
    ['busy', createFixtureState({ runtimeStatus: 'busy', events: [] }), 0, 'already_busy'],
    [
      'runtime-dead',
      createFixtureState({ activeTurnId: null, runtimeStatus: 'dead', events: [] }),
      0,
      'already_dead',
    ],
    [
      'turn-finished',
      createFixtureState({
        events: [
          event(100, 'turn.started', { turnId: TURN_ID }),
          event(101, 'turn.finished', { turnId: TURN_ID, result: 'turn_succeeded' }),
        ],
      }),
      0,
      'turn_succeeded',
    ],
    [
      'turn-finished',
      createFixtureState({ events: [event(100, 'turn.started', { turnId: TURN_ID })] }),
      1,
      'timeout',
    ],
    [
      'turn-finished',
      createFixtureState({
        events: [
          event(100, 'turn.started', { turnId: TURN_ID }),
          event(101, 'turn.finished', {
            turnId: TURN_ID,
            result: 'turn_failed',
            failureKind: 'tool',
          }),
        ],
      }),
      2,
      'turn_failed',
    ],
    [
      'turn-finished',
      createFixtureState({
        events: [
          event(100, 'turn.started', { turnId: TURN_ID }),
          event(101, 'monitor.error', { result: 'monitor_error' }),
        ],
      }),
      3,
      'monitor_error',
    ],
    [
      'turn-finished',
      createFixtureState({
        events: [event(100, 'turn.started', { turnId: TURN_ID }), event(101, 'session.cleared')],
      }),
      4,
      'context_changed',
    ],
  ] as const)(
    'matches MONITOR_PROPOSAL §7.3 exit semantics for --until %s',
    async (condition, state, exitCode, result) => {
      const args = [
        'monitor',
        'wait',
        `session:${SESSION_REF}`,
        '--until',
        condition,
        '--timeout',
        '5ms',
        '--json',
      ]

      const cli = await runCli(args, fixtureEnv(state))
      const payload = parseSingleJsonLine(cli.stdout)

      expect(cli.exitCode).toBe(exitCode)
      expect(payload).toMatchObject({
        event: 'monitor.completed',
        selector: `session:${SESSION_REF}`,
        condition,
        result,
        exitCode,
      })
    }
  )

  test.each(['response', 'response-or-idle'] as const)(
    'rejects session selectors for --until %s with cli-kit usage exit 2',
    async (condition) => {
      const cli = await runCli([
        'monitor',
        'wait',
        `session:${SESSION_REF}`,
        '--until',
        condition,
        '--json',
      ])

      expect(cli.exitCode).toBe(2)
      expect(cli.stdout).toBe('')
      expect(JSON.parse(cli.stderr)).toMatchObject({
        error: {
          usage: true,
          message: expect.stringContaining(`${condition} requires a msg: selector`),
        },
      })
    }
  )

  test('emits JSON output for the final event with context_changed reason discriminator', async () => {
    const cli = await runCli(
      [
        'monitor',
        'wait',
        `session:${SESSION_REF}`,
        '--until',
        'turn-finished',
        '--timeout',
        '5ms',
        '--json',
      ],
      fixtureEnv(
        createFixtureState({
          events: [
            event(100, 'turn.started', { turnId: TURN_ID }),
            event(101, 'monitor.completed', {
              result: 'context_changed',
              reason: 'generation_changed',
              generation: 13,
            }),
          ],
        })
      )
    )

    expect(cli.exitCode).toBe(4)
    expect(parseSingleJsonLine(cli.stdout)).toMatchObject({
      event: 'monitor.completed',
      result: 'context_changed',
      reason: 'generation_changed',
      exitCode: 4,
    })
  })

  test('emits text output for the final event', async () => {
    const cli = await runCli(
      ['monitor', 'wait', `session:${SESSION_REF}`, '--until', 'turn-finished', '--timeout', '5ms'],
      fixtureEnv(
        createFixtureState({
          events: [
            event(100, 'turn.started', { turnId: TURN_ID }),
            event(101, 'turn.finished', { turnId: TURN_ID, result: 'turn_succeeded' }),
          ],
        })
      )
    )

    expect(cli.exitCode).toBe(0)
    expect(cli.stderr).toBe('')
    expect(cli.stdout).toContain('monitor.completed')
    expect(cli.stdout).toContain(`selector=session:${SESSION_REF}`)
    expect(cli.stdout).toContain('condition=turn-finished')
    expect(cli.stdout).toContain('result=turn_succeeded')
    expect(cli.stdout).toContain('exitCode=0')
  })

  test.each([
    [
      'turn failure',
      event(101, 'turn.finished', {
        turnId: TURN_ID,
        result: 'turn_failed',
        failureKind: 'model',
      }),
      'turn_failed',
      'model',
    ],
    [
      'runtime failure',
      event(101, 'runtime.dead', {
        turnId: TURN_ID,
        result: 'runtime_dead',
        failureKind: 'process',
      }),
      'runtime_dead',
      'process',
    ],
  ] as const)(
    'exits 2 for %s and preserves failureKind in the final event payload',
    async (_label, failureEvent, result, failureKind) => {
      const cli = await runCli(
        [
          'monitor',
          'wait',
          `session:${SESSION_REF}`,
          '--until',
          'turn-finished',
          '--timeout',
          '5ms',
          '--json',
        ],
        fixtureEnv(
          createFixtureState({
            events: [event(100, 'turn.started', { turnId: TURN_ID }), failureEvent],
          })
        )
      )

      expect(cli.exitCode).toBe(2)
      expect(parseSingleJsonLine(cli.stdout)).toMatchObject({
        event: 'monitor.completed',
        result,
        failureKind,
        exitCode: 2,
      })
    }
  )

  test.each(['response', 'response-or-idle'] as const)(
    'allows msg selectors for --until %s',
    async (condition) => {
      const cli = await runCli(
        [
          'monitor',
          'wait',
          `msg:${MESSAGE_ID}`,
          '--until',
          condition,
          '--timeout',
          '5ms',
          '--json',
        ],
        fixtureEnv(
          createFixtureState({
            events: [
              event(100, 'turn.started', { turnId: TURN_ID }),
              event(101, 'message.response', {
                turnId: TURN_ID,
                messageId: MESSAGE_ID,
                messageSeq: 1291,
                result: 'response',
              }),
            ],
          })
        )
      )

      expect(cli.exitCode).toBe(0)
      expect(parseSingleJsonLine(cli.stdout)).toMatchObject({
        event: 'monitor.completed',
        selector: `msg:${MESSAGE_ID}`,
        condition,
        result: 'response',
        exitCode: 0,
      })
    }
  )
})
