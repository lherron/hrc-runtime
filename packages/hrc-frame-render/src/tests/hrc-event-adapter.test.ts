import { describe, expect, test } from 'bun:test'

import { type HrcLifecycleEventPayload, adaptHrcLifecycleEvent } from '../hrc-event-adapter.js'

function hrcEvent(overrides: Partial<HrcLifecycleEventPayload> = {}): HrcLifecycleEventPayload {
  return {
    hrcSeq: 41,
    eventKind: 'turn.message',
    scopeRef: 'agent:larry:project:agent-spaces:task:T-01372',
    laneRef: 'main',
    runId: 'hrc-run-ignored',
    payload: {
      type: 'message_end',
      message: { role: 'assistant', content: 'hello from hrc' },
    },
    ...overrides,
  }
}

describe('adaptHrcLifecycleEvent', () => {
  test('maps turn.tool_call to tool_execution_start envelope with hrcSeq', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          hrcSeq: 7,
          eventKind: 'turn.tool_call',
          payload: {
            type: 'tool_execution_start',
            toolUseId: 'toolu_1',
            toolName: 'Bash',
            input: { command: 'bun test' },
          },
        })
      )
    ).toEqual({
      sessionRef: 'agent:larry:project:agent-spaces:task:T-01372/lane:main',
      projectId: 'agent-spaces',
      runId: 'hrc-run-ignored',
      seq: 7,
      event: {
        type: 'tool_execution_start',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: { command: 'bun test' },
      },
    })
  })

  test('maps turn.tool_result to tool_execution_end envelope', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          eventKind: 'turn.tool_result',
          payload: {
            type: 'tool_execution_end',
            toolUseId: 'toolu_1',
            toolName: 'Bash',
            result: { content: [{ type: 'text', text: 'ok' }] },
            isError: false,
          },
        })
      )?.event
    ).toEqual({
      type: 'tool_execution_end',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false,
    })
  })

  test('maps assistant turn.message to message_end with synthesized messageId', () => {
    const envelope = adaptHrcLifecycleEvent(hrcEvent())
    expect(envelope?.event).toMatchObject({
      type: 'message_end',
      messageId: 'hrc:41',
      message: { role: 'assistant', content: 'hello from hrc' },
    })
  })

  test('drops non-assistant messages', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          payload: {
            type: 'message_end',
            message: { role: 'user', content: 'not for progress bubble' },
          },
        })
      )
    ).toBeUndefined()
  })

  test('maps turn.completed to turn_end with payload intact', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          eventKind: 'turn.completed',
          payload: { finalOutput: 'done' },
        })
      )?.event
    ).toEqual({
      type: 'turn_end',
      payload: { finalOutput: 'done' },
    })
  })

  test('drops events without runId', () => {
    expect(adaptHrcLifecycleEvent(hrcEvent({ runId: undefined }))).toBeUndefined()
    expect(adaptHrcLifecycleEvent(hrcEvent({ runId: '' }))).toBeUndefined()
  })

  test('drops events with project-less scope (no project segment)', () => {
    // A scope ref without a project segment should return undefined
    // because there's no project to bind to
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          scopeRef: 'agent:larry',
        })
      )
    ).toBeUndefined()
  })

  test('passes notice-shaped payloads through', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          hrcSeq: 9,
          eventKind: 'notice',
          payload: { type: 'notice', level: 'warn', message: 'stream compacted' },
        })
      )
    ).toEqual({
      sessionRef: 'agent:larry:project:agent-spaces:task:T-01372/lane:main',
      projectId: 'agent-spaces',
      runId: 'hrc-run-ignored',
      seq: 9,
      event: { type: 'notice', level: 'warn', message: 'stream compacted' },
    })
  })

  test('drops unknown event kinds', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({ eventKind: 'runtime.created', payload: { runtimeId: 'rt_1' } })
      )
    ).toBeUndefined()
  })

  test('synthesizes distinct messageIds per turn.message for consecutive prose blocks', () => {
    const first = adaptHrcLifecycleEvent(
      hrcEvent({
        hrcSeq: 101,
        eventKind: 'turn.message',
        payload: {
          type: 'message_end',
          message: { role: 'assistant', content: 'first prose block' },
        },
      })
    )
    const second = adaptHrcLifecycleEvent(
      hrcEvent({
        hrcSeq: 103,
        eventKind: 'turn.message',
        payload: {
          type: 'message_end',
          message: { role: 'assistant', content: 'second prose block' },
        },
      })
    )

    expect(first?.event).toMatchObject({ type: 'message_end', messageId: 'hrc:101' })
    expect(second?.event).toMatchObject({ type: 'message_end', messageId: 'hrc:103' })
    expect((first?.event as { messageId?: string }).messageId).not.toBe(
      (second?.event as { messageId?: string }).messageId
    )
  })

  test('passes raw assistant streaming events (message_start, message_update) through', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          hrcSeq: 11,
          eventKind: 'message_start',
          payload: {
            type: 'message_start',
            messageId: 'msg-1',
            message: { role: 'assistant', content: '' },
          },
        })
      )
    ).toEqual({
      sessionRef: 'agent:larry:project:agent-spaces:task:T-01372/lane:main',
      projectId: 'agent-spaces',
      runId: 'hrc-run-ignored',
      seq: 11,
      event: {
        type: 'message_start',
        messageId: 'msg-1',
        message: { role: 'assistant', content: '' },
      },
    })

    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          hrcSeq: 12,
          eventKind: 'message_update',
          payload: {
            type: 'message_update',
            messageId: 'msg-1',
            textDelta: 'before tool',
          },
        })
      )?.event
    ).toEqual({
      type: 'message_update',
      messageId: 'msg-1',
      textDelta: 'before tool',
    })
  })

  test('renders accepted in-flight admission as contribution accepted', () => {
    const envelope = adaptHrcLifecycleEvent(
      hrcEvent({
        eventKind: 'input.application.accepted',
        payload: {
          admissionKind: 'accepted_in_flight',
          applicationStatus: 'accepted',
          ackSemantics: 'accepted_only',
        },
      })
    )

    expect(envelope?.event).toEqual({
      type: 'notice',
      level: 'info',
      message: 'Contribution accepted',
    })
    expect(JSON.stringify(envelope)).not.toMatch(/\bsteered\b/i)
    expect(JSON.stringify(envelope)).not.toMatch(/\bapplied\b/i)
  })
})
