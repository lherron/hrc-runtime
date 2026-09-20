import { describe, expect, it } from 'bun:test'

import { createBirthTimeline } from '../birth-timeline'

describe('fresh birth timeline (T-08654)', () => {
  it('emits correlated monotonic phase durations without changing the caller flow', () => {
    const entries: Record<string, unknown>[] = []
    const times = [100, 125.4, 170.9]
    const timeline = createBirthTimeline({
      scopeRef: 'agent:muse:project:hrc-runtime:task:T-08654',
      laneRef: 'main',
      birthId: 'msg-timeline',
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
        birthId: 'msg-timeline',
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

  it('keeps one durable request join key while later phases mint their own identities', () => {
    const entries: Record<string, unknown>[] = []
    const times = [0, 4, 9, 17, 26]
    const timeline = createBirthTimeline({
      scopeRef: 'agent:muse:project:hrc-runtime:task:T-08654',
      laneRef: 'main',
      birthId: 'msg-fresh-seat',
      presentation: 'pending',
      now: () => times.shift() ?? 26,
      logger: (fields) => entries.push(fields),
    })

    timeline.mark('request-received')
    timeline.mark('home-resolution-begin')
    timeline.enrich({ hostSessionId: 'hsid-fresh', generation: 1 })
    timeline.mark('session-created')
    timeline.enrich({
      runId: 'run-fresh',
      runtimeId: 'rt-fresh',
      invocationId: 'inv-fresh',
      initialInputId: 'input-fresh',
      presentation: 'observer',
    })
    timeline.mark('launch-carried-input-compiled')
    timeline.mark('viewer-presentation-published')

    expect(entries.map((entry) => entry.phase)).toEqual([
      'request-received',
      'home-resolution-begin',
      'session-created',
      'launch-carried-input-compiled',
      'viewer-presentation-published',
    ])
    expect(entries.every((entry) => entry.birthId === 'msg-fresh-seat')).toBe(true)
    expect(entries[2]).toEqual(
      expect.objectContaining({ hostSessionId: 'hsid-fresh', generation: 1, elapsedMs: 17 })
    )
    expect(entries[4]).toEqual(
      expect.objectContaining({
        hostSessionId: 'hsid-fresh',
        runId: 'run-fresh',
        runtimeId: 'rt-fresh',
        invocationId: 'inv-fresh',
        initialInputId: 'input-fresh',
        presentation: 'observer',
        elapsedMs: 26,
      })
    )
  })
})
