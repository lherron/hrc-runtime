import { describe, expect, test } from 'bun:test'

import type { HrcCollectiveMessageRecord, HrcMessageFilter, ListMessagesResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { cmdThread } from '../commands/thread.js'

const ROOT_ID = 'msg-11111111-1111-4111-8111-111111111111'
const REPLY_ID = 'msg-22222222-2222-4222-8222-222222222222'
const DISPOSITION_ID = 'msg-33333333-3333-4333-8333-333333333333'
const LONG_BODY = `RULING:\n${'complete-body-segment '.repeat(20)}`

function message(
  input: Pick<
    HrcCollectiveMessageRecord,
    'messageSeq' | 'collectiveSeq' | 'messageId' | 'phase' | 'from' | 'to' | 'body'
  > &
    Partial<Pick<HrcCollectiveMessageRecord, 'replyToMessageId'>>
): HrcCollectiveMessageRecord {
  return {
    createdAt: `2026-07-18T16:25:${String(input.collectiveSeq ?? input.messageSeq).padStart(
      2,
      '0'
    )}.000Z`,
    kind: 'dm',
    rootMessageId: ROOT_ID,
    bodyFormat: 'text/plain',
    execution: { state: 'completed' },
    ...input,
  }
}

const THREAD = [
  message({
    messageSeq: 11,
    collectiveSeq: 21,
    messageId: ROOT_ID,
    phase: 'request',
    from: { kind: 'session', sessionRef: 'agent:mable:project:hrc-runtime/lane:main' },
    to: { kind: 'session', sessionRef: 'agent:daedalus:project:hrc-runtime/lane:main' },
    body: 'Architecture brief',
  }),
  message({
    messageSeq: 12,
    collectiveSeq: 22,
    messageId: REPLY_ID,
    replyToMessageId: ROOT_ID,
    phase: 'response',
    from: { kind: 'session', sessionRef: 'agent:daedalus:project:hrc-runtime/lane:main' },
    to: { kind: 'session', sessionRef: 'agent:mable:project:hrc-runtime/lane:main' },
    body: LONG_BODY,
  }),
  message({
    messageSeq: 13,
    collectiveSeq: 23,
    messageId: DISPOSITION_ID,
    replyToMessageId: REPLY_ID,
    phase: 'response',
    from: { kind: 'session', sessionRef: 'agent:mable:project:hrc-runtime/lane:main' },
    to: { kind: 'session', sessionRef: 'agent:daedalus:project:hrc-runtime/lane:main' },
    body: 'DISPOSITION: ADOPTED',
  }),
] satisfies HrcCollectiveMessageRecord[]

function clientWithCalls(calls: HrcMessageFilter[]): HrcClient {
  return {
    async listMessages(filter?: HrcMessageFilter): Promise<ListMessagesResponse> {
      calls.push(filter ?? {})
      if (filter?.thread !== undefined) {
        return {
          messages: THREAD,
          history: {
            source: 'collective',
            complete: true,
            authorityNodeId: 'svc',
            queriedNodeId: 'svc',
            cursorKind: 'collective',
            pendingReplicationCount: 0,
          },
        }
      }
      return { messages: [THREAD[1]!] }
    },
  } as HrcClient
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write
  let output = ''
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString()
    return true
  }) as typeof process.stdout.write
  try {
    await run()
  } finally {
    process.stdout.write = original
  }
  return output
}

describe('hrcchat thread', () => {
  test('walks from a seq-selected middle reply to the complete untruncated thread', async () => {
    const calls: HrcMessageFilter[] = []
    const output = await captureStdout(() =>
      cmdThread(clientWithCalls(calls), { json: false }, ['seq:22'])
    )

    expect(calls).toEqual([
      { afterSeq: 21, limit: 1 },
      { thread: { rootMessageId: ROOT_ID }, order: 'asc' },
    ])
    expect(output).toContain(ROOT_ID)
    expect(output).toContain(REPLY_ID)
    expect(output).toContain(DISPOSITION_ID)
    expect(output).toContain(LONG_BODY)
    expect(output).not.toContain('…(truncated;')
    expect(output.indexOf(ROOT_ID)).toBeLessThan(output.indexOf(REPLY_ID))
    expect(output.indexOf(REPLY_ID)).toBeLessThan(output.indexOf(DISPOSITION_ID))
  })

  test('emits a versioned stable JSON projection from a msg: selector', async () => {
    const calls: HrcMessageFilter[] = []
    const output = await captureStdout(() =>
      cmdThread(clientWithCalls(calls), { json: true }, [`msg:${REPLY_ID}`])
    )
    const parsed = JSON.parse(output)

    expect(calls[0]).toEqual({ messageId: REPLY_ID, limit: 1 })
    expect(parsed).toMatchObject({
      schema: 1,
      anchor: {
        input: `msg:${REPLY_ID}`,
        messageId: REPLY_ID,
        messageSeq: 12,
        collectiveSeq: 22,
      },
      rootMessageId: ROOT_ID,
      ordering: 'reply-topological-asc',
      count: 3,
      messages: [
        { messageId: ROOT_ID, body: 'Architecture brief' },
        { messageId: REPLY_ID, body: LONG_BODY },
        { messageId: DISPOSITION_ID, body: 'DISPOSITION: ADOPTED' },
      ],
    })
  })
})
