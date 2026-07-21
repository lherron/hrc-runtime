import { describe, expect, test } from 'bun:test'

import type { HrcMessageFilter, HrcMessageRecord, ListMessagesResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { cmdShow } from '../commands/show.js'

const MESSAGE_ID = 'msg-03c3d463-30c9-4e39-810d-88c6da2765b7'

function record(): HrcMessageRecord {
  return {
    messageSeq: 15_654,
    messageId: MESSAGE_ID,
    createdAt: '2026-07-21T08:39:45.000Z',
    kind: 'dm',
    phase: 'response',
    from: { kind: 'session', sessionRef: 'agent:clod:project:hrc-runtime/lane:main' },
    to: { kind: 'entity', entity: 'human' },
    rootMessageId: MESSAGE_ID,
    body: 'late response',
    bodyFormat: 'text/plain',
    execution: { state: 'not_applicable' },
  }
}

describe('hrcchat show', () => {
  test('looks up a message id exactly instead of scanning the first 1000 rows', async () => {
    let observed: HrcMessageFilter | undefined
    const client = {
      async listMessages(filter?: HrcMessageFilter): Promise<ListMessagesResponse> {
        observed = filter
        return { messages: [record()] }
      },
    } as HrcClient
    const originalWrite = process.stdout.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      await cmdShow(client, { json: false }, [MESSAGE_ID])
    } finally {
      process.stdout.write = originalWrite
    }

    expect(observed).toEqual({ messageId: MESSAGE_ID, limit: 1 })
  })
})
