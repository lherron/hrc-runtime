/**
 * Sender-visible evidence that durable acceptance did not mean immediate
 * presentation to the target agent.
 */
export type HrcDeliveryWarning = {
  code: 'queued_behind_busy_turn'
  delivery: 'deferred'
  message: 'target is busy; delivery deferred until the active turn completes'
}

export const HRC_QUEUED_BEHIND_BUSY_TURN_WARNING: HrcDeliveryWarning = {
  code: 'queued_behind_busy_turn',
  delivery: 'deferred',
  message: 'target is busy; delivery deferred until the active turn completes',
}
