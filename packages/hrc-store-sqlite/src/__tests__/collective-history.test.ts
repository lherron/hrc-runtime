import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcMessageRecord } from 'hrc-core'
import { openHrcDatabase } from '../database.js'

function message(
  patch: Partial<HrcMessageRecord> & Pick<HrcMessageRecord, 'messageId' | 'messageSeq'>
): HrcMessageRecord {
  return {
    messageSeq: patch.messageSeq,
    messageId: patch.messageId,
    createdAt: patch.createdAt ?? '2026-07-24T12:00:00.000Z',
    kind: patch.kind ?? 'dm',
    phase: patch.phase ?? 'request',
    from: patch.from ?? {
      kind: 'session',
      sessionRef: 'agent:cody:project:hrc-runtime:task:origin/lane:main',
    },
    to: patch.to ?? {
      kind: 'session',
      sessionRef: 'agent:clod:project:hrc-runtime:task:target/lane:main',
    },
    replyToMessageId: patch.replyToMessageId,
    rootMessageId: patch.rootMessageId ?? patch.messageId,
    body: patch.body ?? 'hello',
    bodyFormat: 'text/plain',
    execution: patch.execution ?? { state: 'accepted' },
    metadataJson: patch.metadataJson,
  }
}

describe('collective message history repository', () => {
  test('deduplicates by message ID, prefers origin facts, and preserves both node sequences', () => {
    const db = openHrcDatabase(':memory:')
    try {
      const destination = message({
        messageId: 'msg-collective-1',
        messageSeq: 91,
        createdAt: '2026-07-24T12:00:02.000Z',
        execution: { state: 'not_applicable' },
        metadataJson: {
          federationIngress: { authenticatedNodeId: 'max3', protocolVersion: '1.0' },
        },
      })
      db.collectiveHistory.recordObservation({
        sourceNodeId: 'lab',
        sourceRole: 'destination',
        originNodeId: 'max3',
        acceptedDestinationNodeId: 'lab',
        record: destination,
      })

      const origin = message({
        messageId: destination.messageId,
        messageSeq: 17,
        createdAt: '2026-07-24T12:00:00.000Z',
        execution: { state: 'completed', runId: 'run-origin' },
      })
      db.collectiveHistory.recordObservation({
        sourceNodeId: 'max3',
        sourceRole: 'origin',
        originNodeId: 'max3',
        record: origin,
      })

      const rows = db.collectiveHistory.query({}, 'svc')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        messageId: destination.messageId,
        messageSeq: 17,
        createdAt: '2026-07-24T12:00:00.000Z',
        execution: { state: 'completed', runId: 'run-origin' },
        collectiveSeq: 1,
        collectiveHistory: {
          authorityNodeId: 'svc',
          observations: [
            {
              nodeId: 'lab',
              messageSeq: 91,
              role: 'destination',
              originNodeId: 'max3',
              acceptedDestinationNodeId: 'lab',
              execution: { state: 'not_applicable' },
            },
            {
              nodeId: 'max3',
              messageSeq: 17,
              role: 'origin',
              originNodeId: 'max3',
              execution: { state: 'completed', runId: 'run-origin' },
            },
          ],
        },
      })
    } finally {
      db.close()
    }
  })

  test('keeps parent before a clock-skewed reply and uses only collective cursors', () => {
    const db = openHrcDatabase(':memory:')
    try {
      const request = message({
        messageId: 'msg-parent',
        messageSeq: 800,
        createdAt: '2026-07-24T12:00:10.000Z',
      })
      const response = message({
        messageId: 'msg-child',
        messageSeq: 2,
        phase: 'response',
        replyToMessageId: request.messageId,
        rootMessageId: request.messageId,
        createdAt: '2026-07-24T12:00:00.000Z',
      })
      for (const record of [request, response]) {
        db.collectiveHistory.recordObservation({
          sourceNodeId: 'max3',
          sourceRole: 'origin',
          originNodeId: 'max3',
          record,
        })
      }

      expect(
        db.collectiveHistory
          .query({ thread: { rootMessageId: request.messageId } }, 'svc')
          .map((record) => record.messageId)
      ).toEqual([request.messageId, response.messageId])
      expect(
        db.collectiveHistory.query({ afterSeq: 1 }, 'svc').map((record) => record.messageId)
      ).toEqual([response.messageId])
    } finally {
      db.close()
    }
  })

  test('pushes exact message and cursor filters into SQL before decoding records', () => {
    const root = mkdtempSync(join(tmpdir(), 'hrc-collective-query-'))
    const dbPath = join(root, 'state.sqlite')
    let db = openHrcDatabase(dbPath)
    try {
      for (const record of [
        message({ messageId: 'msg-target', messageSeq: 1 }),
        message({ messageId: 'msg-unrelated', messageSeq: 2 }),
      ]) {
        db.collectiveHistory.recordObservation({
          sourceNodeId: 'svc',
          sourceRole: 'origin',
          originNodeId: 'svc',
          record,
        })
      }
      db.close()

      const sqlite = new Database(dbPath)
      sqlite
        .query(
          `UPDATE collective_history_messages
              SET canonical_record_json = '{'
            WHERE message_id = 'msg-unrelated'`
        )
        .run()
      sqlite.close()

      db = openHrcDatabase(dbPath)
      const stored = db.collectiveHistory.recordObservation({
        sourceNodeId: 'svc',
        sourceRole: 'origin',
        originNodeId: 'svc',
        record: message({
          messageId: 'msg-target',
          messageSeq: 1,
          execution: { state: 'completed', runId: 'run-target' },
        }),
      })
      expect(stored.messageId).toBe('msg-target')
      expect(
        db.collectiveHistory.query({ messageId: 'msg-target', afterSeq: 0 }, 'svc')
      ).toHaveLength(1)
      expect(
        db.collectiveHistory.query({ messageId: 'msg-target', afterSeq: 1 }, 'svc')
      ).toHaveLength(0)
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('collective history durable replication queue', () => {
  test('reopens a delivered row only when the canonical record changes', () => {
    const db = openHrcDatabase(':memory:')
    try {
      const initial = message({ messageId: 'msg-replication', messageSeq: 4 })
      const observation = {
        sourceNodeId: 'lab',
        sourceRole: 'origin' as const,
        originNodeId: 'lab',
        record: initial,
      }
      db.collectiveHistoryReplications.enqueue(observation, '2026-07-24T12:00:00.000Z')
      const first = db.collectiveHistoryReplications.listDue('2026-07-24T12:00:00.000Z')[0]
      if (first === undefined) throw new Error('missing replication')
      expect(
        db.collectiveHistoryReplications.markDelivered(
          first.messageId,
          first.fingerprint,
          '2026-07-24T12:00:01.000Z'
        )
      ).toBe(true)
      expect(db.collectiveHistoryReplications.pendingCount()).toBe(0)

      db.collectiveHistoryReplications.enqueue(observation, '2026-07-24T12:00:02.000Z')
      expect(db.collectiveHistoryReplications.pendingCount()).toBe(0)

      db.collectiveHistoryReplications.enqueue(
        {
          ...observation,
          record: { ...initial, execution: { state: 'completed', runId: 'run-4' } },
        },
        '2026-07-24T12:00:03.000Z'
      )
      expect(db.collectiveHistoryReplications.pendingCount()).toBe(1)
      const changed = db.collectiveHistoryReplications.listDue('2026-07-24T12:00:03.000Z')[0]
      expect(changed?.record.execution).toEqual({ state: 'completed', runId: 'run-4' })
      expect(
        db.collectiveHistoryReplications.markDelivered(
          initial.messageId,
          first.fingerprint,
          '2026-07-24T12:00:04.000Z'
        )
      ).toBe(false)
    } finally {
      db.close()
    }
  })
})
