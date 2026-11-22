/**
 * T-09872 — `hrc restartme`: an agent restarts itself into a fresh context at
 * the end of the turn that armed it, gated on an HRC seat handoff. The caller is
 * identified by the T-09861 lifecycle credential headers; there is no target.
 */

export const HRC_RESTART_SELF_PATH = '/v1/runtimes/restart-self'

export type HrcRestartSelfRequest = { handoffId: string } | { cancel: true }

export type HrcRestartSelfRefusalCode =
  | 'credential_missing'
  | 'credential_unknown'
  | 'credential_revoked'
  | 'credential_mismatch'
  | 'no_active_turn'

export type HrcRestartSelfArmed = {
  outcome: 'armed'
  handoffId: string
  hostSessionId: string
  runtimeId: string
  generation: number
  invocationId: string
  turnId: string
  armedAt: string
  /** True when this call replaced an intent already armed for the same turn. */
  replaced: boolean
}

export type HrcRestartSelfCancelled = {
  outcome: 'cancelled'
  hostSessionId: string
  /** False when nothing was armed. */
  cancelled: boolean
  handoffId?: string | undefined
}

export type HrcRestartSelfResponse = HrcRestartSelfArmed | HrcRestartSelfCancelled
