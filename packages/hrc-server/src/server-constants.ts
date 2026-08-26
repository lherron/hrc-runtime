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

export const STREAMING_NDJSON_HEADERS = {
  ...NDJSON_HEADERS,
  'x-hrc-streaming': '1',
}

export const HRC_EVENTS_KEEPALIVE_MS = 5_000
export const HRC_BOUNDED_EVENTS_MAX_RECORDS = 2_048
export const HRC_BOUNDED_EVENTS_MAX_BYTES = 16 * 1024 * 1024

export const HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV = 'HRC_HEADLESS_CODEX_BROKER_ENABLED'
export const HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED_ENV = 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED'
export const HRC_CODEX_CLI_TMUX_BROKER_ENABLED_ENV = 'HRC_CODEX_CLI_TMUX_BROKER_ENABLED'
export const HRC_PI_TUI_TMUX_BROKER_ENABLED_ENV = 'HRC_PI_TUI_TMUX_BROKER_ENABLED'
export const HRC_AGENT_HARNESS_TMUX_BROKER_ENABLED_ENV = 'HRC_AGENT_HARNESS_TMUX_BROKER_ENABLED'
// T-01810 (T-01801 Phase 1) — durable Unix-IPC broker route. OFF by default
// (truthy-only), unlike the default-ON broker cutover flags above.
export const HRC_BROKER_DURABLE_IPC_ENABLED_ENV = 'HRC_BROKER_DURABLE_IPC_ENABLED'
// T-06810 Wave 2 — mailbox orchestration stays dark until fleet burn-in.
export const HRC_MAIL_KICKER_ENABLED_ENV = 'HRC_MAIL_KICKER_ENABLED'
export const HRC_MAIL_MAX_ROUNDS_ENV = 'HRC_MAIL_MAX_ROUNDS'
export const HRC_TMUX_AGING_ENABLED_ENV = 'HRC_TMUX_AGING_ENABLED'
// T-04921 (T-04905 Phase A) — HRC-owned operator-presentation policy DEFAULT for
// the codex-app-server headless-viewer route. Set to 'tmux-tui' to request the
// dual-tmux viewer for codex-app-server headless runtimes; unset / any other
// value keeps ordinary headless (presentation='none'). The DEFAULT lives here as
// an env policy source; the route decision still gates on driver applicability.
export const HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION_ENV =
  'HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION'
export const HRC_GHOSTTY_VIEWERS_ENV = 'HRC_GHOSTTY_VIEWERS'
export const HRC_GHOSTTY_VIEWER_LINGER_SECONDS_ENV = 'HRC_GHOSTTY_VIEWER_LINGER_SECONDS'
export const DEFAULT_GHOSTTY_VIEWER_LINGER_SECONDS = 300
export const DEFAULT_ATTACHED_RUN_RESUME_TIMEOUT_MS = 120_000
// Must cover the whole attached launch pipeline: the ASP compile alone has been
// observed to stall past 50s, and the CLI applies no timeout of its own.
export const DEFAULT_ATTACHED_START_READY_TIMEOUT_MS = 120_000

export const DEFAULT_STALE_GENERATION_THRESHOLD_SEC = 24 * 60 * 60
export const DEFAULT_HRC_MAIL_KICKER_SWEEP_INTERVAL_MS = 1_000
export const DEFAULT_HRC_MAIL_MAX_ROUNDS = 5

/**
 * T-07575 session retention. The session store keeps every row forever (the
 * 2026-07-28 keep-forever ruling covers session records the same way it covers
 * observation events), so retention is applied to *projection breadth* rather
 * than to storage. Two independent windows:
 *
 * - PROJECTION days bounds what an unscoped `GET /v1/sessions` returns by
 *   default. Scoped reads (`?scopeRef=`) and `?all=true` stay unbounded.
 * - IDLE_ARCHIVE days bounds how long a session keeps claiming `status:
 *   'active'` after its last activity. Archiving is a view state, never a
 *   resume gate: `continuation_json` is untouched.
 */
export const HRC_SESSION_PROJECTION_DAYS_ENV = 'HRC_SESSION_PROJECTION_DAYS'
export const DEFAULT_SESSION_PROJECTION_DAYS = 7
export const HRC_SESSION_IDLE_ARCHIVE_DAYS_ENV = 'HRC_SESSION_IDLE_ARCHIVE_DAYS'
export const DEFAULT_SESSION_IDLE_ARCHIVE_DAYS = 7
export const HRC_SESSION_RETENTION_SWEEP_ENABLED_ENV = 'HRC_SESSION_RETENTION_SWEEP_ENABLED'
/** Idle archival is a daily-scale concern; it does not ride the 300s sweep cadence. */
export const HRC_SESSION_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

export const HRC_ZOMBIE_SWEEP_ENABLED = true
export const HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS = 300
export const HRC_TMUX_AGING_INTERVAL_SECONDS = 300
export const HRC_ZOMBIE_RUN_TIMEOUT_SECONDS = 1800
export const HRC_ACTIVE_RUN_RECONCILE_ENABLED = true
export const HRC_BUSY_HEADLESS_DM_REJECTION_CODE = 'runtime_busy_dm_rejected'
export const HRC_BUSY_HEADLESS_DM_REJECTION_MESSAGE =
  'target session has a busy headless runtime; hrcchat dm will not spawn a parallel runtime'
