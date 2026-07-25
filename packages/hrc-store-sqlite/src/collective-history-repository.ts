import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

import type {
  HrcCollectiveHistoryObservation,
  HrcCollectiveMessageRecord,
  HrcMessageDeliveryEvidence,
  HrcMessageFilter,
  HrcMessageRecord,
} from 'hrc-core'
import {
  collectiveHistoryAddressRef,
  collectiveHistoryFilterColumnValues,
} from './collective-history-columns.js'
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
  reply_to_message_id: string | null
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

function compareMessageOrder(
  left: HrcCollectiveMessageRecord,
  right: HrcCollectiveMessageRecord
): number {
  const byTime = left.createdAt.localeCompare(right.createdAt)
  return byTime === 0 ? left.messageId.localeCompare(right.messageId) : byTime
}

function deliveryEvidence(record: HrcMessageRecord): HrcMessageDeliveryEvidence | undefined {
  const value = record.metadataJson?.['federationDelivery']
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const outcome = (value as Record<string, unknown>)['outcome']
  const observedAt = (value as Record<string, unknown>)['observedAt']
  if (
    (outcome !== 'runtime_delivery' && outcome !== 'store_only') ||
    typeof observedAt !== 'string'
  ) {
    return undefined
  }
  if (outcome === 'runtime_delivery') return { outcome, observedAt }
  const reason = (value as Record<string, unknown>)['reason']
  return typeof reason === 'string' ? { outcome, reason, observedAt } : undefined
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

/** Window growth per escalation, and the point at which we stop guessing and read everything. */
const WINDOW_GROWTH = 8
const COLLECTIVE_HISTORY_MAX_WINDOW = 4096

/**
 * Every filter pushed into indexed SQL. Before T-06973 only `messageId` and
 * `afterSeq` were here and the rest were re-checked in JS after decoding every
 * row, which is what made a `--limit 20` listing cost a full-table scan.
 */
function collectiveHistoryWhere(filter: HrcMessageFilter): {
  clause: string
  values: Array<string | number>
} {
  const where: string[] = []
  const values: Array<string | number> = []
  const eq = (column: string, value: string | number): void => {
    where.push(`${column} = ?`)
    values.push(value)
  }

  if (filter.messageId !== undefined) eq('message_id', filter.messageId)
  if (filter.afterSeq !== undefined) {
    where.push('collective_seq > ?')
    values.push(filter.afterSeq)
  }
  if (filter.from !== undefined) eq('from_ref', collectiveHistoryAddressRef(filter.from))
  if (filter.to !== undefined) eq('to_ref', collectiveHistoryAddressRef(filter.to))
  if (filter.participant !== undefined) {
    const ref = collectiveHistoryAddressRef(filter.participant)
    where.push('(from_ref = ? OR to_ref = ?)')
    values.push(ref, ref)
  }
  if (filter.thread !== undefined) eq('root_message_id', filter.thread.rootMessageId)
  if (filter.replyToMessageId !== undefined) eq('reply_to_message_id', filter.replyToMessageId)
  if (filter.hostSessionId !== undefined) eq('host_session_id', filter.hostSessionId)
  if (filter.runId !== undefined) eq('run_id', filter.runId)
  if (filter.generation !== undefined) eq('generation', filter.generation)
  if (filter.kinds?.length) {
    where.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`)
    values.push(...filter.kinds)
  }
  if (filter.phases?.length) {
    where.push(`phase IN (${filter.phases.map(() => '?').join(', ')})`)
    values.push(...filter.phases)
  }

  return { clause: where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`, values }
}

/**
 * The `limit` records a caller sees: the head of the ascending collective order,
 * or — for `desc`, which is that order reversed — its tail, flipped.
 */
function pageSlice(
  ordered: HrcCollectiveMessageRecord[],
  limit: number,
  descending: boolean
): HrcCollectiveMessageRecord[] {
  if (!descending) return ordered.slice(0, limit)
  return ordered.slice(Math.max(0, ordered.length - limit)).reverse()
}

/**
 * Did the topological pass move anything within the slice the caller will see?
 * If not, that slice is exactly the first `limit` of the globally ordered set
 * and the page is safe to return; if so, the window is too narrow to justify.
 */
function isPermuted(
  sorted: HrcCollectiveMessageRecord[],
  ordered: HrcCollectiveMessageRecord[],
  limit: number,
  descending: boolean
): boolean {
  const from = descending ? Math.max(0, sorted.length - limit) : 0
  const to = descending ? sorted.length : Math.min(limit, sorted.length)
  for (let index = from; index < to; index += 1) {
    if (sorted[index]?.messageId !== ordered[index]?.messageId) return true
  }
  return false
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
           canonical_source_role, canonical_created_at, created_at, updated_at,
           from_ref, to_ref, root_message_id, reply_to_message_id,
           kind, phase, host_session_id, run_id, generation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.record.messageId,
        recordJson,
        input.sourceNodeId,
        input.sourceRole,
        input.record.createdAt,
        observedAt,
        observedAt,
        ...collectiveHistoryFilterColumnValues(input.record)
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
                  updated_at = ?,
                  from_ref = ?, to_ref = ?, root_message_id = ?, reply_to_message_id = ?,
                  kind = ?, phase = ?, host_session_id = ?, run_id = ?, generation = ?
            WHERE message_id = ?`,
          recordJson,
          input.sourceNodeId,
          input.sourceRole,
          input.record.createdAt,
          observedAt,
          ...collectiveHistoryFilterColumnValues(input.record),
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

  /**
   * One batched observation read for a whole page, replacing the per-message
   * query that made every listing N+1 (T-06973).
   */
  private observationsFor(messageIds: string[]): Map<string, HrcCollectiveHistoryObservation[]> {
    const byMessageId = new Map<string, HrcCollectiveHistoryObservation[]>()
    if (messageIds.length === 0) return byMessageId
    const placeholders = messageIds.map(() => '?').join(', ')
    const rows = this.db
      .query<CollectiveObservationRow & { message_id: string }, string[]>(
        `SELECT message_id, source_node_id, source_message_seq, source_role, origin_node_id,
                accepted_destination_node_id, record_json, observed_at
           FROM collective_history_observations
          WHERE message_id IN (${placeholders})
          ORDER BY message_id, source_node_id`
      )
      .all(...messageIds)
    for (const row of rows) {
      const observedRecord = JSON.parse(row.record_json) as HrcMessageRecord
      const delivery = deliveryEvidence(observedRecord)
      const observation: HrcCollectiveHistoryObservation = {
        nodeId: row.source_node_id,
        messageSeq: row.source_message_seq,
        role: row.source_role,
        observedAt: row.observed_at,
        originNodeId: row.origin_node_id,
        ...(row.accepted_destination_node_id === null
          ? {}
          : { acceptedDestinationNodeId: row.accepted_destination_node_id }),
        execution: observedRecord.execution,
        ...(delivery === undefined ? {} : { delivery }),
      }
      const existing = byMessageId.get(row.message_id)
      if (existing === undefined) byMessageId.set(row.message_id, [observation])
      else existing.push(observation)
    }
    return byMessageId
  }

  private decodeRows(
    rows: CollectiveMessageRow[],
    authorityNodeId: string
  ): HrcCollectiveMessageRecord[] {
    const observationsByMessageId = this.observationsFor(rows.map((row) => row.message_id))
    return rows.map((row): HrcCollectiveMessageRecord => {
      const record = JSON.parse(row.canonical_record_json) as HrcMessageRecord
      return {
        ...record,
        collectiveSeq: row.collective_seq,
        collectiveHistory: {
          authorityNodeId,
          observations: observationsByMessageId.get(row.message_id) ?? [],
        },
      }
    })
  }

  /**
   * Rows matching the filter, ordered by the collective order, optionally taking
   * only the leading (`asc`) or trailing (`desc`) `window` rows.
   */
  private selectRows(filter: HrcMessageFilter, window: number | undefined): CollectiveMessageRow[] {
    const { clause, values } = collectiveHistoryWhere(filter)
    // `desc` output is the ascending order reversed, so its page is the
    // *trailing* window: read it descending, then flip back to ascending.
    const descending = filter.order === 'desc'
    const direction = descending ? 'DESC' : 'ASC'
    const limitClause = window === undefined ? '' : ` LIMIT ${window}`
    const rows = this.db
      .query<CollectiveMessageRow, Array<string | number>>(
        `SELECT collective_seq, message_id, reply_to_message_id, canonical_record_json,
                canonical_source_node_id, canonical_source_role, canonical_created_at
           FROM collective_history_messages${clause}
          ORDER BY canonical_created_at ${direction}, message_id ${direction}${limitClause}`
      )
      .all(...values)
    return descending ? rows.reverse() : rows
  }

  /**
   * Does any row in the window reply to a message that matches the filter but
   * sits outside the window? Such a parent would have delayed its child in the
   * whole-set pass, so the window cannot be trusted — and the permutation check
   * alone cannot see it, because inside the window that child looks parentless.
   */
  private hasParentOutsideWindow(filter: HrcMessageFilter, rows: CollectiveMessageRow[]): boolean {
    const present = new Set(rows.map((row) => row.message_id))
    const parents = [
      ...new Set(
        rows
          .map((row) => row.reply_to_message_id)
          .filter((value): value is string => value !== null && !present.has(value))
      ),
    ]
    if (parents.length === 0) return false
    const { clause, values } = collectiveHistoryWhere(filter)
    const placeholders = parents.map(() => '?').join(', ')
    const joiner = clause === '' ? ' WHERE' : `${clause} AND`
    return (
      this.db
        .query<{ present: number }, Array<string | number>>(
          `SELECT 1 AS present FROM collective_history_messages${joiner} message_id IN (${placeholders}) LIMIT 1`
        )
        .get(...values, ...parents) !== null
    )
  }

  query(filter: HrcMessageFilter, authorityNodeId: string): HrcCollectiveMessageRecord[] {
    const limit = filter.limit === undefined ? undefined : Math.max(0, filter.limit)
    if (limit === 0) return []

    // Unbounded queries (thread reconstruction) keep the whole-set semantics.
    // They are already narrowed by indexed filters, so no scan is unbounded in
    // practice; correctness, not the page bound, is what matters here.
    if (limit === undefined) {
      const records = orderThreadTopologically(
        this.decodeRows(this.selectRows(filter, undefined), authorityNodeId)
      )
      if (filter.order === 'desc') records.reverse()
      return records
    }

    // Bounded page. `orderThreadTopologically` is a whole-set pass, so a page
    // is only provably identical to "topologically order everything, then take
    // limit" when the page's own prefix came back un-permuted: if no page row
    // was delayed behind a parent, each emits in the first round in sorted
    // order, and nothing outside the page can overtake it. When the page IS
    // permuted (a clock-skewed reply ahead of its parent) we widen the window
    // rather than answer from a page whose ordering we cannot justify, and the
    // widening terminates at the full filtered set — the old behaviour.
    let window = limit
    for (;;) {
      const rows = this.selectRows(filter, window)
      const exhaustive = rows.length < window
      const sorted = this.decodeRows(rows, authorityNodeId)
      const ordered = orderThreadTopologically(sorted)
      const page = pageSlice(ordered, limit, filter.order === 'desc')
      const trustworthy =
        !isPermuted(sorted, ordered, limit, filter.order === 'desc') &&
        !this.hasParentOutsideWindow(filter, rows)
      if (exhaustive || trustworthy) {
        return page
      }
      window = window * WINDOW_GROWTH
      if (window >= COLLECTIVE_HISTORY_MAX_WINDOW) {
        const all = orderThreadTopologically(
          this.decodeRows(this.selectRows(filter, undefined), authorityNodeId)
        )
        return pageSlice(all, limit, filter.order === 'desc')
      }
    }
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
