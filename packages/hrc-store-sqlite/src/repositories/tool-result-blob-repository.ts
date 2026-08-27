import type { Database } from 'bun:sqlite'
import {
  type ToolResultBlobKind,
  readToolResultSpillDescriptor,
  toolResultFromBrokerResult,
} from 'hrc-core'

export type ToolResultBlobRecord = {
  rowid: number
  blobId: string
  runtimeId: string
  kind: ToolResultBlobKind
  bytes: number
  complete: boolean
  resultJson: string
  createdAt: string
}

export type ToolResultBlobPartInput = {
  blobId: string
  runtimeId: string
  kind: ToolResultBlobKind
  bytes: number
  part: number
  parts: number
  chunk: string
}

export type LedgerBlobMiss = {
  metric: 'ledger.blob_miss'
  blobId: string
  kind: ToolResultBlobKind
}

type ToolResultBlobRow = {
  rowid: number
  blob_id: string
  runtime_id: string
  kind: ToolResultBlobKind
  bytes: number
  complete: number
  result_json: string
  created_at: string
}

const BLOB_COLUMNS = 'rowid, blob_id, runtime_id, kind, bytes, complete, result_json, created_at'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mapBlob(row: ToolResultBlobRow): ToolResultBlobRecord {
  return {
    rowid: row.rowid,
    blobId: row.blob_id,
    runtimeId: row.runtime_id,
    kind: row.kind,
    bytes: row.bytes,
    complete: row.complete !== 0,
    resultJson: row.result_json,
    createdAt: row.created_at,
  }
}

export class ToolResultBlobRepository {
  constructor(
    private readonly db: Database,
    private readonly onMiss?: ((miss: LedgerBlobMiss) => void) | undefined
  ) {}

  insert(input: {
    blobId: string
    runtimeId: string
    kind: ToolResultBlobKind
    bytes: number
    resultJson: string
    createdAt?: string | undefined
  }): ToolResultBlobRecord {
    this.db
      .query<never, [string, string, string, number, string, string | null]>(
        `INSERT OR IGNORE INTO tool_result_blobs (
           blob_id, runtime_id, kind, bytes, complete, result_json, created_at
         ) VALUES (?, ?, ?, ?, 1, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`
      )
      .run(
        input.blobId,
        input.runtimeId,
        input.kind,
        input.bytes,
        input.resultJson,
        input.createdAt ?? null
      )
    const stored = this.get(input.blobId)
    if (!stored) throw new Error(`failed to persist tool-result blob ${input.blobId}`)
    return stored
  }

  get(blobId: string): ToolResultBlobRecord | null {
    const row = this.db
      .query<ToolResultBlobRow, [string]>(
        `SELECT ${BLOB_COLUMNS} FROM tool_result_blobs WHERE blob_id = ?`
      )
      .get(blobId)
    return row ? mapBlob(row) : null
  }

  listLocalFromRowid(afterRowid: number, limit: number): ToolResultBlobRecord[] {
    const ledgerIncarnationId = this.db
      .query<{ ledger_incarnation_id: string }, []>(
        'SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata WHERE id = 1'
      )
      .get()?.ledger_incarnation_id
    if (!ledgerIncarnationId)
      throw new Error('lifecycle-event ledger incarnation metadata is missing')
    return this.db
      .query<ToolResultBlobRow, [number, string, string, number]>(
        `SELECT ${BLOB_COLUMNS}
           FROM tool_result_blobs AS blob
          WHERE blob.rowid > ?
            AND blob.complete = 1
            AND (
              (blob.kind = 'lifecycle_canonical'
                AND blob.blob_id LIKE ('lc:' || ? || ':%')
                AND EXISTS (
                  SELECT 1
                    FROM hrc_events AS event
                   WHERE event.hrc_seq = CAST(
                     substr(blob.blob_id, length('lc:' || ? || ':') + 1) AS INTEGER
                   )
                     AND event.source_ref IS NULL
                ))
              OR
              (blob.kind = 'broker_raw' AND EXISTS (
                SELECT 1
                  FROM broker_invocation_events AS event
                 WHERE event.runtime_id = blob.runtime_id
                   AND event.source_ref IS NULL
              ))
            )
          ORDER BY blob.rowid ASC
          LIMIT ?`
      )
      .all(afterRowid, ledgerIncarnationId, ledgerIncarnationId, limit)
      .map(mapBlob)
  }

  ingestPart(input: ToolResultBlobPartInput): { completed: boolean; duplicate: boolean } {
    const apply = this.db.transaction(() => {
      if (this.get(input.blobId)) return { completed: true, duplicate: true }
      const inserted = this.db
        .query<never, [string, number, number, string, string, number, string]>(
          `INSERT OR IGNORE INTO tool_result_blob_parts (
             blob_id, part, parts, runtime_id, kind, bytes, chunk
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.blobId,
          input.part,
          input.parts,
          input.runtimeId,
          input.kind,
          input.bytes,
          input.chunk
        )
      const count =
        this.db
          .query<{ count: number }, [string]>(
            'SELECT COUNT(*) AS count FROM tool_result_blob_parts WHERE blob_id = ?'
          )
          .get(input.blobId)?.count ?? 0
      if (count !== input.parts) {
        return { completed: false, duplicate: inserted.changes === 0 }
      }
      const assembled = this.db
        .query<{ result_json: string | null }, [string]>(
          `SELECT group_concat(chunk, '') AS result_json
             FROM (
               SELECT chunk
                 FROM tool_result_blob_parts
                WHERE blob_id = ?
                ORDER BY part ASC
             )`
        )
        .get(input.blobId)?.result_json
      if (assembled === undefined || assembled === null) {
        throw new Error(`failed to assemble tool-result blob ${input.blobId}`)
      }
      const validation = this.db
        .query<{ actual_bytes: number; valid_json: number }, [string, string]>(
          'SELECT length(CAST(? AS BLOB)) AS actual_bytes, json_valid(?) AS valid_json'
        )
        .get(assembled, assembled)
      if (validation?.actual_bytes !== input.bytes || validation.valid_json !== 1) {
        throw new Error(`invalid assembled tool-result blob ${input.blobId}`)
      }
      this.insert({
        blobId: input.blobId,
        runtimeId: input.runtimeId,
        kind: input.kind,
        bytes: input.bytes,
        resultJson: assembled,
      })
      this.db
        .query<never, [string]>('DELETE FROM tool_result_blob_parts WHERE blob_id = ?')
        .run(input.blobId)
      return { completed: true, duplicate: inserted.changes === 0 }
    })
    return apply.immediate()
  }

  hydrateBrokerEventJson(brokerEventJson: string): string {
    let payload: unknown
    try {
      payload = JSON.parse(brokerEventJson) as unknown
    } catch {
      return brokerEventJson
    }
    if (!isRecord(payload)) return brokerEventJson
    const spill = readToolResultSpillDescriptor(payload['result'])
    if (!spill) return brokerEventJson
    const blob = this.completeBlob(spill.blobId, spill.kind)
    if (!blob) return brokerEventJson
    return JSON.stringify({ ...payload, result: JSON.parse(blob.resultJson) as unknown })
  }

  hydrateLifecyclePayload(payload: unknown): unknown {
    if (!isRecord(payload)) return payload
    const spill = readToolResultSpillDescriptor(payload['result'])
    if (!spill) return payload
    const blob = this.completeBlob(spill.blobId, spill.kind)
    if (!blob) return payload
    const stored = JSON.parse(blob.resultJson) as unknown
    return {
      ...payload,
      result: blob.kind === 'broker_raw' ? toolResultFromBrokerResult(stored) : stored,
    }
  }

  private completeBlob(blobId: string, kind: ToolResultBlobKind): ToolResultBlobRecord | null {
    const blob = this.get(blobId)
    if (blob?.complete) return blob
    this.onMiss?.({ metric: 'ledger.blob_miss', blobId, kind })
    return null
  }
}
