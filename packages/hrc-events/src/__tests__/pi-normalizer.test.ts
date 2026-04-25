import { describe, expect, it } from 'bun:test'
import { normalizePiHookEvent } from '../pi-normalizer.js'
import type { PiHookEnvelopeInput } from '../pi-normalizer.js'

function piEnvelope(hookData: Record<string, unknown>): PiHookEnvelopeInput {
  return {
    launchId: 'launch-pi-1',
    hostSessionId: 'hsid-pi-1',
    runtimeId: 'rt-pi-1',
    generation: 7,
    scopeRef: 'agent-spaces:T-01262',
    laneRef: 'main',
    hookData,
  }
}

describe('normalizePiHookEvent', () => {
  it('maps tool_execution_start to a hook-sourced semantic tool start event with launch fence metadata', () => {
    const result = normalizePiHookEvent(
      piEnvelope({
        eventName: 'tool_execution_start',
        toolUseId: 'toolu-pi-1',
        toolName: 'exec_command',
        input: { cmd: 'bun test', workdir: '/repo' },
      })
    )

    expect(result.source).toBe('hook')
    expect(result.eventName).toBe('tool_execution_start')
    expect(result.events).toEqual([
      {
        type: 'tool_execution_start',
        toolUseId: 'toolu-pi-1',
        toolName: 'exec_command',
        input: { cmd: 'bun test', workdir: '/repo' },
      },
    ])
    expect(result.semanticEvents).toEqual([
      {
        source: 'hook',
        eventKind: 'turn.tool_call',
        launchId: 'launch-pi-1',
        hostSessionId: 'hsid-pi-1',
        runtimeId: 'rt-pi-1',
        generation: 7,
        scopeRef: 'agent-spaces:T-01262',
        laneRef: 'main',
        payload: {
          type: 'tool_execution_start',
          toolUseId: 'toolu-pi-1',
          toolName: 'exec_command',
          input: { cmd: 'bun test', workdir: '/repo' },
        },
      },
    ])
  })

  it('maps turn_start and turn_end to hook-sourced semantic turn lifecycle events', () => {
    const start = normalizePiHookEvent(
      piEnvelope({
        eventName: 'turn_start',
        prompt: 'continue the task',
      })
    )
    const end = normalizePiHookEvent(
      piEnvelope({
        eventName: 'turn_end',
      })
    )

    expect(start.semanticEvents[0]).toMatchObject({
      source: 'hook',
      eventKind: 'turn.started',
      launchId: 'launch-pi-1',
      hostSessionId: 'hsid-pi-1',
      runtimeId: 'rt-pi-1',
      generation: 7,
      scopeRef: 'agent-spaces:T-01262',
      laneRef: 'main',
    })
    expect(end.semanticEvents[0]).toMatchObject({
      source: 'hook',
      eventKind: 'turn.completed',
      launchId: 'launch-pi-1',
      hostSessionId: 'hsid-pi-1',
      runtimeId: 'rt-pi-1',
      generation: 7,
      scopeRef: 'agent-spaces:T-01262',
      laneRef: 'main',
    })
  })

  it('maps message_update to a hook-sourced assistant message semantic event', () => {
    const result = normalizePiHookEvent(
      piEnvelope({
        eventName: 'message_update',
        role: 'assistant',
        content: 'I am updating the implementation.',
      })
    )

    expect(result.semanticEvents).toEqual([
      {
        source: 'hook',
        eventKind: 'turn.message',
        launchId: 'launch-pi-1',
        hostSessionId: 'hsid-pi-1',
        runtimeId: 'rt-pi-1',
        generation: 7,
        scopeRef: 'agent-spaces:T-01262',
        laneRef: 'main',
        payload: {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: 'I am updating the implementation.',
          },
        },
      },
    ])
  })
})
