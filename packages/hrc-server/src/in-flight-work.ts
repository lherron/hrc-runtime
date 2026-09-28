import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * One in-flight unit of work that would be killed by stopping/restarting hrc.
 */
export type InFlightWork = {
  runId: string
  scopeRef: string
  laneRef: string
  status: string
  transport: string | undefined
  startedAt: string | undefined
}

/**
 * How recently a runtime must have shown activity to count as "in flight".
 * Runtimes whose `runs.status='started'` row was never reconciled (orphans
 * from prior crashes or dropped tmux sessions) are filtered out so the gate
 * doesn't permanently block on zombie state from days ago. Operators can
 * still see stale rows by querying the db directly; the gate's job is to
 * protect live work, not audit history.
 */
const IN_FLIGHT_RECENCY_MS = 5 * 60_000

/**
 * Optional filter for the in-flight list. `excludeTransports` drops rows whose
 * `runs.transport` matches any listed value. Used by `hrc server restart` to
 * skip tmux runs, which keep running independently of the daemon and are not
 * killed by a restart.
 */
export type InFlightFilter = {
  excludeTransports?: readonly string[] | undefined
  /** Include recent accepted rows that are queued but not yet active on a runtime. */
  includeAcceptedRuns?: boolean | undefined
  /**
   * The requesting caller's own runId. A `restart --wait` from inside an agent
   * turn would otherwise deadlock waiting on itself: the turn cannot finish
   * until the wait returns. Attribution only — it can only shrink the gate for a
   * caller the daemon already authorized.
   */
  excludeRunId?: string | undefined
}

/**
 * Read in-flight runs from hrc state.sqlite on a separate read-only
 * connection. T-09861 moved this gate into the daemon: the lifecycle endpoint
 * authorizes first, then gates, waits or drains, then acts.
 *
 * "In flight" = a runtime is currently `busy` with an `active_run_id`, **and**
 * the hrc_events stream shows recent activity for that runtime. We use the
 * event timestamp rather than `runtimes.last_activity_at` because the latter
 * is set at child_started and never refreshed, so legitimately-busy runtimes
 * can show ancient values. We JOIN through runtimes rather than scanning runs
 * alone because abandoned `runs.status='started'` rows accumulate when
 * launches die hard.
 */
export function listInFlightWork(dbPath: string, filter?: InFlightFilter): InFlightWork[] {
  const path = dbPath
  if (!existsSync(path)) return []
  const db = new Database(path, { readonly: true })
  try {
    const cutoff = new Date(Date.now() - IN_FLIGHT_RECENCY_MS).toISOString()
    type InFlightRow = {
      run_id: string
      scope_ref: string
      lane_ref: string
      status: string
      transport: string | null
      started_at: string | null
    }
    const rows: InFlightRow[] = filter?.includeAcceptedRuns
      ? db
          .query<InFlightRow, [string, string]>(
            `SELECT r.run_id, r.scope_ref, r.lane_ref, r.status, r.transport, r.started_at
             FROM runs r
             LEFT JOIN runtimes rt ON rt.active_run_id = r.run_id
             WHERE r.status IN ('accepted', 'started', 'running')
               AND r.completed_at IS NULL
               AND (
                 (
                   rt.status = 'busy'
                   AND (
                     SELECT e.ts FROM hrc_events e
                     WHERE e.runtime_id = rt.runtime_id
                     ORDER BY e.hrc_seq DESC
                     LIMIT 1
                   ) > ?
                 )
                 OR (r.status = 'accepted' AND r.updated_at > ?)
               )
             ORDER BY COALESCE(r.started_at, r.updated_at) ASC`
          )
          .all(cutoff, cutoff)
      : db
          .query<InFlightRow, [string]>(
            `SELECT r.run_id, r.scope_ref, r.lane_ref, r.status, r.transport, r.started_at
             FROM runtimes rt
             INNER JOIN runs r ON r.run_id = rt.active_run_id
             WHERE rt.status = 'busy'
               AND rt.active_run_id IS NOT NULL
               AND r.status IN ('accepted', 'started', 'running')
               AND r.completed_at IS NULL
               AND (
                 SELECT e.ts FROM hrc_events e
                 WHERE e.runtime_id = rt.runtime_id
                 ORDER BY e.hrc_seq DESC
                 LIMIT 1
               ) > ?
             ORDER BY r.started_at ASC`
          )
          .all(cutoff)
    const self = filter?.excludeRunId
    const excluded = filter?.excludeTransports?.length
      ? new Set(filter.excludeTransports)
      : undefined
    return rows
      .filter((row) => row.run_id !== self)
      .filter((row) => (excluded ? !excluded.has(row.transport ?? '') : true))
      .map((row) => ({
        runId: row.run_id,
        scopeRef: row.scope_ref,
        laneRef: row.lane_ref,
        status: row.status,
        transport: row.transport ?? undefined,
        startedAt: row.started_at ?? undefined,
      }))
  } finally {
    db.close()
  }
}

export function formatInFlightWork(items: InFlightWork[]): string {
  if (items.length === 0) return '(no in-flight work)\n'
  const lines: string[] = []
  for (const item of items) {
    const transport = item.transport ? ` [${item.transport}]` : ''
    const started = item.startedAt ? ` since ${item.startedAt}` : ''
    lines.push(
      `  ${item.runId}  ${item.scopeRef}~${item.laneRef}  ${item.status}${transport}${started}`
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * Poll until no in-flight work remains, or the timeout elapses. Returns the
 * final in-flight list (empty on success). pollIntervalMs defaults to 500.
 */
export async function waitForInFlightDrain(options: {
  timeoutMs: number
  pollIntervalMs?: number | undefined
  dbPath: string
  filter?: InFlightFilter | undefined
  onTick?: ((items: InFlightWork[]) => void) | undefined
}): Promise<InFlightWork[]> {
  const interval = options.pollIntervalMs ?? 500
  const deadline = Date.now() + options.timeoutMs
  let items = listInFlightWork(options.dbPath, options.filter)
  options.onTick?.(items)
  while (items.length > 0 && Date.now() < deadline) {
    await delay(interval)
    items = listInFlightWork(options.dbPath, options.filter)
    options.onTick?.(items)
  }
  return items
}
