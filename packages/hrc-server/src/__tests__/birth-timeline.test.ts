import { describe, expect, it } from 'bun:test'

import { createBirthTimeline } from '../birth-timeline'

describe('fresh birth timeline (T-08654)', () => {
  it('emits correlated monotonic phase durations without changing the caller flow', () => {
    const entries: Record<string, unknown>[] = []
    const times = [100, 125.4, 170.9]
    const timeline = createBirthTimeline({
      scopeRef: 'agent:muse:project:hrc-runtime:task:T-08654',
      laneRef: 'main',
      hostSessionId: 'hsid-timeline',
      generation: 3,
      runId: 'run-timeline',
      presentation: 'observer',
      now: () => times.shift() ?? 170.9,
      logger: (fields) => entries.push(fields),
    })

    timeline.mark('request-received')
    timeline.enrich({ runtimeId: 'rt-timeline', operationId: 'op-timeline' })
    timeline.mark('aspd-compile-admitted', {
      invocationId: 'inv-timeline',
      compileId: 'compile-timeline',
    })

    expect(entries).toEqual([
      expect.objectContaining({
        phase: 'request-received',
        durMs: 25.4,
        elapsedMs: 25.4,
        scopeRef: 'agent:muse:project:hrc-runtime:task:T-08654',
        hostSessionId: 'hsid-timeline',
        runId: 'run-timeline',
        presentation: 'observer',
      }),
      expect.objectContaining({
        phase: 'aspd-compile-admitted',
        durMs: 45.5,
        elapsedMs: 70.9,
        runtimeId: 'rt-timeline',
        operationId: 'op-timeline',
        invocationId: 'inv-timeline',
        compileId: 'compile-timeline',
      }),
    ])
  })
})
