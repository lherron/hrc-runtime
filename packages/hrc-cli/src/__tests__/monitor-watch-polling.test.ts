import { describe, expect, test } from 'bun:test'

import { cmdMonitorWatch } from '../monitor-watch'
import {
  MESSAGE_ID,
  type MonitorFixtureState,
  type MonitorWatchArgs,
  SELECTOR,
  TURN_ID,
  createFixtureState,
  event,
  expectValidMonitorEvent,
  invokeWatch,
  parseJsonLines,
} from './fixtures/cli-test-fixture.js'

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
        forever: true,
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
    expect(events.filter((entry) => entry['event'] === 'monitor.completed')).toEqual([
      expect.objectContaining({
        result: 'interrupted',
        outcome: 'error',
        exitCode: 130,
        phase: 'after-arm',
      }),
    ])
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
        forever: true,
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

  test('follow read failure exits 23 with exactly one error terminal event', async () => {
    const stdoutChunks: string[] = []
    let reads = 0
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
      { json: true, selector: SELECTOR, follow: true, forever: true },
      {
        buildMonitorState: async () => {
          reads += 1
          if (reads === 1) return createFixtureState()
          throw new Error('fixture monitor read failed')
        },
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: { write: () => true },
      }
    )

    expect(exitCode).toBe(23)
    const terminals = parseJsonLines(stdoutChunks.join('')).filter(
      (entry) => entry['event'] === 'monitor.completed'
    )
    expect(terminals).toEqual([
      expect.objectContaining({
        result: 'monitor_error',
        outcome: 'error',
        exitCode: 23,
        phase: 'after-arm',
      }),
    ])
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
        forever: true,
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
   * the idle event appears only on a subsequent poll cycle.
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
    expect(stderrChunks.join('')).toContain('monitor.armed')

    const events = parseJsonLines(stdoutChunks.join(''))

    // Should have polled buildMonitorState more than once
    expect(callCount).toBeGreaterThan(1)

    // Condition-mode output finishes with the shared structured result.
    expect(events.at(-1)).toMatchObject({
      event: 'monitor.completed',
      result: 'matched',
      conditions: ['idle'],
      matchedCondition: 'idle',
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

  test('--follow --until idle against an already-idle ready runtime exits already_true quickly', async () => {
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

    expect(cli.exitCode).toBe(10)
    expect(cli.events.at(-1)).toMatchObject({
      event: 'monitor.completed',
      selector: SELECTOR,
      conditions: ['idle'],
      matchedCondition: 'idle',
      result: 'already_true',
      exitCode: 10,
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

    expect(exitCode).toBe(20)

    const events = parseJsonLines(stdoutChunks.join(''))
    expect(events.at(-1)).toMatchObject({
      event: 'monitor.completed',
      result: 'timeout',
      exitCode: 20,
      conditions: ['idle'],
    })
  })
})
