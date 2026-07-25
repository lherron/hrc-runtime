import type { HrcMessageAddress, HrcMessageRecord } from 'hrc-core'

/**
 * Filterable projection of a canonical collective-history record (T-06973).
 *
 * Before this existed, every filter but `messageId`/`afterSeq` lived only inside
 * `canonical_record_json`, so any limited query had to select every row, parse
 * every record and filter in JS. These columns are the indexed materialization
 * of those fields. One module owns the projection so the write path and the
 * backfill migration cannot drift apart — a drift would silently drop rows from
 * filtered queries rather than fail loudly.
 */
export type CollectiveHistoryFilterColumns = {
  from_ref: string
  to_ref: string
  root_message_id: string
  reply_to_message_id: string | null
  kind: string
  phase: string
  host_session_id: string | null
  run_id: string | null
  generation: number | null
}

/**
 * Single-string form of an address, so `from`/`to`/`participant` become plain
 * indexed equality. The two address kinds are disjoint by construction: a
 * session ref is `agent:...`-shaped and can never collide with the `entity:`
 * prefix.
 */
export function collectiveHistoryAddressRef(address: HrcMessageAddress): string {
  return address.kind === 'entity' ? `entity:${address.entity}` : `session:${address.sessionRef}`
}

export function collectiveHistoryFilterColumns(
  record: HrcMessageRecord
): CollectiveHistoryFilterColumns {
  return {
    from_ref: collectiveHistoryAddressRef(record.from),
    to_ref: collectiveHistoryAddressRef(record.to),
    root_message_id: record.rootMessageId,
    reply_to_message_id: record.replyToMessageId ?? null,
    kind: record.kind,
    phase: record.phase,
    host_session_id: record.execution.hostSessionId ?? null,
    run_id: record.execution.runId ?? null,
    generation: record.execution.generation ?? null,
  }
}

/** Column order shared by the insert, the canonical-replace update and the backfill. */
export const COLLECTIVE_HISTORY_FILTER_COLUMN_NAMES = [
  'from_ref',
  'to_ref',
  'root_message_id',
  'reply_to_message_id',
  'kind',
  'phase',
  'host_session_id',
  'run_id',
  'generation',
] as const satisfies ReadonlyArray<keyof CollectiveHistoryFilterColumns>

export function collectiveHistoryFilterColumnValues(
  record: HrcMessageRecord
): Array<string | number | null> {
  const columns = collectiveHistoryFilterColumns(record)
  return COLLECTIVE_HISTORY_FILTER_COLUMN_NAMES.map((name) => columns[name])
}
