import type { Database } from 'bun:sqlite'
import type { HrcFirstTurnWatchRecord } from 'hrc-core'

const FIRST_TURN_WATCH_COLUMNS = `
  runtime_id,
  generation,
  host_session_id,
  scope_ref,
  lane_ref,
  run_id,
  invocation_id,
  transport,
  priming_dispatched_at,
  first_turn_deadline_at,
  first_turn_at,
  first_turn_missing_tripped_at,
  disarmed_at,
  disarm_reason,
  trip_event_seq,
  diagnostics_event_seq,
  bundle_dir,
  created_at,
  updated_at
`

type FirstTurnWatchRow = {
  runtime_id: string
  generation: number
  host_session_id: string
  scope_ref: string
  lane_ref: string
  run_id: string | null
  invocation_id: string | null
  transport: string | null
  priming_dispatched_at: string | null
  first_turn_deadline_at: string | null
  first_turn_at: string | null
  first_turn_missing_tripped_at: string | null
  disarmed_at: string | null
  disarm_reason: string | null
  trip_event_seq: number | null
  diagnostics_event_seq: number | null
  bundle_dir: string | null
  created_at: string
  updated_at: string
}

function mapRow(row: FirstTurnWatchRow): HrcFirstTurnWatchRecord {
  return {
    runtimeId: row.runtime_id,
    generation: row.generation,
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.invocation_id !== null ? { invocationId: row.invocation_id } : {}),
    ...(row.transport !== null ? { transport: row.transport } : {}),
    ...(row.priming_dispatched_at !== null
      ? { primingDispatchedAt: row.priming_dispatched_at }
      : {}),
    ...(row.first_turn_deadline_at !== null
      ? { firstTurnDeadlineAt: row.first_turn_deadline_at }
      : {}),
    ...(row.first_turn_at !== null ? { firstTurnAt: row.first_turn_at } : {}),
    ...(row.first_turn_missing_tripped_at !== null
      ? { firstTurnMissingTrippedAt: row.first_turn_missing_tripped_at }
      : {}),
    ...(row.disarmed_at !== null ? { disarmedAt: row.disarmed_at } : {}),
    ...(row.disarm_reason !== null ? { disarmReason: row.disarm_reason } : {}),
    ...(row.trip_event_seq !== null ? { tripEventSeq: row.trip_event_seq } : {}),
    ...(row.diagnostics_event_seq !== null
      ? { diagnosticsEventSeq: row.diagnostics_event_seq }
      : {}),
    ...(row.bundle_dir !== null ? { bundleDir: row.bundle_dir } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Durable state for the `first_turn_missing` provision-liveness watchdog
 * (T-07235). Every transition is a single-row conditional UPDATE (or a
 * conditional INSERT), so arm/clear/disarm/trip are idempotent by construction
 * and safe to call from more than one dispatch origin.
 */
export class FirstTurnWatchRepository {
  constructor(private readonly db: Database) {}

  /**
   * Stamp `priming_dispatched_at` and the ABSOLUTE `first_turn_deadline_at` for
   * a generation that has never had a first turn and is not already armed.
   *
   * Idempotent: a generation already armed, already satisfied, already tripped,
   * or explicitly disarmed is left untouched, so redundant calls from several
   * dispatch origins cannot move a deadline or re-arm a settled generation.
   * Returns the row iff THIS call armed it.
   */
  arm(input: {
    runtimeId: string
    generation: number
    hostSessionId: string
    scopeRef: string
    laneRef: string
    runId?: string | undefined
    invocationId?: string | undefined
    transport?: string | undefined
    primingDispatchedAt: string
    firstTurnDeadlineAt: string
  }): HrcFirstTurnWatchRecord | null {
    const inserted = this.db
      .query(
        `INSERT INTO runtime_first_turn_watch (
           runtime_id, generation, host_session_id, scope_ref, lane_ref,
           run_id, invocation_id, transport,
           priming_dispatched_at, first_turn_deadline_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runtime_id, generation) DO UPDATE SET
           run_id = COALESCE(runtime_first_turn_watch.run_id, excluded.run_id),
           invocation_id = COALESCE(runtime_first_turn_watch.invocation_id, excluded.invocation_id),
           transport = COALESCE(runtime_first_turn_watch.transport, excluded.transport),
           priming_dispatched_at = excluded.priming_dispatched_at,
           first_turn_deadline_at = excluded.first_turn_deadline_at,
           updated_at = excluded.updated_at
         WHERE runtime_first_turn_watch.priming_dispatched_at IS NULL
           AND runtime_first_turn_watch.first_turn_at IS NULL
           AND runtime_first_turn_watch.first_turn_missing_tripped_at IS NULL
           AND runtime_first_turn_watch.disarmed_at IS NULL`
      )
      .run(
        input.runtimeId,
        input.generation,
        input.hostSessionId,
        input.scopeRef,
        input.laneRef,
        input.runId ?? null,
        input.invocationId ?? null,
        input.transport ?? null,
        input.primingDispatchedAt,
        input.firstTurnDeadlineAt,
        input.primingDispatchedAt,
        input.primingDispatchedAt
      ) as { changes?: number }

    if ((inserted.changes ?? 0) === 0) return null
    return this.get(input.runtimeId, input.generation)
  }

  /**
   * `turn.started` for the generation: the invariant is satisfied. Recorded
   * even after a trip so a late start is durably visible next to the trip.
   */
  markFirstTurn(runtimeId: string, generation: number, firstTurnAt: string): boolean {
    const result = this.db
      .query(
        `UPDATE runtime_first_turn_watch
            SET first_turn_at = ?, updated_at = ?
          WHERE runtime_id = ? AND generation = ? AND first_turn_at IS NULL`
      )
      .run(firstTurnAt, firstTurnAt, runtimeId, generation) as { changes?: number }
    return (result.changes ?? 0) > 0
  }

  /**
   * Disarm an armed generation without recording a liveness failure: the
   * harness process is gone, so an exit reason already owns the outcome and
   * must not be reclassified as a liveness trip.
   */
  disarm(
    runtimeId: string,
    generation: number,
    reason: string,
    disarmedAt: string
  ): HrcFirstTurnWatchRecord | null {
    const result = this.db
      .query(
        `UPDATE runtime_first_turn_watch
            SET disarmed_at = ?, disarm_reason = ?, updated_at = ?
          WHERE runtime_id = ? AND generation = ?
            AND first_turn_at IS NULL
            AND first_turn_missing_tripped_at IS NULL
            AND disarmed_at IS NULL`
      )
      .run(disarmedAt, reason, disarmedAt, runtimeId, generation) as { changes?: number }
    if ((result.changes ?? 0) === 0) return null
    return this.get(runtimeId, generation)
  }

  /**
   * The evaluation pass's ONLY read: armed rows past their stored deadline.
   * Backed by the partial armed-row index, so the 30s cadence costs an indexed
   * read over a handful of rows.
   */
  listArmedDue(nowIso: string, limit = 100): HrcFirstTurnWatchRecord[] {
    const rows = this.db
      .query<FirstTurnWatchRow, [string, number]>(
        `SELECT ${FIRST_TURN_WATCH_COLUMNS} FROM runtime_first_turn_watch
          WHERE first_turn_deadline_at IS NOT NULL
            AND first_turn_at IS NULL
            AND first_turn_missing_tripped_at IS NULL
            AND disarmed_at IS NULL
            AND first_turn_deadline_at <= ?
          ORDER BY first_turn_deadline_at ASC
          LIMIT ?`
      )
      .all(nowIso, limit)
    return rows.map(mapRow)
  }

  /**
   * Stamp the trip. Conditional on the row still being armed so two passes (or
   * a pass racing a late `turn.started`) can never trip the same generation
   * twice. Caller runs this inside the same transaction as the durable
   * `first_turn_missing` event and the run-terminal stamp.
   */
  markTripped(
    runtimeId: string,
    generation: number,
    trippedAt: string,
    tripEventSeq: number
  ): boolean {
    const result = this.db
      .query(
        `UPDATE runtime_first_turn_watch
            SET first_turn_missing_tripped_at = ?, trip_event_seq = ?, updated_at = ?
          WHERE runtime_id = ? AND generation = ?
            AND first_turn_at IS NULL
            AND first_turn_missing_tripped_at IS NULL
            AND disarmed_at IS NULL`
      )
      .run(trippedAt, tripEventSeq, trippedAt, runtimeId, generation) as { changes?: number }
    return (result.changes ?? 0) > 0
  }

  /** Publish the bundle pointer once the linking event has an hrcSeq. */
  recordDiagnostics(
    runtimeId: string,
    generation: number,
    input: { bundleDir: string; diagnosticsEventSeq: number; updatedAt: string }
  ): void {
    this.db
      .query(
        `UPDATE runtime_first_turn_watch
            SET bundle_dir = ?, diagnostics_event_seq = ?, updated_at = ?
          WHERE runtime_id = ? AND generation = ?`
      )
      .run(input.bundleDir, input.diagnosticsEventSeq, input.updatedAt, runtimeId, generation)
  }

  get(runtimeId: string, generation: number): HrcFirstTurnWatchRecord | null {
    const row = this.db
      .query<FirstTurnWatchRow, [string, number]>(
        `SELECT ${FIRST_TURN_WATCH_COLUMNS} FROM runtime_first_turn_watch
          WHERE runtime_id = ? AND generation = ?`
      )
      .get(runtimeId, generation)
    return row ? mapRow(row) : null
  }

  getByTripEventSeq(tripEventSeq: number): HrcFirstTurnWatchRecord | null {
    const row = this.db
      .query<FirstTurnWatchRow, [number]>(
        `SELECT ${FIRST_TURN_WATCH_COLUMNS} FROM runtime_first_turn_watch
          WHERE trip_event_seq = ?`
      )
      .get(tripEventSeq)
    return row ? mapRow(row) : null
  }

  getByRunId(runId: string): HrcFirstTurnWatchRecord | null {
    const row = this.db
      .query<FirstTurnWatchRow, [string]>(
        `SELECT ${FIRST_TURN_WATCH_COLUMNS} FROM runtime_first_turn_watch
          WHERE run_id = ?`
      )
      .get(runId)
    return row ? mapRow(row) : null
  }

  listTripsByRuntimeId(runtimeId: string): HrcFirstTurnWatchRecord[] {
    const rows = this.db
      .query<FirstTurnWatchRow, [string]>(
        `SELECT ${FIRST_TURN_WATCH_COLUMNS} FROM runtime_first_turn_watch
          WHERE runtime_id = ? AND first_turn_missing_tripped_at IS NOT NULL
          ORDER BY first_turn_missing_tripped_at DESC`
      )
      .all(runtimeId)
    return rows.map(mapRow)
  }

  /**
   * Every tripped row, newest first. Retention and the fleet-wide diagnostics
   * listing both read this; neither recomputes eligibility from the filesystem.
   */
  listTrips(limit = 200): HrcFirstTurnWatchRecord[] {
    const rows = this.db
      .query<FirstTurnWatchRow, [number]>(
        `SELECT ${FIRST_TURN_WATCH_COLUMNS} FROM runtime_first_turn_watch
          WHERE first_turn_missing_tripped_at IS NOT NULL
          ORDER BY first_turn_missing_tripped_at DESC
          LIMIT ?`
      )
      .all(limit)
    return rows.map(mapRow)
  }

  /** Latest trip per runtime, for the runtime-list health projection. */
  listLatestTripByRuntime(): Map<string, HrcFirstTurnWatchRecord> {
    const rows = this.db
      .query<FirstTurnWatchRow, []>(
        `SELECT ${FIRST_TURN_WATCH_COLUMNS} FROM runtime_first_turn_watch
          WHERE first_turn_missing_tripped_at IS NOT NULL
          ORDER BY first_turn_missing_tripped_at ASC`
      )
      .all()
    const latest = new Map<string, HrcFirstTurnWatchRecord>()
    for (const row of rows) {
      latest.set(row.runtime_id, mapRow(row))
    }
    return latest
  }

  /** Retention: drop the bundle pointer once its directory has been removed. */
  clearBundle(runtimeId: string, generation: number, updatedAt: string): void {
    this.db
      .query(
        `UPDATE runtime_first_turn_watch
            SET bundle_dir = NULL, updated_at = ?
          WHERE runtime_id = ? AND generation = ?`
      )
      .run(updatedAt, runtimeId, generation)
  }
}
