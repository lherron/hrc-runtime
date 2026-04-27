import { describe, expect, test } from 'bun:test'

import { parseSelector } from '../selectors.js'

type MonitorCondition =
  | 'turn-finished'
  | 'idle'
  | 'busy'
  | 'response'
  | 'response-or-idle'
  | 'runtime-dead'

type MonitorOutcome = {
  result: string
  exitCode: number
  reason?: string | undefined
  failureKind?: string | undefined
  eventStream?: unknown[] | undefined
}

type MonitorConditionEngineModule = {
  createMonitorConditionEngine: (
    reader: ReturnType<MonitorReaderModule['createMonitorReader']>
  ) => {
    wait: (request: {
      selector: ReturnType<typeof parseSelector>
      condition: MonitorCondition
      timeoutMs?: number | undefined
      stallAfterMs?: number | undefined
    }) => Promise<MonitorOutcome>
  }
}

type MonitorReaderModule = {
  createMonitorReader: (state: MonitorFixtureState) => {
    resolve: (selector: ReturnType<typeof parseSelector>) => unknown
    snapshot: (selector?: ReturnType<typeof parseSelector>) => unknown
    watch: (request: {
      selector?: ReturnType<typeof parseSelector> | undefined
      follow?: boolean | undefined
      fromSeq?: number | undefined
    }) => AsyncIterable<unknown>
    captureStart: (
      selector: ReturnType<typeof parseSelector>,
      options?: { afterSnapshot?: (() => void) | undefined }
    ) => Promise<unknown>
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
    status: 'active' | 'removed'
    activeTurnId: string | null
  }>
  runtimes: Array<{
    runtimeId: string
    hostSessionId: string
    status: 'busy' | 'idle' | 'crashed' | 'dead'
    transport: 'sdk' | 'tmux' | 'headless'
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

async function loadMonitorReaderModule(): Promise<MonitorReaderModule> {
  return (await import('../monitor/index.js')) as MonitorReaderModule
}

async function loadMonitorConditionEngineModule(): Promise<MonitorConditionEngineModule> {
  return (await import('../monitor/condition-engine.js')) as MonitorConditionEngineModule
}

function createFixtureState(
  overrides: {
    runtimeStatus?: MonitorFixtureState['runtimes'][number]['status'] | undefined
    activeTurnId?: string | null | undefined
    sessionStatus?: MonitorFixtureState['sessions'][number]['status'] | undefined
    events?: MonitorFixtureEvent[] | undefined
  } = {}
): MonitorFixtureState {
  const sessionRef = 'agent:cody:project:agent-spaces:task:T-01288/lane:main'
  const scopeRef = 'agent:cody:project:agent-spaces:task:T-01288'
  const hostSessionId = 'host-session-f1b'
  const runtimeId = 'runtime-f1b'
  const activeTurnId =
    overrides.activeTurnId === undefined ? 'turn-captured' : overrides.activeTurnId

  return {
    daemon: {
      pid: 4242,
      status: 'healthy',
      startedAt: '2026-04-27T15:30:00.000Z',
    },
    socket: {
      path: '/tmp/hrc.sock',
      responsive: true,
    },
    tmux: {
      socketPath: '/tmp/hrc-tmux.sock',
      sessionCount: 1,
      windowCount: 1,
      paneCount: 1,
    },
    sessions: [
      {
        sessionRef,
        scopeRef,
        laneRef: 'main',
        hostSessionId,
        generation: 7,
        runtimeId,
        status: overrides.sessionStatus ?? 'active',
        activeTurnId,
      },
    ],
    runtimes: [
      {
        runtimeId,
        hostSessionId,
        status: overrides.runtimeStatus ?? (activeTurnId === null ? 'idle' : 'busy'),
        transport: 'tmux',
        activeTurnId,
      },
    ],
    messages: [
      {
        messageId: 'msg-f1b',
        messageSeq: 1288,
        sessionRef,
        hostSessionId,
        runtimeId,
        runId: 'turn-captured',
      },
    ],
    events: overrides.events ?? [event(100, 'turn.started', { turnId: 'turn-captured' })],
  }
}

function event(
  seq: number,
  name: string,
  overrides: Partial<MonitorFixtureEvent> = {}
): MonitorFixtureEvent {
  return {
    seq,
    ts: '2026-04-27T15:31:00.000Z',
    event: name,
    sessionRef: 'agent:cody:project:agent-spaces:task:T-01288/lane:main',
    scopeRef: 'agent:cody:project:agent-spaces:task:T-01288',
    laneRef: 'main',
    hostSessionId: 'host-session-f1b',
    generation: 7,
    runtimeId: 'runtime-f1b',
    ...overrides,
  }
}

async function waitForCondition(
  state: MonitorFixtureState,
  condition: MonitorCondition,
  selectorRaw = 'session:agent:cody:project:agent-spaces:task:T-01288/lane:main'
): Promise<MonitorOutcome> {
  const [{ createMonitorReader }, { createMonitorConditionEngine }] = await Promise.all([
    loadMonitorReaderModule(),
    loadMonitorConditionEngineModule(),
  ])
  const reader = createMonitorReader(state)
  const engine = createMonitorConditionEngine(reader)
  return engine.wait({
    selector: parseSelector(selectorRaw),
    condition,
    timeoutMs: 25,
  })
}

describe('monitor condition engine acceptance (T-01288 / MONITOR_PROPOSAL section 6)', () => {
  test.each([
    ['turn-finished', 'turn.finished', 'turn_succeeded'],
    ['idle', 'runtime.idle', 'idle'],
    ['busy', 'runtime.busy', 'busy'],
    ['runtime-dead', 'runtime.dead', 'runtime_dead'],
  ] as const)(
    'resolves %s from a matching post-snapshot event',
    async (condition, eventName, result) => {
      const state = createFixtureState({
        runtimeStatus: condition === 'busy' ? 'idle' : 'busy',
        activeTurnId: 'turn-captured',
        events: [
          event(100, 'turn.started', { turnId: 'turn-captured' }),
          event(101, eventName, {
            turnId: 'turn-captured',
            result,
            failureKind: result === 'runtime_dead' ? 'runtime' : undefined,
          }),
        ],
      })

      await expect(waitForCondition(state, condition)).resolves.toMatchObject({
        result,
        exitCode: result === 'runtime_dead' ? 2 : 0,
      })
    }
  )

  test('resolves response only for a correlated msg selector', async () => {
    const state = createFixtureState({
      events: [
        event(100, 'turn.started', { turnId: 'turn-captured' }),
        event(101, 'message.response', {
          messageId: 'msg-f1b',
          messageSeq: 1288,
          turnId: 'turn-captured',
          result: 'response',
        }),
      ],
    })

    await expect(waitForCondition(state, 'response', 'msg:msg-f1b')).resolves.toMatchObject({
      result: 'response',
      exitCode: 0,
    })
  })

  test('ignores uncorrelated message.response events while waiting for a msg selector response', async () => {
    const [{ createMonitorReader }, { createMonitorConditionEngine }] = await Promise.all([
      loadMonitorReaderModule(),
      loadMonitorConditionEngineModule(),
    ])
    const state = createFixtureState()
    const reader = createMonitorReader(state)
    const originalCaptureStart = reader.captureStart
    reader.captureStart = async (selector, options) => {
      return originalCaptureStart(selector, {
        ...options,
        afterSnapshot: () => {
          options?.afterSnapshot?.()
          state.events.push(
            event(101, 'message.response', {
              messageId: 'msg-other',
              messageSeq: 999,
              turnId: 'turn-other',
              result: 'response',
            }),
            event(102, 'message.response', {
              messageId: 'msg-f1b',
              messageSeq: 1288,
              turnId: 'turn-captured',
              result: 'response',
            })
          )
        },
      })
    }
    const engine = createMonitorConditionEngine(reader)

    const result = await engine.wait({
      selector: parseSelector('msg:msg-f1b'),
      condition: 'response',
      timeoutMs: 25,
    })

    expect(result).toMatchObject({
      result: 'response',
      exitCode: 0,
    })
    expect(result.eventStream).toContainEqual(
      expect.objectContaining({
        event: 'message.response',
        messageId: 'msg-f1b',
        messageSeq: 1288,
      })
    )
  })

  test.each([
    [
      'response-or-idle',
      [
        event(100, 'turn.started', { turnId: 'turn-captured' }),
        event(101, 'message.response', {
          messageId: 'msg-f1b',
          messageSeq: 1288,
          turnId: 'turn-captured',
          result: 'response',
        }),
      ],
      'response',
    ],
    [
      'response-or-idle',
      [
        event(100, 'turn.started', { turnId: 'turn-captured' }),
        event(101, 'turn.finished', { turnId: 'turn-captured', result: 'turn_succeeded' }),
        event(102, 'runtime.idle', { turnId: 'turn-captured', result: 'idle_no_response' }),
      ],
      'idle_no_response',
    ],
  ] as const)('resolves %s as %s for a msg selector', async (condition, events, result) => {
    const state = createFixtureState({ events: [...events] })

    await expect(waitForCondition(state, condition, 'msg:msg-f1b')).resolves.toMatchObject({
      result,
      exitCode: 0,
    })
  })

  test.each([
    ['turn-finished', { activeTurnId: null }, 'no_active_turn'],
    ['idle', { activeTurnId: null, runtimeStatus: 'idle' }, 'already_idle'],
    ['busy', { activeTurnId: 'turn-captured', runtimeStatus: 'busy' }, 'already_busy'],
    ['runtime-dead', { activeTurnId: null, runtimeStatus: 'dead' }, 'already_dead'],
  ] as const)('short-circuits %s at start with %s', async (condition, stateOverride, result) => {
    const state = createFixtureState({ ...stateOverride, events: [] })

    await expect(waitForCondition(state, condition)).resolves.toMatchObject({
      result,
      exitCode: 0,
    })
  })

  test('does not miss an event that arrives between atomic start snapshot and follow attach', async () => {
    const [{ createMonitorReader }, { createMonitorConditionEngine }] = await Promise.all([
      loadMonitorReaderModule(),
      loadMonitorConditionEngineModule(),
    ])
    const state = createFixtureState()
    const reader = createMonitorReader(state)
    const originalCaptureStart = reader.captureStart
    reader.captureStart = async (selector, options) => {
      return originalCaptureStart(selector, {
        ...options,
        afterSnapshot: () => {
          options?.afterSnapshot?.()
          state.events.push(
            event(101, 'turn.finished', {
              turnId: 'turn-captured',
              result: 'turn_succeeded',
            })
          )
        },
      })
    }

    const engine = createMonitorConditionEngine(reader)

    await expect(
      engine.wait({
        selector: parseSelector('session:agent:cody:project:agent-spaces:task:T-01288/lane:main'),
        condition: 'turn-finished',
        timeoutMs: 25,
      })
    ).resolves.toMatchObject({
      result: 'turn_succeeded',
      exitCode: 0,
    })
  })

  test.each([
    [
      'session_rebound',
      event(101, 'monitor.completed', { result: 'context_changed', reason: 'session_rebound' }),
    ],
    [
      'generation_changed',
      event(101, 'monitor.completed', {
        generation: 8,
        result: 'context_changed',
        reason: 'generation_changed',
      }),
    ],
    ['cleared', event(101, 'monitor.completed', { result: 'context_changed', reason: 'cleared' })],
  ] as const)('returns context_changed with reason=%s', async (reason, changedEvent) => {
    const state = createFixtureState({
      events: [event(100, 'turn.started', { turnId: 'turn-captured' }), changedEvent],
    })

    await expect(waitForCondition(state, 'turn-finished')).resolves.toMatchObject({
      result: 'context_changed',
      reason,
      exitCode: 4,
    })
  })

  test.each(['response', 'response-or-idle'] as const)(
    'rejects session selector for %s at the engine boundary',
    async (condition) => {
      const state = createFixtureState()

      await expect(waitForCondition(state, condition)).rejects.toMatchObject({
        detail: expect.objectContaining({
          condition,
          selectorKind: 'session',
        }),
      })
    }
  )

  test.each([
    [
      'success',
      createFixtureState({ activeTurnId: null, events: [] }),
      'turn-finished',
      0,
      'no_active_turn',
    ],
    [
      'timeout',
      createFixtureState({ events: [event(100, 'turn.started', { turnId: 'turn-captured' })] }),
      'turn-finished',
      1,
      'timeout',
    ],
    [
      'turn failure',
      createFixtureState({
        events: [
          event(100, 'turn.started', { turnId: 'turn-captured' }),
          event(101, 'turn.finished', {
            turnId: 'turn-captured',
            result: 'turn_failed',
            failureKind: 'model',
          }),
        ],
      }),
      'turn-finished',
      2,
      'turn_failed',
    ],
    [
      'monitor infrastructure error',
      createFixtureState({
        events: [event(100, 'turn.started', { turnId: 'turn-captured' })],
      }),
      'turn-finished',
      3,
      'monitor_error',
    ],
    [
      'context changed',
      createFixtureState({
        events: [
          event(100, 'turn.started', { turnId: 'turn-captured' }),
          event(101, 'session.cleared'),
        ],
      }),
      'turn-finished',
      4,
      'context_changed',
    ],
  ] as const)(
    'covers MONITOR_PROPOSAL §7.3 wait exit mapping for %s',
    async (_label, state, condition, exitCode, result) => {
      const [{ createMonitorReader }, { createMonitorConditionEngine }] = await Promise.all([
        loadMonitorReaderModule(),
        loadMonitorConditionEngineModule(),
      ])
      const engine = createMonitorConditionEngine(createMonitorReader(state))

      await expect(
        engine.wait({
          selector: parseSelector('session:agent:cody:project:agent-spaces:task:T-01288/lane:main'),
          condition,
          timeoutMs: exitCode === 3 ? undefined : 5,
        })
      ).resolves.toMatchObject({
        result,
        exitCode,
      })
    }
  )

  test.each([
    [
      'turn failure',
      'turn-finished',
      event(101, 'turn.finished', {
        turnId: 'turn-captured',
        result: 'turn_failed',
        failureKind: 'tool',
      }),
      'turn_failed',
      'tool',
    ],
    [
      'runtime failure',
      'idle',
      event(101, 'runtime.dead', {
        turnId: 'turn-captured',
        result: 'runtime_dead',
        failureKind: 'process',
      }),
      'runtime_dead',
      'process',
    ],
  ] as const)(
    'returns exit 2 and failureKind discriminator for %s',
    async (_label, condition, failureEvent, result, failureKind) => {
      const state = createFixtureState({
        events: [event(100, 'turn.started', { turnId: 'turn-captured' }), failureEvent],
      })

      await expect(waitForCondition(state, condition)).resolves.toMatchObject({
        result,
        exitCode: 2,
        failureKind,
        eventStream: expect.arrayContaining([
          expect.objectContaining({
            event: 'monitor.completed',
            result,
            exitCode: 2,
            failureKind,
          }),
        ]),
      })
    }
  )
})
