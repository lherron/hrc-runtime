import type { ParticipantAttempt } from 'hrc-store-sqlite'

const ABSORBING_ATTEMPT_STATES = new Set(['SUPERSEDED', 'ABANDONED', 'TERMINAL'])

export function isAbsorbingParticipantAttempt(attempt: ParticipantAttempt): boolean {
  return ABSORBING_ATTEMPT_STATES.has(attempt.state)
}
