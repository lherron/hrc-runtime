import {
  HrcConflictError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
} from 'hrc-core'
import type {
  HrcHarness,
  HrcProvider,
  HrcRunRecord,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { isRuntimeUnavailableStatus } from './server-util.js'
import { isRunActive, isTerminalBrokerInvocationState } from './require-helpers.js'

export type InteractiveRuntimeSelectionView = {
  transport: string
  status: string
}

export function selectLatestInteractiveRuntime<T extends InteractiveRuntimeSelectionView>(
  runtimes: readonly T[]
): T | null {
  return (
    runtimes
      .filter((runtime) => runtime.transport === 'tmux' || runtime.transport === 'ghostty')
      .at(-1) ?? null
  )
}

export function selectDispatchInteractiveRuntime<T extends InteractiveRuntimeSelectionView>(
  runtimes: readonly T[]
): T | null {
  const interactive = runtimes.filter(
    (runtime) => runtime.transport === 'tmux' || runtime.transport === 'ghostty'
  )
  const available = interactive.filter((runtime) => !isRuntimeUnavailableStatus(runtime.status))
  return available.at(-1) ?? interactive.at(-1) ?? null
}

export function findLatestRuntime(db: HrcDatabase, hostSessionId: string): HrcRuntimeSnapshot | null {
  return selectLatestInteractiveRuntime(db.runtimes.listByHostSessionId(hostSessionId))
}

export function findDispatchInteractiveRuntime(
  db: HrcDatabase,
  hostSessionId: string
): HrcRuntimeSnapshot | null {
  return selectDispatchInteractiveRuntime(db.runtimes.listByHostSessionId(hostSessionId))
}

export function getReusableHeadlessRuntimeForSession(
  db: HrcDatabase,
  hostSessionId: string,
  provider: HrcProvider,
  harnessId?: HrcHarness | undefined
): HrcRuntimeSnapshot | null {
  const runtime = db.runtimes
    .listByHostSessionId(hostSessionId)
    .filter((candidate) => {
      if (candidate.transport !== 'headless' || candidate.provider !== provider) {
        return false
      }
      // When the intent specifies a harness id, only reuse runtimes labeled
      // with the same id — provider-only reuse is unsafe across SDK/CLI lines
      // (e.g. a Codex CLI runtime cannot serve a pi-sdk turn).
      if (harnessId !== undefined && candidate.harness !== harnessId) {
        return false
      }
      if (candidate.controllerKind === 'harness-broker') {
        if (candidate.activeInvocationId === undefined) {
          return false
        }
        const invocation = db.brokerInvocations.getByInvocationId(candidate.activeInvocationId)
        if (!invocation || isTerminalBrokerInvocationState(invocation.invocationState)) {
          return false
        }
      }
      return true
    })
    .at(-1)
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    return null
  }
  return runtime
}

export function findBusyHeadlessRuntimeForSession(
  db: HrcDatabase,
  hostSessionId: string
): HrcRuntimeSnapshot | null {
  return (
    db.runtimes
      .listByHostSessionId(hostSessionId)
      .filter((runtime) => {
        if (
          runtime.transport !== 'headless' ||
          runtime.activeRunId === undefined ||
          isRuntimeUnavailableStatus(runtime.status)
        ) {
          return false
        }

        const activeRun = db.runs.getByRunId(runtime.activeRunId)
        return !activeRun || isRunActive(activeRun)
      })
      .at(-1) ?? null
  )
}

export function findLatestSessionRuntime(
  db: HrcDatabase,
  hostSessionId: string
): HrcRuntimeSnapshot | null {
  return db.runtimes.listByHostSessionId(hostSessionId).at(-1) ?? null
}

/**
 * Resolve the runtime that best represents a session for operator-facing views
 * (getTarget/doctor/who) and pane capture/peek: prefer the latest live
 * interactive (tmux/ghostty) runtime so a newer headless dm-runtime cannot
 * shadow the live TUI. Falls back to the latest available runtime of any
 * transport (headless/sdk buffer capture), then the latest runtime regardless
 * of status so callers can still report a stale/unavailable binding.
 */
export function findBoundSessionRuntime(
  db: HrcDatabase,
  hostSessionId: string
): HrcRuntimeSnapshot | null {
  const runtimes = db.runtimes.listByHostSessionId(hostSessionId)
  const interactive = runtimes.filter(
    (runtime) =>
      (runtime.transport === 'tmux' || runtime.transport === 'ghostty') &&
      !isRuntimeUnavailableStatus(runtime.status)
  )
  if (interactive.length > 0) {
    return interactive.at(-1) ?? null
  }
  const available = runtimes.filter((runtime) => !isRuntimeUnavailableStatus(runtime.status))
  if (available.length > 0) {
    return available.at(-1) ?? null
  }
  return runtimes.at(-1) ?? null
}

export function findLatestRunForRuntime(db: HrcDatabase, runtimeId: string): HrcRunRecord | null {
  return db.runs.listByRuntimeId(runtimeId).at(-1) ?? null
}

export function resolveActiveRunId(db: HrcDatabase, runtime: HrcRuntimeSnapshot): string {
  const activeRun =
    runtime.activeRunId !== undefined ? db.runs.getByRunId(runtime.activeRunId) : null
  const latestRun = findLatestRunForRuntime(db, runtime.runtimeId)
  const runId = activeRun?.runId ?? latestRun?.runId
  if (!runId) {
    throw new HrcConflictError(
      HrcErrorCode.RUN_MISMATCH,
      'no active run available for semantic in-flight input',
      {
        runtimeId: runtime.runtimeId,
      }
    )
  }

  return runId
}


export function requireLatestRuntime(db: HrcDatabase, hostSessionId: string): HrcRuntimeSnapshot {
  const runtime = findLatestRuntime(db, hostSessionId)
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    throw new HrcRuntimeUnavailableError(`no ready runtime for host session "${hostSessionId}"`, {
      hostSessionId,
    })
  }
  return runtime
}

export function requireLatestSessionRuntime(db: HrcDatabase, hostSessionId: string): HrcRuntimeSnapshot {
  const runtime = findLatestSessionRuntime(db, hostSessionId)
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    throw new HrcRuntimeUnavailableError(`no ready runtime for host session "${hostSessionId}"`, {
      hostSessionId,
    })
  }
  return runtime
}
