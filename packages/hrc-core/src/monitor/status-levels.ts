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
} as const satisfies Record<string, HrcRuntimeStatusLevel | null>
