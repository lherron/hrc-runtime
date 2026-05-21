import { describe, expect, test } from 'bun:test'
import type { AgentEvent, RunTurnNonInteractiveResponse } from 'agent-spaces'
import type { HrcEventEnvelope, HrcRuntimeIntent } from 'hrc-core'

import { runSdkTurn } from '../agent-spaces-adapter/sdk-adapter'

function makeIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
      correlation: {
        sessionRef: {
          scopeRef: 'agent:rex:project:agent-spaces:task:T-01539',
          laneRef: 'lane:main',
        },
        hostSessionId: 'hs-consumer-contract',
        runId: 'run-consumer-contract',
      },
    },
    harness: {
      provider: 'anthropic',
      interactive: false,
    },
  }
}

function makeBase(seq: number): Pick<AgentEvent, 'ts' | 'seq' | 'hostSessionId' | 'runId'> {
  return {
    ts: '2026-05-21T00:00:00.000Z',
    seq,
    hostSessionId: 'asp-host-session',
    runId: 'asp-run',
  }
}

describe('agent-spaces consumer contracts', () => {
  test('maps public AgentEvent variants into HRC event envelopes', async () => {
    const events: Array<Omit<HrcEventEnvelope, 'seq' | 'streamSeq'>> = []
    const buffers: string[] = []

    await runSdkTurn({
      intent: makeIntent(),
      hostSessionId: 'hs-consumer-contract',
      runId: 'run-consumer-contract',
      runtimeId: 'rt-consumer-contract',
      prompt: 'check event contract',
      scopeRef: 'agent:rex:project:agent-spaces:task:T-01539',
      laneRef: 'main',
      generation: 3,
      onHrcEvent: (event) => events.push(event),
      onBuffer: (text) => buffers.push(text),
      runner: async (request): Promise<RunTurnNonInteractiveResponse> => {
        const continuation = { provider: 'anthropic' as const, key: 'sdk-continuation' }
        const agentEvents: AgentEvent[] = [
          {
            ...makeBase(1),
            type: 'state',
            state: 'running',
            continuation,
            cpSessionId: 'legacy-cp',
          },
          {
            ...makeBase(2),
            type: 'message_delta',
            role: 'assistant',
            delta: 'partial',
          },
          {
            ...makeBase(3),
            type: 'message',
            role: 'assistant',
            content: 'complete message',
          },
          {
            ...makeBase(4),
            type: 'tool_call',
            toolUseId: 'tool-1',
            toolName: 'Read',
            input: { path: '/tmp/file' },
          },
          {
            ...makeBase(5),
            type: 'tool_result',
            toolUseId: 'tool-1',
            toolName: 'Read',
            output: 'file contents',
            isError: false,
          },
          {
            ...makeBase(6),
            type: 'complete',
            result: { success: true, finalOutput: 'done' },
          },
        ]

        for (const event of agentEvents) {
          await request.callbacks.onEvent(event)
        }

        return {
          continuation,
          provider: 'anthropic',
          frontend: request.frontend,
          result: { success: true, finalOutput: 'done' },
        }
      },
    })

    expect(events.map((event) => event.eventKind)).toEqual([
      'sdk.running',
      'sdk.message_delta',
      'sdk.message',
      'sdk.tool_call',
      'sdk.tool_result',
      'sdk.complete',
    ])
    expect(events[0].eventJson).toEqual({
      type: 'state',
      state: 'running',
      cpSessionId: 'legacy-cp',
      continuation: { provider: 'anthropic', key: 'sdk-continuation' },
    })
    expect(events[0].eventJson).not.toHaveProperty('ts')
    expect(events[0].eventJson).not.toHaveProperty('seq')
    expect(events[0].eventJson).not.toHaveProperty('hostSessionId')
    expect(events[0].eventJson).not.toHaveProperty('runId')
    expect(events[3].eventJson).toMatchObject({
      type: 'tool_call',
      toolUseId: 'tool-1',
      toolName: 'Read',
      input: { path: '/tmp/file' },
    })
    expect(events[5].eventJson).toMatchObject({
      type: 'complete',
      result: { success: true, finalOutput: 'done' },
    })
    expect(buffers).toEqual(['partial', 'complete message'])
  })
})
