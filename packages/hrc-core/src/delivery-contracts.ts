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

/**
 * Sender-visible outcome of an urgent (`whenBusy: 'steer'`) delivery.
 *
 * `admitted_into_active_turn` means the input was ADMITTED into the turn that
 * was already running. It is NOT proof that the model replanned before an
 * already-running tool produced another side effect — the harness accepts the
 * text into the turn, and what the model does with it is the model's business.
 * Consumers must not read this as compliance evidence.
 *
 * A steer produces no turn and no reply of its own, so `mergedIntoRunId` points
 * at the run it joined rather than at a run belonging to this message.
 */
export type HrcDeliveryOutcome =
  | { code: 'started_fresh_turn'; delivery: 'started' }
  | {
      code: 'admitted_into_active_turn'
      delivery: 'admitted'
      mergedIntoRunId: string
      turnId?: string | undefined
      deliverySemantics: 'interrupting_steer'
      ackSemantics: 'accepted_only'
    }

export const HRC_STARTED_FRESH_TURN_OUTCOME: HrcDeliveryOutcome = {
  code: 'started_fresh_turn',
  delivery: 'started',
}

export function hrcAdmittedIntoActiveTurn(input: {
  mergedIntoRunId: string
  turnId?: string | undefined
}): HrcDeliveryOutcome {
  return {
    code: 'admitted_into_active_turn',
    delivery: 'admitted',
    mergedIntoRunId: input.mergedIntoRunId,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    deliverySemantics: 'interrupting_steer',
    ackSemantics: 'accepted_only',
  }
}

/**
 * Lifecycle of a durable urgent-delivery contribution (T-07155).
 *
 * `attempting` exists only across the broker RPC; it is a write-ahead marker, not
 * an admitted-pending state. Recovery seals it rather than waiting on it, so it
 * can never become the limbo the design set out to avoid.
 */
export type HrcSteerContributionState =
  | 'attempting'
  | 'admitted'
  | 'unsupported'
  | 'race_lost'
  | 'ambiguous'

export type HrcSteerContributionRecord = {
  contributionId: string
  hostSessionId: string
  idempotencyKey?: string | undefined
  requestHash?: string | undefined
  runtimeId: string
  invocationId: string
  activeRunId: string
  inputId: string
  state: HrcSteerContributionState
  outcomeCode?: string | undefined
  outcome?: Record<string, unknown> | undefined
  createdAt: string
  updatedAt: string
}
