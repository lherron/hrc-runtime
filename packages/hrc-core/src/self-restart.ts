/**
 * T-09872 — `hrc restartme`: an agent restarts itself into a fresh context at
 * the end of the turn that armed it, gated on a wrkq handoff. The caller is
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

/** Inline a pending HRC obligation, or retain the legacy wrkq resume recipe. */
export function selfRestartResumePrompt(input: {
  handoffId: string
  priorGeneration: number
  nextGeneration: number
  handoff?: { id: string; etag: number; title: string; body: string } | undefined
}): string {
  if (input.handoff) {
    const h = input.handoff
    return `Fresh context after self-restart (generation ${input.priorGeneration} → ${input.nextGeneration}). Pending HRC seat handoff ${h.id} (etag ${h.etag}). Absorb the handoff below, then acknowledge it with \`hrc handoff acknowledge ${h.id} --if-match ${h.etag} --note 'Consumed; <retained context>'\` and continue the work it describes.\n\n${h.title}\n\n${h.body}`
  }
  return `Fresh context after self-restart (generation ${input.priorGeneration} → ${input.nextGeneration}). Run \`wrkq handoff get ${input.handoffId} --json\`, absorb it, acknowledge it with \`wrkq handoff acknowledge\`, then continue the work it describes.`
}
