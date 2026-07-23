import { randomUUID } from 'node:crypto'

import type { Database } from 'bun:sqlite'
import type {
  HrcMailActor,
  HrcMailDispositionResult,
  HrcMailEnvelope,
  HrcMailEnvelopeState,
  HrcMailIngressPath,
  HrcMailListRequest,
  HrcMailReceipt,
  HrcMailSendRequest,
  HrcMailSendResponse,
} from 'hrc-core'

import {
  canonicalHrcMailJson,
  compileHrcMailReplySchema,
  fingerprintHrcMailJson,
  validateHrcMailReply,
} from './reply-schema.js'

type EnvelopeRow = {
  envelope_seq: number
  envelope_id: string
  ingress_id: string
  from_kind: HrcMailActor['kind']
  from_ref: string
  target_session_ref: string
  payload_kind: HrcMailEnvelope['payload']['kind']
  body: string
  metadata_json: string | null
  reply_schema_json: string | null
  state: HrcMailEnvelopeState
  round_count: number
  response_present: number
  response_json: string | null
  response_fingerprint: string | null
  defer_reason: string | null
  retry_after_ms: number | null
  retry_at: string | null
  presented_at: string | null
  acked_at: string | null
  deferred_at: string | null
  dead_at: string | null
  terminal_actor_kind: HrcMailActor['kind'] | null
  terminal_actor_ref: string | null
  created_at: string
  updated_at: string
}

type ReceiptRow = {
  ingress_id: string
  path_choice: HrcMailIngressPath
  envelope_id: string
  request_fingerprint: string
  receipt_json: string
  created_at: string
}

const ENVELOPE_COLUMNS = `
  envelope_seq, envelope_id, ingress_id, from_kind, from_ref, target_session_ref,
  payload_kind, body, metadata_json, reply_schema_json, state, round_count,
  response_present, response_json, response_fingerprint, defer_reason, retry_after_ms,
  retry_at, presented_at, acked_at, deferred_at, dead_at,
  terminal_actor_kind, terminal_actor_ref, created_at, updated_at
`

export type HrcMailRepositoryErrorCode =
  | 'unknown_envelope'
  | 'target_mismatch'
  | 'invalid_transition'
  | 'conflicting_disposition'
  | 'invalid_reply_schema'
  | 'invalid_reply'
  | 'batch_schema_ack'
  | 'ingress_conflict'

export class HrcMailRepositoryError extends Error {
  constructor(
    readonly code: HrcMailRepositoryErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'HrcMailRepositoryError'
  }
}

export type CreateHrcMailEnvelopeInput = HrcMailSendRequest & {
  envelopeId?: string | undefined
}

export type AckHrcMailEnvelopeInput = {
  actor: HrcMailActor
  envelopeIds: string[]
  response?: unknown
}

export type DeferHrcMailEnvelopeInput = {
  actor: HrcMailActor
  envelopeId: string
  reason: string
  retryAfterMs?: number | undefined
}

function actorRef(actor: HrcMailActor): string {
  return actor.kind === 'scope' ? actor.sessionRef : actor.principal
}

function mapActor(kind: HrcMailActor['kind'], ref: string): HrcMailActor {
  return kind === 'scope'
    ? { kind: 'scope', sessionRef: ref }
    : { kind: 'operator', principal: ref }
}

function parseOptionalJson(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value)
}

function mapEnvelope(row: EnvelopeRow): HrcMailEnvelope {
  return {
    envelopeId: row.envelope_id,
    ingressId: row.ingress_id,
    from: mapActor(row.from_kind, row.from_ref),
    targetSessionRef: row.target_session_ref,
    payload: {
      kind: row.payload_kind,
      body: row.body,
      ...(row.metadata_json === null
        ? {}
        : { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }),
    },
    ...(row.reply_schema_json === null
      ? {}
      : { replySchema: JSON.parse(row.reply_schema_json) as Record<string, unknown> }),
    state: row.state,
    roundCount: row.round_count,
    ...(row.response_present === 1 ? { response: parseOptionalJson(row.response_json) } : {}),
    ...(row.defer_reason === null ? {} : { deferReason: row.defer_reason }),
    ...(row.retry_at === null ? {} : { retryAt: row.retry_at }),
    ...(row.presented_at === null ? {} : { presentedAt: row.presented_at }),
    ...(row.acked_at === null ? {} : { ackedAt: row.acked_at }),
    ...(row.deferred_at === null ? {} : { deferredAt: row.deferred_at }),
    ...(row.dead_at === null ? {} : { deadAt: row.dead_at }),
    ...(row.terminal_actor_kind === null || row.terminal_actor_ref === null
      ? {}
      : { terminalActor: mapActor(row.terminal_actor_kind, row.terminal_actor_ref) }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapReceipt(row: ReceiptRow): HrcMailReceipt {
  return JSON.parse(row.receipt_json) as HrcMailReceipt
}

function assertNonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new HrcMailRepositoryError('invalid_transition', `${field} must not be empty`, { field })
  }
  return normalized
}

function assertNonBlankText(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new HrcMailRepositoryError('invalid_transition', `${field} must not be empty`, { field })
  }
  return value
}

function assertAuthority(envelope: HrcMailEnvelope, actor: HrcMailActor): void {
  if (actor.kind === 'operator') return
  if (actor.sessionRef !== envelope.targetSessionRef) {
    throw new HrcMailRepositoryError(
      'target_mismatch',
      `envelope ${envelope.envelopeId} targets ${envelope.targetSessionRef}, not ${actor.sessionRef}`,
      {
        envelopeId: envelope.envelopeId,
        targetSessionRef: envelope.targetSessionRef,
        claimedSessionRef: actor.sessionRef,
      }
    )
  }
}

function requestFingerprint(input: HrcMailSendRequest): string {
  return fingerprintHrcMailJson({
    from: input.from,
    targetSessionRef: input.targetSessionRef,
    payload: input.payload,
    ...(input.replySchema === undefined ? {} : { replySchema: input.replySchema }),
  })
}

export class HrcMailEnvelopeRepository {
  constructor(private readonly db: Database) {}

  get(envelopeId: string): HrcMailEnvelope | undefined {
    const row = this.db
      .query<EnvelopeRow, [string]>(
        `SELECT ${ENVELOPE_COLUMNS} FROM hrcmail_envelopes WHERE envelope_id = ?`
      )
      .get(envelopeId)
    return row === null ? undefined : mapEnvelope(row)
  }

  require(envelopeId: string): HrcMailEnvelope {
    const envelope = this.get(envelopeId)
    if (!envelope) {
      throw new HrcMailRepositoryError(
        'unknown_envelope',
        `unknown mail envelope "${envelopeId}"`,
        { envelopeId }
      )
    }
    return envelope
  }

  getIngressReceipt(ingressId: string): HrcMailReceipt | undefined {
    const row = this.db
      .query<ReceiptRow, [string]>(
        `SELECT ingress_id, path_choice, envelope_id, request_fingerprint, receipt_json, created_at
         FROM hrcmail_ingress_receipts
         WHERE ingress_id = ?`
      )
      .get(ingressId)
    return row === null ? undefined : mapReceipt(row)
  }

  create(input: CreateHrcMailEnvelopeInput): HrcMailSendResponse {
    const ingressId = assertNonEmpty(input.ingressId, 'ingressId')
    const targetSessionRef = assertNonEmpty(input.targetSessionRef, 'targetSessionRef')
    const body = assertNonBlankText(input.payload.body, 'payload.body')
    const fingerprint = requestFingerprint(input)

    if (input.replySchema !== undefined) {
      try {
        compileHrcMailReplySchema(input.replySchema)
      } catch (error) {
        throw new HrcMailRepositoryError(
          'invalid_reply_schema',
          error instanceof Error ? error.message : String(error),
          { ingressId }
        )
      }
    }

    return this.db
      .transaction(() => {
        const existingReceipt = this.db
          .query<ReceiptRow, [string]>(
            `SELECT ingress_id, path_choice, envelope_id, request_fingerprint, receipt_json, created_at
             FROM hrcmail_ingress_receipts
             WHERE ingress_id = ?`
          )
          .get(ingressId)
        if (existingReceipt !== null) {
          if (existingReceipt.request_fingerprint !== fingerprint) {
            throw new HrcMailRepositoryError(
              'ingress_conflict',
              `ingress id "${ingressId}" was already used with different mail content`,
              { ingressId, envelopeId: existingReceipt.envelope_id }
            )
          }
          if (input.materializationIntent !== undefined && existingReceipt.path_choice === 'mail') {
            this.db
              .query(
                `UPDATE hrcmail_envelopes
                 SET materialization_intent_json =
                       COALESCE(materialization_intent_json, ?)
                 WHERE envelope_id = ?`
              )
              .run(canonicalHrcMailJson(input.materializationIntent), existingReceipt.envelope_id)
          }
          return {
            receipt: mapReceipt(existingReceipt),
            envelope: this.require(existingReceipt.envelope_id),
          }
        }

        const now = new Date().toISOString()
        const envelopeId = input.envelopeId ?? `mail-${randomUUID()}`
        this.db
          .query(
            `INSERT INTO hrcmail_envelopes (
              envelope_id, ingress_id, from_kind, from_ref, target_session_ref,
              payload_kind, body, metadata_json, reply_schema_json, state,
              materialization_intent_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
          )
          .run(
            envelopeId,
            ingressId,
            input.from.kind,
            actorRef(input.from),
            targetSessionRef,
            input.payload.kind,
            body,
            input.payload.metadata === undefined
              ? null
              : canonicalHrcMailJson(input.payload.metadata),
            input.replySchema === undefined ? null : canonicalHrcMailJson(input.replySchema),
            input.materializationIntent === undefined
              ? null
              : canonicalHrcMailJson(input.materializationIntent),
            now,
            now
          )

        const inserted = this.db
          .query<{ envelope_seq: number }, [string]>(
            'SELECT envelope_seq FROM hrcmail_envelopes WHERE envelope_id = ?'
          )
          .get(envelopeId)
        if (inserted !== null) {
          this.db
            .query(
              `UPDATE hrcmail_stop_refusals
               SET observed_envelope_seq = MAX(observed_envelope_seq, ?),
                   refusal_count = 0,
                   updated_at = ?
               WHERE target_session_ref = ?`
            )
            .run(inserted.envelope_seq, now, targetSessionRef)
        }

        const receipt: HrcMailReceipt = {
          ingressId,
          envelopeId,
          path: 'mail',
          createdAt: now,
        }
        this.db
          .query(
            `INSERT INTO hrcmail_ingress_receipts (
              ingress_id, path_choice, envelope_id, request_fingerprint, receipt_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(ingressId, 'mail', envelopeId, fingerprint, canonicalHrcMailJson(receipt), now)

        return { receipt, envelope: this.require(envelopeId) }
      })
      .immediate() as HrcMailSendResponse
  }

  inbox(actor: HrcMailActor, targetSessionRef: string): HrcMailEnvelope[] {
    const target = assertNonEmpty(targetSessionRef, 'targetSessionRef')
    if (actor.kind === 'scope' && actor.sessionRef !== target) {
      throw new HrcMailRepositoryError(
        'target_mismatch',
        `mailbox ${target} cannot be read as ${actor.sessionRef}`,
        { targetSessionRef: target, claimedSessionRef: actor.sessionRef }
      )
    }

    return this.db
      .query<EnvelopeRow, [string]>(
        `SELECT ${ENVELOPE_COLUMNS}
         FROM hrcmail_envelopes
         WHERE target_session_ref = ? AND state IN ('pending', 'presented')
         ORDER BY envelope_seq ASC`
      )
      .all(target)
      .map(mapEnvelope)
  }

  list(filter: HrcMailListRequest = {}): HrcMailEnvelope[] {
    const where: string[] = []
    const values: Array<string | number> = []
    if (filter.targetSessionRef !== undefined) {
      where.push('target_session_ref = ?')
      values.push(filter.targetSessionRef)
    }
    if (filter.state !== undefined) {
      where.push('state = ?')
      values.push(filter.state)
    } else if (filter.dead === true) {
      where.push("state = 'dead'")
    }

    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000)
    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
    return this.db
      .query<EnvelopeRow, Array<string | number>>(
        `SELECT ${ENVELOPE_COLUMNS}
         FROM hrcmail_envelopes
         ${clause}
         ORDER BY envelope_seq DESC
         LIMIT ?`
      )
      .all(...values, limit)
      .map(mapEnvelope)
  }

  presentPendingForTarget(targetSessionRef: string, limit = 100): HrcMailEnvelope[] {
    const target = assertNonEmpty(targetSessionRef, 'targetSessionRef')
    return this.db
      .transaction(() => {
        const pending = this.db
          .query<
            { envelope_id: string; payload_kind: HrcMailEnvelope['payload']['kind'] },
            [string, number]
          >(
            `SELECT envelope_id, payload_kind
             FROM hrcmail_envelopes
             WHERE target_session_ref = ? AND state = 'pending'
             ORDER BY envelope_seq ASC
             LIMIT ?`
          )
          .all(target, Math.min(Math.max(limit, 1), 1000))
        const now = new Date().toISOString()

        for (const row of pending) {
          if (row.payload_kind === 'conversational') {
            this.db
              .query(
                `UPDATE hrcmail_envelopes
                 SET state = 'acked', presented_at = ?, acked_at = ?, updated_at = ?
                 WHERE envelope_id = ? AND state = 'pending'`
              )
              .run(now, now, now, row.envelope_id)
          } else {
            this.db
              .query(
                `UPDATE hrcmail_envelopes
                 SET state = 'presented', presented_at = ?, updated_at = ?
                 WHERE envelope_id = ? AND state = 'pending'`
              )
              .run(now, now, row.envelope_id)
          }
        }

        return pending.map((row) => this.require(row.envelope_id))
      })
      .immediate() as HrcMailEnvelope[]
  }

  ack(input: AckHrcMailEnvelopeInput): HrcMailDispositionResult[] {
    if (input.envelopeIds.length === 0) {
      throw new HrcMailRepositoryError('invalid_transition', 'at least one envelope id is required')
    }
    const uniqueIds = [...new Set(input.envelopeIds)]

    return this.db
      .transaction(() => {
        const envelopes = uniqueIds.map((id) => this.require(id))
        if (
          envelopes.length > 1 &&
          envelopes.some((envelope) => envelope.replySchema !== undefined)
        ) {
          throw new HrcMailRepositoryError(
            'batch_schema_ack',
            'schema-bound envelopes must be acknowledged one at a time'
          )
        }
        return envelopes.map((envelope) => this.ackOne(envelope, input.actor, input.response))
      })
      .immediate() as HrcMailDispositionResult[]
  }

  private ackOne(
    envelope: HrcMailEnvelope,
    actor: HrcMailActor,
    response: unknown
  ): HrcMailDispositionResult {
    assertAuthority(envelope, actor)
    const responsePresent = response !== undefined
    const responseFingerprint = responsePresent ? fingerprintHrcMailJson(response) : null

    if (envelope.state === 'acked') {
      const row = this.requireRow(envelope.envelopeId)
      if (
        row.response_present === (responsePresent ? 1 : 0) &&
        row.response_fingerprint === responseFingerprint
      ) {
        return { outcome: 'idempotent', envelope }
      }
      throw new HrcMailRepositoryError(
        'conflicting_disposition',
        `envelope ${envelope.envelopeId} is already acknowledged with a different response`,
        { envelopeId: envelope.envelopeId }
      )
    }

    if (envelope.state !== 'presented' && envelope.state !== 'deferred') {
      throw new HrcMailRepositoryError(
        'invalid_transition',
        `cannot acknowledge ${envelope.state} envelope ${envelope.envelopeId}`,
        { envelopeId: envelope.envelopeId, state: envelope.state }
      )
    }

    if (envelope.replySchema !== undefined) {
      if (!responsePresent) {
        throw new HrcMailRepositoryError(
          'invalid_reply',
          `envelope ${envelope.envelopeId} requires a response`,
          { envelopeId: envelope.envelopeId }
        )
      }
      const result = validateHrcMailReply(envelope.replySchema, response)
      if (!result.valid) {
        const validationSummary = result.errors
          .map((error) => `${error.instancePath || '/'} ${error.message}`)
          .join('; ')
        throw new HrcMailRepositoryError(
          'invalid_reply',
          `response does not satisfy envelope ${envelope.envelopeId} reply schema: ${validationSummary}`,
          { envelopeId: envelope.envelopeId, validationErrors: result.errors }
        )
      }
    }

    const now = new Date().toISOString()
    const changed = this.db
      .query(
        `UPDATE hrcmail_envelopes
         SET state = 'acked', response_present = ?, response_json = ?,
             response_fingerprint = ?, acked_at = ?,
             terminal_actor_kind = ?, terminal_actor_ref = ?, updated_at = ?
         WHERE envelope_id = ? AND state IN ('presented', 'deferred')`
      )
      .run(
        responsePresent ? 1 : 0,
        responsePresent ? canonicalHrcMailJson(response) : null,
        responseFingerprint,
        now,
        actor.kind,
        actorRef(actor),
        now,
        envelope.envelopeId
      )
    if (changed.changes !== 1) {
      return this.ackOne(this.require(envelope.envelopeId), actor, response)
    }
    return { outcome: 'applied', envelope: this.require(envelope.envelopeId) }
  }

  defer(input: DeferHrcMailEnvelopeInput): HrcMailDispositionResult {
    const reason = assertNonEmpty(input.reason, 'reason')
    if (
      input.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(input.retryAfterMs) || input.retryAfterMs <= 0)
    ) {
      throw new HrcMailRepositoryError(
        'invalid_transition',
        'retryAfterMs must be a positive integer',
        { retryAfterMs: input.retryAfterMs }
      )
    }

    return this.db
      .transaction(() => {
        const envelope = this.require(input.envelopeId)
        assertAuthority(envelope, input.actor)
        const row = this.requireRow(input.envelopeId)

        if (envelope.state === 'deferred') {
          if (row.defer_reason === reason && row.retry_after_ms === (input.retryAfterMs ?? null)) {
            return { outcome: 'idempotent', envelope }
          }
          throw new HrcMailRepositoryError(
            'conflicting_disposition',
            `envelope ${input.envelopeId} is already deferred with different details`,
            { envelopeId: input.envelopeId }
          )
        }
        if (envelope.state !== 'presented') {
          throw new HrcMailRepositoryError(
            'invalid_transition',
            `cannot defer ${envelope.state} envelope ${input.envelopeId}`,
            { envelopeId: input.envelopeId, state: envelope.state }
          )
        }

        const nowMs = Date.now()
        const now = new Date(nowMs).toISOString()
        const retryAt =
          input.retryAfterMs === undefined
            ? null
            : new Date(nowMs + input.retryAfterMs).toISOString()
        const changed = this.db
          .query(
            `UPDATE hrcmail_envelopes
             SET state = 'deferred', defer_reason = ?, retry_after_ms = ?,
                 retry_at = ?, deferred_at = ?, updated_at = ?
             WHERE envelope_id = ? AND state = 'presented'`
          )
          .run(reason, input.retryAfterMs ?? null, retryAt, now, now, input.envelopeId)
        if (changed.changes !== 1) {
          throw new HrcMailRepositoryError(
            'conflicting_disposition',
            `envelope ${input.envelopeId} changed while defer was being applied`,
            { envelopeId: input.envelopeId }
          )
        }
        return { outcome: 'applied', envelope: this.require(input.envelopeId) }
      })
      .immediate() as HrcMailDispositionResult
  }

  requeueDeferredDue(now = new Date().toISOString()): HrcMailEnvelope[] {
    return this.db
      .transaction(() => {
        const due = this.db
          .query<{ envelope_id: string }, [string]>(
            `SELECT envelope_id
             FROM hrcmail_envelopes
             WHERE state = 'deferred' AND retry_at IS NOT NULL AND retry_at <= ?
             ORDER BY envelope_seq ASC`
          )
          .all(now)
        for (const row of due) {
          this.db
            .query(
              `UPDATE hrcmail_envelopes
               SET state = 'pending', defer_reason = NULL, retry_after_ms = NULL,
                   retry_at = NULL, deferred_at = NULL, updated_at = ?
               WHERE envelope_id = ? AND state = 'deferred' AND retry_at <= ?`
            )
            .run(now, row.envelope_id, now)
        }
        return due.map((row) => this.require(row.envelope_id))
      })
      .immediate() as HrcMailEnvelope[]
  }

  markDead(envelopeId: string): HrcMailEnvelope {
    return this.db
      .transaction(() => {
        const envelope = this.require(envelopeId)
        if (envelope.state === 'dead') return envelope
        if (envelope.state !== 'presented') {
          throw new HrcMailRepositoryError(
            'invalid_transition',
            `cannot dead-letter ${envelope.state} envelope ${envelopeId}`,
            { envelopeId, state: envelope.state }
          )
        }
        const now = new Date().toISOString()
        this.db
          .query(
            `UPDATE hrcmail_envelopes
             SET state = 'dead', dead_at = ?, updated_at = ?
             WHERE envelope_id = ? AND state = 'presented'`
          )
          .run(now, now, envelopeId)
        return this.require(envelopeId)
      })
      .immediate() as HrcMailEnvelope
  }

  private requireRow(envelopeId: string): EnvelopeRow {
    const row = this.db
      .query<EnvelopeRow, [string]>(
        `SELECT ${ENVELOPE_COLUMNS} FROM hrcmail_envelopes WHERE envelope_id = ?`
      )
      .get(envelopeId)
    if (row === null) {
      throw new HrcMailRepositoryError(
        'unknown_envelope',
        `unknown mail envelope "${envelopeId}"`,
        { envelopeId }
      )
    }
    return row
  }
}
