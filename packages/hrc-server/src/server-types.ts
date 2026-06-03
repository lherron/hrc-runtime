import type {
  HrcErrorCode,
  HrcEventEnvelope,
  HrcLaunchRecord,
  HrcLifecycleEvent,
  HrcMessageAddress,
  HrcMessageRecord,
  HrcProvider,
  HrcRunRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  ReconcileActiveRunReason,
  SweepZombieRunResult,
} from 'hrc-core'
import type { HrcLifecycleQueryFilters } from 'hrc-store-sqlite'
import type { SdkInflightInputClient } from './agent-spaces-adapter/index.js'
import type { GhostmuxManagerOptions } from './ghostmux.js'

export type HrcEventsRouteFilters = Omit<
  HrcLifecycleQueryFilters,
  'fromHrcSeq' | 'fromStreamSeq' | 'limit' | 'launchId'
>

export type InFlightInputResponse = {
  accepted: boolean
  runtimeId: string
  runId: string
  pendingTurns?: number | undefined
}

export type AttachDescriptorResponse = {
  transport: 'tmux' | 'ghostty'
  argv: string[]
  bindingFence: {
    hostSessionId: string
    runtimeId: string
    generation: number
    windowId?: string | undefined
    tabId?: string | undefined
    paneId?: string | undefined
    surfaceId?: string | undefined
  }
}

export type PreparedSemanticDmPayload = {
  payload: string
  runId?: string | undefined
  normalizedIntent?: HrcRuntimeIntent | undefined
}

export type FollowSubscriber = (event: HrcEventEnvelope | HrcLifecycleEvent) => void

export type MessageSubscriber = (record: HrcMessageRecord) => void

export type TurnResponseFinalizer = {
  requestMessageId: string
  from: HrcMessageAddress
  to: HrcMessageAddress
  mode: 'headless' | 'interactive' | 'nonInteractive'
  sessionRef: string
}

export type PendingBrokerLiteralInput = {
  sessionRef: string
  hostSessionId: string
  generation: number
  text: string
}

export type AttachBeforeInvocationStartOption = {
  pendingStartId: string
}

export type PendingAttachedRunOperation = Promise<unknown>

export type ExactRouteHandler = (request: Request, url: URL) => Response | Promise<Response>

export type LaunchLifecyclePayload = {
  hostSessionId: string
  timestamp?: string | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
  exitCode?: number | undefined
  signal?: string | undefined
}

export type LaunchContinuationPayload = {
  hostSessionId: string
  continuation: {
    provider: HrcProvider
    key?: string | undefined
  }
  harnessSessionJson?: Record<string, unknown> | undefined
  timestamp?: string | undefined
}

export type LaunchEventPayload = Record<string, unknown> & {
  type: string
}

export type HookEnvelope = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  hookData: unknown
}

export type SessionRow = {
  host_session_id: string
  scope_ref: string
  lane_ref: string
  generation: number
  status: string
  prior_host_session_id: string | null
  created_at: string
  updated_at: string
  parsed_scope_json: string | null
  ancestor_scope_refs_json: string
  last_applied_intent_json: string | null
  continuation_json: string | null
}

export type HrcServerRunRow = {
  run_id: string
  host_session_id: string
  runtime_id: string | null
  scope_ref: string
  lane_ref: string
  generation: number
  transport: string
  status: string
  accepted_at: string | null
  started_at: string | null
  completed_at: string | null
  updated_at: string
  error_code: HrcErrorCode | null
  error_message: string | null
}

export type ZombieObservedSource = SweepZombieRunResult['observedSource']

export type ObservedRunActivity = {
  observedAt: string
  observedSource: ZombieObservedSource
  latestEventAt?: string | undefined
}

export type ZombieRunCandidate = {
  run: HrcRunRecord
} & ObservedRunActivity

export type ActiveRunReconcileCandidate = {
  run: HrcRunRecord
  runtime: HrcRuntimeSnapshot
  launch?: HrcLaunchRecord | undefined
} & ObservedRunActivity

export type ActiveRunReconcilePlan = {
  reason: ReconcileActiveRunReason
  action: 'reap' | 'suspect'
  errorCode?: HrcErrorCode | undefined
  nextRuntimeStatus?: string | undefined
}

export type LatestRunEventRow = {
  ts: string
}

export type HrcServerOptions = {
  runtimeRoot: string
  stateRoot: string
  socketPath: string
  lockPath: string
  spoolDir: string
  dbPath: string
  /**
   * Preferred port for the OTLP/HTTP log ingest listener on 127.0.0.1. Falls
   * back to an OS-chosen ephemeral port if occupied. Defaults to 4318.
   */
  otelPreferredPort?: number | undefined
  /**
   * Disable the OTLP listener entirely (tests/environments that don't want
   * Codex OTEL ingest). When false, the server runs without OTEL capture and
   * `otelEndpoint` is undefined.
   */
  otelListenerEnabled?: boolean | undefined
  /**
   * Test-only override: if provided, no listener is started and this string is
   * stamped into launch artifacts verbatim. Useful for integration tests that
   * want deterministic URLs without binding a real port.
   */
  otelEndpoint?: string | undefined
  tmuxSocketPath?: string | undefined
  /**
   * Auto-rotation policy: a session whose `createdAt` exceeds this age (in
   * seconds) will be rotated to a new generation before dispatch, unless the
   * caller passes `allowStaleGeneration: true`. Default = 24h. Set to `0` to
   * disable the check (equivalent to `staleGenerationEnabled: false`).
   *
   * Env override: `HRC_STALE_GENERATION_HOURS` (hours, floating-point allowed).
   */
  staleGenerationThresholdSec?: number | undefined
  /**
   * Kill-switch for the stale-generation auto-rotation feature. When `false`,
   * sessions are never auto-rotated regardless of age. Default = `true`.
   *
   * Env override: `HRC_STALE_GENERATION_ENABLED` (`0`/`false` disables).
   */
  staleGenerationEnabled?: boolean | undefined
  /**
   * Cut headless OpenAI Codex dispatch over to the Harness Broker. Default on.
   *
   * Env override: `HRC_HEADLESS_CODEX_BROKER_ENABLED` (`0`/`false` disables).
   */
  headlessCodexBrokerEnabled?: boolean | undefined
  /**
   * Cut interactive Claude Code tmux dispatch over to the Harness Broker. Default on.
   *
   * Env override: `HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED` (`0`/`false` disables).
   */
  claudeCodeTmuxBrokerEnabled?: boolean | undefined
  /**
   * Cut interactive Codex CLI tmux dispatch over to the Harness Broker. Default on.
   *
   * Env override: `HRC_CODEX_CLI_TMUX_BROKER_ENABLED` (`0`/`false` disables).
   */
  codexCliTmuxBrokerEnabled?: boolean | undefined
  /**
   * Enable the durable Unix-IPC broker route (T-01810 / T-01801 Phase 1). OFF by
   * default (truthy-only), unlike the default-on broker cutover flags.
   *
   * Env override: `HRC_BROKER_DURABLE_IPC_ENABLED` (truthy enables).
   */
  brokerDurableIpcEnabled?: boolean | undefined
  sdkInflightInputClient?: SdkInflightInputClient | undefined
  sdkInflightInputRetryDelayMs?: number | undefined
  sdkInflightInputMissingActiveRunRetryMs?: number | undefined
  ghostmuxOptions?: GhostmuxManagerOptions | undefined
}

export type HrcServer = {
  stop(): Promise<void>
  /** Resolved OTLP/HTTP log ingest URL (e.g. http://127.0.0.1:4318/v1/logs), if the listener is active. */
  readonly otelEndpoint: string | undefined
}
