import { describe, expect, test } from 'bun:test'

import type { HrcCollectiveMessageRecord, HrcMessageFilter } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { cmdMessages } from '../commands/messages.js'

const NOTIFICATION_ID = 'msg-11111111-1111-4111-8111-111111111111'
const COLLIDING_ID = 'msg-22222222-2222-4222-8222-222222222222'

function message(input: {
  messageId: string
  messageSeq: number
  collectiveSeq: number
}): HrcCollectiveMessageRecord {
  return {
    ...input,
    createdAt: '2026-08-10T12:57:41.953Z',
    kind: 'dm',
    phase: 'request',
    from: { kind: 'entity', entity: 'human' },
    to: {
      kind: 'session',
      sessionRef: 'agent:cody:project:hrc-runtime:task:T-07188/lane:main',
    },
    rootMessageId: input.messageId,
    body: 'cursor fixture',
    bodyFormat: 'text/plain',
    execution: { state: 'not_applicable' },
  }
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  let output = ''
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    await run()
  } finally {
    process.stdout.write = originalWrite
  }
  return output
}

describe('hrcchat messages collective history status', () => {
  test('labels an incomplete local fallback and distinguishes collective/local sequences', async () => {
    const client = {
      async listMessages() {
        return {
          messages: [
            {
              messageSeq: 7,
              collectiveSeq: 44,
              messageId: 'msg-history',
              createdAt: '2026-07-24T12:00:00.000Z',
              kind: 'dm' as const,
              phase: 'request' as const,
              from: { kind: 'entity' as const, entity: 'human' as const },
              to: {
                kind: 'session' as const,
                sessionRef: 'agent:cody:project:hrc-runtime:task:minisvc/lane:main',
              },
              rootMessageId: 'msg-history',
              body: 'history row',
              bodyFormat: 'text/plain' as const,
              execution: { state: 'completed' as const },
            },
          ],
          history: {
            source: 'local' as const,
            complete: false,
            authorityNodeId: 'svc',
            queriedNodeId: 'lab',
            cursorKind: 'node-local' as const,
            pendingReplicationCount: 1,
            degraded: {
              code: 'collective_unreachable' as const,
              message: 'svc sleeping',
            },
          },
        }
      },
    } as unknown as HrcClient
    const originalStdout = process.stdout.write
    const originalStderr = process.stderr.write
    let stdout = ''
    let stderr = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString()
      return true
    }) as typeof process.stderr.write
    try {
      await cmdMessages(client, {}, [])
    } finally {
      process.stdout.write = originalStdout
      process.stderr.write = originalStderr
    }

    expect(stderr).toContain('history incomplete (collective_unreachable): svc sleeping')
    expect(stdout).toContain('@44/#7')
    expect(stdout).toContain('history row')
  })
})

describe('T-07188 messages --after sequence namespace', () => {
  const notification = message({
    messageId: NOTIFICATION_ID,
    messageSeq: 18_427,
    collectiveSeq: 19_566,
  })
  const colliding = message({
    messageId: COLLIDING_ID,
    messageSeq: 17_288,
    collectiveSeq: 18_427,
  })

  function clientWithFilters(filters: HrcMessageFilter[]): HrcClient {
    return {
      async listMessages(filter?: HrcMessageFilter) {
        const observed = filter ?? {}
        filters.push(observed)
        if (observed.messageId === NOTIFICATION_ID) return { messages: [notification] }
        if (observed.afterSeq === 18_426 && observed.limit === 1) {
          return { messages: [colliding] }
        }
        return { messages: [] }
      },
      async traceMessage(request: { messageSeq?: number; messageId?: string }) {
        if (request.messageSeq !== notification.messageSeq) {
          throw new Error(`unexpected trace request: ${JSON.stringify(request)}`)
        }
        return { message: notification }
      },
    } as unknown as HrcClient
  }

  test('bare notification seq refuses a distinct @seq/#seq collision', async () => {
    const filters: HrcMessageFilter[] = []
    await expect(
      cmdMessages(clientWithFilters(filters), { after: '18427', json: true }, [])
    ).rejects.toThrow(
      /ambiguous message sequence 18427: @18427 \(collective seq\).*#18427 \(node-local message seq\)/
    )
  })

  test('explicit #seq maps the notification to its collective history cursor', async () => {
    const filters: HrcMessageFilter[] = []
    await captureStdout(async () => {
      await cmdMessages(clientWithFilters(filters), { after: '#18427', json: true }, [])
    })
    expect(filters.at(-1)).toEqual({ afterSeq: 19_566, limit: 50 })
  })

  test('explicit @seq passes through as the collective history cursor', async () => {
    const filters: HrcMessageFilter[] = []
    await captureStdout(async () => {
      await cmdMessages(clientWithFilters(filters), { after: '@19566', json: true }, [])
    })
    expect(filters).toEqual([{ afterSeq: 19_566, limit: 50 }])
  })
})
