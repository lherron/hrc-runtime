import type { HrcDeliveryOutcome, HrcDeliveryWarning } from 'hrc-core'

export function writeDeliveryWarnings(warnings: HrcDeliveryWarning[] | undefined): void {
  for (const warning of warnings ?? []) {
    process.stderr.write(`hrcchat: warning [${warning.code}]: ${warning.message}\n`)
  }
}

/**
 * Render the outcome of an urgent send. `admitted` deliberately says "admitted
 * into the active turn" rather than anything stronger: the harness accepted the
 * text into the running turn, which is not proof the agent replanned before an
 * already-running tool produced another side effect.
 */
export function writeDeliveryOutcome(delivery: HrcDeliveryOutcome | undefined): void {
  if (delivery === undefined) return
  if (delivery.code === 'admitted_into_active_turn') {
    process.stderr.write(
      `hrcchat: steer [${delivery.code}]: admitted into the target's active turn (run ${delivery.mergedIntoRunId}); no separate reply will follow\n`
    )
    return
  }
  if (delivery.code === 'presented_to_live_harness') {
    // T-07203: pane-write proof only — never claim admission. The harness
    // decides whether the text joins the active turn or a later prompt.
    process.stderr.write(
      `hrcchat: steer [${delivery.code}]: written into the target's live session mid-turn (run ${delivery.presentedDuringRunId}); the harness decides when it takes effect — this is not admission proof\n`
    )
    return
  }
  process.stderr.write(
    `hrcchat: steer [${delivery.code}]: target was idle; the order started its own turn\n`
  )
}
