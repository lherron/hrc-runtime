import { describe, expect, it } from 'bun:test'

import { createMonitorReader, parseSelector } from '../index'
import type { HrcMonitorState } from '../index'

describe('monitor snapshot durable count overrides', () => {
  it('keeps global totals when selector state contains only one session and runtime', () => {
    const scopeRef = 'agent:test:project:hrc-runtime:task:status-summary'
    const sessionRef = `${scopeRef}/lane:main`
    const state: HrcMonitorState & {
      sessionGlobalCount: number
      runtimeGlobalCount: number
    } = {
      sessions: [
        {
          sessionRef,
          scopeRef,
          laneRef: 'main',
          hostSessionId: 'hsid-selected',
          generation: 1,
          runtimeId: 'rt-selected',
          status: 'active',
        },
      ],
      runtimes: [
        {
          runtimeId: 'rt-selected',
          hostSessionId: 'hsid-selected',
          status: 'ready',
          transport: 'headless',
        },
      ],
      events: [],
      eventGlobalHighWaterSeq: 1_000_000,
      sessionGlobalCount: 6_738,
      runtimeGlobalCount: 8_666,
    }

    const snapshot = createMonitorReader(state).snapshot(parseSelector('runtime:rt-selected'))
    expect(snapshot.counts).toEqual({ sessions: 6_738, runtimes: 8_666 })
  })
})
