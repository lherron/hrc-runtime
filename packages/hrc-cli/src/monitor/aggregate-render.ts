import type { HrcMonitorOutcome, HrcMonitorRuntimeState } from 'hrc-core'

export type MonitorConditionMember = {
  scopeRef: string
  runtimeId: string
  status: string
  statusChangedAt: string
  matchedCondition?: string | undefined
}

export type MonitorConditionEvent = {
  event: 'monitor.armed' | 'monitor.completed' | 'monitor.stalled'
  selector: string
  quantifier: 'exact' | 'any' | 'all'
  conditions: string[]
  phase: 'before-arm' | 'at-arm' | 'after-arm'
  observedAt: string
  members: MonitorConditionMember[]
  result: string
  outcome: HrcMonitorOutcome
  exitCode: number
  matchedCondition?: string | undefined
  scopeRef?: string | undefined
  runtimeId?: string | undefined
  replayed: false
  ts: string
}

export function monitorMember(
  runtime: HrcMonitorRuntimeState,
  scopeRef: string,
  matchedCondition?: string | undefined
): MonitorConditionMember {
  return {
    scopeRef,
    runtimeId: runtime.runtimeId,
    status: runtime.status,
    statusChangedAt: runtime.statusChangedAt ?? 'unknown',
    ...(matchedCondition !== undefined ? { matchedCondition } : {}),
  }
}
