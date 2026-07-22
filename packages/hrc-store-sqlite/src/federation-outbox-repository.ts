import type { Database } from 'bun:sqlite'
import type {
  FederationMessageEnvelope,
  FederationOutboxDeliveryRecord,
  FederationOutboxError,
  FederationOutboxState,
  FederationPendingMessageEnvelope,
  FederationRemoteEstablishRequest,
} from 'hrc-core'

export type { FederationOutboxDeliveryRecord, FederationOutboxState } from 'hrc-core'

export type EnqueueFederationOutboxInput = {
  deliveryId: string
  messageId: string
  peerNodeId: string
  envelope: FederationMessageEnvelope
  now: string
}

export type EnqueueFederationEstablishingOutboxInput = {
  deliveryId: string
  messageId: string
  peerNodeId: string
  establish: FederationRemoteEstablishRequest
  envelope: FederationPendingMessageEnvelope
  now: string
}

export type ScheduleFederationOutboxRetryInput = {
  deliveryId: string
  state: 'retry_scheduled' | 'peer_unreachable'
  nextAttemptAt: string
  attemptedAt: string
  errorCode: string
  errorMessage: string
  structuredErrorCode?: string | undefined
  errorReason?: string | undefined
  retryable?: boolean | undefined
  homeNodeId?: string | undefined
}

export type MarkFederationOutboxDeadLetterInput = {
  deliveryId: string
  attemptedAt: string
  errorCode: string
  errorMessage: string
  structuredErrorCode?: string | undefined
  errorReason?: string | undefined
  retryable?: boolean | undefined
  homeNodeId?: string | undefined
}

type OutboxRow = {
  delivery_id: string
  message_id: string
  peer_node_id: string
  envelope_json: string
  state: FederationOutboxState
  total_attempts: number
  cycle_attempts: number
  replay_count: number
  retry_window_started_at: string
  next_attempt_at: string | null
  last_attempt_at: string | null
  delivered_at: string | null
  dead_lettered_at: string | null
  last_error_code: string | null
  last_error_message: string | null
  created_at: string
  updated_at: string
}

const OUTBOX_COLUMNS = `
  delivery_id, message_id, peer_node_id, envelope_json, state,
  total_attempts, cycle_attempts, replay_count, retry_window_started_at,
  next_attempt_at, last_attempt_at, delivered_at, dead_lettered_at,
  last_error_code, last_error_message, created_at, updated_at
`

type StoredOutboxPayload =
  | {
      stage: 'establishing'
      establish: FederationRemoteEstablishRequest
      envelope: FederationPendingMessageEnvelope
      lastError?: FederationOutboxError | undefined
    }
  | {
      stage: 'delivering'
      envelope: FederationMessageEnvelope
      lastError?: FederationOutboxError | undefined
    }

function payloadFor(record: FederationOutboxDeliveryRecord): StoredOutboxPayload {
  return record.stage === 'establishing'
    ? { stage: record.stage, establish: record.establish, envelope: record.envelope }
    : { stage: record.stage, envelope: record.envelope }
}

function errorFor(input: {
  errorCode: string
  errorMessage: string
  structuredErrorCode?: string | undefined
  errorReason?: string | undefined
  retryable?: boolean | undefined
  homeNodeId?: string | undefined
}): FederationOutboxError | undefined {
  if (
    input.errorReason === undefined &&
    input.retryable === undefined &&
    input.homeNodeId === undefined
  ) {
    return undefined
  }
  return {
    code: input.structuredErrorCode ?? input.errorCode,
    message: input.errorMessage,
    ...(input.errorReason === undefined ? {} : { reason: input.errorReason }),
    retryable: input.retryable === true,
    ...(input.homeNodeId === undefined ? {} : { homeNodeId: input.homeNodeId }),
  }
}

function parsePayload(raw: string): StoredOutboxPayload {
  const parsed = JSON.parse(raw) as StoredOutboxPayload | FederationMessageEnvelope
  if ('stage' in parsed) return parsed
  // Rows written before staged establishment are already delivery-fenced.
  return { stage: 'delivering', envelope: parsed }
}

function mapRow(row: OutboxRow): FederationOutboxDeliveryRecord {
  const payload = parsePayload(row.envelope_json)
  return {
    deliveryId: row.delivery_id,
    messageId: row.message_id,
    peerNodeId: row.peer_node_id,
    ...payload,
    state: row.state,
    totalAttempts: row.total_attempts,
    cycleAttempts: row.cycle_attempts,
    replayCount: row.replay_count,
    retryWindowStartedAt: row.retry_window_started_at,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    lastAttemptAt: row.last_attempt_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    deadLetteredAt: row.dead_lettered_at ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined,
    ...(payload.lastError === undefined ? {} : { lastError: payload.lastError }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} is required`)
}

function requireTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`)
}

export class FederationOutboxRepository {
  constructor(private readonly db: Database) {}

  enqueue(input: EnqueueFederationOutboxInput): FederationOutboxDeliveryRecord {
    requireText(input.deliveryId, 'deliveryId')
    requireText(input.messageId, 'messageId')
    requireText(input.peerNodeId, 'peerNodeId')
    requireTimestamp(input.now, 'now')
    if (input.envelope.messageId !== input.messageId) {
      throw new Error('outbox envelope messageId must match its owning message')
    }

    const insert = this.db.transaction(() => {
      this.db
        .query<unknown, [string, string, string, string, string, string, string, string]>(
          `INSERT INTO federation_outbox_deliveries (
             delivery_id, message_id, peer_node_id, envelope_json, state,
             total_attempts, cycle_attempts, replay_count,
             retry_window_started_at, next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?, ?, ?)`
        )
        .run(
          input.deliveryId,
          input.messageId,
          input.peerNodeId,
          JSON.stringify({ stage: 'delivering', envelope: input.envelope }),
          input.now,
          input.now,
          input.now,
          input.now
        )
      return this.require(input.deliveryId)
    })
    return insert()
  }

  enqueueEstablishing(
    input: EnqueueFederationEstablishingOutboxInput
  ): FederationOutboxDeliveryRecord {
    requireText(input.deliveryId, 'deliveryId')
    requireText(input.messageId, 'messageId')
    requireText(input.peerNodeId, 'peerNodeId')
    requireText(input.establish.scopeRef, 'establish.scopeRef')
    requireText(input.establish.correlationId, 'establish.correlationId')
    requireTimestamp(input.now, 'now')
    if (input.envelope.messageId !== input.messageId) {
      throw new Error('outbox envelope messageId must match its owning message')
    }

    const insert = this.db.transaction(() => {
      this.db
        .query<unknown, [string, string, string, string, string, string, string, string]>(
          `INSERT INTO federation_outbox_deliveries (
             delivery_id, message_id, peer_node_id, envelope_json, state,
             total_attempts, cycle_attempts, replay_count,
             retry_window_started_at, next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?, ?, ?)`
        )
        .run(
          input.deliveryId,
          input.messageId,
          input.peerNodeId,
          JSON.stringify({
            stage: 'establishing',
            establish: input.establish,
            envelope: input.envelope,
          }),
          input.now,
          input.now,
          input.now,
          input.now
        )
      return this.require(input.deliveryId)
    })
    return insert()
  }

  advanceToDelivery(
    deliveryId: string,
    peerNodeId: string,
    envelope: FederationMessageEnvelope,
    now: string
  ): FederationOutboxDeliveryRecord {
    requireText(peerNodeId, 'peerNodeId')
    requireTimestamp(now, 'now')
    const existing = this.require(deliveryId)
    this.assertMutable(deliveryId)
    if (existing.stage !== 'establishing') {
      throw new Error(`federation delivery ${deliveryId} is already in ${existing.stage}`)
    }
    if (envelope.messageId !== existing.messageId) {
      throw new Error('advanced envelope messageId must not change')
    }
    this.db
      .query<unknown, [string, string, string, string]>(
        `UPDATE federation_outbox_deliveries
            SET peer_node_id = ?, envelope_json = ?, updated_at = ?
          WHERE delivery_id = ?`
      )
      .run(peerNodeId, JSON.stringify({ stage: 'delivering', envelope }), now, deliveryId)
    return this.require(deliveryId)
  }

  get(deliveryId: string): FederationOutboxDeliveryRecord | undefined {
    const row = this.db
      .query<OutboxRow, [string]>(
        `SELECT ${OUTBOX_COLUMNS} FROM federation_outbox_deliveries WHERE delivery_id = ?`
      )
      .get(deliveryId)
    return row === null ? undefined : mapRow(row)
  }

  getByMessageId(messageId: string): FederationOutboxDeliveryRecord | undefined {
    const row = this.db
      .query<OutboxRow, [string]>(
        `SELECT ${OUTBOX_COLUMNS} FROM federation_outbox_deliveries WHERE message_id = ?`
      )
      .get(messageId)
    return row === null ? undefined : mapRow(row)
  }

  list(): FederationOutboxDeliveryRecord[] {
    return this.db
      .query<OutboxRow, []>(
        `SELECT ${OUTBOX_COLUMNS} FROM federation_outbox_deliveries ORDER BY created_at, delivery_id`
      )
      .all()
      .map(mapRow)
  }

  listDue(now: string, limit = 100): FederationOutboxDeliveryRecord[] {
    requireTimestamp(now, 'now')
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('limit must be a positive integer')
    return this.db
      .query<OutboxRow, [string, number]>(
        `SELECT ${OUTBOX_COLUMNS}
           FROM federation_outbox_deliveries
          WHERE state IN ('pending', 'retry_scheduled', 'peer_unreachable')
            AND next_attempt_at <= ?
          ORDER BY next_attempt_at, created_at, delivery_id
          LIMIT ?`
      )
      .all(now, limit)
      .map(mapRow)
  }

  retarget(
    deliveryId: string,
    peerNodeId: string,
    envelope: FederationMessageEnvelope,
    now: string
  ): FederationOutboxDeliveryRecord {
    requireText(peerNodeId, 'peerNodeId')
    requireTimestamp(now, 'now')
    const existing = this.require(deliveryId)
    this.assertMutable(deliveryId)
    if (existing.stage !== 'delivering') {
      throw new Error(`cannot retarget federation delivery ${deliveryId} while establishing`)
    }
    if (envelope.messageId !== existing.messageId) {
      throw new Error('retargeted envelope messageId must not change')
    }
    this.db
      .query<unknown, [string, string, string, string]>(
        `UPDATE federation_outbox_deliveries
            SET peer_node_id = ?, envelope_json = ?, updated_at = ?
          WHERE delivery_id = ?`
      )
      .run(peerNodeId, JSON.stringify({ stage: 'delivering', envelope }), now, deliveryId)
    return this.require(deliveryId)
  }

  scheduleRetry(input: ScheduleFederationOutboxRetryInput): FederationOutboxDeliveryRecord {
    requireTimestamp(input.attemptedAt, 'attemptedAt')
    requireTimestamp(input.nextAttemptAt, 'nextAttemptAt')
    this.assertMutable(input.deliveryId)
    const existing = this.require(input.deliveryId)
    const structuredError = errorFor(input)
    const payload = {
      ...payloadFor(existing),
      ...(structuredError === undefined ? {} : { lastError: structuredError }),
    }
    this.db
      .query<
        unknown,
        [FederationOutboxState, string, string, string, string, string, string, string]
      >(
        `UPDATE federation_outbox_deliveries
            SET state = ?, total_attempts = total_attempts + 1,
                cycle_attempts = cycle_attempts + 1, next_attempt_at = ?,
                last_attempt_at = ?, last_error_code = ?, last_error_message = ?,
                envelope_json = ?, delivered_at = NULL, dead_lettered_at = NULL, updated_at = ?
          WHERE delivery_id = ?`
      )
      .run(
        input.state,
        input.nextAttemptAt,
        input.attemptedAt,
        input.errorCode,
        input.errorMessage,
        JSON.stringify(payload),
        input.attemptedAt,
        input.deliveryId
      )
    return this.require(input.deliveryId)
  }

  markDelivered(deliveryId: string, deliveredAt: string): FederationOutboxDeliveryRecord {
    requireTimestamp(deliveredAt, 'deliveredAt')
    this.assertMutable(deliveryId)
    const payload = payloadFor(this.require(deliveryId))
    this.db
      .query<unknown, [string, string, string, string, string]>(
        `UPDATE federation_outbox_deliveries
            SET state = 'delivered', total_attempts = total_attempts + 1,
                cycle_attempts = cycle_attempts + 1, next_attempt_at = NULL,
                last_attempt_at = ?, delivered_at = ?, dead_lettered_at = NULL,
                last_error_code = NULL, last_error_message = NULL,
                envelope_json = ?, updated_at = ?
          WHERE delivery_id = ?`
      )
      .run(deliveredAt, deliveredAt, JSON.stringify(payload), deliveredAt, deliveryId)
    return this.require(deliveryId)
  }

  markDeadLetter(input: MarkFederationOutboxDeadLetterInput): FederationOutboxDeliveryRecord {
    requireTimestamp(input.attemptedAt, 'attemptedAt')
    this.assertMutable(input.deliveryId)
    const existing = this.require(input.deliveryId)
    const structuredError = errorFor(input)
    const payload = {
      ...payloadFor(existing),
      ...(structuredError === undefined ? {} : { lastError: structuredError }),
    }
    this.db
      .query<unknown, [string, string, string, string, string, string, string]>(
        `UPDATE federation_outbox_deliveries
            SET state = 'dead_letter', total_attempts = total_attempts + 1,
                cycle_attempts = cycle_attempts + 1, next_attempt_at = NULL,
                last_attempt_at = ?, dead_lettered_at = ?,
                last_error_code = ?, last_error_message = ?, envelope_json = ?, updated_at = ?
          WHERE delivery_id = ?`
      )
      .run(
        input.attemptedAt,
        input.attemptedAt,
        input.errorCode,
        input.errorMessage,
        JSON.stringify(payload),
        input.attemptedAt,
        input.deliveryId
      )
    return this.require(input.deliveryId)
  }

  replay(deliveryId: string, now: string): FederationOutboxDeliveryRecord {
    requireTimestamp(now, 'now')
    const existing = this.require(deliveryId)
    if (existing.state !== 'dead_letter') {
      throw new Error(`delivery ${deliveryId} is not dead-lettered`)
    }
    const payload = payloadFor(existing)
    this.db
      .query<unknown, [string, string, string, string, string]>(
        `UPDATE federation_outbox_deliveries
            SET state = 'pending', cycle_attempts = 0, replay_count = replay_count + 1,
                retry_window_started_at = ?, next_attempt_at = ?, dead_lettered_at = NULL,
                last_error_code = NULL, last_error_message = NULL,
                envelope_json = ?, updated_at = ?
          WHERE delivery_id = ?`
      )
      .run(now, now, JSON.stringify(payload), now, deliveryId)
    return this.require(deliveryId)
  }

  /**
   * Permanently discard an exhausted delivery. Active rows cannot be dropped:
   * a send may already be in flight, while dead-letter rows are terminal for
   * automatic delivery and therefore safe to remove deliberately.
   */
  dropDeadLetter(deliveryId: string): FederationOutboxDeliveryRecord {
    const existing = this.require(deliveryId)
    if (existing.state !== 'dead_letter') {
      throw new Error(`delivery ${deliveryId} is not dead-lettered`)
    }
    this.db
      .query<unknown, [string]>(
        `DELETE FROM federation_outbox_deliveries
          WHERE delivery_id = ? AND state = 'dead_letter'`
      )
      .run(deliveryId)
    return existing
  }

  private require(deliveryId: string): FederationOutboxDeliveryRecord {
    const record = this.get(deliveryId)
    if (record === undefined) throw new Error(`unknown federation delivery ${deliveryId}`)
    return record
  }

  private assertMutable(deliveryId: string): void {
    const record = this.require(deliveryId)
    if (record.state === 'delivered' || record.state === 'dead_letter') {
      throw new Error(`federation delivery ${deliveryId} is terminal (${record.state})`)
    }
  }
}
