import type { Database } from 'bun:sqlite'
import type { HrcSteerContributionRecord, HrcSteerContributionState } from 'hrc-core'

import { execute } from './shared.js'

type SteerContributionRow = {
  contribution_id: string
  host_session_id: string
  idempotency_key: string | null
  runtime_id: string
  invocation_id: string
  active_run_id: string
  input_id: string
  state: string
  outcome_code: string | null
  outcome_json: string | null
  created_at: string
  updated_at: string
}

function mapRow(row: SteerContributionRow): HrcSteerContributionRecord {
  return {
    contributionId: row.contribution_id,
    hostSessionId: row.host_session_id,
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    runtimeId: row.runtime_id,
    invocationId: row.invocation_id,
    activeRunId: row.active_run_id,
    inputId: row.input_id,
    state: row.state as HrcSteerContributionState,
    ...(row.outcome_code === null ? {} : { outcomeCode: row.outcome_code }),
    ...(row.outcome_json === null
      ? {}
      : { outcome: JSON.parse(row.outcome_json) as Record<string, unknown> }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * T-07155 — the durable ledger for urgent (`whenBusy: 'steer'`) delivery.
 *
 * Write-ahead then seal. The record is inserted `attempting` BEFORE the broker
 * RPC and updated to a terminal state after, so a retry that reuses the caller's
 * idempotency key returns the recorded outcome instead of re-actuating. This is
 * what keeps the caller-stable idempotency promise honest for a delivery that
 * deliberately creates no run row: `expectedTurnId` fences staleness, not
 * duplication — the same turn is still active on a retry.
 *
 * A record still `attempting` after a crash is sealed `ambiguous` by recovery,
 * never retried, because whether the harness applied it is genuinely unknown.
 */
export class SteerContributionRepository {
  constructor(private readonly db: Database) {}

  /** Write-ahead insert. Must happen before any actuation. */
  insertAttempting(record: {
    contributionId: string
    hostSessionId: string
    idempotencyKey?: string | undefined
    runtimeId: string
    invocationId: string
    activeRunId: string
    inputId: string
    now: string
  }): void {
    execute(
      this.db,
      `
        INSERT INTO steer_contributions (
          contribution_id, host_session_id, idempotency_key,
          runtime_id, invocation_id, active_run_id, input_id,
          state, outcome_code, outcome_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'attempting', NULL, NULL, ?, ?)
      `,
      record.contributionId,
      record.hostSessionId,
      record.idempotencyKey ?? null,
      record.runtimeId,
      record.invocationId,
      record.activeRunId,
      record.inputId,
      record.now,
      record.now
    )
  }

  /**
   * T-07203: re-aim a write-ahead record's run pointer BEFORE actuation.
   * The idle-path reject-probe inserts with the provisional runId; when the
   * probe reveals a concurrent active turn, the pointer is re-aimed to that
   * resolved run before the single steer attempt. Guarded to `attempting`
   * rows only — a sealed record's identity is immutable.
   */
  updateAttemptingRunPointer(
    contributionId: string,
    patch: { activeRunId: string; runtimeId: string; invocationId: string; now: string }
  ): boolean {
    const result = this.db
      .prepare(
        `
        UPDATE steer_contributions
           SET active_run_id = ?, runtime_id = ?, invocation_id = ?, updated_at = ?
         WHERE contribution_id = ? AND state = 'attempting'
      `
      )
      .run(patch.activeRunId, patch.runtimeId, patch.invocationId, patch.now, contributionId)
    return result.changes > 0
  }

  /** Seal the record with its terminal outcome. Idempotent by contributionId. */
  seal(
    contributionId: string,
    patch: {
      state: Exclude<HrcSteerContributionState, 'attempting'>
      outcomeCode?: string | undefined
      outcome?: Record<string, unknown> | undefined
      now: string
    }
  ): void {
    execute(
      this.db,
      `
        UPDATE steer_contributions
           SET state = ?, outcome_code = ?, outcome_json = ?, updated_at = ?
         WHERE contribution_id = ?
      `,
      patch.state,
      patch.outcomeCode ?? null,
      patch.outcome === undefined ? null : JSON.stringify(patch.outcome),
      patch.now,
      contributionId
    )
  }

  getById(contributionId: string): HrcSteerContributionRecord | null {
    const row = this.db
      .query<SteerContributionRow, [string]>(
        'SELECT * FROM steer_contributions WHERE contribution_id = ?'
      )
      .get(contributionId)
    return row ? mapRow(row) : null
  }

  findByIdempotencyKey(
    hostSessionId: string,
    idempotencyKey: string
  ): HrcSteerContributionRecord | null {
    const row = this.db
      .query<SteerContributionRow, [string, string]>(
        'SELECT * FROM steer_contributions WHERE host_session_id = ? AND idempotency_key = ?'
      )
      .get(hostSessionId, idempotencyKey)
    return row ? mapRow(row) : null
  }

  /**
   * T-07676: an unchanged active run's committed non-actuated refusal is the
   * once-per-run fence. Later wakes observe it instead of probing the same
   * broker turn again; a different run id deliberately misses this lookup.
   */
  findRefusalForActiveRun(
    hostSessionId: string,
    runtimeId: string,
    activeRunId: string
  ): HrcSteerContributionRecord | null {
    const row = this.db
      .query<SteerContributionRow, [string, string, string]>(
        `SELECT *
           FROM steer_contributions
          WHERE host_session_id = ?
            AND runtime_id = ?
            AND active_run_id = ?
            AND state = 'refused'
          ORDER BY updated_at DESC
          LIMIT 1`
      )
      .get(hostSessionId, runtimeId, activeRunId)
    return row ? mapRow(row) : null
  }

  listAttempting(): HrcSteerContributionRecord[] {
    return this.db
      .query<SteerContributionRow, []>(
        "SELECT * FROM steer_contributions WHERE state = 'attempting' ORDER BY created_at"
      )
      .all()
      .map(mapRow)
  }

  /**
   * Startup recovery: a write-ahead record the daemon never sealed cannot be
   * retried, because the RPC may or may not have reached the harness. Sealing it
   * `ambiguous` makes a later retry with the same key return the truth rather
   * than actuate a second time.
   */
  sealOrphanedAsAmbiguous(now: string): number {
    const orphans = this.listAttempting()
    for (const orphan of orphans) {
      this.seal(orphan.contributionId, {
        state: 'ambiguous',
        outcomeCode: 'urgent_delivery_ambiguous',
        now,
      })
    }
    return orphans.length
  }
}
