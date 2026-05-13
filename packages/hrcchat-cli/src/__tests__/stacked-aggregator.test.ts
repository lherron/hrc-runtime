import { describe, expect, it } from 'bun:test'
import type { HrcLifecycleEvent, SemanticTurnHandoffResponse } from 'hrc-core'

type StackedLine = {
  type: 'turn_stacked'
  version: 1
  stackSeq: number
  phase: string
  flush: string
  events: number
  summary: string
  exitCode?: number
  result?: string
  permission?: { requestId: string; toolUseId: string; toolName: string }
  hrcSeqRange?: { from: number; to: number }
}

type TimerHandle = number

class FakeClock {
  nowMs = Date.parse('2026-05-13T18:00:00.000Z')
  private nextHandle = 1
  private timers = new Map<TimerHandle, { at: number; callback: () => void }>()

  now = (): number => this.nowMs

  setTimeout = (callback: () => void, ms: number): TimerHandle => {
    const handle = this.nextHandle++
    this.timers.set(handle, { at: this.nowMs + ms, callback })
    return handle
  }

  clearTimeout = (handle: TimerHandle): void => {
    this.timers.delete(handle)
  }

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms
    while (true) {
      let next: { handle: TimerHandle; at: number; callback: () => void } | undefined
      for (const [handle, timer] of this.timers) {
        if (timer.at <= target && (!next || timer.at < next.at)) {
          next = { handle, ...timer }
        }
      }
      if (!next) break
      this.nowMs = next.at
      this.timers.delete(next.handle)
      next.callback()
      await Promise.resolve()
    }
    this.nowMs = target
    await Promise.resolve()
  }
}

async function loadAggregatorModule(): Promise<{
  createStackedAggregator: (options: unknown) => {
    start: () => void
    receive: (event: HrcLifecycleEvent) => Promise<void>
    finish: (result: { exitCode: number; result: string; finalBody?: string }) => Promise<void>
    close: () => Promise<void>
  }
}> {
  return await import('../stacked-aggregator.js')
}

function makeHandoff(
  overrides: Partial<SemanticTurnHandoffResponse> = {}
): SemanticTurnHandoffResponse {
  return {
    messageId: 'msg-request',
    sessionRef: 'agent:larry:project:agent-spaces:task:T-01449/lane:main',
    scopeRef: 'agent:larry:project:agent-spaces:task:T-01449',
    laneRef: 'main',
    hostSessionId: 'hsid-test',
    runtimeId: 'rt-test',
    runId: 'run-test',
    generation: 1,
    fromSeq: 10,
    ...overrides,
  }
}

function event(
  hrcSeq: number,
  eventKind: string,
  payload: Record<string, unknown> = {}
): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: new Date(Date.parse('2026-05-13T18:00:00.000Z') + hrcSeq).toISOString(),
    hostSessionId: 'hsid-test',
    scopeRef: 'agent:larry:project:agent-spaces:task:T-01449',
    laneRef: 'main',
    generation: 1,
    runId: 'run-test',
    category: 'turn',
    transport: 'sdk',
    replayed: false,
    eventKind,
    payload,
  }
}

function makeHarness(options: { windowMs?: number; stallAfterMs?: number } = {}) {
  const clock = new FakeClock()
  const lines: StackedLine[] = []
  const summarized: HrcLifecycleEvent[][] = []
  const summarizer = {
    async summarize(input: { events: HrcLifecycleEvent[]; phase: string }): Promise<string> {
      summarized.push(input.events)
      const lastTool = input.events
        .map((item) => item.payload?.['toolName'])
        .findLast((toolName): toolName is string => typeof toolName === 'string')
      return `${input.events.length} events; last tool: ${lastTool ?? 'none'}; phase: ${input.phase}`
    },
  }

  return {
    clock,
    lines,
    summarized,
    async create() {
      const { createStackedAggregator } = await loadAggregatorModule()
      const aggregator = createStackedAggregator({
        windowMs: options.windowMs ?? 1_000,
        stallAfterMs: options.stallAfterMs ?? 3_000,
        targetScope: 'larry@agent-spaces:T-01449',
        handoff: makeHandoff(),
        summarizer,
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        writeLine(line: StackedLine) {
          lines.push(line)
        },
      })
      aggregator.start()
      return aggregator
    },
  }
}

describe('stacked turn aggregator', () => {
  it('emits N interval flushes for N elapsed windows with monotonic stackSeq', async () => {
    const harness = makeHarness()
    const aggregator = await harness.create()

    await aggregator.receive(event(11, 'run_queued'))
    await aggregator.receive(event(12, 'turn.tool_call', { toolName: 'Read' }))
    await harness.clock.advance(3_000)

    expect(harness.lines).toHaveLength(3)
    expect(harness.lines.map((line) => line.flush)).toEqual(['interval', 'interval', 'interval'])
    expect(harness.lines.map((line) => line.stackSeq)).toEqual([1, 2, 3])
    expect(harness.lines[0]).toMatchObject({
      type: 'turn_stacked',
      version: 1,
      phase: 'progress',
      events: 2,
      hrcSeqRange: { from: 11, to: 12 },
    })
  })

  it('does not force-flush the queued to progress transition', async () => {
    const harness = makeHarness()
    const aggregator = await harness.create()

    await aggregator.receive(event(11, 'run_queued'))
    await aggregator.receive(event(12, 'turn.tool_call', { toolName: 'Bash' }))
    await Promise.resolve()

    expect(harness.lines).toHaveLength(0)
    await harness.clock.advance(1_000)
    expect(harness.lines).toHaveLength(1)
    expect(harness.lines[0]!.flush).toBe('interval')
  })

  it('force-flushes permission/final/error transitions and skips the next interval tick', async () => {
    const harness = makeHarness()
    const aggregator = await harness.create()

    await aggregator.receive(
      event(11, 'permission_request', {
        requestId: 'perm-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /tmp/example' },
      })
    )
    expect(harness.lines.map((line) => line.flush)).toEqual(['permission'])

    await harness.clock.advance(1_000)
    expect(harness.lines).toHaveLength(1)

    await aggregator.receive(
      event(12, 'turn.completed', { body: 'done', replyMessageId: 'msg-reply' })
    )
    expect(harness.lines.map((line) => line.flush)).toEqual(['permission', 'final'])
    expect(harness.lines[1]).toMatchObject({ phase: 'final', result: 'success', exitCode: 0 })
  })

  it('suppresses duplicate permission requestIds but emits a distinct permission request', async () => {
    const harness = makeHarness()
    const aggregator = await harness.create()

    await aggregator.receive(
      event(11, 'permission_request', {
        requestId: 'perm-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
      })
    )
    await aggregator.receive(
      event(12, 'permission_request', {
        requestId: 'perm-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
      })
    )
    await aggregator.receive(
      event(13, 'permission_request', {
        requestId: 'perm-2',
        toolUseId: 'tool-2',
        toolName: 'Edit',
      })
    )

    expect(harness.lines).toHaveLength(2)
    expect(harness.lines.map((line) => line.permission?.requestId)).toEqual(['perm-1', 'perm-2'])
  })

  it('emits deterministic silent heartbeats without calling the summarizer', async () => {
    const harness = makeHarness()
    await harness.create()

    await harness.clock.advance(1_000)

    expect(harness.lines).toHaveLength(1)
    expect(harness.lines[0]).toMatchObject({
      flush: 'interval',
      events: 0,
      summary: 'No activity.',
    })
    expect(harness.summarized).toHaveLength(0)
  })

  it('does not let heartbeats reset upstream stall tracking', async () => {
    const harness = makeHarness({ windowMs: 1_000, stallAfterMs: 3_000 })
    const aggregator = await harness.create()

    await aggregator.receive(event(11, 'turn.tool_call', { toolName: 'Read' }))
    await harness.clock.advance(1_000)
    await harness.clock.advance(1_000)
    await harness.clock.advance(1_000)

    expect(harness.lines.map((line) => line.flush)).toEqual(['interval', 'interval', 'stall'])
    expect(harness.lines[2]).toMatchObject({
      phase: 'error',
      flush: 'stall',
      result: 'stall',
      exitCode: 1,
    })

    await harness.clock.advance(1_000)
    expect(harness.lines.map((line) => line.flush)).toEqual(['interval', 'interval', 'stall'])
  })

  it('single-flights an interval tick and final event race to one final line', async () => {
    const harness = makeHarness()
    const aggregator = await harness.create()

    await aggregator.receive(event(11, 'turn.tool_call', { toolName: 'Bash' }))
    const tick = harness.clock.advance(1_000)
    const final = aggregator.receive(event(12, 'turn.completed', { body: 'done' }))
    await Promise.all([tick, final])

    const finalLines = harness.lines.filter((line) => line.phase === 'final')
    expect(finalLines).toHaveLength(1)
    expect(harness.lines.at(-1)).toMatchObject({ phase: 'final', flush: 'final' })
  })

  it('keeps stackSeq monotonic across interval, force, and terminal lines', async () => {
    const harness = makeHarness()
    const aggregator = await harness.create()

    await aggregator.receive(event(11, 'turn.tool_call', { toolName: 'Read' }))
    await harness.clock.advance(1_000)
    await aggregator.receive(
      event(12, 'permission_request', {
        requestId: 'perm-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
      })
    )
    await aggregator.finish({ exitCode: 5, result: 'permission_blocked' })

    expect(harness.lines.map((line) => line.stackSeq)).toEqual([1, 2, 3])
    expect(harness.lines.map((line) => line.flush)).toEqual(['interval', 'permission', 'final'])
  })

  it('writes the final flush before signaling exit readiness', async () => {
    const clock = new FakeClock()
    const order: string[] = []
    const { createStackedAggregator } = await loadAggregatorModule()
    const aggregator = createStackedAggregator({
      windowMs: 1_000,
      stallAfterMs: 3_000,
      targetScope: 'larry@agent-spaces:T-01449',
      handoff: makeHandoff(),
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      summarizer: { summarize: async () => 'final summary' },
      writeLine() {
        order.push('write')
      },
      onExitReady() {
        order.push('exit')
      },
    })

    aggregator.start()
    await aggregator.finish({ exitCode: 1, result: 'stall' })

    expect(order).toEqual(['write', 'exit'])
  })

  it('ships final result metadata with a fallback summary when the summarizer fails', async () => {
    const clock = new FakeClock()
    const lines: StackedLine[] = []
    const { createStackedAggregator } = await loadAggregatorModule()
    const aggregator = createStackedAggregator({
      windowMs: 1_000,
      stallAfterMs: 3_000,
      targetScope: 'larry@agent-spaces:T-01449',
      handoff: makeHandoff(),
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      summarizer: {
        async summarize() {
          throw new Error('haiku timeout')
        },
      },
      writeLine(line: StackedLine) {
        lines.push(line)
      },
    })

    aggregator.start()
    await aggregator.receive(event(11, 'turn.tool_call', { toolName: 'Bash' }))
    await aggregator.finish({ exitCode: 5, result: 'permission_blocked' })

    expect(lines.at(-1)).toMatchObject({
      phase: 'final',
      flush: 'final',
      result: 'permission_blocked',
      exitCode: 5,
      summary: '1 events; last tool: Bash; phase: final',
    })
  })
})
