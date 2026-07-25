import { describe, expect, test } from 'bun:test'

import type { HrcClient } from 'hrc-sdk'
import { cmdMessages } from '../commands/messages.js'

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
