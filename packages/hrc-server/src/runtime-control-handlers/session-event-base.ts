import type { HrcSessionRecord } from 'hrc-core'

/**
 * The common HRC-event envelope fields projected from a session record plus a
 * timestamp: `{ ts, hostSessionId, scopeRef, laneRef, generation }`. Every
 * `appendHrcEvent` call in these handlers rebuilds exactly this clump by hand;
 * spreading the result of this projection keeps the payload shape identical
 * while removing the repetition.
 *
 * Per-event extras (`runtimeId`, `runId`, `transport`, `appId`, `payload`, …)
 * intentionally stay inline at each call site — this projection covers ONLY the
 * five always-present fields.
 */
export function sessionEventBase(
  session: Pick<HrcSessionRecord, 'hostSessionId' | 'scopeRef' | 'laneRef' | 'generation'>,
  ts: string
): {
  ts: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
} {
  return {
    ts,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
  }
}
