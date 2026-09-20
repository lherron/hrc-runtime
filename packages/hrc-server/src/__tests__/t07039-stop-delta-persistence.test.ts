import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { TurnId } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import {
  INVOCATION_ID,
  RUN_ID,
  type SeededFixture,
  bufferTextForRun,
  envelope,
  makeSeededFixture,
  messageId,
  toolCallId,
  ts,
} from './broker-event-mapper-fixtures'

const PERSIST_RAW_DELTAS_ENV = 'HRC_PERSIST_RAW_DELTAS'
const TURN_ID = 'turn_t07039' as TurnId
const MESSAGE_ID = messageId('message_t07039')
const TOOL_CALL_ID = toolCallId('tool_t07039')

let fixture: SeededFixture
let previousPersistRawDeltas: string | undefined

beforeEach(async () => {
  previousPersistRawDeltas = process.env[PERSIST_RAW_DELTAS_ENV]
  delete process.env[PERSIST_RAW_DELTAS_ENV]
  fixture = await makeSeededFixture()
})

afterEach(async () => {
  if (previousPersistRawDeltas === undefined) {
    delete process.env[PERSIST_RAW_DELTAS_ENV]
  } else {
    process.env[PERSIST_RAW_DELTAS_ENV] = previousPersistRawDeltas
  }
  await fixture.cleanup()
})

function mapper(): BrokerEventMapper {
  return new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
}

describe('T-07039 raw broker delta persistence gate', () => {
  it('keeps all streaming deltas exclusively in the broker ledger while advancing the cursor', () => {
    fixture.db.brokerInvocations.update(INVOCATION_ID, {
      lastProjectedSeq: 2,
      updatedAt: ts(99),
    })
    const eventMapper = mapper()

    eventMapper.apply(envelope('input.accepted', 3, { inputId: 'input_w3a_1' }))
    eventMapper.apply(
      envelope(
        'turn.started',
        4,
        { turnId: TURN_ID, inputId: 'input_w3a_1' as never },
        { turnId: TURN_ID, inputId: 'input_w3a_1' as never }
      )
    )
    const assistantDelta = eventMapper.apply(
      envelope(
        'assistant.message.delta',
        5,
        { messageId: MESSAGE_ID, text: 'projected delta text' },
        { turnId: TURN_ID }
      )
    )
    const toolDelta = eventMapper.apply(
      envelope(
        'tool.call.delta',
        6,
        { toolCallId: TOOL_CALL_ID, text: 'live tool output' },
        { turnId: TURN_ID }
      )
    )
    eventMapper.apply(
      envelope(
        'turn.completed',
        7,
        { turnId: TURN_ID, status: 'completed', producedContent: true },
        { turnId: TURN_ID }
      )
    )

    expect(
      fixture.db.brokerInvocationEvents
        .listByInvocationId(INVOCATION_ID)
        .map((record) => record.seq)
    ).toEqual([3, 4, 7])
    expect(bufferTextForRun(fixture.db, RUN_ID)).toBe('')
    expect(assistantDelta.idempotent).toBe(true)
    expect(assistantDelta.ignoredDelta).toBe(true)
    expect(assistantDelta.brokerEvent.id).toBeUndefined()
    expect(JSON.parse(assistantDelta.brokerEvent.brokerEnvelopeJson!)).toMatchObject({
      seq: 5,
      type: 'assistant.message.delta',
      payload: { text: 'projected delta text' },
    })
    expect(toolDelta.brokerEvent.id).toBeUndefined()
    expect(JSON.parse(toolDelta.brokerEvent.brokerEnvelopeJson!)).toMatchObject({
      seq: 6,
      type: 'tool.call.delta',
      payload: { text: 'live tool output' },
    })

    expect(assistantDelta.events).toEqual([])
    expect(toolDelta.events).toEqual([])
    expect(toolDelta.idempotent).toBe(true)
    expect(toolDelta.ignoredDelta).toBe(true)
    expect(fixture.db.brokerInvocationEvents.getProjectionDisposition(INVOCATION_ID, 5)).toBeNull()
    expect(fixture.db.brokerInvocationEvents.getProjectionDisposition(INVOCATION_ID, 6)).toBeNull()
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(7)
    expect(fixture.db.events.listFromSeq(1)).toEqual([])
  })

  it('refuses to advance across a missing event when skipping a tool delta', () => {
    fixture.db.brokerInvocations.update(INVOCATION_ID, {
      lastProjectedSeq: 2,
      updatedAt: ts(99),
    })

    expect(() =>
      mapper().apply(
        envelope('tool.call.delta', 4, {
          toolCallId: TOOL_CALL_ID,
          text: 'must not skip unknown seq 3',
        })
      )
    ).toThrow('expected 3, received 4')
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(2)
  })

  it('keeps a large tool-delta burst out of every HRC projection table', () => {
    const eventMapper = mapper()

    for (let seq = 1; seq <= 2_500; seq += 1) {
      eventMapper.apply(
        envelope('tool.call.delta', seq, {
          toolCallId: TOOL_CALL_ID,
          text: `raw broker fragment ${seq}`,
        })
      )
    }

    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(0)
    expect(eventMapper.flushIgnoredDeltas(INVOCATION_ID)).toBe(2_500)
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(
      2_500
    )
    expect(fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)).toEqual([])
    expect(fixture.db.events.listFromSeq(1)).toEqual([])
    expect(
      fixture.db.sqlite.query('SELECT COUNT(*) AS count FROM broker_projection_dispositions').get()
    ).toEqual({ count: 0 })
  })

  it('persists every non-delta kind by default', () => {
    const eventMapper = mapper()

    eventMapper.apply(
      envelope('diagnostic', 10, {
        level: 'info',
        source: 'driver',
        message: 'unknown-to-projection kinds remain durable',
      })
    )

    const record = fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 10)
    expect(record?.type).toBe('diagnostic')
    expect(record?.projectionStatus).toBe('applied')
  })

  it('never restores either delta kind when the retired raw-delta environment variable is set', () => {
    process.env[PERSIST_RAW_DELTAS_ENV] = '1'
    fixture.db.brokerInvocations.update(INVOCATION_ID, {
      lastProjectedSeq: 4,
      updatedAt: ts(99),
    })
    const eventMapper = mapper()

    eventMapper.apply(
      envelope('assistant.message.delta', 5, {
        messageId: MESSAGE_ID,
        text: 'persisted by kill switch',
      })
    )
    eventMapper.apply(
      envelope('tool.call.delta', 6, {
        toolCallId: TOOL_CALL_ID,
        data: { output: 'persisted by kill switch' },
      })
    )

    eventMapper.flushIgnoredDeltas(INVOCATION_ID)
    const rows = fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
    expect(rows).toEqual([])
    expect(fixture.db.brokerInvocationEvents.getProjectionDisposition(INVOCATION_ID, 5)).toBeNull()
    expect(fixture.db.brokerInvocationEvents.getProjectionDisposition(INVOCATION_ID, 6)).toBeNull()
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(6)
  })

  it('advances one contiguous committed cursor across non-mirrored deltas and rejects divergent replay', () => {
    fixture.db.brokerInvocations.update(INVOCATION_ID, {
      lastProjectedSeq: 2,
      updatedAt: ts(99),
    })
    const eventMapper = mapper()
    const seq3 = envelope('diagnostic', 3, { level: 'info', message: 'three' })
    const seq4 = envelope('assistant.message.delta', 4, {
      messageId: MESSAGE_ID,
      text: 'non-mirrored four',
    })
    const seq5 = envelope('tool.call.delta', 5, {
      toolCallId: TOOL_CALL_ID,
      text: 'non-mirrored five',
    })
    const seq6 = envelope('diagnostic', 6, { level: 'info', message: 'six' })

    eventMapper.apply(seq3)
    eventMapper.apply(seq4)
    eventMapper.apply(seq5)
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(3)
    expect(fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 4)).toBeNull()
    expect(fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 5)).toBeNull()
    expect(fixture.db.brokerInvocationEvents.getProjectionDisposition(INVOCATION_ID, 4)).toBeNull()
    expect(fixture.db.brokerInvocationEvents.getProjectionDisposition(INVOCATION_ID, 5)).toBeNull()

    eventMapper.apply(seq6)
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(6)
    expect(eventMapper.apply(seq5).idempotent).toBe(true)
    expect(eventMapper.apply(seq4).idempotent).toBe(true)
  })

  it('flushes retained delta-only ranges through the retained cursor only', () => {
    const eventMapper = mapper()

    eventMapper.applyRetained(
      envelope('assistant.message.delta', 1, { messageId: MESSAGE_ID, text: 'retained one' })
    )
    eventMapper.applyRetained(
      envelope('tool.call.delta', 2, { toolCallId: TOOL_CALL_ID, text: 'retained two' })
    )

    expect(eventMapper.flushIgnoredDeltas(INVOCATION_ID, true)).toBe(2)
    const invocation = fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)
    expect(invocation?.lastProjectedSeq).toBe(0)
    expect(invocation?.retainedProjectedThroughSeq).toBe(2)
    expect(fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)).toEqual([])
  })
})
