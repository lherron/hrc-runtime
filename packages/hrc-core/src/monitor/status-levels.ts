export type HrcRuntimeStatusLevel = 'idle' | 'busy' | 'runtime-dead'

/**
 * Frozen classification of every runtime status currently authored by HRC.
 * Transitional statuses intentionally satisfy no monitor level.
 */
export const RUNTIME_STATUS_LEVEL_BY_STATUS = {
  ready: 'idle',
  idle: 'idle',
  busy: 'busy',
  awaiting_input: 'busy',
  dead: 'runtime-dead',
  stale: 'runtime-dead',
  terminated: 'runtime-dead',
  stopped: 'runtime-dead',
  failed: 'runtime-dead',
  disposed: 'runtime-dead',
  crashed: 'runtime-dead',
  exited: 'runtime-dead',
  starting: null,
  stopping: null,
  adopted: null,
  detached: null,
} as const satisfies Record<string, HrcRuntimeStatusLevel | null>

/**
 * Every status a runtime can hold that means it will never run another turn.
 * Derived from the frozen classification above so the set cannot drift from it:
 * a new terminal status is terminal here the moment it is classified
 * `runtime-dead`. Callers that need "not live, not current" — `--previous`
 * runtime selection, monitor's runtime-dead guard — ask here rather than
 * hand-rolling a status list, which is how `--previous` came to recognize
 * `terminated` but not `stale`.
 */
export const TERMINAL_RUNTIME_STATUSES: ReadonlySet<string> = new Set(
  Object.entries(RUNTIME_STATUS_LEVEL_BY_STATUS)
    .filter(([, level]) => level === 'runtime-dead')
    .map(([status]) => status)
)

export function isTerminalRuntimeStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_RUNTIME_STATUSES.has(status)
}
