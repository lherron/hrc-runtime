/**
 * Sender-visible evidence that durable acceptance did not mean immediate
 * presentation to the target agent.
 *
 * `queued_behind_busy_turn` (headless): the input genuinely waits until the
 * active turn completes — the deferral fence is until-turn-end.
 *
 * `queued_to_live_harness` (interactive, T-07203): the input was queued to a
 * live harness that may surface queued input mid-turn at its own tool-call
 * boundaries — or after the turn. The timing is the harness's choice;
 * senders needing preemption semantics must use `whenBusy: 'steer'`.
 */
export type HrcDeliveryWarning =
  | {
      code: 'queued_behind_busy_turn'
      delivery: 'deferred'
      message: 'target is busy; delivery deferred until the active turn completes'
    }
  | {
      code: 'queued_to_live_harness'
      delivery: 'deferred'
      message: 'target is busy; input queued to the live harness and may surface mid-turn or after the active turn completes'
    }

export const HRC_QUEUED_BEHIND_BUSY_TURN_WARNING: HrcDeliveryWarning = {
  code: 'queued_behind_busy_turn',
  delivery: 'deferred',
  message: 'target is busy; delivery deferred until the active turn completes',
}

export const HRC_QUEUED_TO_LIVE_HARNESS_WARNING: HrcDeliveryWarning = {
  code: 'queued_to_live_harness',
  delivery: 'deferred',
  message:
    'target is busy; input queued to the live harness and may surface mid-turn or after the active turn completes',
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
 *
 * `presented_to_live_harness` (T-07203) is the WEAKER interactive-route truth:
 * the text was written into the target's live session while the named run was
 * active — and that is ALL it proves. The harness may fold it into the active
 * turn, hold it, or make it a later prompt; there is no admission evidence.
 * Consumers must never treat it as a landed stop order. Routes only report
 * `admitted_into_active_turn` when the actuator proves turn admission.
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
  | {
      code: 'presented_to_live_harness'
      delivery: 'presented'
      presentedDuringRunId: string
      deliverySemantics: 'pane_presentation'
      ackSemantics: 'pane_write_only'
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

export function hrcPresentedToLiveHarness(input: {
  presentedDuringRunId: string
}): HrcDeliveryOutcome {
  return {
    code: 'presented_to_live_harness',
    delivery: 'presented',
    presentedDuringRunId: input.presentedDuringRunId,
    deliverySemantics: 'pane_presentation',
    ackSemantics: 'pane_write_only',
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
  // T-07203: interactive-route success — pane presentation, NOT admission.
  | 'presented'
  // T-07203: the dispatch raced to an idle target and started a fresh turn;
  // the recorded activeRunId IS that fresh run. Replay reconstructs a started
  // dispatch instead of re-actuating.
  | 'started_fresh'
  // T-07214: a best-effort (steer_else_queue) attempt failed provably
  // NON-actuated and the delivery fell to the route's ordinary floor. Keyless,
  // audit-only: records the attempt-to-floor transition; never replayed.
  | 'queued_fallback'
  | 'unsupported'
  | 'race_lost'
  | 'ambiguous'

export type HrcSteerContributionRecord = {
  contributionId: string
  hostSessionId: string
  idempotencyKey?: string | undefined
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
