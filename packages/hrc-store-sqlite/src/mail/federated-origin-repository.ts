import type { Database } from 'bun:sqlite'
import type {
  HrcMailEnvelope,
  HrcMailReceipt,
  HrcMailSendRequest,
  HrcMailSendResponse,
} from 'hrc-core'

import { HrcMailRepositoryError, fingerprintHrcMailRequest } from './envelope-repository.js'
import {
  canonicalHrcMailJson,
  compileHrcMailReplySchema,
  fingerprintHrcMailJson,
} from './reply-schema.js'

type FederatedOriginRow = {
  ingress_id: string
  envelope_id: string
  request_message_id: string
  request_fingerprint: string
  envelope_json: string
  disposition_message_id: string | null
  disposition_fingerprint: string | null
  created_at: string
  updated_at: string
}

const COLUMNS = `
  ingress_id, envelope_id, request_message_id, request_fingerprint,
  envelope_json, disposition_message_id, disposition_fingerprint,
  created_at, updated_at
`

export type HrcMailFederatedOriginRecord = {
  ingressId: string
  envelopeId: string
  requestMessageId: string
  requestFingerprint: string
  envelope: HrcMailEnvelope
  dispositionMessageId?: string | undefined
  dispositionFingerprint?: string | undefined
  createdAt: string
  updatedAt: string
}

export type CreateHrcMailFederatedOriginInput = {
  request: HrcMailSendRequest
  envelopeId: string
  requestMessageId: string
}

export type ApplyHrcMailFederatedDispositionInput = {
  requestMessageId: string
  dispositionMessageId: string
  envelope: HrcMailEnvelope
}

function mapRow(row: FederatedOriginRow): HrcMailFederatedOriginRecord {
  return {
    ingressId: row.ingress_id,
    envelopeId: row.envelope_id,
    requestMessageId: row.request_message_id,
    requestFingerprint: row.request_fingerprint,
    envelope: JSON.parse(row.envelope_json) as HrcMailEnvelope,
    ...(row.disposition_message_id === null
      ? {}
      : { dispositionMessageId: row.disposition_message_id }),
    ...(row.disposition_fingerprint === null
      ? {}
      : { dispositionFingerprint: row.disposition_fingerprint }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function terminalProjectionFingerprint(envelope: HrcMailEnvelope): string {
  return fingerprintHrcMailJson({
    state: envelope.state,
    roundCount: envelope.roundCount,
    ...(Object.hasOwn(envelope, 'response') ? { response: envelope.response } : {}),
    ...(envelope.ackedAt === undefined ? {} : { ackedAt: envelope.ackedAt }),
    ...(envelope.deadAt === undefined ? {} : { deadAt: envelope.deadAt }),
    ...(envelope.presentedAt === undefined ? {} : { presentedAt: envelope.presentedAt }),
    ...(envelope.terminalActor === undefined ? {} : { terminalActor: envelope.terminalActor }),
  })
}

export class HrcMailFederatedOriginRepository {
  constructor(private readonly db: Database) {}

  getByIngressId(ingressId: string): HrcMailFederatedOriginRecord | undefined {
    const row = this.db
      .query<FederatedOriginRow, [string]>(
        `SELECT ${COLUMNS} FROM hrcmail_federated_origins WHERE ingress_id = ?`
      )
      .get(ingressId)
    return row === null ? undefined : mapRow(row)
  }

  getByEnvelopeId(envelopeId: string): HrcMailFederatedOriginRecord | undefined {
    const row = this.db
      .query<FederatedOriginRow, [string]>(
        `SELECT ${COLUMNS} FROM hrcmail_federated_origins WHERE envelope_id = ?`
      )
      .get(envelopeId)
    return row === null ? undefined : mapRow(row)
  }

  getByRequestMessageId(requestMessageId: string): HrcMailFederatedOriginRecord | undefined {
    const row = this.db
      .query<FederatedOriginRow, [string]>(
        `SELECT ${COLUMNS} FROM hrcmail_federated_origins WHERE request_message_id = ?`
      )
      .get(requestMessageId)
    return row === null ? undefined : mapRow(row)
  }

  create(input: CreateHrcMailFederatedOriginInput): HrcMailSendResponse {
    const fingerprint = fingerprintHrcMailRequest(input.request)
    if (input.request.replySchema !== undefined) {
      try {
        compileHrcMailReplySchema(input.request.replySchema)
      } catch (error) {
        throw new HrcMailRepositoryError(
          'invalid_reply_schema',
          error instanceof Error ? error.message : String(error),
          { ingressId: input.request.ingressId }
        )
      }
    }
    return this.db
      .transaction(() => {
        const existing = this.getByIngressId(input.request.ingressId)
        if (existing !== undefined) {
          if (existing.requestFingerprint !== fingerprint) {
            throw new HrcMailRepositoryError(
              'ingress_conflict',
              `ingress id "${input.request.ingressId}" was already used with different mail content`,
              { ingressId: input.request.ingressId, envelopeId: existing.envelopeId }
            )
          }
          return {
            receipt: this.requireReceipt(input.request.ingressId),
            envelope: existing.envelope,
          }
        }

        const receiptRow = this.db
          .query<{ envelope_id: string; request_fingerprint: string }, [string]>(
            `SELECT envelope_id, request_fingerprint
             FROM hrcmail_ingress_receipts
             WHERE ingress_id = ?`
          )
          .get(input.request.ingressId)
        if (receiptRow !== null) {
          throw new HrcMailRepositoryError(
            'ingress_conflict',
            `ingress id "${input.request.ingressId}" already chose a different delivery path`,
            { ingressId: input.request.ingressId, envelopeId: receiptRow.envelope_id }
          )
        }

        const now = new Date().toISOString()
        const envelope: HrcMailEnvelope = {
          envelopeId: input.envelopeId,
          ingressId: input.request.ingressId,
          from: input.request.from,
          targetSessionRef: input.request.targetSessionRef,
          payload: input.request.payload,
          ...(input.request.replySchema === undefined
            ? {}
            : { replySchema: input.request.replySchema }),
          state: 'pending',
          roundCount: 0,
          createdAt: now,
          updatedAt: now,
        }
        const receipt: HrcMailReceipt = {
          ingressId: input.request.ingressId,
          envelopeId: input.envelopeId,
          path: 'mail',
          createdAt: now,
        }
        this.db
          .query(
            `INSERT INTO hrcmail_federated_origins (
               ingress_id, envelope_id, request_message_id, request_fingerprint,
               envelope_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.request.ingressId,
            input.envelopeId,
            input.requestMessageId,
            fingerprint,
            canonicalHrcMailJson(envelope),
            now,
            now
          )
        this.db
          .query(
            `INSERT INTO hrcmail_ingress_receipts (
               ingress_id, path_choice, envelope_id, request_fingerprint,
               receipt_json, created_at
             ) VALUES (?, 'mail', ?, ?, ?, ?)`
          )
          .run(
            input.request.ingressId,
            input.envelopeId,
            fingerprint,
            canonicalHrcMailJson(receipt),
            now
          )
        return { receipt, envelope }
      })
      .immediate() as HrcMailSendResponse
  }

  applyDisposition(input: ApplyHrcMailFederatedDispositionInput): {
    outcome: 'applied' | 'idempotent'
    envelope: HrcMailEnvelope
  } {
    if (input.envelope.state !== 'acked' && input.envelope.state !== 'dead') {
      throw new HrcMailRepositoryError(
        'invalid_transition',
        `federated disposition must be terminal, got ${input.envelope.state}`,
        { envelopeId: input.envelope.envelopeId, state: input.envelope.state }
      )
    }
    const fingerprint = terminalProjectionFingerprint(input.envelope)
    return this.db
      .transaction(() => {
        const origin = this.getByRequestMessageId(input.requestMessageId)
        if (origin === undefined) {
          throw new HrcMailRepositoryError(
            'unknown_envelope',
            `unknown federated mail request "${input.requestMessageId}"`,
            { requestMessageId: input.requestMessageId }
          )
        }
        if (
          origin.envelopeId !== input.envelope.envelopeId ||
          origin.requestFingerprint !==
            fingerprintHrcMailRequest({
              ingressId: origin.ingressId,
              from: input.envelope.from,
              targetSessionRef: input.envelope.targetSessionRef,
              payload: input.envelope.payload,
              ...(input.envelope.replySchema === undefined
                ? {}
                : { replySchema: input.envelope.replySchema }),
            })
        ) {
          throw new HrcMailRepositoryError(
            'conflicting_disposition',
            `federated disposition does not match origin envelope ${origin.envelopeId}`,
            { envelopeId: origin.envelopeId, requestMessageId: input.requestMessageId }
          )
        }
        if (origin.dispositionMessageId !== undefined) {
          if (
            origin.dispositionMessageId === input.dispositionMessageId &&
            origin.dispositionFingerprint === fingerprint
          ) {
            return { outcome: 'idempotent' as const, envelope: origin.envelope }
          }
          throw new HrcMailRepositoryError(
            'conflicting_disposition',
            `federated envelope ${origin.envelopeId} already has a different terminal disposition`,
            { envelopeId: origin.envelopeId }
          )
        }

        const projected: HrcMailEnvelope = {
          ...origin.envelope,
          state: input.envelope.state,
          roundCount: input.envelope.roundCount,
          ...(Object.hasOwn(input.envelope, 'response')
            ? { response: input.envelope.response }
            : {}),
          ...(input.envelope.presentedAt === undefined
            ? {}
            : { presentedAt: input.envelope.presentedAt }),
          ...(input.envelope.ackedAt === undefined ? {} : { ackedAt: input.envelope.ackedAt }),
          ...(input.envelope.deadAt === undefined ? {} : { deadAt: input.envelope.deadAt }),
          ...(input.envelope.terminalActor === undefined
            ? {}
            : { terminalActor: input.envelope.terminalActor }),
          updatedAt: input.envelope.updatedAt,
        }
        const changed = this.db
          .query(
            `UPDATE hrcmail_federated_origins
             SET envelope_json = ?, disposition_message_id = ?,
                 disposition_fingerprint = ?, updated_at = ?
             WHERE request_message_id = ? AND disposition_message_id IS NULL`
          )
          .run(
            canonicalHrcMailJson(projected),
            input.dispositionMessageId,
            fingerprint,
            projected.updatedAt,
            input.requestMessageId
          )
        if (changed.changes !== 1) return this.applyDisposition(input)
        return { outcome: 'applied' as const, envelope: projected }
      })
      .immediate()
  }

  private requireReceipt(ingressId: string): HrcMailReceipt {
    const row = this.db
      .query<{ receipt_json: string }, [string]>(
        'SELECT receipt_json FROM hrcmail_ingress_receipts WHERE ingress_id = ?'
      )
      .get(ingressId)
    if (row === null) throw new Error(`missing federated mail receipt ${ingressId}`)
    return JSON.parse(row.receipt_json) as HrcMailReceipt
  }
}
