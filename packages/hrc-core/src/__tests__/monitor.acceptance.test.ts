import { describe, expect, test } from 'bun:test'

import { formatSelector, parseSelector } from '../selectors.js'

type MonitorModule = {
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
    status: 'busy' | 'idle' | 'crashed'
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
}

async function loadMonitorModule(): Promise<MonitorModule> {
  return (await import('../monitor/index.js')) as MonitorModule
}

function createFixtureState(): MonitorFixtureState {
  const sessionRef = 'agent:cody:project:agent-spaces:task:T-01286/lane:repair'
  const scopeRef = 'agent:cody:project:agent-spaces:task:T-01286'
  const hostSessionId = 'host-session-live'
  const runtimeId = 'runtime-live'

  return {
    daemon: {
      pid: 4242,
      status: 'healthy',
      startedAt: '2026-04-27T14:00:00.000Z',
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
        laneRef: 'repair',
        hostSessionId,
        generation: 7,
        runtimeId,
        status: 'active',
        activeTurnId: 'turn-active',
      },
    ],
    runtimes: [
      {
        runtimeId,
        hostSessionId,
        status: 'busy',
        transport: 'tmux',
        activeTurnId: 'turn-active',
      },
    ],
    messages: [
      {
        messageId: 'msg-live',
        messageSeq: 77,
        sessionRef,
        hostSessionId,
        runtimeId,
        runId: 'turn-active',
      },
    ],
    events: [
      {
        seq: 101,
        ts: '2026-04-27T14:01:00.000Z',
        event: 'turn.started',
        sessionRef,
        scopeRef,
        laneRef: 'repair',
        hostSessionId,
        generation: 7,
        runtimeId,
        turnId: 'turn-active',
      },
      {
        seq: 102,
        ts: '2026-04-27T14:01:01.000Z',
        event: 'message.response',
        sessionRef,
        scopeRef,
        laneRef: 'repair',
        hostSessionId,
        generation: 7,
        runtimeId,
        turnId: 'turn-active',
        messageId: 'msg-live',
        messageSeq: 77,
      },
    ],
  }
}

async function collect(iterable: AsyncIterable<unknown>, limit = 200): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of iterable) {
    events.push(event)
    if (events.length >= limit) break
  }
  return events
}

describe('monitor acceptance: selector resolver (T-01286 / MONITOR_PROPOSAL section 5)', () => {
  test('resolves every F0 monitor selector kind to live state with the current event high-water mark', async () => {
    const { createMonitorReader } = await loadMonitorModule()
    const state = createFixtureState()
    const reader = createMonitorReader(state)

    const selectors = [
      'cody@agent-spaces:T-01286~repair',
      'scope:agent:cody:project:agent-spaces:task:T-01286',
      'session:agent:cody:project:agent-spaces:task:T-01286/lane:repair',
      'host:host-session-live',
      'runtime:runtime-live',
      'msg:msg-live',
      'seq:77',
    ]

    for (const raw of selectors) {
      const selector = parseSelector(raw)
      expect(reader.resolve(selector)).toMatchObject({
        selector: {
          kind: selector.kind,
          canonical: formatSelector(selector),
        },
        sessionRef: 'agent:cody:project:agent-spaces:task:T-01286/lane:repair',
        scopeRef: 'agent:cody:project:agent-spaces:task:T-01286',
        laneRef: 'repair',
        hostSessionId: 'host-session-live',
        generation: 7,
        runtimeId: 'runtime-live',
        activeTurnId: 'turn-active',
        eventHighWaterSeq: 102,
      })
    }
  })

  test('returns structured not-found errors without throwing away selector kind or requested id', async () => {
    const { createMonitorReader } = await loadMonitorModule()
    const reader = createMonitorReader(createFixtureState())

    expect(reader.resolve(parseSelector('runtime:missing-runtime'))).toEqual({
      ok: false,
      error: {
        code: 'unknown_runtime',
        message: expect.any(String),
        detail: {
          selectorKind: 'runtime',
          runtimeId: 'missing-runtime',
        },
      },
    })
  })
})

describe('monitor acceptance: snapshot reader (T-01286)', () => {
  test('reads a current-state snapshot for a selector with daemon, socket, event, tmux, runtime, and session details', async () => {
    const { createMonitorReader } = await loadMonitorModule()
    const reader = createMonitorReader(createFixtureState())

    expect(reader.snapshot(parseSelector('cody@agent-spaces:T-01286~repair'))).toMatchObject({
      kind: 'monitor.snapshot',
      selector: {
        canonical: 'session:agent:cody:project:agent-spaces:task:T-01286/lane:repair',
      },
      eventHighWaterSeq: 102,
      daemon: {
        status: 'healthy',
        pid: 4242,
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
      counts: {
        sessions: 1,
        runtimes: 1,
      },
      session: {
        sessionRef: 'agent:cody:project:agent-spaces:task:T-01286/lane:repair',
        hostSessionId: 'host-session-live',
        generation: 7,
        activeTurnId: 'turn-active',
      },
      runtime: {
        runtimeId: 'runtime-live',
        status: 'busy',
        transport: 'tmux',
        activeTurnId: 'turn-active',
      },
    })
  })
})

describe('monitor acceptance: event-source reader defaults (T-01286 / Q3 frozen)', () => {
  test('non-follow watch defaults to the last 100 matching events through the current high-water mark', async () => {
    const { createMonitorReader } = await loadMonitorModule()
    const state = createFixtureState()
    const sessionRef = state.sessions[0]!.sessionRef
    const scopeRef = state.sessions[0]!.scopeRef

    state.events = Array.from({ length: 150 }, (_, index) => ({
      seq: index + 1,
      ts: '2026-04-27T14:01:00.000Z',
      event: 'runtime.idle',
      sessionRef,
      scopeRef,
      laneRef: 'repair',
      hostSessionId: 'host-session-live',
      generation: 7,
      runtimeId: 'runtime-live',
    }))

    const reader = createMonitorReader(state)
    const events = await collect(reader.watch({ selector: parseSelector(`session:${sessionRef}`) }))

    expect(events).toHaveLength(100)
    expect(events[0]).toMatchObject({ seq: 51, replayed: true })
    expect(events.at(-1)).toMatchObject({ seq: 150, replayed: true })
  })

  test('follow watch defaults to current high-water plus an initial monitor.snapshot event', async () => {
    const { createMonitorReader } = await loadMonitorModule()
    const reader = createMonitorReader(createFixtureState())

    const events = await collect(
      reader.watch({
        selector: parseSelector('runtime:runtime-live'),
        follow: true,
      }),
      1
    )

    expect(events).toEqual([
      expect.objectContaining({
        seq: 102,
        event: 'monitor.snapshot',
        replayed: false,
        snapshot: expect.objectContaining({
          eventHighWaterSeq: 102,
          runtime: expect.objectContaining({ runtimeId: 'runtime-live' }),
        }),
      }),
    ])
  })
})

describe('monitor acceptance: atomic capture start cursor (T-01286)', () => {
  test('does not miss a terminal event that arrives between snapshot read and follow attach', async () => {
    const { createMonitorReader } = await loadMonitorModule()
    const state = createFixtureState()
    const reader = createMonitorReader(state)

    const capture = await reader.captureStart(parseSelector('runtime:runtime-live'), {
      afterSnapshot: () => {
        state.events.push({
          seq: 103,
          ts: '2026-04-27T14:01:02.000Z',
          event: 'turn.finished',
          sessionRef: 'agent:cody:project:agent-spaces:task:T-01286/lane:repair',
          scopeRef: 'agent:cody:project:agent-spaces:task:T-01286',
          laneRef: 'repair',
          hostSessionId: 'host-session-live',
          generation: 7,
          runtimeId: 'runtime-live',
          turnId: 'turn-active',
        })
      },
    })

    expect(capture).toMatchObject({
      sessionRef: 'agent:cody:project:agent-spaces:task:T-01286/lane:repair',
      hostSessionId: 'host-session-live',
      generation: 7,
      runtimeId: 'runtime-live',
      activeTurnId: 'turn-active',
      eventHighWaterSeq: expect.any(Number),
      streamCursorSeq: expect.any(Number),
    })

    const cursor = (capture as { streamCursorSeq: number }).streamCursorSeq
    expect(cursor).toBeLessThanOrEqual(103)

    const events = await collect(
      reader.watch({
        selector: parseSelector('runtime:runtime-live'),
        follow: true,
        fromSeq: cursor,
      }),
      10
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        seq: 103,
        event: 'turn.finished',
        turnId: 'turn-active',
      })
    )
  })
})
