import { randomUUID } from 'node:crypto'
import { HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  ColdBirthPromptMode,
  HrcExecutionFormat,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import { assertActuatorSplitRuntimeReuse } from './actuator-split.js'
import {
  CALLER_SURFACE_REUSE_REFUSAL,
  type HeadlessExecutionRoute,
  decideHeadlessExecutionRoute,
  getBrokerRuntimeDriver,
  refusesSurfaceReuse,
} from './broker-decisions.js'
import { hasLeasedBrokerSubstrate } from './broker/runtime-hosting.js'
import type { ParticipantDeliveryTarget } from './participant-delivery.js'
import {
  type RedirectOffBirthJoin,
  type RedirectOffCodexRoute,
  assertNoOperatorPresentationConflict,
  decideCrossingBirthRoute,
  decideRedirectOffCodexRoute,
  isOmittedChoiceCodexRequest,
  startBirthOf,
} from './presentation-operator.js'
import { isBrokerRuntimeInputDispatchable } from './require-helpers.js'
import {
  assertV2SelectionCompatibleForReuse,
  findDispatchInteractiveRuntime,
} from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import type {
  AttachBeforeInvocationStartOption,
  CoalescedQueuedMember,
  DispatchRunPersistenceOptions,
} from './server-types.js'
import { dispatchRunPersistence } from './server-types.js'
import { isRuntimeUnavailableStatus } from './server-util.js'
import { dispatchAdmittedTurnForSession } from './turn-dispatch-admitted-turn.js'
import type { JsonRepairRunCorrelation } from './turn-dispatch-attached-run-handlers.js'
import { assertBrokerRuntimeExecutionFormat } from './turn-dispatch-runtime-handlers.js'
import { activeBrokerRuntimeForSession } from './turn-dispatch-submission-support.js'

export type DispatchTurnForSessionOptions = DispatchRunPersistenceOptions & {
  runId?: string | undefined
  ensureInteractiveRuntime?: boolean | undefined
  waitForCompletion?: boolean | undefined
  joinInFlightRuntimeStart?: boolean | undefined
  attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
  repairCorrelation?: JsonRepairRunCorrelation | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
  coalescedMembers?: readonly CoalescedQueuedMember[] | undefined
  /** Selected at public ingress before compile. */
  executionFormat?: HrcExecutionFormat | undefined
  /** Canonical format2 idempotency body, stable across retries. */
  format2RequestHash?: string | undefined
  /** T-07397 surface-ownership proof; see DispatchTurnRequest. */
  establishedBrokerInvocationId?: string | undefined
  /**
   * A mail summons that is itself birthing an interactive launch-primed seat
   * rides that seat's launch turn. Ignored by reuse, headless, SDK, and
   * non-launch-primed routes (T-07920).
   */
  launchPromptOnColdBirth?: boolean | undefined
  /**
   * Requested cold-launch prompt carriage (T-08610): an explicit per-request
   * override of the `launchPromptOnColdBirth` derivation below. Carried from
   * `POST /v1/submissions/invoke`'s `coldBirth.promptMode`, which is an option
   * on the invoke class method, not an admission-class selector.
   */
  coldBirthPromptMode?: ColdBirthPromptMode | undefined
}

export async function dispatchTurnForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  /** Absent only for a participant, which is routed by durable linkage (R7.6). */
  inputIntent: HrcRuntimeIntent | undefined,
  prompt: string,
  options: DispatchTurnForSessionOptions = {}
): Promise<Response> {
  const executionFormat = options.executionFormat ?? 'format1'
  const liveBrokerRuntime = activeBrokerRuntimeForSession(this, session)
  if (liveBrokerRuntime !== undefined) {
    assertBrokerRuntimeExecutionFormat(this, liveBrokerRuntime, executionFormat)
  }
  const existingRun = options.runId ? this.db.runs.getByRunId(options.runId) : null
  const releaseAdmission = this.turnAdmissionGate.admit({
    existingAcceptedRun: existingRun?.status === 'accepted',
  })
  try {
    return await dispatchAdmittedTurnForSession.call(this, session, inputIntent, prompt, options)
  } finally {
    releaseAdmission()
  }
}

/**
 * T-08716: the scope's latest live broker runtime, when that runtime was born
 * under v2. Producer-selected rows carry no HRC provider projection; that
 * absence, not the request's intent, is what marks them. A tmux seat is
 * reconciled first, and one that reconciled dead is not returned, so the
 * dispatch falls through to an ordinary v2 birth. A birth in flight is joined
 * by the cold route instead.
 */
export async function findReusableProducerSelectedRuntime(
  this: HrcServerInstanceForHandlers,
  hostSessionId: string
): Promise<HrcRuntimeSnapshot | undefined> {
  if (this.runtimeStartOperations.has(hostSessionId)) return undefined
  const live = this.db.runtimes
    .listByHostSessionId(hostSessionId)
    .filter(
      (runtime) =>
        runtime.controllerKind === 'harness-broker' &&
        runtime.status !== 'failed' &&
        !isRuntimeUnavailableStatus(runtime.status)
    )
    .at(-1)
  if (live === undefined || live.provider !== undefined) return undefined
  // T-09237: the projection is not the health check. A seat the broker already
  // reported terminal is closed out here, so the dispatch births fresh instead
  // of being refused (T-07397) or queued into a dead seat.
  if (
    this.harnessBrokerController?.closeOutTerminalLiveSeat(live.runtimeId, 'dispatch-admission')
  ) {
    return undefined
  }
  if (live.transport !== 'tmux' || !hasLeasedBrokerSubstrate(live)) return live
  const reconciled = await this.reconcileTmuxRuntimeLiveness(live)
  return isRuntimeUnavailableStatus(reconciled.status) ? undefined : reconciled
}

/**
 * T-09237: admission must not read a `ready` projection over a seat the broker
 * already reported terminal. Closes such a runtime out (failing its open runs)
 * and returns the re-read row, which admission then treats as unavailable.
 */
export function closeOutDeadSeatBeforeAdmission<T extends HrcRuntimeSnapshot | null>(
  this: HrcServerInstanceForHandlers,
  runtime: T
): T {
  if (
    runtime === null ||
    !this.harnessBrokerController?.closeOutTerminalLiveSeat(runtime.runtimeId, 'dispatch-admission')
  ) {
    return runtime
  }
  return (this.db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime) as T
}

// Drivers whose interactive input turn is delivered without waiting for the
// provider turn, exactly as the legacy broker-reuse branch treats them.
const NON_BLOCKING_TMUX_BROKER_DRIVERS = new Set(['codex-cli-tmux', 'pi-tui-tmux', 'muse-cli-tmux'])

/**
 * T-08716: deliver an ordinary dispatch into a live v2 tmux seat. HRC owns
 * reuse (aspd-prepared-execution-release): the frozen selection is the only
 * reuse identity, and the guards of legacy broker-reuse still apply. A refusal
 * here mutates nothing: the live seat is never stale-marked or replaced.
 */
export async function dispatchIntoProducerSelectedTmuxRuntime(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: DispatchTurnForSessionOptions
): Promise<Response> {
  assertV2SelectionCompatibleForReuse(runtime, intent)
  assertActuatorSplitRuntimeReuse(intent, runtime)
  assertNoOperatorPresentationConflict(intent, [runtime])
  // T-07397/T-08540: a refusal to reuse, or a claimed ownership proof, admits
  // only the caller's own active invocation, by exact identity.
  if (refusesSurfaceReuse(intent) || options.establishedBrokerInvocationId !== undefined) {
    const carried = options.establishedBrokerInvocationId
    if (carried === undefined || carried !== runtime.activeInvocationId) {
      throw new HrcRuntimeUnavailableError(CALLER_SURFACE_REUSE_REFUSAL, {
        hostSessionId: session.hostSessionId,
        runtimeId: runtime.runtimeId,
        route: 'producer-selected-reuse',
        reason: CALLER_SURFACE_REUSE_REFUSAL,
      })
    }
  }
  // T-05358: a starting/stopping invocation cannot take input. Unlike the
  // legacy branch this does not reprovision: the seat is still the scope's
  // writer, and the caller retries once it settles.
  if (!isBrokerRuntimeInputDispatchable(this.db, runtime)) {
    throw new HrcRuntimeUnavailableError('broker runtime is transitioning and cannot take input', {
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      route: 'producer-selected-reuse',
      reason: 'broker_runtime_transitioning',
    })
  }
  await this.publishPresentation(runtime, {
    operatorAttachPending: options.attachBeforeInvocationStart !== undefined,
  })
  const driver = getBrokerRuntimeDriver(runtime)
  return await this.executeInteractiveBrokerInputTurn(session, runtime, prompt, runId, {
    waitForCompletion:
      driver !== undefined && NON_BLOCKING_TMUX_BROKER_DRIVERS.has(driver)
        ? false
        : options.waitForCompletion,
    repairCorrelation: options.repairCorrelation,
    responseFormat: options.responseFormat,
    ...dispatchRunPersistence(options),
  })
}

/**
 * Submit into the participant's own existing runtime through the existing
 * broker input-turn path.
 *
 * The transport decides which of the two established executors runs, and both
 * take a runtime that already exists. Nothing new is queued, accounted or
 * receipted here: run persistence, the user-prompt event, first-turn watch,
 * broker admission, wait and replay all remain the ones every other turn uses.
 */
export async function deliverIntoAttachedParticipant(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  target: ParticipantDeliveryTarget,
  prompt: string,
  options: DispatchTurnForSessionOptions
): Promise<Response> {
  const runId = options.runId ?? `run-${randomUUID()}`
  const { runtime } = target
  const inputTurnOptions = {
    // The submission doors pass `waitForCompletion: true` to mean "do not
    // return until the broker mints a submission identity" -- their own comment
    // says they never wait for turn EXECUTION. The broker input-turn executors
    // read the same flag as "wait for the turn to finish". Passing it through
    // unchanged made a real enqueue return only after 31,442ms, by which point
    // the host journal already showed turn_started AND turn_completed, so
    // steering into that turn was impossible by construction.
    //
    // Three things make `false` correct here rather than merely shorter. The
    // executors' early return carries `submissionId` and `admission`, so the
    // identity still exists when the door answers. `handleSubmission` performs
    // its OWN terminal wait afterwards via `waitForPublicDispatchStage`, so an
    // explicit `wait: true` still completes only at terminal. And the
    // interactive route already does exactly this for its live drivers. Only
    // door-originated calls are affected; a direct caller (the mail kicker,
    // app sessions) keeps whatever it asked for.
    waitForCompletion: options.submissionDoor === undefined ? options.waitForCompletion : false,
    repairCorrelation: options.repairCorrelation,
    responseFormat: options.responseFormat,
    ...dispatchRunPersistence(options),
  }
  return runtime.transport === 'tmux'
    ? await this.executeInteractiveBrokerInputTurn(
        session,
        runtime,
        prompt,
        runId,
        inputTurnOptions
      )
    : await this.executeHeadlessBrokerInputTurn(session, runtime, prompt, runId, inputTurnOptions)
}

/**
 * T-08555 (§1.3 rules 3–5) — route an omitted-choice Codex dispatch on a
 * redirect-off node, or undefined when the request is not one. A start in
 * flight contributes the birth it has chosen (its decision is awaited, never its
 * boot, so a same-harness headless boot still queues this prompt); a start that
 * recorded no birth is awaited in full, never treated as absent. Rows are judged
 * after tmux reconcile. The result is the authority every later join re-checks.
 */
export async function classifyRedirectOffCodexDispatch(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  options: { establishedBrokerInvocationId?: string | undefined }
): Promise<RedirectOffBirthJoin | undefined> {
  if (!isOmittedChoiceCodexRequest(intent)) return undefined
  const inFlightStart = this.runtimeStartOperations.get(session.hostSessionId)
  const inFlightBirth = inFlightStart ? await startBirthOf(inFlightStart) : undefined
  let route: RedirectOffCodexRoute
  if (inFlightBirth !== undefined) {
    route = decideCrossingBirthRoute(intent, inFlightBirth)
  } else {
    if (inFlightStart !== undefined) await inFlightStart.catch(() => undefined)
    const dispatchRuntime = findDispatchInteractiveRuntime(this.db, session.hostSessionId)
    if (
      dispatchRuntime?.controllerKind === 'harness-broker' &&
      hasLeasedBrokerSubstrate(dispatchRuntime)
    ) {
      await this.reconcileTmuxRuntimeLiveness(dispatchRuntime)
    }
    route = decideRedirectOffCodexRoute(
      intent,
      this.db.runtimes.listByHostSessionId(session.hostSessionId)
    )
  }
  return {
    route,
    claudeCodeTmuxBrokerEnabled: this.claudeCodeTmuxBrokerEnabled,
    piTuiTmuxBrokerEnabled: this.piTuiTmuxBrokerEnabled,
    museCliTmuxBrokerEnabled: this.museCliTmuxBrokerEnabled,
    ...(options.establishedBrokerInvocationId !== undefined
      ? { establishedBrokerInvocationId: options.establishedBrokerInvocationId }
      : {}),
  }
}

export function routeFormat2Dispatch(
  server: Pick<
    HrcServerInstanceForHandlers,
    'headlessCodexBrokerEnabled' | 'headlessMuseBrokerEnabled'
  >,
  intent: HrcRuntimeIntent,
  options: Pick<DispatchTurnForSessionOptions, 'establishedBrokerInvocationId'>
): HeadlessExecutionRoute {
  // An established invocation is the caller's exact broker ownership proof.
  // Its frozen compiler intent can omit HRC's harness provider, so do not
  // reclassify that already-open broker as a generic headless request.
  if (options.establishedBrokerInvocationId !== undefined) return 'broker'
  return decideHeadlessExecutionRoute(intent, {
    brokerFlagEnabled: server.headlessCodexBrokerEnabled,
    museBrokerFlagEnabled: server.headlessMuseBrokerEnabled,
  })
}
