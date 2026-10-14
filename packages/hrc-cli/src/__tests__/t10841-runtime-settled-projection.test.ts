import { describe, expect, it } from 'bun:test'

import type { HrcMonitorState } from 'hrc-core'

import { applyLifecycleProjection } from '../monitor/wait-projection'

// T-10841 / architecture/contracts/runtime-settled.yaml: runtime.settled
// applies to a projection only when its activeTurnId equals clearedRunId.
// A non-matching or null owner is a complete no-op, status included.

const HOST = 'hsid-t10841'
const RUNTIME = 'rt-t10841'
const CLEARED = 'run-t10841-a'

type ProjectionEvents = Parameters<typeof applyLifecycleProjection>[1]

function state(activeTurnId: string | null): Pick<HrcMonitorState, 'sessions' | 'runtimes'> {
  return {
    sessions: [
      {
        sessionRef: 'agent:t10841/lane:main',
        scopeRef: 'agent:t10841',
        laneRef: 'main',
        hostSessionId: HOST,
        generation: 1,
        runtimeId: RUNTIME,
        status: 'active',
        activeTurnId,
      },
    ],
    runtimes: [
      {
        runtimeId: RUNTIME,
        hostSessionId: HOST,
        status: 'busy',
        transport: 'tmux',
        activeTurnId,
      },
    ],
  }
}

function settled(): ProjectionEvents {
  return [
    {
      hrcSeq: 10,
      streamSeq: 10,
      scopeRef: 'agent:t10841',
      laneRef: 'main',
      generation: 1,
      replayed: false,
      ts: '2026-10-13T20:00:00.000Z',
      hostSessionId: HOST,
      runtimeId: RUNTIME,
      eventKind: 'runtime.settled',
      category: 'runtime',
      payload: {
        runtimeId: RUNTIME,
        clearedRunId: CLEARED,
        previousStatus: 'busy',
        status: 'ready',
        cause: 'idle-seat',
      },
    },
  ]
}

describe('T-10841 runtime.settled monitor projection', () => {
  it('clears the matching owner and idles the runtime', () => {
    const projected = state(CLEARED)
    applyLifecycleProjection(projected, settled())

    expect(projected.runtimes[0]).toMatchObject({ status: 'idle', activeTurnId: null })
    expect(projected.sessions[0]?.activeTurnId).toBeNull()
  })

  it('leaves a newer owner and its busy status alone', () => {
    const projected = state('run-t10841-b')
    applyLifecycleProjection(projected, settled())

    expect(projected.runtimes[0]).toMatchObject({ status: 'busy', activeTurnId: 'run-t10841-b' })
    expect(projected.sessions[0]?.activeTurnId).toBe('run-t10841-b')
  })

  it('is a no-op on a null owner, status included', () => {
    const projected = state(null)
    applyLifecycleProjection(projected, settled())

    expect(projected.runtimes[0]).toMatchObject({ status: 'busy', activeTurnId: null })
  })
})
