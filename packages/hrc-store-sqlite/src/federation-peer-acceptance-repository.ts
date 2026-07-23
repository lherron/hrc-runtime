import type { Database } from 'bun:sqlite'

import { execute } from './repositories/shared.js'

export type FederationPeerAcceptancePhase = 'request' | 'response'

export type FederationPeerAcceptanceRecord = {
  messageId: string
  acceptedByNodeId: string
  phase: FederationPeerAcceptancePhase
  requestEpoch?: number | undefined
  acceptedAt: string
}

export type RecordFederationPeerAcceptanceInput = Omit<
  FederationPeerAcceptanceRecord,
  'acceptedAt'
> & {
  acceptedAt?: string | undefined
}

type PeerAcceptanceRow = {
  message_id: string
  accepted_by_node_id: string
  phase: FederationPeerAcceptancePhase
  request_epoch: number | null
  accepted_at: string
}

function mapRow(row: PeerAcceptanceRow): FederationPeerAcceptanceRecord {
  return {
    messageId: row.message_id,
    acceptedByNodeId: row.accepted_by_node_id,
    phase: row.phase,
    ...(row.request_epoch === null ? {} : { requestEpoch: row.request_epoch }),
    acceptedAt: row.accepted_at,
  }
}

function requireInput(input: RecordFederationPeerAcceptanceInput): void {
  if (input.messageId.trim().length === 0) throw new Error('messageId is required')
  if (input.acceptedByNodeId.trim().length === 0) throw new Error('acceptedByNodeId is required')
  if (input.phase === 'request') {
    if (!Number.isSafeInteger(input.requestEpoch) || (input.requestEpoch ?? 0) < 1) {
      throw new Error('requestEpoch must be a positive safe integer for a request acceptance')
    }
  } else if (input.requestEpoch !== undefined) {
    throw new Error('requestEpoch is request metadata and must be absent for a response acceptance')
  }
}

export class FederationPeerAcceptanceConflictError extends Error {
  constructor(
    readonly existing: FederationPeerAcceptanceRecord,
    readonly attempted: RecordFederationPeerAcceptanceInput
  ) {
    super(
      `conflicting peer-acceptance ACK for ${attempted.messageId}: ` +
        `${existing.acceptedByNodeId}/${existing.phase}` +
        `${existing.requestEpoch === undefined ? '' : `@${existing.requestEpoch}`} vs ` +
        `${attempted.acceptedByNodeId}/${attempted.phase}` +
        `${attempted.requestEpoch === undefined ? '' : `@${attempted.requestEpoch}`}`
    )
    this.name = 'FederationPeerAcceptanceConflictError'
  }
}

export class FederationPeerAcceptanceRepository {
  private readonly recordInTransaction: (input: RecordFederationPeerAcceptanceInput) => {
    outcome: 'recorded' | 'duplicate'
    record: FederationPeerAcceptanceRecord
  }

  constructor(private readonly db: Database) {
    this.recordInTransaction = db.transaction((input: RecordFederationPeerAcceptanceInput) => {
      requireInput(input)
      const existing = this.get(input.messageId)
      if (existing !== undefined) {
        if (
          existing.acceptedByNodeId !== input.acceptedByNodeId ||
          existing.phase !== input.phase ||
          existing.requestEpoch !== input.requestEpoch
        ) {
          throw new FederationPeerAcceptanceConflictError(existing, input)
        }
        return { outcome: 'duplicate' as const, record: existing }
      }

      execute(
        this.db,
        `INSERT INTO federation_peer_acceptances (
          message_id, accepted_by_node_id, phase, request_epoch, accepted_at
        ) VALUES (?, ?, ?, ?, ?)`,
        input.messageId,
        input.acceptedByNodeId,
        input.phase,
        input.requestEpoch ?? null,
        input.acceptedAt ?? new Date().toISOString()
      )
      const stored = this.get(input.messageId)
      if (stored === undefined) throw new Error('failed to reload peer-acceptance ACK')
      return { outcome: 'recorded' as const, record: stored }
    })
  }

  get(messageId: string): FederationPeerAcceptanceRecord | undefined {
    const row = this.db
      .query<PeerAcceptanceRow, [string]>(
        `SELECT message_id, accepted_by_node_id, phase, request_epoch, accepted_at
         FROM federation_peer_acceptances WHERE message_id = ?`
      )
      .get(messageId)
    return row === null ? undefined : mapRow(row)
  }

  record(input: RecordFederationPeerAcceptanceInput): {
    outcome: 'recorded' | 'duplicate'
    record: FederationPeerAcceptanceRecord
  } {
    return this.recordInTransaction(input)
  }
}
