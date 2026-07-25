import { describe, expect, test } from 'bun:test'

import {
  type HrcMonitorEvent,
  type HrcMonitorState,
  createMonitorReader,
} from '../monitor/index.js'
import { parseSelector } from '../selectors.js'

const BASE = 'agent:smokey:project:agent-spaces:task:T-05110'
const RED = `${BASE}:role:red`
const VERIFY = `${BASE}:role:verify`

function session(
  scopeRef: string,
  runtimeId: string,
  options: { lane?: string; generation?: number; status?: string } = {}
): HrcMonitorState['sessions'][number] {
  const laneRef = options.lane ?? 'main'
  return {
    sessionRef: `${scopeRef}/lane:${laneRef}`,
    scopeRef,
    laneRef,
    hostSessionId: `host-${runtimeId}`,
    generation: options.generation ?? 1,
    runtimeId,
    status: options.status ?? 'active',
    activeTurnId: runtimeId === 'runtime-verify' ? 'turn-verify' : null,
  }
}

function runtime(runtimeId: string, status = 'idle'): HrcMonitorState['runtimes'][number] {
  return {
    runtimeId,
    hostSessionId: `host-${runtimeId}`,
    status,
    transport: 'headless',
    activeTurnId: runtimeId === 'runtime-verify' ? 'turn-verify' : null,
  }
}

function event(
  seq: number,
  scopeRef: string,
  runtimeId: string,
  laneRef = 'main'
): HrcMonitorEvent {
  return {
    seq,
    event: 'assistant.message.completed',
    scopeRef,
    sessionRef: `${scopeRef}/lane:${laneRef}`,
    laneRef,
    hostSessionId: `host-${runtimeId}`,
    runtimeId,
  }
}

function state(): HrcMonitorState {
  return {
    sessions: [
      session(RED, 'runtime-red', { generation: 4 }),
      session(VERIFY, 'runtime-verify', { generation: 7 }),
    ],
    runtimes: [runtime('runtime-red'), runtime('runtime-verify', 'busy')],
    events: [
      event(101, RED, 'runtime-red'),
      // Durable rows written by older releases used "default"; it is the same
      // canonical lane as a slash-role target's implicit "main".
      event(102, VERIFY, 'runtime-verify', 'default'),
      event(103, `${BASE}:role:other`, 'runtime-other'),
    ],
    eventGlobalHighWaterSeq: 900,
  }
}

async function collect(iterable: AsyncIterable<unknown>): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  for await (const row of iterable) rows.push(row as Record<string, unknown>)
  return rows
}

describe('monitor role-tree selectors (T-05113)', () => {
  test('exact slash-role target resolves and replays only that role, including legacy default lane rows', async () => {
    const reader = createMonitorReader(state())
    const selector = parseSelector('smokey@agent-spaces:T-05110/verify')

    expect(reader.resolve(selector)).toMatchObject({
      scopeRef: VERIFY,
      sessionRef: `${VERIFY}/lane:main`,
      runtimeId: 'runtime-verify',
      eventHighWaterSeq: 900,
    })
    expect(await collect(reader.watch({ selector, fromSeq: 1 }))).toEqual([
      expect.objectContaining({
        seq: 102,
        scopeRef: VERIFY,
        runtimeId: 'runtime-verify',
        replayed: true,
      }),
    ])
  })

  test('role-less target snapshot exposes deterministic immediate role children and legacy fields', () => {
    const snapshot = createMonitorReader(state()).snapshot(
      parseSelector('smokey@agent-spaces:T-05110')
    )

    expect(snapshot.runtime?.runtimeId).toBe('runtime-verify')
    expect(snapshot.resolution).toMatchObject({
      scopeRef: VERIFY,
      runtimeId: 'runtime-verify',
      eventHighWaterSeq: 900,
    })
    expect(snapshot.matches).toEqual([
      expect.objectContaining({
        matchKind: 'role-child',
        roleName: 'verify',
        scopeHandle: 'smokey@agent-spaces:T-05110/verify',
        sessionHandle: 'smokey@agent-spaces:T-05110/verify',
        runtimeId: 'runtime-verify',
        status: 'busy',
        generation: 7,
      }),
      expect.objectContaining({
        matchKind: 'role-child',
        roleName: 'red',
        runtimeId: 'runtime-red',
        generation: 4,
      }),
    ])
  })

  test('role-less target watch aggregates immediate role children on the same lane and keeps global high-water', async () => {
    const fixture = state()
    fixture.sessions.push(session(VERIFY, 'runtime-verify-repair', { lane: 'repair' }))
    fixture.runtimes.push(runtime('runtime-verify-repair'))
    fixture.events.push(event(104, VERIFY, 'runtime-verify-repair', 'repair'))
    const reader = createMonitorReader(fixture)
    const selector = parseSelector('smokey@agent-spaces:T-05110')

    expect((await collect(reader.watch({ selector, fromSeq: 1 }))).map((row) => row.seq)).toEqual([
      101, 102, 103,
    ])
    expect(
      (
        await collect(
          reader.watch({
            selector: parseSelector(`scope:${BASE}`),
            fromSeq: 1,
          })
        )
      ).map((row) => row.seq)
    ).toEqual([101, 102, 103, 104])
    const followed = await collect(reader.watch({ selector, follow: true }))
    expect(followed[0]).toMatchObject({
      seq: 900,
      event: 'monitor.snapshot',
      snapshot: { eventHighWaterSeq: 900 },
    })
  })

  test('condition capture accepts one concrete match and rejects ambiguous role-less selectors with alternatives', async () => {
    const one = state()
    one.sessions = one.sessions.filter((candidate) => candidate.scopeRef === VERIFY)
    one.runtimes = one.runtimes.filter((candidate) => candidate.runtimeId === 'runtime-verify')
    one.sessions.push(
      session(VERIFY, 'runtime-verify-old', {
        generation: 1,
        status: 'removed',
      })
    )
    one.runtimes.push(runtime('runtime-verify-old', 'terminated'))

    await expect(
      createMonitorReader(one).captureStart(parseSelector('smokey@agent-spaces:T-05110'))
    ).resolves.toMatchObject({
      runtimeId: 'runtime-verify',
      scopeRef: VERIFY,
      streamCursorSeq: 900,
    })

    const ambiguous = await createMonitorReader(state()).captureStart(
      parseSelector('smokey@agent-spaces:T-05110')
    )
    expect(ambiguous).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_selector',
        detail: {
          alternatives: [
            expect.objectContaining({
              roleHandle: 'smokey@agent-spaces:T-05110/verify',
              runtimeSelector: 'runtime:runtime-verify',
            }),
            expect.objectContaining({
              roleHandle: 'smokey@agent-spaces:T-05110/red',
              runtimeSelector: 'runtime:runtime-red',
            }),
          ],
        },
      },
    })
  })
})
