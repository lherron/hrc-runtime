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
  it('leaves seq gaps while still projecting and returning live delta envelopes', () => {
    const eventMapper = mapper()

    eventMapper.apply(envelope('input.accepted', 3, { inputId: 'input_t07039' }))
    eventMapper.apply(envelope('turn.started', 4, { turnId: TURN_ID }, { turnId: TURN_ID }))
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
    expect(bufferTextForRun(fixture.db, RUN_ID)).toBe('projected delta text')
    expect(assistantDelta.idempotent).toBe(false)
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
    expect(fixture.db.events.listFromSeq(1)).toEqual([])
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

  it('restores both delta rows when HRC_PERSIST_RAW_DELTAS=1', () => {
    process.env[PERSIST_RAW_DELTAS_ENV] = '1'
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

    const rows = fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
    expect(rows.map((record) => record.seq)).toEqual([5, 6])
    expect(rows.map((record) => record.type)).toEqual([
      'assistant.message.delta',
      'tool.call.delta',
    ])
    expect(rows.every((record) => record.projectionStatus === 'applied')).toBe(true)
  })
})
