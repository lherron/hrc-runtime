import { parseScopeRef } from 'agent-scope'
import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  HrcRunRecord,
  HrcRuntimeSnapshot,
  ReconcileActiveRunResult,
  SweepRuntimeTransport,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { isLiveProcess } from './server-lock.js'
import type { ListRuntimesFilter } from './server-parsers.js'
import type { HrcServerRunRow } from './server-types.js'
import { isRuntimeUnavailableStatus } from './server-util.js'
import { getObservedTmuxSessionName } from './startup-reconcile.js'
import type { TmuxManager as ServerTmuxManager, TmuxPaneState } from './tmux.js'

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

type RuntimeTmuxIdentity = TmuxPaneState

export type RuntimeAgingEvidence = {
  invocationId: string | null
  invocationBrokerPid: number | null
  invocationChildPid: number | null
}

export type RuntimeAgingDisposition =
  | { eligible: true; evidence: RuntimeAgingEvidence }
  | { eligible: false; reason: string }

export type RuntimeTmuxManagerFactory = (options: { socketPath: string }) => Pick<
  ServerTmuxManager,
  'inspectWindow'
>

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'zombie'])

function runtimeTmuxIdentity(runtime: HrcRuntimeSnapshot): RuntimeTmuxIdentity | undefined {
  const tmux = runtime.tmuxJson
  if (!tmux) return undefined
  const socketPath = tmux['socketPath']
  const sessionName = tmux['sessionName']
  const windowName = tmux['windowName']
  const sessionId = tmux['sessionId']
  const windowId = tmux['windowId']
  const paneId = tmux['paneId']
  if (
    typeof socketPath !== 'string' ||
    socketPath.length === 0 ||
    typeof sessionName !== 'string' ||
    sessionName.length === 0 ||
    typeof windowName !== 'string' ||
    windowName.length === 0 ||
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    typeof windowId !== 'string' ||
    windowId.length === 0 ||
    typeof paneId !== 'string' ||
    paneId.length === 0
  ) {
    return undefined
  }
  return { socketPath, sessionName, windowName, sessionId, windowId, paneId }
}

function runtimeBrokerPid(runtime: HrcRuntimeSnapshot): number | undefined {
  const broker = runtime.runtimeStateJson?.['broker']
  if (broker === null || typeof broker !== 'object' || Array.isArray(broker)) return undefined
  const brokerPid = (broker as Record<string, unknown>)['brokerPid']
  return typeof brokerPid === 'number' ? brokerPid : undefined
}

function tmuxIdentityMatches(
  expected: RuntimeTmuxIdentity,
  observed: RuntimeTmuxIdentity
): boolean {
  return (
    expected.socketPath === observed.socketPath &&
    expected.sessionName === observed.sessionName &&
    expected.windowName === observed.windowName &&
    expected.sessionId === observed.sessionId &&
    expected.windowId === observed.windowId &&
    expected.paneId === observed.paneId
  )
}

/**
 * Shared liveness gate for manual runtime sweep and recurring tmux aging.
 *
 * Age/status filtering happens before this function. It only returns eligible
 * after every durable ownership edge and process/substrate probe is negative.
 * Ambiguity is a named skip, never permission to stale.
 */
export async function evaluateRuntimeAgingDisposition(
  runtime: HrcRuntimeSnapshot,
  input: {
    db: HrcDatabase
    tmuxManagerFactory: RuntimeTmuxManagerFactory
  }
): Promise<RuntimeAgingDisposition> {
  if (runtime.status === 'busy') {
    return { eligible: false, reason: 'busy' }
  }
  if (runtime.activeRunId !== undefined) {
    return { eligible: false, reason: 'active_run' }
  }
  if (
    input.db.runs
      .listByRuntimeId(runtime.runtimeId)
      .some((run) => !TERMINAL_RUN_STATUSES.has(run.status))
  ) {
    return { eligible: false, reason: 'nonterminal_run' }
  }

  if (runtime.childPid !== undefined && isLiveProcess(runtime.childPid)) {
    return { eligible: false, reason: 'live_child_pid' }
  }
  if (runtime.wrapperPid !== undefined && isLiveProcess(runtime.wrapperPid)) {
    return { eligible: false, reason: 'live_wrapper_pid' }
  }
  const persistedBrokerPid = runtimeBrokerPid(runtime)
  if (persistedBrokerPid !== undefined && isLiveProcess(persistedBrokerPid)) {
    return { eligible: false, reason: 'live_broker_pid' }
  }

  const invocation =
    runtime.activeInvocationId !== undefined
      ? input.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
      : null
  if (runtime.activeInvocationId !== undefined && invocation === null) {
    return { eligible: false, reason: 'missing_invocation' }
  }
  if (invocation?.brokerPid !== undefined && isLiveProcess(invocation.brokerPid)) {
    return { eligible: false, reason: 'live_invocation_broker_pid' }
  }
  if (invocation?.childPid !== undefined && isLiveProcess(invocation.childPid)) {
    return { eligible: false, reason: 'live_invocation_child_pid' }
  }

  if (runtime.transport === 'tmux') {
    const identity = runtimeTmuxIdentity(runtime)
    if (identity === undefined) {
      return { eligible: false, reason: 'missing_tmux_identity' }
    }
    let observed: TmuxPaneState | null
    try {
      observed = await input
        .tmuxManagerFactory({ socketPath: identity.socketPath })
        .inspectWindow({ sessionName: identity.sessionName, windowName: identity.windowName })
    } catch {
      return { eligible: false, reason: 'tmux_probe_error' }
    }
    if (observed !== null) {
      return {
        eligible: false,
        reason: tmuxIdentityMatches(identity, observed) ? 'live_tmux' : 'tmux_identity_mismatch',
      }
    }
  }

  return {
    eligible: true,
    evidence: {
      invocationId: runtime.activeInvocationId ?? null,
      invocationBrokerPid: invocation?.brokerPid ?? null,
      invocationChildPid: invocation?.childPid ?? null,
    },
  }
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
  filter: ListRuntimesFilter,
  resolvedStaleThresholdMs: number
): HrcRuntimeSnapshot[] {
  const explicitStatuses = filter.status !== undefined && filter.status.length > 0
  const statusSet = explicitStatuses ? new Set(filter.status) : null
  const staleThresholdMs = filter.olderThanMs ?? resolvedStaleThresholdMs
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
    if (filter.agent !== undefined || filter.task !== undefined) {
      let parsed: ReturnType<typeof parseScopeRef>
      try {
        parsed = parseScopeRef(runtime.scopeRef)
      } catch {
        return false
      }
      if (filter.agent !== undefined && parsed.agentId !== filter.agent) {
        return false
      }
      if (filter.task !== undefined && parsed.taskId !== filter.task) {
        return false
      }
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
