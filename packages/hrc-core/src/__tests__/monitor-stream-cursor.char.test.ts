import { describe, expect, test } from 'bun:test'

import { parseSelector } from '../selectors.js'

// Characterization test for T-04718 (F5): pins the *exact* observable read-only
// semantics of the `streamCursorSeq` field on the object returned by
// `captureStart` (currently enforced by `protectStreamCursor`'s Proxy).
//
// These assertions exist to gate any future swap of the protection mechanism
// (e.g. Proxy -> Object.defineProperty). They run in an ES module, i.e. strict
// mode — the same mode the production code executes under — so strict-mode
// assignment/redefine behavior is captured faithfully.

type MonitorModule = {
  createMonitorReader: (state: unknown) => {
    captureStart: (selector: ReturnType<typeof parseSelector>) => Promise<unknown>
  }
}

async function loadMonitorModule(): Promise<MonitorModule> {
  return (await import('../monitor/index.js')) as MonitorModule
}

function createFixtureState(): unknown {
  const sessionRef = 'agent:cody:project:agent-spaces:task:T-01286/lane:repair'
  const scopeRef = 'agent:cody:project:agent-spaces:task:T-01286'
  const hostSessionId = 'host-session-live'
  const runtimeId = 'runtime-live'

  return {
    daemon: { pid: 4242, status: 'healthy', startedAt: '2026-04-27T14:00:00.000Z' },
    socket: { path: '/tmp/hrc.sock', responsive: true },
    tmux: { socketPath: '/tmp/hrc-tmux.sock', sessionCount: 1, windowCount: 1, paneCount: 1 },
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
    messages: [],
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
    ],
  }
}

async function makeCapture(): Promise<Record<string, unknown> & { streamCursorSeq: number }> {
  const { createMonitorReader } = await loadMonitorModule()
  const reader = createMonitorReader(createFixtureState())
  const capture = (await reader.captureStart(parseSelector('runtime:runtime-live'))) as Record<
    string,
    unknown
  > & { streamCursorSeq: number }
  return capture
}

describe('monitor char: protectStreamCursor read-only contract (T-04718 / F5)', () => {
  test('streamCursorSeq reads back a positive numeric cursor', async () => {
    const capture = await makeCapture()
    expect(typeof capture.streamCursorSeq).toBe('number')
    expect(capture.streamCursorSeq).toBeGreaterThanOrEqual(1)
  })

  test('streamCursorSeq is an enumerable own property (survives Object.keys, spread, JSON)', async () => {
    const capture = await makeCapture()
    const value = capture.streamCursorSeq

    expect(Object.keys(capture)).toContain('streamCursorSeq')

    const spread = { ...capture }
    expect(spread.streamCursorSeq).toBe(value)

    const roundTrip = JSON.parse(JSON.stringify(capture)) as { streamCursorSeq: number }
    expect(roundTrip.streamCursorSeq).toBe(value)
  })

  test('assigning streamCursorSeq is silently rejected — no throw, value unchanged', async () => {
    const capture = await makeCapture()
    const value = capture.streamCursorSeq

    // Current mechanism (Proxy `set` trap returning true) swallows the write
    // WITHOUT throwing, even under strict mode. This is the load-bearing
    // observable difference from a `writable:false` data property, which would
    // throw a TypeError here.
    expect(() => {
      capture.streamCursorSeq = value + 999
    }).not.toThrow()
    expect(capture.streamCursorSeq).toBe(value)
  })

  test('redefining streamCursorSeq via Object.defineProperty is silently rejected — no throw, value unchanged', async () => {
    const capture = await makeCapture()
    const value = capture.streamCursorSeq

    expect(() => {
      Object.defineProperty(capture, 'streamCursorSeq', { value: value + 999 })
    }).not.toThrow()
    expect(capture.streamCursorSeq).toBe(value)
  })

  test('other capture fields remain mutable', async () => {
    const capture = await makeCapture()
    expect(() => {
      capture.generation = 999
    }).not.toThrow()
    expect(capture.generation).toBe(999)
  })
})
