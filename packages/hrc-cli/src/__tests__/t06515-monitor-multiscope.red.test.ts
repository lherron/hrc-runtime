import { describe, expect, test } from 'bun:test'

import { cmdMonitorWatch } from '../monitor-watch'

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

  test('rejects a multi-selector set with bare --until before condition-specific legality', async () => {
    const result = await invokeWatch(
      ['msg:first', 'msg:second', '--follow', '--until', 'response', '--format', 'ndjson'],
      async () => allState
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('set-shaped selectors require --until-any or --until-all')
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
