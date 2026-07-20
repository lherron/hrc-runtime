import type { Database } from 'bun:sqlite'

import { execute } from './repositories/shared.js'

export type FederationAcceptedRequestRecord = {
  requestMessageId: string
  acceptedByNodeId: string
  acceptedEpoch: number
  acceptedAt: string
}

export type RecordFederationAcceptanceInput = Omit<
  FederationAcceptedRequestRecord,
  'acceptedAt'
> & {
  acceptedAt?: string | undefined
}

type AcceptedRequestRow = {
  request_message_id: string
  accepted_by_node_id: string
  accepted_epoch: number
  accepted_at: string
}

function mapRow(row: AcceptedRequestRow): FederationAcceptedRequestRecord {
  return {
    requestMessageId: row.request_message_id,
    acceptedByNodeId: row.accepted_by_node_id,
    acceptedEpoch: row.accepted_epoch,
    acceptedAt: row.accepted_at,
  }
}

function requireInput(input: RecordFederationAcceptanceInput): void {
  if (input.requestMessageId.trim().length === 0) throw new Error('requestMessageId is required')
  if (input.acceptedByNodeId.trim().length === 0) throw new Error('acceptedByNodeId is required')
  if (!Number.isSafeInteger(input.acceptedEpoch) || input.acceptedEpoch < 1) {
    throw new Error('acceptedEpoch must be a positive safe integer')
  }
}

export class FederationAcceptedRequestRepository {
  private readonly recordInTransaction: (input: RecordFederationAcceptanceInput) => {
    outcome: 'recorded' | 'duplicate'
    record: FederationAcceptedRequestRecord
  }

  constructor(private readonly db: Database) {
    this.recordInTransaction = db.transaction((input: RecordFederationAcceptanceInput) => {
      requireInput(input)
      const existing = this.get(input.requestMessageId)
      if (existing !== undefined) {
        if (
          existing.acceptedByNodeId !== input.acceptedByNodeId ||
          existing.acceptedEpoch !== input.acceptedEpoch
        ) {
          throw new Error(
            `conflicting accepted-request ACK for ${input.requestMessageId}: ` +
              `${existing.acceptedByNodeId}@${existing.acceptedEpoch} vs ` +
              `${input.acceptedByNodeId}@${input.acceptedEpoch}`
          )
        }
        return { outcome: 'duplicate' as const, record: existing }
      }

      execute(
        this.db,
        `INSERT INTO federation_accepted_requests (
          request_message_id, accepted_by_node_id, accepted_epoch, accepted_at
        ) VALUES (?, ?, ?, ?)`,
        input.requestMessageId,
        input.acceptedByNodeId,
        input.acceptedEpoch,
        input.acceptedAt ?? new Date().toISOString()
      )
      const stored = this.get(input.requestMessageId)
      if (stored === undefined) throw new Error('failed to reload accepted-request ACK')
      return { outcome: 'recorded' as const, record: stored }
    })
  }

  get(requestMessageId: string): FederationAcceptedRequestRecord | undefined {
    const row = this.db
      .query<AcceptedRequestRow, [string]>(
        `SELECT request_message_id, accepted_by_node_id, accepted_epoch, accepted_at
         FROM federation_accepted_requests WHERE request_message_id = ?`
      )
      .get(requestMessageId)
    return row === null ? undefined : mapRow(row)
  }

  record(input: RecordFederationAcceptanceInput): {
    outcome: 'recorded' | 'duplicate'
    record: FederationAcceptedRequestRecord
  } {
    return this.recordInTransaction(input)
  }
}
