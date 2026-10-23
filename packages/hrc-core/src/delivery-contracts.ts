/**
 * Sender-visible evidence that durable acceptance did not mean immediate
 * presentation to the target agent.
 *
 * `queued_behind_busy_turn` (headless): the input genuinely waits until the
 * active turn completes — the deferral fence is until-turn-end.
 *
 * `queued_to_live_harness` (interactive, T-07203): the input was queued to a
 * live harness that may surface queued input mid-turn at its own tool-call
 * boundaries — or after the turn. The timing is the harness's choice.
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
 * Sender-visible outcome of a legacy urgent delivery.
 *
 * `admitted_into_active_turn` means the input was ADMITTED into the turn that
 * was already running. It is NOT proof that the model replanned before an
 * already-running tool produced another side effect — the harness accepts the
 * text into the turn, and what the model does with it is the model's business.
 * Consumers must not read this as compliance evidence.
 *
 * A steer that joins a running turn produces no turn and no reply of its own,
 * so `mergedIntoRunId` points at the run it joined rather than at a run
 * belonging to this message. (A steer to an idle seat starts a turn instead.)
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
