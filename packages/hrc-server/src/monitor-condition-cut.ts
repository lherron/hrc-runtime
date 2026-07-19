import { randomUUID } from 'node:crypto'

import { RUNTIME_STATUS_LEVEL_BY_STATUS } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

export type MonitorConditionCutRequest = {
  selectors: string[]
  quantifier: 'any' | 'all'
  conditions: string[]
}

export type MonitorConditionCutMember = {
  scopeRef: string
  runtimeId: string
  status: string
  statusChangedAt: string
  matchedCondition?: string | undefined
}

/**
 * Reads quantified membership and member states from one SQLite snapshot.
 * The optional hook is a test seam proving a concurrent writer cannot create a
 * cross-cut aggregate; it runs after membership establishes the read snapshot.
 */
export function readMonitorConditionCut(
  db: HrcDatabase,
  request: MonitorConditionCutRequest,
  hooks: { afterMembershipRead?: (() => void) | undefined } = {}
): {
  observedAt: string
  observationId: string
  members: MonitorConditionCutMember[]
} {
  const read = db.sqlite.transaction(() => {
    const membership = db.runtimes
      .listAll()
      .filter((runtime) =>
        request.selectors.some((selector) => matchesSelector(runtime.scopeRef, selector))
      )
      .map((runtime) => runtime.runtimeId)

    hooks.afterMembershipRead?.()

    const members = membership.flatMap((runtimeId) => {
      const runtime = db.runtimes.getByRuntimeId(runtimeId)
      if (!runtime) return []
      const level = (RUNTIME_STATUS_LEVEL_BY_STATUS as Record<string, string | null | undefined>)[
        runtime.status
      ]
      const matchedCondition = request.conditions.find((condition) => condition === level)
      return [
        {
          scopeRef: runtime.scopeRef,
          runtimeId: runtime.runtimeId,
          status: runtime.status,
          statusChangedAt: runtime.statusChangedAt ?? 'unknown',
          ...(matchedCondition !== undefined ? { matchedCondition } : {}),
        },
      ]
    })
    return { observedAt: new Date().toISOString(), members }
  })

  return { ...read(), observationId: `monitor-cut:${randomUUID()}` }
}

function matchesSelector(scopeRef: string, selector: string): boolean {
  if (/^T-\d+$/.test(selector)) {
    const segment = `:task:${selector}`
    return scopeRef.endsWith(segment) || scopeRef.includes(`${segment}:`)
  }
  if (selector.startsWith('scope:') && selector.endsWith(':*')) {
    return scopeRef.startsWith(selector.slice('scope:'.length, -1))
  }
  if (selector.startsWith('scope:')) return scopeRef === selector.slice('scope:'.length)
  return false
}
