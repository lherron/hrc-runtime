import { describe, expect, test } from 'bun:test'

import { main } from '../cli'
import { parseMonitorSelectors } from '../monitor-selectors'
import { cmdMonitorWatch, waitForAnyMonitorCondition } from '../monitor-watch'

const TASK_ID = 'T-06515'
const OTHER_TASK_ID = 'T-99999'
const COORD_SCOPE = `agent:coordinator:project:hrc-runtime:task:${TASK_ID}:role:coordinator`
const WORKER_SCOPE = `agent:worker:project:hrc-runtime:task:${TASK_ID}:role:tester`
const OTHER_SCOPE = `agent:intruder:project:hrc-runtime:task:${OTHER_TASK_ID}:role:tester`

type FixtureEvent = {
  seq: number
  hrcSeq: number
  streamSeq: number
  ts: string
  event: string
  eventKind: string
  category: string
  sessionRef: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
  runtimeId: string
  turnId: string
  runId: string
  result?: string | undefined
}

type FixtureState = {
  daemon: { pid: number; status: 'healthy' }
  socket: { path: string; responsive: true }
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
  messages: []
  events: FixtureEvent[]
}

type ExtendedWatchArgs = {
  selector?: string | undefined
  selectors?: string[] | undefined
  format?: 'compact' | 'ndjson' | undefined
  follow?: boolean | undefined
  until?: string | undefined
  timeoutMs?: number | undefined
  forever?: boolean | undefined
  signal?: AbortSignal | undefined
}

function ids(scopeRef: string): { hostSessionId: string; runtimeId: string; turnId: string } {
  const agent = scopeRef.match(/^agent:([^:]+)/)?.[1] ?? 'unknown'
  return {
    hostSessionId: `host-${agent}`,
    runtimeId: `runtime-${agent}`,
    turnId: `turn-${agent}`,
  }
}

function fixtureEvent(
  seq: number,
  scopeRef: string,
  eventKind = 'turn.started',
  result?: string,
  runId = ids(scopeRef).turnId
): FixtureEvent {
  const identity = ids(scopeRef)
  return {
    seq,
    hrcSeq: seq,
    streamSeq: seq,
    ts: `2026-07-17T15:00:${String(seq).padStart(2, '0')}.000Z`,
    event: eventKind === 'turn.completed' ? 'turn.finished' : eventKind,
    eventKind,
    category: eventKind.split('.')[0] ?? 'turn',
    sessionRef: `${scopeRef}/lane:main`,
    scopeRef,
    laneRef: 'main',
    hostSessionId: identity.hostSessionId,
    generation: 1,
    runtimeId: identity.runtimeId,
    turnId: runId,
    runId,
    ...(result ? { result } : {}),
  }
}

function deadFixtureState(
  scopes: string[],
  events: FixtureEvent[],
  deadScope: string
): FixtureState {
  const state = fixtureState(scopes, events, new Set([deadScope]))
  const runtime = state.runtimes.find(
    (candidate) => candidate.runtimeId === ids(deadScope).runtimeId
  )
  if (!runtime) throw new Error(`missing runtime for ${deadScope}`)
  runtime.status = 'dead'
  return state
}

async function waitForAny(
  initialState: FixtureState,
  selectorRaws: string[],
  buildMonitorState: () => Promise<FixtureState>,
  timeoutMs = 800
): Promise<{ outcome: Record<string, unknown>; scopeRef: string }> {
  return (await waitForAnyMonitorCondition(
    initialState as never,
    { until: 'terminal', timeoutMs },
    parseMonitorSelectors(selectorRaws),
    { buildMonitorState: buildMonitorState as never }
  )) as { outcome: Record<string, unknown>; scopeRef: string }
}

function fixtureState(
  scopes: string[],
  events: FixtureEvent[],
  idleScopes = new Set<string>()
): FixtureState {
  return {
    daemon: { pid: 6515, status: 'healthy' },
    socket: { path: '/tmp/t06515.sock', responsive: true },
    sessions: scopes.map((scopeRef) => {
      const identity = ids(scopeRef)
      const idle = idleScopes.has(scopeRef)
      return {
        sessionRef: `${scopeRef}/lane:main`,
        scopeRef,
        laneRef: 'main',
        hostSessionId: identity.hostSessionId,
        generation: 1,
        runtimeId: identity.runtimeId,
        status: 'active' as const,
        activeTurnId: idle ? null : identity.turnId,
      }
    }),
    runtimes: scopes.map((scopeRef) => {
      const identity = ids(scopeRef)
      const idle = idleScopes.has(scopeRef)
      return {
        runtimeId: identity.runtimeId,
        hostSessionId: identity.hostSessionId,
        status: idle ? ('idle' as const) : ('busy' as const),
        transport: 'tmux' as const,
        activeTurnId: idle ? null : identity.turnId,
      }
    }),
    messages: [],
    events,
  }
}

async function invokeWatch(
  args: string[] | ExtendedWatchArgs,
  buildMonitorState: () => Promise<FixtureState>
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = await (
    cmdMonitorWatch as unknown as (
      args: string[] | ExtendedWatchArgs,
      deps: {
        buildMonitorState: () => Promise<FixtureState>
        stdout: { write(chunk: string): boolean }
        stderr: { write(chunk: string): boolean }
      }
    ) => Promise<number>
  )(args, {
    buildMonitorState,
    stdout: {
      write(chunk) {
        stdout.push(chunk)
        return true
      },
    },
    stderr: {
      write(chunk) {
        stderr.push(chunk)
        return true
      },
    },
  })
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') }
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function replayScopes(stdout: string): string[] {
  return jsonLines(stdout)
    .filter(
      (event) =>
        event['event'] !== 'monitor.snapshot' && !String(event['event']).startsWith('monitor.')
    )
    .map((event) => String(event['scopeRef']))
}

describe('T-06515 monitor selector-set grammar', () => {
  const allState = fixtureState(
    [COORD_SCOPE, WORKER_SCOPE, OTHER_SCOPE],
    [fixtureEvent(1, COORD_SCOPE), fixtureEvent(2, WORKER_SCOPE), fixtureEvent(3, OTHER_SCOPE)]
  )

  test.each([
    ['exact scope', [`scope:${COORD_SCOPE}`], [COORD_SCOPE]],
    [
      'trailing-star prefix',
      [`scope:agent:worker:project:hrc-runtime:task:${TASK_ID}:*`],
      [WORKER_SCOPE],
    ],
    ['bare task id', [TASK_ID], [COORD_SCOPE, WORKER_SCOPE]],
    [
      'mixed exact and prefix set',
      [`scope:${COORD_SCOPE}`, `scope:agent:worker:project:hrc-runtime:task:${TASK_ID}:*`],
      [COORD_SCOPE, WORKER_SCOPE],
    ],
  ] as const)(
    'matches %s selectors against event scopeRef',
    async (_label, selectors, expected) => {
      const result = await invokeWatch(
        [...selectors, '--from-seq', '1', '--format', 'ndjson'],
        async () => allState
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(replayScopes(result.stdout)).toEqual(expected)
    }
  )

  test('task selector discovers a matching runtime whose first event lands after watch start', async () => {
    const controller = new AbortController()
    const initial = fixtureState([COORD_SCOPE], [fixtureEvent(1, COORD_SCOPE)])
    const updated = fixtureState(
      [COORD_SCOPE, WORKER_SCOPE, OTHER_SCOPE],
      [fixtureEvent(1, COORD_SCOPE), fixtureEvent(2, WORKER_SCOPE), fixtureEvent(3, OTHER_SCOPE)]
    )
    let reads = 0

    const result = await invokeWatch(
      {
        selectors: [TASK_ID],
        follow: true,
        forever: true,
        format: 'ndjson',
        signal: controller.signal,
      },
      async () => {
        reads += 1
        if (reads === 1) return initial
        controller.abort()
        return updated
      }
    )

    expect(result.exitCode).toBe(130)
    expect(replayScopes(result.stdout)).toContain(WORKER_SCOPE)
    expect(replayScopes(result.stdout)).not.toContain(OTHER_SCOPE)
  })

  test.each(['response', 'response-or-idle'] as const)(
    'rejects a multi-selector set with --until %s using the canonical usage error',
    async (condition) => {
      const result = await invokeWatch(
        ['msg:first', 'msg:second', '--follow', '--until', condition, '--format', 'ndjson'],
        async () => allState
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain(`${condition} requires a msg: selector`)
    }
  )
})

describe('T-06515 any-match and default terminal gating', () => {
  test('first terminal stream wins and the final ndjson event names its scopeRef', async () => {
    const initial = fixtureState(
      [COORD_SCOPE, WORKER_SCOPE],
      [fixtureEvent(1, COORD_SCOPE), fixtureEvent(2, WORKER_SCOPE)]
    )
    const finished = fixtureState(
      [COORD_SCOPE, WORKER_SCOPE],
      [
        fixtureEvent(1, COORD_SCOPE),
        fixtureEvent(2, WORKER_SCOPE),
        fixtureEvent(3, WORKER_SCOPE, 'turn.completed', 'turn_succeeded'),
      ]
    )
    const result = await invokeWatch(
      [
        `scope:${COORD_SCOPE}`,
        `scope:${WORKER_SCOPE}`,
        '--follow',
        '--until',
        'terminal',
        '--timeout',
        '25ms',
        '--format',
        'ndjson',
      ],
      (() => {
        let reads = 0
        return async () => {
          reads += 1
          return reads === 1 ? initial : finished
        }
      })()
    )

    expect(result.exitCode).toBe(0)
    expect(jsonLines(result.stdout).at(-1)).toMatchObject({
      event: 'monitor.completed',
      condition: 'terminal',
      scopeRef: WORKER_SCOPE,
      exitCode: 0,
    })
  })

  test('single concrete runtime follow defaults to terminal while --forever overrides it', async () => {
    const initial = fixtureState([COORD_SCOPE], [fixtureEvent(1, COORD_SCOPE)])
    const finished = fixtureState(
      [COORD_SCOPE],
      [
        fixtureEvent(1, COORD_SCOPE),
        fixtureEvent(2, COORD_SCOPE, 'turn.completed', 'turn_succeeded'),
      ]
    )
    let reads = 0
    const defaultResult = await invokeWatch(
      {
        selector: `runtime:${ids(COORD_SCOPE).runtimeId}`,
        follow: true,
        format: 'ndjson',
      },
      async () => {
        reads += 1
        return reads === 1 ? initial : finished
      }
    )

    const foreverController = new AbortController()
    let foreverReads = 0
    const foreverResult = await invokeWatch(
      {
        selector: `runtime:${ids(COORD_SCOPE).runtimeId}`,
        follow: true,
        forever: true,
        format: 'ndjson',
        signal: foreverController.signal,
      },
      async () => {
        foreverReads += 1
        if (foreverReads > 1) foreverController.abort()
        return foreverReads === 1 ? initial : finished
      }
    )

    expect(defaultResult.exitCode).toBe(0)
    expect(jsonLines(defaultResult.stdout).at(-1)).toMatchObject({
      event: 'monitor.completed',
      condition: 'terminal',
      scopeRef: COORD_SCOPE,
    })
    expect(foreverResult.exitCode).toBe(130)
  })

  test.each([
    [
      'multiple exact selectors',
      [`runtime:${ids(COORD_SCOPE).runtimeId}`, `runtime:${ids(WORKER_SCOPE).runtimeId}`],
    ],
    ['a prefix selector', [`scope:agent:worker:project:hrc-runtime:task:${TASK_ID}:*`]],
    ['a task-id selector', [TASK_ID]],
  ] as const)('%s do not receive the implicit terminal condition', async (_label, selectors) => {
    const controller = new AbortController()
    const state = fixtureState([COORD_SCOPE, WORKER_SCOPE], [])
    let reads = 0
    const result = await invokeWatch(
      { selectors: [...selectors], follow: true, format: 'ndjson', signal: controller.signal },
      async () => {
        reads += 1
        if (reads > 1) controller.abort()
        return state
      }
    )

    expect(result.exitCode).toBe(130)
  })

  test('AC1: a late idle scope cannot win fan-in before a real terminal event', async () => {
    const initial = fixtureState([COORD_SCOPE], [fixtureEvent(1, COORD_SCOPE)])
    const lateIdle = fixtureState(
      [COORD_SCOPE, WORKER_SCOPE],
      [fixtureEvent(1, COORD_SCOPE)],
      new Set([WORKER_SCOPE])
    )
    const finished = fixtureState(
      [COORD_SCOPE, WORKER_SCOPE],
      [
        fixtureEvent(1, COORD_SCOPE),
        fixtureEvent(2, COORD_SCOPE, 'turn.completed', 'turn_succeeded', 'run-coordinator'),
      ],
      new Set([WORKER_SCOPE])
    )
    let reads = 0

    const winner = await waitForAny(initial, [TASK_ID], async () => {
      reads += 1
      return reads <= 4 ? lateIdle : finished
    })

    expect(winner.scopeRef).toBe(COORD_SCOPE)
    expect(winner.outcome).toMatchObject({
      result: 'turn_succeeded',
      exitCode: 0,
      runId: 'run-coordinator',
    })
  })

  test.each(['initial', 'late'] as const)(
    'AC5: %s never-ran candidates are non-terminal',
    async (discovery) => {
      const initial = fixtureState(
        discovery === 'initial' ? [COORD_SCOPE, WORKER_SCOPE] : [COORD_SCOPE],
        [fixtureEvent(1, COORD_SCOPE)],
        discovery === 'initial' ? new Set([WORKER_SCOPE]) : new Set()
      )
      const discovered = fixtureState(
        [COORD_SCOPE, WORKER_SCOPE],
        [fixtureEvent(1, COORD_SCOPE)],
        new Set([WORKER_SCOPE])
      )

      const winner = await waitForAny(initial, [TASK_ID], async () => discovered, 250)

      expect(winner.outcome).toMatchObject({ result: 'timeout', exitCode: 1 })
    }
  )

  test.each(['initial', 'late'] as const)(
    'AC5/AC6: %s stillborn candidates resolve from replayable runtime death',
    async (discovery) => {
      const scopes = discovery === 'initial' ? [COORD_SCOPE, WORKER_SCOPE] : [COORD_SCOPE]
      const initial = fixtureState(
        scopes,
        [fixtureEvent(1, COORD_SCOPE)],
        discovery === 'initial' ? new Set([WORKER_SCOPE]) : new Set()
      )
      const dead = deadFixtureState(
        [COORD_SCOPE, WORKER_SCOPE],
        [
          fixtureEvent(1, COORD_SCOPE),
          fixtureEvent(2, WORKER_SCOPE, 'runtime.dead', 'runtime_dead'),
        ],
        WORKER_SCOPE
      )
      let reads = 0

      const winner = await waitForAny(initial, [TASK_ID], async () => {
        reads += 1
        return discovery === 'initial' && reads < 3 ? initial : dead
      })

      expect(winner.scopeRef).toBe(WORKER_SCOPE)
      expect(winner.outcome).toMatchObject({ result: 'runtime_dead', exitCode: 0 })
    }
  )

  test('AC10/AC11: implicit follow ignores pre-fence terminal history and reports the next run', async () => {
    const initial = fixtureState(
      [COORD_SCOPE],
      [fixtureEvent(1, COORD_SCOPE, 'turn.completed', 'turn_succeeded', 'run-prior')],
      new Set([COORD_SCOPE])
    )
    const finished = fixtureState(
      [COORD_SCOPE],
      [
        fixtureEvent(1, COORD_SCOPE, 'turn.completed', 'turn_succeeded', 'run-prior'),
        fixtureEvent(2, COORD_SCOPE, 'turn.started', undefined, 'run-next'),
        fixtureEvent(3, COORD_SCOPE, 'turn.completed', 'turn_succeeded', 'run-next'),
      ]
    )
    let reads = 0

    const result = await invokeWatch(
      {
        selector: `runtime:${ids(COORD_SCOPE).runtimeId}`,
        follow: true,
        format: 'ndjson',
      },
      async () => {
        reads += 1
        return reads === 1 ? initial : finished
      }
    )

    expect(result.exitCode).toBe(0)
    expect(jsonLines(result.stdout).at(-1)).toMatchObject({
      event: 'monitor.completed',
      condition: 'terminal',
      scopeRef: COORD_SCOPE,
      runId: 'run-next',
      exitCode: 0,
    })
  })
})

describe('T-06515 fan-in output identity', () => {
  const state = fixtureState(
    [COORD_SCOPE, WORKER_SCOPE],
    [fixtureEvent(1, COORD_SCOPE), fixtureEvent(2, WORKER_SCOPE)]
  )

  test('ndjson carries scopeRef on every interleaved lifecycle event', async () => {
    const result = await invokeWatch(
      [TASK_ID, '--from-seq', '1', '--format', 'ndjson'],
      async () => state
    )
    const events = jsonLines(result.stdout).filter(
      (event) => !String(event['event']).startsWith('monitor.')
    )

    expect(events).toHaveLength(2)
    expect(events.every((event) => typeof event['scopeRef'] === 'string')).toBe(true)
    expect(events.map((event) => event['scopeRef'])).toEqual([COORD_SCOPE, WORKER_SCOPE])
  })

  test('compact output carries a scope badge on every interleaved event', async () => {
    const result = await invokeWatch(
      [TASK_ID, '--from-seq', '1', '--format', 'compact'],
      async () => state
    )
    const lines = result.stdout.split('\n').filter(Boolean)

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(`coordinator:${TASK_ID}`)
    expect(lines[1]).toContain(`worker:${TASK_ID}`)
  })
})

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with ${code}`)
  }
}

test('monitor wait accepts multiple selectors and reports the first terminal scope', async () => {
  const state = fixtureState(
    [COORD_SCOPE, WORKER_SCOPE],
    [
      fixtureEvent(1, COORD_SCOPE),
      fixtureEvent(2, WORKER_SCOPE),
      fixtureEvent(3, WORKER_SCOPE, 'turn.completed', 'turn_succeeded'),
    ]
  )
  const stdout: string[] = []
  const stderr: string[] = []
  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write
  const originalExit = process.exit
  const originalFixture = process.env['HRC_MONITOR_FIXTURE_STATE_JSON']
  process.env['HRC_MONITOR_FIXTURE_STATE_JSON'] = JSON.stringify(state)
  process.stdout.write = ((chunk: string) => {
    stdout.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    stderr.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  process.exit = ((code?: number) => {
    throw new CliExit(code ?? 0)
  }) as typeof process.exit

  let exitCode = 0
  try {
    await main([
      'monitor',
      'wait',
      `scope:${COORD_SCOPE}`,
      `scope:${WORKER_SCOPE}`,
      '--until',
      'terminal',
      '--since',
      '1',
      '--timeout',
      '25ms',
      '--json',
    ])
  } catch (error) {
    if (!(error instanceof CliExit)) throw error
    exitCode = error.code
  } finally {
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
    process.exit = originalExit
    if (originalFixture === undefined) process.env['HRC_MONITOR_FIXTURE_STATE_JSON'] = undefined
    else process.env['HRC_MONITOR_FIXTURE_STATE_JSON'] = originalFixture
  }

  expect(exitCode).toBe(0)
  expect(stderr.join('')).toBe('')
  expect(JSON.parse(stdout.join(''))).toMatchObject({
    event: 'monitor.completed',
    condition: 'terminal',
    scopeRef: WORKER_SCOPE,
    runId: ids(WORKER_SCOPE).turnId,
    exitCode: 0,
  })
})
