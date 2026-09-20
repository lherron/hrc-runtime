import { writeServerLog } from './server-log.js'

/**
 * One in-process, monotonic timeline for a fresh HRC birth. The timeline is
 * deliberately observational: it neither changes authority nor gates a start.
 * Every mark repeats the stable join keys because log rotation makes a single
 * begin record an unreliable lookup anchor.
 */
export type BirthTimeline = {
  mark(phase: string, fields?: Record<string, unknown>): void
  /** Add identifiers once a later phase has allocated them. */
  enrich(fields: Record<string, unknown>): void
}

export function createBirthTimeline(input: {
  scopeRef: string
  laneRef: string
  /** Stable request-level key, available before HRC mints a run. */
  birthId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runId?: string | undefined
  presentation?: string | undefined
  now?: () => number
  logger?: (fields: Record<string, unknown>) => void
}): BirthTimeline {
  const now = input.now ?? (() => performance.now())
  const startedAt = now()
  let previousAt = startedAt
  const correlation: Record<string, unknown> = {}

  return {
    mark(phase, extra = {}) {
      const observedAt = now()
      const durMs = Number((observedAt - previousAt).toFixed(1))
      const elapsedMs = Number((observedAt - startedAt).toFixed(1))
      previousAt = observedAt
      try {
        const fields = {
          phase,
          durMs,
          elapsedMs,
          scopeRef: input.scopeRef,
          laneRef: input.laneRef,
          ...(input.birthId !== undefined ? { birthId: input.birthId } : {}),
          ...(input.hostSessionId !== undefined ? { hostSessionId: input.hostSessionId } : {}),
          ...(input.generation !== undefined ? { generation: input.generation } : {}),
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          ...(input.presentation !== undefined ? { presentation: input.presentation } : {}),
          ...correlation,
          ...extra,
        }
        if (input.logger !== undefined) input.logger(fields)
        else writeServerLog('INFO', 'runtime.birth.timeline', fields)
      } catch {
        // Timing must never change a launch outcome.
      }
    },
    enrich(fields) {
      Object.assign(correlation, fields)
    },
  }
}
