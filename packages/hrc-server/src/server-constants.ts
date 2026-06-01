export const HRC_SERVER_RUN_COLUMNS = `
  run_id,
  host_session_id,
  runtime_id,
  scope_ref,
  lane_ref,
  generation,
  transport,
  status,
  accepted_at,
  started_at,
  completed_at,
  updated_at,
  error_code,
  error_message
`

export const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
}

export const HRC_EVENTS_KEEPALIVE_MS = 5_000

export const HRC_CLAUDE_GHOSTTY_ENV = 'HRC_CLAUDE_GHOSTTY'
export const HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV = 'HRC_HEADLESS_CODEX_BROKER_ENABLED'
export const HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED_ENV = 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED'
export const HRC_CODEX_CLI_TMUX_BROKER_ENABLED_ENV = 'HRC_CODEX_CLI_TMUX_BROKER_ENABLED'
// T-01810 (T-01801 Phase 1) — durable Unix-IPC broker route. OFF by default
// (truthy-only), unlike the default-ON broker cutover flags above.
export const HRC_BROKER_DURABLE_IPC_ENABLED_ENV = 'HRC_BROKER_DURABLE_IPC_ENABLED'

export const DEFAULT_STALE_GENERATION_THRESHOLD_SEC = 24 * 60 * 60
export const DEFAULT_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES = 15

export const HRC_ZOMBIE_SWEEP_ENABLED = true
export const HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS = 300
export const HRC_ZOMBIE_RUN_TIMEOUT_SECONDS = 1800
export const HRC_ACTIVE_RUN_RECONCILE_ENABLED = true
export const HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_INTERVAL_MS = 30_000

export const HRC_BUSY_HEADLESS_DM_REJECTION_CODE = 'runtime_busy_dm_rejected'
export const HRC_BUSY_HEADLESS_DM_REJECTION_MESSAGE =
  'target session has a busy headless runtime; hrcchat dm will not spawn a parallel runtime'
