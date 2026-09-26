import type { HrcContinuationRef } from '../contracts'

/**
 * Compile-time records copied from the producer continuation protocol. These
 * labels must remain representable as persisted continuation history without
 * widening the closed HRC runtime-selection provider union.
 */
export const realPersistedContinuations = [
  {
    provider: 'codex',
    kind: 'thread',
    key: '01a00cfd-0740-7872-91f3-0cf61a25cafa',
  },
  {
    provider: 'openai-codex',
    kind: 'session',
    key: 'agent-harness-session-08438',
  },
] satisfies readonly HrcContinuationRef[]
