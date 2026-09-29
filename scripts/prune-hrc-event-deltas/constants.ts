export const DEFAULT_HRC_STORE_PATH = '/Users/lherron/praesidium/var/state/hrc/state.sqlite'
export const DEFAULT_EVENT_RETENTION_DAYS = 3
export const DEFAULT_RUNTIME_BUFFER_RETENTION_DAYS = 1
// T-07235 diagnostic-bundle retention. These are runtime artifact DIRECTORIES,
// not table rows: the first artifact class HRC writes to disk on its own
// initiative, so it needs its own declared policy (docs/state-retention.md).
export const DEFAULT_FIRST_TURN_BUNDLE_KEEP = 3
export const DEFAULT_FIRST_TURN_BUNDLE_TTL_DAYS = 14
export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
export const MILLISECONDS_PER_MINUTE = 60 * 1000

/**
 * Writer-lock discipline. This job shares `state.sqlite` with the live daemon,
 * whose writes carry a 5s busy timeout. Every write step is therefore bounded,
 * paced, and abandonable: the prune must never be able to starve the daemon,
 * regardless of how large the database has grown.
 */
export const DEFAULT_DEADLINE_MINUTES = 30
export const DEFAULT_PACE_MILLIS = 250
export const DEFAULT_MAX_WRITE_HOLD_MILLIS = 500
/**
 * Share of wall-clock time this job may hold the writer lock. Bounding the
 * length of a single hold is not enough on its own: the daemon has write paths
 * that surface SQLITE_BUSY immediately instead of waiting out their busy
 * timeout, so what they actually see is the probability of finding the lock
 * held. Yielding several times longer than each hold keeps that probability low.
 */
export const DEFAULT_MAX_DUTY_CYCLE = 0.25
export const DEFAULT_INCREMENTAL_VACUUM_CHUNK_PAGES = 100
export const DEFAULT_BUSY_MAX_RETRIES = 8
export const MAX_PAUSE_MILLIS = 5_000
export const MIN_INCREMENTAL_VACUUM_CHUNK_PAGES = 25
export const MAX_INCREMENTAL_VACUUM_CHUNK_PAGES = 10_000
export const MIN_DELETE_BATCH_SIZE = 25
/**
 * Every table's first batch of the night is taken blind, before any hold has
 * been measured. Starting at the configured ceiling makes that first step
 * unbounded — the whole table can fit in one batch and hold the lock for all of
 * it. So each table probes small and ramps up toward the ceiling instead.
 */
export const INITIAL_DELETE_BATCH_SIZE = 250
export const BUSY_BACKOFF_BASE_MILLIS = 500
export const BUSY_BACKOFF_MAX_MILLIS = 15_000

export const TERMINAL_RUN_STATUSES_SQL = "'completed', 'failed', 'cancelled', 'zombie'"
export const TERMINAL_RUNTIME_STATUSES_SQL = "'terminated', 'dead', 'stale', 'crashed'"
export const TERMINAL_INVOCATION_STATES_SQL = "'exited', 'failed', 'disposed'"
export const DELTA_EVENT_TYPES_SQL = "'assistant.message.delta', 'tool.call.delta'"
export const PURGE_DELTA_BACKLOG_OPERATION = 'purge-delta-backlog'
export const STRIP_ENVELOPE_PAYLOADS_OPERATION = 'strip-envelope-payloads'
export const SPILL_TOOL_RESULTS_OPERATION = 'spill-tool-results'
export const RESTUB_TOOL_RESULTS_OPERATION = 'restub-tool-results'
export const T07040_BACKFILL_SOURCE_REF = 'backfill-T-07040'
export const T07040_EXPECTED_BACKFILL_ROWS = 822

/**
 * These event kinds are durable resume barriers. They remain exempt even when
 * the payload does not represent a barrier (for example stale auto-rotation);
 * the small over-retention makes a malformed payload fail closed.
 */
export const RESUME_BARRIER_EVENT_KINDS_SQL = `
  'session.continuation_dropped',
  'context.cleared',
  'runtime.terminated',
  'broker.continuation.cleared'
`

export const EVENTS_ELIGIBLE_SQL = `
  e.ts < ?
  AND e.event_kind NOT IN (${RESUME_BARRIER_EVENT_KINDS_SQL})
  AND (
    e.run_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM runs AS run
      WHERE run.run_id = e.run_id
        AND run.status IN (${TERMINAL_RUN_STATUSES_SQL})
    )
  )
  AND (
    e.runtime_id IS NULL
    OR (
      e.run_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM runtimes AS current_runtime
        WHERE current_runtime.runtime_id = e.runtime_id
          AND current_runtime.active_run_id = e.run_id
      )
    )
    OR EXISTS (
      SELECT 1
      FROM runtimes AS terminal_runtime
      WHERE terminal_runtime.runtime_id = e.runtime_id
        AND terminal_runtime.status IN (${TERMINAL_RUNTIME_STATUSES_SQL})
        AND terminal_runtime.active_run_id IS NULL
    )
  )
`

export const HRC_EVENTS_ELIGIBLE_SQL = `
  e.ts < ?
  AND e.event_kind NOT IN (${RESUME_BARRIER_EVENT_KINDS_SQL})
  AND (
    e.source_ref IS NOT NULL
    OR (
      (
        e.run_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM runs AS run
          WHERE run.run_id = e.run_id
            AND run.status IN (${TERMINAL_RUN_STATUSES_SQL})
        )
      )
      AND (
        e.runtime_id IS NULL
        OR (
          e.run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM runtimes AS current_runtime
            WHERE current_runtime.runtime_id = e.runtime_id
              AND current_runtime.active_run_id = e.run_id
          )
        )
        OR EXISTS (
          SELECT 1
          FROM runtimes AS terminal_runtime
          WHERE terminal_runtime.runtime_id = e.runtime_id
            AND terminal_runtime.status IN (${TERMINAL_RUNTIME_STATUSES_SQL})
            AND terminal_runtime.active_run_id IS NULL
        )
      )
    )
  )
`

export const BROKER_INVOCATION_EVENTS_ELIGIBLE_SQL = `
  e.time < ?
  AND (
    e.source_ref IS NOT NULL
    OR (
      EXISTS (
        SELECT 1
        FROM broker_invocations AS invocation
        WHERE invocation.invocation_id = e.invocation_id
          AND invocation.invocation_state IN (${TERMINAL_INVOCATION_STATES_SQL})
      )
      AND (
        e.run_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM runs AS run
          WHERE run.run_id = e.run_id
            AND run.status IN (${TERMINAL_RUN_STATUSES_SQL})
        )
      )
      AND (
        e.runtime_id IS NULL
        OR (
          e.run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM runtimes AS current_runtime
            WHERE current_runtime.runtime_id = e.runtime_id
              AND current_runtime.active_run_id = e.run_id
          )
        )
        OR EXISTS (
          SELECT 1
          FROM runtimes AS terminal_runtime
          WHERE terminal_runtime.runtime_id = e.runtime_id
            AND terminal_runtime.status IN (${TERMINAL_RUNTIME_STATUSES_SQL})
            AND terminal_runtime.active_run_id IS NULL
        )
      )
    )
  )
`

export const RUNTIME_BUFFERS_ELIGIBLE_SQL = `
  e.created_at < ?
  AND EXISTS (
    SELECT 1
    FROM runs AS run
    WHERE run.run_id = e.run_id
      AND run.status IN (${TERMINAL_RUN_STATUSES_SQL})
  )
  AND EXISTS (
    SELECT 1
    FROM runtimes AS runtime
    WHERE runtime.runtime_id = e.runtime_id
      AND runtime.status IN (${TERMINAL_RUNTIME_STATUSES_SQL})
      AND runtime.active_run_id IS NULL
  )
`

/**
 * T-07045 one-time cleanup. T-07040 removed the last events-table consumer, so
 * every raw broker mirror row is now disposable, not just its delta kinds.
 * The parameter is an intentional operation token: it lets this plan share the
 * parameterized/count/delete machinery without smuggling in a retention cutoff.
 */
export const PURGE_EVENTS_ELIGIBLE_SQL = `
  ? = '${PURGE_DELTA_BACKLOG_OPERATION}'
  AND e.event_kind LIKE 'broker.%'
`

/**
 * Delta rows attached to an invocation that is non-terminal at the moment this
 * statement runs stay fenced. Re-evaluating the predicate inside every DELETE
 * batch closes the race between pre-flight counting and a live invocation.
 *
 * The source-ref exclusion is deliberately redundant with the current
 * continuation.cleared type of the 822 T-07040 backfill rows. The hard count
 * assertion below catches drift; this predicate makes the rows fail closed even
 * if their type is ever repaired or rewritten.
 */
export const PURGE_BROKER_INVOCATION_DELTAS_ELIGIBLE_SQL = `
  ? = '${PURGE_DELTA_BACKLOG_OPERATION}'
  AND e.type IN (${DELTA_EVENT_TYPES_SQL})
  AND COALESCE(e.source_ref, '') <> '${T07040_BACKFILL_SOURCE_REF}'
  AND NOT EXISTS (
    SELECT 1
    FROM broker_invocations AS invocation
    WHERE invocation.invocation_id = e.invocation_id
      AND invocation.invocation_state NOT IN (${TERMINAL_INVOCATION_STATES_SQL})
  )
`
