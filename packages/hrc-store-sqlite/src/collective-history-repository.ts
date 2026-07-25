import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

import type {
  HrcCollectiveHistoryObservation,
  HrcCollectiveMessageRecord,
  HrcMessageAddress,
  HrcMessageFilter,
  HrcMessageRecord,
} from 'hrc-core'
import { execute } from './repositories/shared.js'

export type CollectiveHistorySourceRole = 'origin' | 'destination'

export type RecordCollectiveHistoryObservationInput = {
  sourceNodeId: string
  sourceRole: CollectiveHistorySourceRole
  originNodeId: string
  acceptedDestinationNodeId?: string | undefined
  observedAt?: string | undefined
  record: HrcMessageRecord
}

type CollectiveMessageRow = {
  collective_seq: number
  message_id: string
  canonical_record_json: string
  canonical_source_node_id: string
  canonical_source_role: CollectiveHistorySourceRole
  canonical_created_at: string
}

type CollectiveObservationRow = {
  source_node_id: string
  source_message_seq: number
  source_role: CollectiveHistorySourceRole
  origin_node_id: string
  accepted_destination_node_id: string | null
  record_json: string
  observed_at: string
}

function addressEquals(left: HrcMessageAddress, right: HrcMessageAddress): boolean {
  if (left.kind !== right.kind) return false
  return left.kind === 'entity'
    ? left.entity === (right as Extract<HrcMessageAddress, { kind: 'entity' }>).entity
    : left.sessionRef === (right as Extract<HrcMessageAddress, { kind: 'session' }>).sessionRef
}

function matchesFilter(record: HrcMessageRecord, filter: HrcMessageFilter): boolean {
  if (filter.messageId !== undefined && record.messageId !== filter.messageId) return false
  if (filter.from !== undefined && !addressEquals(record.from, filter.from)) return false
  if (filter.to !== undefined && !addressEquals(record.to, filter.to)) return false
  if (
    filter.participant !== undefined &&
    !addressEquals(record.from, filter.participant) &&
    !addressEquals(record.to, filter.participant)
  ) {
    return false
  }
  if (filter.thread !== undefined && record.rootMessageId !== filter.thread.rootMessageId) {
    return false
  }
  if (
    filter.replyToMessageId !== undefined &&
    record.replyToMessageId !== filter.replyToMessageId
  ) {
    return false
  }
  if (
    filter.hostSessionId !== undefined &&
    record.execution.hostSessionId !== filter.hostSessionId
  ) {
    return false
  }
  if (filter.runId !== undefined && record.execution.runId !== filter.runId) return false
  if (filter.generation !== undefined && record.execution.generation !== filter.generation) {
    return false
  }
  if (filter.kinds?.length && !filter.kinds.includes(record.kind)) return false
  if (filter.phases?.length && !filter.phases.includes(record.phase)) return false
  return true
}

function compareMessageOrder(
  left: HrcCollectiveMessageRecord,
  right: HrcCollectiveMessageRecord
): number {
  const byTime = left.createdAt.localeCompare(right.createdAt)
  return byTime === 0 ? left.messageId.localeCompare(right.messageId) : byTime
}

/**
 * Stable parent-before-child order after the ordinary timestamp/message-id
 * sort. This keeps a skewed response clock from placing a reply before the
 * request it names while remaining deterministic across every ingress node.
 */
function orderThreadTopologically(
  records: HrcCollectiveMessageRecord[]
): HrcCollectiveMessageRecord[] {
  const sorted = [...records].sort(compareMessageOrder)
  const selectedIds = new Set(sorted.map((record) => record.messageId))
  const emitted = new Set<string>()
  const output: HrcCollectiveMessageRecord[] = []
  let remaining = sorted

  while (remaining.length > 0) {
    const next: HrcCollectiveMessageRecord[] = []
    let progressed = false
    for (const record of remaining) {
      const parent = record.replyToMessageId
      if (parent === undefined || !selectedIds.has(parent) || emitted.has(parent)) {
        output.push(record)
        emitted.add(record.messageId)
        progressed = true
      } else {
        next.push(record)
      }
    }
    if (!progressed) {
      // Corrupt/cyclic legacy linkage must not make history unreadable.
      output.push(...next)
      break
    }
    remaining = next
  }
  return output
}

export class CollectiveHistoryRepository {
  constructor(private readonly db: Database) {}

  recordObservation(input: RecordCollectiveHistoryObservationInput): HrcCollectiveMessageRecord {
    const observedAt = input.observedAt ?? new Date().toISOString()
    const recordJson = JSON.stringify(input.record)
    const existing = this.db
      .query<CollectiveMessageRow, [string]>(
        `SELECT collective_seq, message_id, canonical_record_json,
                canonical_source_node_id, canonical_source_role, canonical_created_at
           FROM collective_history_messages
          WHERE message_id = ?`
      )
      .get(input.record.messageId)

    if (existing === null) {
      execute(
        this.db,
        `INSERT INTO collective_history_messages (
           message_id, canonical_record_json, canonical_source_node_id,
           canonical_source_role, canonical_created_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.record.messageId,
        recordJson,
        input.sourceNodeId,
        input.sourceRole,
        input.record.createdAt,
        observedAt,
        observedAt
      )
    } else {
      if (
        existing.canonical_source_role === 'origin' &&
        input.sourceRole === 'origin' &&
        existing.canonical_source_node_id !== input.sourceNodeId
      ) {
        throw new Error(`conflicting collective-history origins for ${input.record.messageId}`)
      }
      const shouldReplaceCanonical =
        input.sourceRole === 'origin' ||
        (existing.canonical_source_role === 'destination' &&
          input.sourceNodeId.localeCompare(existing.canonical_source_node_id) < 0)
      if (shouldReplaceCanonical) {
        execute(
          this.db,
          `UPDATE collective_history_messages
              SET canonical_record_json = ?,
                  canonical_source_node_id = ?,
                  canonical_source_role = ?,
                  canonical_created_at = ?,
                  updated_at = ?
            WHERE message_id = ?`,
          recordJson,
          input.sourceNodeId,
          input.sourceRole,
          input.record.createdAt,
          observedAt,
          input.record.messageId
        )
      }
    }

    execute(
      this.db,
      `INSERT INTO collective_history_observations (
         message_id, source_node_id, source_message_seq, source_role,
         origin_node_id, accepted_destination_node_id, record_json,
         observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, source_node_id) DO UPDATE SET
         source_message_seq = excluded.source_message_seq,
         source_role = excluded.source_role,
         origin_node_id = excluded.origin_node_id,
         accepted_destination_node_id = excluded.accepted_destination_node_id,
         record_json = excluded.record_json,
         updated_at = excluded.updated_at`,
      input.record.messageId,
      input.sourceNodeId,
      input.record.messageSeq,
      input.sourceRole,
      input.originNodeId,
      input.acceptedDestinationNodeId ?? null,
      recordJson,
      observedAt,
      observedAt
    )

    const records = this.query({ messageId: input.record.messageId }, 'svc')
    const stored = records[0]
    if (stored === undefined) {
      throw new Error(`failed to reload collective history ${input.record.messageId}`)
    }
    return stored
  }

  query(filter: HrcMessageFilter, authorityNodeId: string): HrcCollectiveMessageRecord[] {
    const rows = this.db
      .query<CollectiveMessageRow, []>(
        `SELECT collective_seq, message_id, canonical_record_json,
                canonical_source_node_id, canonical_source_role, canonical_created_at
           FROM collective_history_messages`
      )
      .all()

    let records = rows
      .filter((row) => filter.afterSeq === undefined || row.collective_seq > filter.afterSeq)
      .map((row): HrcCollectiveMessageRecord => {
        const record = JSON.parse(row.canonical_record_json) as HrcMessageRecord
        const observations = this.db
          .query<CollectiveObservationRow, [string]>(
            `SELECT source_node_id, source_message_seq, source_role, origin_node_id,
                    accepted_destination_node_id, record_json, observed_at
               FROM collective_history_observations
              WHERE message_id = ?
              ORDER BY source_node_id`
          )
          .all(row.message_id)
          .map(
            (observation): HrcCollectiveHistoryObservation => ({
              nodeId: observation.source_node_id,
              messageSeq: observation.source_message_seq,
              role: observation.source_role,
              observedAt: observation.observed_at,
              originNodeId: observation.origin_node_id,
              ...(observation.accepted_destination_node_id === null
                ? {}
                : {
                    acceptedDestinationNodeId: observation.accepted_destination_node_id,
                  }),
              execution: (JSON.parse(observation.record_json) as HrcMessageRecord).execution,
            })
          )
        return {
          ...record,
          collectiveSeq: row.collective_seq,
          collectiveHistory: { authorityNodeId, observations },
        }
      })
      .filter((record) => matchesFilter(record, filter))

    records = orderThreadTopologically(records)
    if (filter.order === 'desc') records.reverse()
    if (filter.limit !== undefined) records = records.slice(0, Math.max(0, filter.limit))
    return records
  }

  count(): number {
    return (
      this.db
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM collective_history_messages')
        .get()?.count ?? 0
    )
  }
}

export type CollectiveHistoryReplicationRecord = {
  messageId: string
  sourceNodeId: string
  sourceMessageSeq: number
  sourceRole: CollectiveHistorySourceRole
  originNodeId: string
  acceptedDestinationNodeId?: string | undefined
  record: HrcMessageRecord
  fingerprint: string
  totalAttempts: number
  nextAttemptAt: string
}

type ReplicationRow = {
  message_id: string
  source_node_id: string
  source_message_seq: number
  source_role: CollectiveHistorySourceRole
  origin_node_id: string
  accepted_destination_node_id: string | null
  record_json: string
  record_fingerprint: string
  total_attempts: number
  next_attempt_at: string
}

function mapReplicationRow(row: ReplicationRow): CollectiveHistoryReplicationRecord {
  return {
    messageId: row.message_id,
    sourceNodeId: row.source_node_id,
    sourceMessageSeq: row.source_message_seq,
    sourceRole: row.source_role,
    originNodeId: row.origin_node_id,
    ...(row.accepted_destination_node_id === null
      ? {}
      : { acceptedDestinationNodeId: row.accepted_destination_node_id }),
    record: JSON.parse(row.record_json) as HrcMessageRecord,
    fingerprint: row.record_fingerprint,
    totalAttempts: row.total_attempts,
    nextAttemptAt: row.next_attempt_at,
  }
}

export class CollectiveHistoryReplicationRepository {
  constructor(private readonly db: Database) {}

  enqueue(input: Omit<RecordCollectiveHistoryObservationInput, 'observedAt'>, now: string): void {
    const recordJson = JSON.stringify(input.record)
    const fingerprint = createHash('sha256').update(recordJson).digest('hex')
    const existing = this.db
      .query<{ record_fingerprint: string }, [string]>(
        `SELECT record_fingerprint
           FROM collective_history_replications
          WHERE message_id = ?`
      )
      .get(input.record.messageId)
    if (existing?.record_fingerprint === fingerprint) return

    execute(
      this.db,
      `INSERT INTO collective_history_replications (
         message_id, source_node_id, source_message_seq, source_role,
         origin_node_id, accepted_destination_node_id, record_json,
         record_fingerprint, state, total_attempts, next_attempt_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         source_node_id = excluded.source_node_id,
         source_message_seq = excluded.source_message_seq,
         source_role = excluded.source_role,
         origin_node_id = excluded.origin_node_id,
         accepted_destination_node_id = excluded.accepted_destination_node_id,
         record_json = excluded.record_json,
         record_fingerprint = excluded.record_fingerprint,
         state = 'pending',
         total_attempts = 0,
         next_attempt_at = excluded.next_attempt_at,
         last_attempt_at = NULL,
         delivered_at = NULL,
         last_error_code = NULL,
         last_error_message = NULL,
         updated_at = excluded.updated_at`,
      input.record.messageId,
      input.sourceNodeId,
      input.record.messageSeq,
      input.sourceRole,
      input.originNodeId,
      input.acceptedDestinationNodeId ?? null,
      recordJson,
      fingerprint,
      now,
      now,
      now
    )
  }

  listDue(now: string, limit = 100): CollectiveHistoryReplicationRecord[] {
    return this.db
      .query<ReplicationRow, [string, number]>(
        `SELECT message_id, source_node_id, source_message_seq, source_role,
                origin_node_id, accepted_destination_node_id, record_json,
                record_fingerprint, total_attempts, next_attempt_at
           FROM collective_history_replications
          WHERE state = 'pending' AND next_attempt_at <= ?
          ORDER BY source_message_seq, message_id
          LIMIT ?`
      )
      .all(now, limit)
      .map(mapReplicationRow)
  }

  markDelivered(messageId: string, fingerprint: string, now: string): boolean {
    const result = this.db
      .query<unknown, [string, string, string, string, string]>(
        `UPDATE collective_history_replications
            SET state = 'delivered',
                total_attempts = total_attempts + 1,
                last_attempt_at = ?,
                delivered_at = ?,
                last_error_code = NULL,
                last_error_message = NULL,
                updated_at = ?
          WHERE message_id = ? AND record_fingerprint = ?`
      )
      .run(now, now, now, messageId, fingerprint)
    return result.changes === 1
  }

  scheduleRetry(input: {
    messageId: string
    fingerprint: string
    now: string
    nextAttemptAt: string
    errorCode: string
    errorMessage: string
  }): boolean {
    const result = this.db
      .query<unknown, [string, string, string, string, string, string, string]>(
        `UPDATE collective_history_replications
            SET state = 'pending',
                total_attempts = total_attempts + 1,
                last_attempt_at = ?,
                next_attempt_at = ?,
                last_error_code = ?,
                last_error_message = ?,
                updated_at = ?
          WHERE message_id = ? AND record_fingerprint = ?`
      )
      .run(
        input.now,
        input.nextAttemptAt,
        input.errorCode,
        input.errorMessage,
        input.now,
        input.messageId,
        input.fingerprint
      )
    return result.changes === 1
  }

  pendingCount(): number {
    return (
      this.db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
             FROM collective_history_replications
            WHERE state = 'pending'`
        )
        .get()?.count ?? 0
    )
  }
}
