import { describe, expect, it } from 'bun:test'
import type { HrcLifecycleEvent } from 'hrc-core'
import { deriveLastFailure, deriveRuntimeLiveness, deriveTurnStatus } from '../status-derive'

const now = new Date('2026-04-26T17:00:00.000Z')

function event(overrides: Partial<HrcLifecycleEvent>): HrcLifecycleEvent {
  return {
    hrcSeq: 1,
    streamSeq: 1,
    ts: '2026-04-26T16:59:00.000Z',
    hostSessionId: 'hsid-test',
    scopeRef: 'agent:test:project:status',
    laneRef: 'lane:main',
    generation: 1,
    category: 'turn',
    eventKind: 'turn.started',
    replayed: false,
    payload: {},
    ...overrides,
  }
}

describe('deriveTurnStatus', () => {
  it('returns in_progress when activeRunId latest event is active', () => {
    const events = [
      event({
        hrcSeq: 1,
        ts: '2026-04-26T16:58:00.000Z',
        runId: 'run-active',
        launchId: 'launch-active',
        eventKind: 'turn.accepted',
      }),
      event({
        hrcSeq: 2,
        ts: '2026-04-26T16:58:05.000Z',
        runId: 'run-active',
        launchId: 'launch-active',
        eventKind: 'turn.user_prompt',
        payload: { message: { role: 'user', content: 'status please' } },
      }),
      event({
        hrcSeq: 3,
        ts: '2026-04-26T16:59:30.000Z',
        runId: 'run-active',
        launchId: 'launch-active',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Bash' },
      }),
    ]

    expect(deriveTurnStatus({ activeRunId: 'run-active' }, events, now)).toEqual({
      state: 'in_progress',
      runId: 'run-active',
      launchId: 'launch-active',
      ageSec: 120,
      toolCallCount: 1,
      lastTool: { name: 'Bash', ageSec: 30 },
      userPrompt: 'status please',
    })
  })

  it('returns idle when there is no activeRunId', () => {
    const events = [
      event({
        hrcSeq: 1,
        ts: '2026-04-26T16:59:15.000Z',
        eventKind: 'turn.completed',
      }),
    ]

    expect(deriveTurnStatus({ activeRunId: null }, events, now)).toEqual({
      state: 'idle',
      lastCompletedAgeSec: 45,
    })
  })

  it('returns idle when the active run latest event completed', () => {
    const events = [
      event({
        hrcSeq: 1,
        runId: 'run-done',
        eventKind: 'turn.started',
      }),
      event({
        hrcSeq: 2,
        ts: '2026-04-26T16:59:40.000Z',
        runId: 'run-done',
        eventKind: 'turn.completed',
      }),
    ]

    expect(deriveTurnStatus({ activeRunId: 'run-done' }, events, now)).toEqual({
      state: 'idle',
      lastCompletedAgeSec: 20,
    })
  })
})

describe('deriveRuntimeLiveness', () => {
  it('returns stale when a required pid is gone', () => {
    expect(
      deriveRuntimeLiveness({
        status: 'busy',
        wrapperPid: 999999,
        childPid: null,
      })
    ).toBe('stale')
  })

  it('returns live when required pids respond', () => {
    expect(
      deriveRuntimeLiveness({
        status: 'busy',
        wrapperPid: process.pid,
        childPid: null,
      })
    ).toBe('live')
  })

  it('returns exited for terminal rows regardless of pid state', () => {
    expect(
      deriveRuntimeLiveness({
        status: 'terminated',
        wrapperPid: process.pid,
        childPid: null,
      })
    ).toBe('exited')
  })
})

describe('deriveLastFailure', () => {
  const cases: Array<[string, HrcLifecycleEvent, string]> = [
    [
      'turn.completed',
      event({
        eventKind: 'turn.completed',
        errorCode: 'RUNTIME_UNAVAILABLE',
        payload: { success: false },
      }),
      'errorCode=RUNTIME_UNAVAILABLE',
    ],
    [
      'launch.exited',
      event({
        category: 'launch',
        eventKind: 'launch.exited',
        payload: { exitCode: 1, signal: null },
      }),
      'exitCode=1',
    ],
    [
      'launch.callback_rejected',
      event({
        category: 'launch',
        eventKind: 'launch.callback_rejected',
        payload: { reason: 'stale_generation' },
      }),
      'stale_generation',
    ],
    [
      'inflight.rejected',
      event({
        category: 'inflight',
        eventKind: 'inflight.rejected',
        payload: { reason: 'runtime_busy' },
      }),
      'runtime_busy',
    ],
    [
      'runtime.dead',
      event({
        category: 'runtime',
        eventKind: 'runtime.dead',
        payload: { errorMessage: 'child exited' },
      }),
      'child exited',
    ],
    [
      'turn.tool_result',
      event({
        eventKind: 'turn.tool_result',
        payload: { isError: true },
      }),
      'isError=true',
    ],
  ]

  for (const [kind, failureEvent, expectedReason] of cases) {
    it(`matches ${kind} failures`, () => {
      const failure = deriveLastFailure([
        event({ hrcSeq: 1, eventKind: 'turn.started' }),
        { ...failureEvent, hrcSeq: 2 },
      ])

      expect(failure?.event.hrcSeq).toBe(2)
      expect(failure?.reason).toContain(expectedReason)
    })
  }

  it('returns the nearest matching failure when walking backward', () => {
    const failure = deriveLastFailure([
      event({ hrcSeq: 1, eventKind: 'launch.exited', payload: { exitCode: 1 } }),
      event({ hrcSeq: 2, eventKind: 'turn.message' }),
      event({ hrcSeq: 3, eventKind: 'turn.tool_result', payload: { isError: true } }),
    ])

    expect(failure?.event.hrcSeq).toBe(3)
    expect(failure?.reason).toBe('isError=true')
  })

  it('returns undefined when no failure is present', () => {
    expect(
      deriveLastFailure([
        event({ eventKind: 'turn.completed', payload: { success: true } }),
        event({ eventKind: 'launch.exited', payload: { exitCode: 0 } }),
      ])
    ).toBeUndefined()
  })
})
