import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  HrcRunRecord,
  HrcRuntimeSnapshot,
  ReconcileActiveRunResult,
  SweepRuntimeTransport,
} from 'hrc-core'
import { isLiveProcess } from './server-lock.js'
import type { ListRuntimesFilter } from './server-parsers.js'
import type { HrcServerRunRow } from './server-types.js'
import { isRuntimeUnavailableStatus } from './server-util.js'
import { getObservedTmuxSessionName } from './startup-reconcile.js'
import type { TmuxManager as ServerTmuxManager } from './tmux.js'

const DEFAULT_STALE_GENERATION_THRESHOLD_SEC = 24 * 60 * 60

export function parseSweepDurationMs(raw: string): number {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/)
  if (!match) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'olderThan must be a duration', {
      field: 'olderThan',
    })
  }

  const value = Number.parseFloat(match[1] as string)
  const unit = match[2] ?? 'ms'
  const multiplier =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60 * 1000
          : unit === 'h'
            ? 60 * 60 * 1000
            : 24 * 60 * 60 * 1000
  return Math.max(0, Math.floor(value * multiplier))
}

export function mapServerRunRow(row: HrcServerRunRow): HrcRunRecord {
  return {
    runId: row.run_id,
    hostSessionId: row.host_session_id,
    ...(row.runtime_id ? { runtimeId: row.runtime_id } : {}),
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    transport: row.transport,
    status: row.status,
    ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    updatedAt: row.updated_at,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
  }
}

export function reconcileResultTransport(run: HrcRunRecord): ReconcileActiveRunResult['transport'] {
  return run.transport === 'sdk' || run.transport === 'headless' || run.transport === 'ghostty'
    ? run.transport
    : 'tmux'
}

export function runtimeMatchesSweepRequest(
  runtime: HrcRuntimeSnapshot,
  filters: {
    cutoffMs: number
    includeRecentUnavailable: boolean
    nowMs: number
    scope?: string | undefined
    statuses: string[]
    transport?: SweepRuntimeTransport | undefined
  }
): boolean {
  if (!isSweepRuntimeTransport(runtime.transport)) {
    return false
  }
  if (filters.transport !== undefined && runtime.transport !== filters.transport) {
    return false
  }
  const updatedAtMs = Date.parse(runtime.updatedAt)
  const recentUnavailable =
    filters.includeRecentUnavailable &&
    isRuntimeUnavailableStatus(runtime.status) &&
    Number.isFinite(updatedAtMs) &&
    filters.nowMs - updatedAtMs <= 30_000
  if (!filters.statuses.includes(runtime.status) && !recentUnavailable) {
    return false
  }
  if (filters.scope !== undefined && !runtime.scopeRef.startsWith(filters.scope)) {
    return false
  }

  const activityTs = runtime.lastActivityAt ?? runtime.createdAt
  const activityMs = Date.parse(activityTs)
  return Number.isFinite(activityMs) && activityMs <= filters.cutoffMs
}

/**
 * Orphan safety gate for `runtime prune` (T-05441). A runtime store row is only
 * prunable when it is genuinely orphaned: its status is unavailable
 * (stale/dead/terminated), it owns no active run, its tracked process is dead,
 * and — for tmux — its recorded session is no longer live. Any surviving edge of
 * liveness spares the record (returned as a `skipped` disposition with a reason
 * naming the guard). NEVER deletes a live/ready/busy/claimed/active-run record.
 */
export async function evaluatePruneDisposition(
  runtime: HrcRuntimeSnapshot,
  tmux: ServerTmuxManager
): Promise<{ prunable: boolean; reason?: string }> {
  if (!isRuntimeUnavailableStatus(runtime.status)) {
    return { prunable: false, reason: `status_not_prunable:${runtime.status}` }
  }
  if (runtime.activeRunId != null) {
    return { prunable: false, reason: 'active_run' }
  }

  const trackedPid = runtime.childPid ?? runtime.wrapperPid
  if (trackedPid !== undefined && isLiveProcess(trackedPid)) {
    return { prunable: false, reason: 'live_process' }
  }

  if (runtime.transport === 'tmux') {
    const tmuxSessionName = getObservedTmuxSessionName(runtime)
    if (tmuxSessionName) {
      const inspected = await tmux.inspectSession(tmuxSessionName)
      if (inspected) {
        return { prunable: false, reason: 'live_tmux' }
      }
    }
  }

  return { prunable: true }
}

export function isSweepRuntimeTransport(transport: string): transport is SweepRuntimeTransport {
  return (
    transport === 'tmux' ||
    transport === 'headless' ||
    transport === 'sdk' ||
    transport === 'ghostty'
  )
}

export function filterRuntimes(
  runtimes: HrcRuntimeSnapshot[],
  filter: ListRuntimesFilter
): HrcRuntimeSnapshot[] {
  const explicitStatuses = filter.status !== undefined && filter.status.length > 0
  const statusSet = explicitStatuses ? new Set(filter.status) : null
  const staleThresholdMs = filter.olderThanMs ?? resolveListStaleThresholdMs()
  const staleBefore = Date.now() - staleThresholdMs

  const filtered = runtimes.filter((runtime) => {
    if (filter.transport !== undefined && runtime.transport !== filter.transport) {
      return false
    }
    if (statusSet && !statusSet.has(runtime.status)) {
      return false
    }
    if (filter.scope !== undefined && !runtime.scopeRef.startsWith(filter.scope)) {
      return false
    }
    if (filter.stale === true) {
      if (!explicitStatuses && (runtime.status === 'terminated' || runtime.status === 'dead')) {
        return false
      }
      const activityTs = runtime.lastActivityAt ?? runtime.createdAt
      const activityMs = Date.parse(activityTs)
      if (!Number.isFinite(activityMs) || activityMs > staleBefore) {
        return false
      }
    }
    return true
  })

  if (explicitStatuses && filter.status && filter.status.length > 1) {
    const statusOrder = new Map(filter.status.map((status, index) => [status, index] as const))
    return [...filtered].sort(
      (left, right) => (statusOrder.get(left.status) ?? 0) - (statusOrder.get(right.status) ?? 0)
    )
  }

  return filtered
}

export function resolveListStaleThresholdMs(): number {
  const raw = process.env['HRC_STALE_GENERATION_HOURS']
  if (raw === undefined) {
    return DEFAULT_STALE_GENERATION_THRESHOLD_SEC * 1000
  }
  const hours = Number.parseFloat(raw)
  if (!Number.isFinite(hours) || hours < 0) {
    return DEFAULT_STALE_GENERATION_THRESHOLD_SEC * 1000
  }
  return Math.floor(hours * 60 * 60 * 1000)
}

/**
 * Liveness gate for interactive harness re-ensure (T-01026).
 *
 * Returns `true` when the existing runtime can be reused as-is:
 *   - forceRestart is NOT requested
 *   - a prior runtime exists and is not in an unavailable state
 *   - its tmux session/pane is still present
 *   - the tracked process (childPid ?? wrapperPid) is still alive
 *     (if no pid is tracked yet we assume alive when tmux is alive)
 */
export async function isInteractiveRuntimeLive(
  priorRuntime: HrcRuntimeSnapshot | null,
  forceRestart: boolean,
  tmux: ServerTmuxManager
): Promise<boolean> {
  if (forceRestart) return false
  if (!priorRuntime) return false
  if (isRuntimeUnavailableStatus(priorRuntime.status)) return false

  const tmuxSessionName = getObservedTmuxSessionName(priorRuntime)
  if (!tmuxSessionName) return false

  const inspected = await tmux.inspectSession(tmuxSessionName)
  if (!inspected) return false

  const trackedPid = priorRuntime.childPid ?? priorRuntime.wrapperPid
  if (trackedPid !== undefined && !isLiveProcess(trackedPid)) return false

  return true
}
