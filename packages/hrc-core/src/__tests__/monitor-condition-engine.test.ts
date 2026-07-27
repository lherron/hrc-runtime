import { describe, expect, test } from 'bun:test'

import {
  type HrcMonitorConditionEngineReader,
  createMonitorConditionEngine,
} from '../monitor/condition-engine.js'

const selector = { kind: 'runtime' as const, runtimeId: 'runtime-1' }

function readerFor(events: Array<Record<string, unknown>>): HrcMonitorConditionEngineReader {
  return {
    captureStart: async () => ({
      selector: { kind: 'runtime', canonical: 'runtime:runtime-1' },
      sessionRef: 'agent:cody:project:hrc-runtime:task:T-07013/lane:main',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-07013',
      laneRef: 'main',
      hostSessionId: 'host-1',
      generation: 1,
      runtimeId: 'runtime-1',
      activeTurnId: 'turn-1',
      eventHighWaterSeq: 1,
      streamCursorSeq: 2,
    }),
    snapshot: () => ({
      kind: 'monitor.snapshot',
      eventHighWaterSeq: 1,
      counts: { sessions: 1, runtimes: 1 },
      runtime: {
        runtimeId: 'runtime-1',
        hostSessionId: 'host-1',
        status: 'busy',
        transport: 'headless',
        activeTurnId: 'turn-1',
      },
    }),
    watch: async function* () {
      for (const event of events) yield event
    },
  }
}

describe('monitor condition engine terminal outcome contract', () => {
  test('turn-finished reports an observed failed turn as observed_failure/13', async () => {
    const outcome = await createMonitorConditionEngine(
      readerFor([
        {
          seq: 2,
          event: 'turn.finished',
          runtimeId: 'runtime-1',
          turnId: 'turn-1',
          result: 'turn_failed',
          failureKind: 'tool',
        },
      ])
    ).wait({ selector, condition: 'turn-finished' })

    expect(outcome).toMatchObject({
      result: 'turn_failed',
      outcome: 'observed_failure',
      exitCode: 13,
      failureKind: 'tool',
    })
    expect(outcome.eventStream?.filter((event) => event['event'] === 'monitor.completed')).toEqual([
      expect.objectContaining({
        result: 'turn_failed',
        outcome: 'observed_failure',
        exitCode: 13,
      }),
    ])
  })
})
