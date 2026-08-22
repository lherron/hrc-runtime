/**
 * The one place a provisioning directive becomes a LAUNCH value (T-07398).
 *
 * `intent.provision` is the overlaid `[provisioning]` result — the agent
 * profile plus any project target, with the per-summon `+` directives applied
 * last. Until this module existed it was carried, validated and persisted to
 * `lastAppliedIntentJson`, and then dropped: every adapter read
 * `intent.harness.model`, which no sender populates from a directive, so a
 * runtime born from `+model=sonnet` launched `--model opus` and self-reported
 * claude-opus-5 (C-15425 / DM #230).
 *
 * WHY A SHARED HELPER RATHER THAN THREE FIXES. There are three doors to a
 * process (cli / compile / sdk) and the intent shape they receive is the
 * persisted one. Resolving the launch route here and calling it from all three
 * means a new door — or a caller that assembles an intent by hand — cannot
 * silently reintroduce the same hole; there is exactly one answer to "what
 * model is this runtime launching with".
 */

import type { HrcRuntimeIntent } from 'hrc-core'

/**
 * The model this runtime actually launches with.
 *
 * `harness.model` WINS when set. It is the explicit, launch-level choice a
 * caller made about this one invocation, whereas `provision.model` is the
 * merged default-plus-directive answer; preferring the explicit field also
 * means this change cannot alter the behaviour of any existing caller that
 * already sets it. The directive fills the gap that made the value evaporate.
 */
export function resolveLaunchModel(intent: HrcRuntimeIntent): string | undefined {
  return intent.harness.model ?? intent.provision?.model
}

/**
 * The reasoning effort this runtime launches with.
 *
 * `HrcHarnessIntent` has no reasoning field at all, so unlike the model there
 * is nothing to prefer over the directive — the overlaid `provision` is the
 * only source, which is precisely why `+reasoning=` could never reach a
 * process before now.
 */
export function resolveLaunchReasoning(intent: HrcRuntimeIntent): string | undefined {
  return intent.provision?.reasoning
}

/** The compile boundary's closed reasoning vocabulary. */
export type CompileReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

/**
 * The same value on the compile hop, whose contract declares a CLOSED enum
 * while `[provisioning].reasoning` is harness-neutral text.
 *
 * Passed through rather than dropped when it is not one of the four: the value
 * was already validated at the sender against the resolved harness's own
 * vocabulary (Wave 2a), per-harness reasoning mapping belongs to the compiler
 * and not to HRC, and silently discarding a directive the operator typed is the
 * exact failure mode this module exists to end. A value the compiler cannot map
 * must fail there, loudly, rather than disappear here.
 */
export function resolveCompileReasoningEffort(
  intent: HrcRuntimeIntent
): CompileReasoningEffort | undefined {
  return resolveLaunchReasoning(intent) as CompileReasoningEffort | undefined
}
