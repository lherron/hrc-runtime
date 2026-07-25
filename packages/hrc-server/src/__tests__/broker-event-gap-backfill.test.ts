import { afterEach, describe, expect, it } from 'bun:test'
import { HrcErrorCode } from 'hrc-core'
import type {
  InputId,
  InvocationEventEnvelope,
  InvocationEventType,
  InvocationEventsSinceRequest,
  InvocationEventsSinceResponse,
  InvocationId,
  TurnId,
} from 'spaces-harness-broker-protocol'

import { HarnessBrokerController } from '../broker/controller'
import { BrokerEventMapper } from '../broker/event-mapper'
import {
  INVOCATION_ID,
  Q_INPUT_A_ID,
  Q_INPUT_C_ID,
  Q_INVOCATION_ID,
  Q_RUNTIME_ID,
  Q_RUN_A_ID,
  Q_RUN_C_ID,
  RUNTIME_ID,
  type SeededFixture,
  envelope,
  makeQueuedFixture,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

type LogRecord = { message: string; fields?: Record<string, unknown> }

class GapReplayClient {
  readonly calls: InvocationEventsSinceRequest[] = []
  response: InvocationEventsSinceResponse = {
    events: [],
    currentSeq: 0,
    retentionFloorSeq: 0,
  }

  async eventsSince(request: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse> {
    this.calls.push(request)
    return this.response
  }
}

function diagnostic(
  seq: number,
  overrides: Partial<Pick<InvocationEventEnvelope, 'invocationId'>> = {}
): InvocationEventEnvelope {
  return envelope('diagnostic', seq, { level: 'info', message: `event ${seq}` }, overrides)
}

function queuedEvent(
  type: InvocationEventType,
  seq: number,
  payload: unknown,
  extra: {
    inputId?: InputId | undefined
    turnId?: TurnId | undefined
  } = {}
): InvocationEventEnvelope {
  return {
    invocationId: Q_INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
    ...extra,
  }
}

async function* eventStream(
  events: InvocationEventEnvelope[]
): AsyncGenerator<InvocationEventEnvelope> {
  yield* events
}

function bindGapClient(
  controller: HarnessBrokerController,
  runtimeId: string,
  invocationId: InvocationId,
  client: GapReplayClient
): void {
  ;(
    controller as unknown as {
      active: Map<
        string,
        {
          runtimeId: string
          invocationId: string
          client: GapReplayClient
          closing: boolean
        }
      >
    }
  ).active.set(runtimeId, {
    runtimeId,
    invocationId,
    client,
    closing: false,
  })
}

function consume(
  controller: HarnessBrokerController,
  runtimeId: string,
  events: InvocationEventEnvelope[]
): void {
  ;(
    controller as unknown as {
      consumeEvents: (runtimeId: string, events: AsyncIterable<InvocationEventEnvelope>) => void
    }
  ).consumeEvents(runtimeId, eventStream(events))
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40))
}

const fixtures: SeededFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.cleanup()
  }
})

function makeController(
  fixture: SeededFixture,
  logs: { warn: LogRecord[]; error: LogRecord[] }
): HarnessBrokerController {
  const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
  return new HarnessBrokerController({
    db: fixture.db,
    mapper,
    now: () => ts(100),
    eventGapBackfillDelayMs: 5,
    logger: {
      warn(message, fields) {
        logs.warn.push({ message, fields })
      },
      error(message, fields) {
        logs.error.push({ message, fields })
      },
    },
  })
}

describe('broker event gap detection and durable-ledger backfill', () => {
  it('warns on seq 1,2,4 and repairs seq 3 without regressing the high-water', async () => {
    const fixture = await makeSeededFixture()
    fixtures.push(fixture)
    const logs = { warn: [] as LogRecord[], error: [] as LogRecord[] }
    const controller = makeController(fixture, logs)
    const client = new GapReplayClient()
    client.response = {
      events: [diagnostic(3)],
      currentSeq: 4,
      retentionFloorSeq: 0,
    }
    bindGapClient(controller, RUNTIME_ID, INVOCATION_ID, client)

    consume(controller, RUNTIME_ID, [diagnostic(1), diagnostic(2), diagnostic(4)])
    await settle()

    expect(client.calls).toEqual([{ invocationId: INVOCATION_ID, afterSeq: 2 }])
    expect(fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 3)).not.toBeNull()
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastEventSeq).toBe(4)
    expect(logs.warn).toContainEqual({
      message: 'broker.event_gap_detected',
      fields: {
        runtimeId: RUNTIME_ID,
        invocationId: INVOCATION_ID,
        missingSeqs: [3],
        arrivedSeq: 4,
      },
    })
    expect(logs.warn).toContainEqual({
      message: 'broker.event_gap_backfilled',
      fields: {
        runtimeId: RUNTIME_ID,
        invocationId: INVOCATION_ID,
        repairedSeqs: [3],
      },
    })
  })

  it('does not fetch when the missing event arrives live inside the debounce', async () => {
    const fixture = await makeSeededFixture()
    fixtures.push(fixture)
    const logs = { warn: [] as LogRecord[], error: [] as LogRecord[] }
    const controller = makeController(fixture, logs)
    const client = new GapReplayClient()
    bindGapClient(controller, RUNTIME_ID, INVOCATION_ID, client)

    consume(controller, RUNTIME_ID, [diagnostic(1), diagnostic(2), diagnostic(4), diagnostic(3)])
    await settle()

    expect(client.calls).toEqual([])
    expect(fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 3)).not.toBeNull()
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastEventSeq).toBe(4)
    expect(logs.warn.some((entry) => entry.message === 'broker.event_gap_unrecoverable')).toBe(
      false
    )
  })

  it('backfills the lost owning terminal after unwedge without resurrecting its failed run', async () => {
    const fixture = await makeQueuedFixture()
    fixtures.push(fixture)
    const logs = { warn: [] as LogRecord[], error: [] as LogRecord[] }
    const controller = makeController(fixture, logs)
    const client = new GapReplayClient()
    const turnA = 'turn_gap_A' as TurnId
    const turnC = 'turn_gap_C' as TurnId
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })

    mapper.apply(
      queuedEvent('input.accepted', 47, { inputId: Q_INPUT_A_ID }, { inputId: Q_INPUT_A_ID })
    )
    mapper.apply(queuedEvent('turn.started', 48, { turnId: turnA }, { turnId: turnA }))
    fixture.db.brokerInvocations.update(Q_INVOCATION_ID, {
      lastEventSeq: 48,
      updatedAt: ts(48),
    })
    client.response = {
      events: [
        queuedEvent(
          'turn.completed',
          49,
          { turnId: turnA, status: 'completed', producedContent: true },
          { turnId: turnA }
        ),
      ],
      currentSeq: 52,
      retentionFloorSeq: 0,
    }
    bindGapClient(controller, Q_RUNTIME_ID, Q_INVOCATION_ID, client)

    consume(controller, Q_RUNTIME_ID, [
      queuedEvent('input.accepted', 50, { inputId: Q_INPUT_C_ID }, { inputId: Q_INPUT_C_ID }),
      queuedEvent('turn.started', 51, { turnId: turnC }, { turnId: turnC }),
      queuedEvent(
        'turn.completed',
        52,
        { turnId: turnC, status: 'completed', producedContent: true },
        { turnId: turnC }
      ),
    ])
    await settle()

    expect(fixture.db.runs.getByRunId(Q_RUN_A_ID)).toMatchObject({
      status: 'failed',
      errorCode: HrcErrorCode.RUN_MISMATCH,
    })
    expect(fixture.db.runs.getByRunId(Q_RUN_C_ID)?.status).toBe('completed')
    expect(
      fixture.db.brokerInvocationEvents.getByInvocationAndSeq(Q_INVOCATION_ID, 49)
    ).not.toBeNull()
    expect(fixture.db.brokerInvocations.getByInvocationId(Q_INVOCATION_ID)?.lastEventSeq).toBe(52)
    expect(logs.warn.some((entry) => entry.message === 'broker.event_gap_backfilled')).toBe(true)
    expect(logs.error).toEqual([])
  })

  it('reports an unrecoverable gap when the retention floor is past the missing seq', async () => {
    const fixture = await makeSeededFixture()
    fixtures.push(fixture)
    const logs = { warn: [] as LogRecord[], error: [] as LogRecord[] }
    const controller = makeController(fixture, logs)
    const client = new GapReplayClient()
    client.response = {
      events: [],
      currentSeq: 4,
      retentionFloorSeq: 3,
    }
    bindGapClient(controller, RUNTIME_ID, INVOCATION_ID, client)

    consume(controller, RUNTIME_ID, [diagnostic(1), diagnostic(2), diagnostic(4)])
    await settle()

    expect(fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 3)).toBeNull()
    expect(logs.warn).toContainEqual({
      message: 'broker.event_gap_unrecoverable',
      fields: {
        runtimeId: RUNTIME_ID,
        invocationId: INVOCATION_ID,
        missingSeqs: [3],
        reason: 'retention_floor',
        retentionFloorSeq: 3,
      },
    })
  })
  /**
   * T-06974 (from T-06090): a terminal envelope used to CANCEL the debounced
   * backfill and declare the gap unrecoverable, even though the ledger replay
   * that could close it was available right then. Each terminal type now runs
   * that replay as a final attempt.
   */
  for (const terminal of [
    {
      type: 'invocation.exited' as InvocationEventType,
      payload: { exitCode: 0, signal: null, reason: 'process-exit' },
    },
    {
      type: 'invocation.failed' as InvocationEventType,
      payload: { message: 'runner degraded', reason: 'runner-degraded' },
    },
    { type: 'invocation.disposed' as InvocationEventType, payload: { disposed: true } },
  ]) {
    it(`repairs a gap revealed by ${terminal.type} instead of cancelling the backfill`, async () => {
      const fixture = await makeSeededFixture()
      fixtures.push(fixture)
      const logs = { warn: [] as LogRecord[], error: [] as LogRecord[] }
      const controller = makeController(fixture, logs)
      const client = new GapReplayClient()
      client.response = {
        events: [diagnostic(3)],
        currentSeq: 5,
        retentionFloorSeq: 0,
      }
      bindGapClient(controller, RUNTIME_ID, INVOCATION_ID, client)

      // seq 3 never arrives live; the terminal lands while the gap backfill is
      // still debounced.
      consume(controller, RUNTIME_ID, [
        diagnostic(1),
        diagnostic(2),
        diagnostic(4),
        envelope(terminal.type, 5, terminal.payload),
      ])
      await settle()

      expect(client.calls).toEqual([{ invocationId: INVOCATION_ID, afterSeq: 2 }])
      expect(
        fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 3)
      ).not.toBeNull()
      expect(logs.warn).toContainEqual({
        message: 'broker.event_gap_backfilled',
        fields: {
          runtimeId: RUNTIME_ID,
          invocationId: INVOCATION_ID,
          repairedSeqs: [3],
        },
      })
      expect(logs.warn.some((entry) => entry.message === 'broker.event_gap_unrecoverable')).toBe(
        false
      )
    })
  }

  it('still reports unrecoverable on a terminal gap the ledger genuinely cannot fill', async () => {
    const fixture = await makeSeededFixture()
    fixtures.push(fixture)
    const logs = { warn: [] as LogRecord[], error: [] as LogRecord[] }
    const controller = makeController(fixture, logs)
    const client = new GapReplayClient()
    client.response = { events: [], currentSeq: 5, retentionFloorSeq: 3 }
    bindGapClient(controller, RUNTIME_ID, INVOCATION_ID, client)

    consume(controller, RUNTIME_ID, [
      diagnostic(1),
      diagnostic(2),
      diagnostic(4),
      envelope('invocation.exited', 5, { exitCode: 0, signal: null, reason: 'process-exit' }),
    ])
    await settle()

    expect(fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 3)).toBeNull()
    expect(logs.warn.some((entry) => entry.message === 'broker.event_gap_unrecoverable')).toBe(true)
  })

  it('a terminal flush replays once, not twice, when the debounce would also have fired', async () => {
    const fixture = await makeSeededFixture()
    fixtures.push(fixture)
    const logs = { warn: [] as LogRecord[], error: [] as LogRecord[] }
    const controller = makeController(fixture, logs)
    const client = new GapReplayClient()
    client.response = { events: [diagnostic(3)], currentSeq: 5, retentionFloorSeq: 0 }
    bindGapClient(controller, RUNTIME_ID, INVOCATION_ID, client)

    consume(controller, RUNTIME_ID, [
      diagnostic(1),
      diagnostic(2),
      diagnostic(4),
      envelope('invocation.exited', 5, { exitCode: 0, signal: null, reason: 'process-exit' }),
    ])
    // Well past the 5ms debounce: the cleared pending entry must not fire again.
    await settle()
    await settle()

    expect(client.calls).toHaveLength(1)
  })
})
