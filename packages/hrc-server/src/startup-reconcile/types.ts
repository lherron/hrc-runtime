import type { HrcRuntimeSnapshot, KillBrokerTmuxLeasesResponse } from 'hrc-core'
import type {
  BrokerControllerAttachResult,
  BrokerUnixClientFactory,
  HarnessBrokerController,
} from '../broker/controller.js'
import type { TmuxPaneState } from '../tmux.js'

export const DEFAULT_BROKER_ORPHAN_SWEEP_GRACE_MS = 5 * 60 * 1000
export const HRC_REAPED_RUN_ERROR_MESSAGE = 'runtime lifecycle is incompatible with an active run'
export const USER_INITIATED_CONTINUATION_CLEAR_REASONS = new Set([
  'prompt_input_exit',
  'logout',
  'clear',
])

export type BrokerTmuxLeaseSweepOptions = {
  graceMs: number
  removeDeadSocketFiles: boolean
  killLiveLeaseServers: boolean
}

export type BrokerTmuxLeaseSweepResult = Omit<KillBrokerTmuxLeasesResponse, 'ok'>

/**
 * Application-level broker liveness, observed via a `broker.health` round-trip
 * (NOT a raw socket connect). `ok`/`degraded` are both IPC-live and attach-
 * eligible; `shutting_down` means the broker is draining (skip binding, but the
 * runtime is NOT dead); `unreachable` covers connect/timeout/RPC failure and is
 * treated as non-terminal for durable runtimes (the lease may still be valid).
 */
export type BrokerHealthState = 'ok' | 'degraded' | 'shutting_down' | 'unreachable'

export type BrokerReattachProbe = {
  brokerSocketLive: boolean
  brokerWindow: TmuxPaneState | null
  tuiWindow: TmuxPaneState | null
  userExited?: boolean | undefined
  /** Result of the `broker.health` round-trip; absent for legacy/raw probes. */
  brokerHealth?: BrokerHealthState | undefined
}

export type DurableBrokerReattachDeps = {
  controller: Pick<HarnessBrokerController, 'attachAndReplay'>
  brokerUnixClientFactory: BrokerUnixClientFactory
  resolveAttachToken(runtime: HrcRuntimeSnapshot): Promise<string | undefined>
  probeBrokerLease(runtime: HrcRuntimeSnapshot): Promise<BrokerReattachProbe>
  /**
   * When false, do classification/orphan work ONLY — probe + lease-identity
   * checks that may stale a genuinely-dead runtime — but do NOT attach+replay a
   * live one onto the controller (it returns `broker-attachable` and is left
   * intact for the serving controller's warmup). This keeps a single attach
   * authority: the pre-instance reconcile classifies; the post-construction
   * serving warm is the only path that binds onto the request-serving controller
   * (the one with a live `notifyEvent` loop). Defaults to true (attach).
   */
  attach?: boolean | undefined
}

export type BrokerReattachOutcome = {
  runtimeId: string
  state:
    | 'broker-attached'
    | 'broker-attachable'
    | 'broker-shutting-down'
    | 'direct-tmux-degraded'
    | 'terminated'
    | 'stale'
    | 'broker-ipc-unavailable'
  brokerAttached: boolean
  replayedThroughSeq?: number | undefined
  reason?: string | undefined
}

export type BrokerWindowObservation = {
  brokerWindow: TmuxPaneState | null
  tuiWindow: TmuxPaneState | null
}

/** Operator-visible warmup category, derived from a BrokerReattachOutcome. */
export type BrokerWarmupCategory =
  | 'attached'
  | 'skipped_shutting_down'
  | 'ipc_unreachable_nonterminal'
  | 'substrate_gone_stale'
  | 'lease_identity_invalid_stale'
  | 'attach_replay_failed'
  | 'terminated'
  | 'other'

export type BrokerWarmupSummary = {
  total: number
  attached: number
  byCategory: Record<BrokerWarmupCategory, number>
}

export type { BrokerControllerAttachResult }
