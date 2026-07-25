import { describe, expect, test } from 'bun:test'

import type { TraceMessageResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { cmdTrace } from '../commands/trace.js'

const MESSAGE_ID = 'msg-11111111-1111-4111-8111-111111111111'

function response(): TraceMessageResponse {
  return {
    localNodeId: 'svc',
    message: {
      messageSeq: 12,
      messageId: MESSAGE_ID,
      createdAt: '2026-07-25T10:00:00.000Z',
      kind: 'dm',
      phase: 'request',
      from: { kind: 'entity', entity: 'human' },
      to: {
        kind: 'session',
        sessionRef: 'agent:cody:project:hrc-runtime:task:T-06830/lane:main',
      },
      rootMessageId: MESSAGE_ID,
      body: 'trace me',
      bodyFormat: 'text/plain',
      execution: { state: 'not_applicable' },
      collectiveHistory: {
        authorityNodeId: 'svc',
        observations: [
          {
            nodeId: 'svc',
            messageSeq: 12,
            role: 'origin',
            observedAt: '2026-07-25T10:00:00.000Z',
            originNodeId: 'svc',
            execution: { state: 'not_applicable' },
          },
          {
            nodeId: 'max3',
            messageSeq: 98,
            role: 'destination',
            observedAt: '2026-07-25T10:00:02.000Z',
            originNodeId: 'svc',
            acceptedDestinationNodeId: 'max3',
            execution: {
              state: 'started',
              runtimeId: 'rt-t06830',
              runId: 'run-t06830',
              transport: 'tmux',
            },
            delivery: {
              outcome: 'runtime_delivery',
              observedAt: '2026-07-25T10:00:02.000Z',
            },
          },
        ],
      },
    },
    acceptance: {
      acceptedByNodeId: 'max3',
      phase: 'request',
      requestEpoch: 4,
      acceptedAt: '2026-07-25T10:00:01.000Z',
      outcome: 'accepted',
    },
    destination: {
      nodeId: 'max3',
      messageId: MESSAGE_ID,
      messageSeq: 98,
      observedAt: '2026-07-25T10:00:02.000Z',
      execution: {
        state: 'started',
        runtimeId: 'rt-t06830',
        runId: 'run-t06830',
        transport: 'tmux',
      },
      delivery: {
        outcome: 'runtime_delivery',
        observedAt: '2026-07-25T10:00:02.000Z',
      },
    },
    history: {
      source: 'collective',
      complete: true,
      authorityNodeId: 'svc',
      queriedNodeId: 'svc',
      cursorKind: 'collective',
      pendingReplicationCount: 0,
    },
    verdict: {
      code: 'delivered_to_runtime',
      summary: 'delivered to runtime rt-t06830 on max3',
    },
  }
}

describe('hrcchat trace', () => {
  test('uses a numeric selector and renders the complete chain and verdict', async () => {
    let request: unknown
    let filter: unknown
    const client = {
      // A bare numeric is a collective seq (T-06970), resolved the same way
      // `show`/`thread` resolve it, so trace only ever traces by message id.
      async listMessages(input: unknown) {
        filter = input
        return { messages: [{ ...response().message, collectiveSeq: 17_932 }] }
      },
      async traceMessage(input: unknown) {
        request = input
        return response()
      },
    } as HrcClient
    let output = ''
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      await cmdTrace(client, {}, ['17932'])
    } finally {
      process.stdout.write = originalWrite
    }

    expect(filter).toEqual({ afterSeq: 17_931, limit: 1 })
    expect(request).toEqual({ messageId: MESSAGE_ID })
    expect(output).toContain(`message ${MESSAGE_ID} phase=request`)
    expect(output).toContain('ack accepted by=max3')
    expect(output).toContain(
      'destination max3 #98 delivery=runtime_delivery execution=started runtime=rt-t06830'
    )
    expect(output).toContain('verdict delivered to runtime rt-t06830 on max3')
  })
})
