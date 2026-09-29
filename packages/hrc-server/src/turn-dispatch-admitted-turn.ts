import { randomUUID } from 'node:crypto'
import { HrcErrorCode, HrcRuntimeUnavailableError, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import {
  assertActuatorSplitRouteAdmission,
  assertActuatorSplitRuntimeReuse,
  normalizeActuatorSplitPolicy,
} from './actuator-split.js'
import {
  assertAppIdentityOwner,
  assertAppRunIdUnused,
  isAppScopedSession,
  issueAppBirthRunGrant,
} from './app-session-identity.js'
import {
  decideHeadlessExecutionRoute,
  decideInteractiveBrokerAdmission,
  isProducerSelectedOrdinaryBirth,
  normalizeClaudeInteractiveBrokerIntent,
  normalizeCodexInteractiveBrokerIntent,
  normalizeRuntimeProvisionIntent,
  runInteractiveTmuxRoute,
  shouldDeferHeadlessToInteractiveBrokerReuse,
  shouldRedirectClaudeToInteractiveBroker,
  shouldRedirectCodexToInteractiveBroker,
  shouldUseHeadlessTransport,
  shouldUseSdkTransport,
  toLatestRuntimeAdmissionView,
  toLiveInteractiveRuntimeReuseView,
} from './broker-decisions.js'
import { hasLeasedBrokerSubstrate } from './broker/runtime-hosting.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import {
  participantDeliveryUnavailable,
  resolveParticipantDelivery,
} from './participant-delivery.js'
import { reconnectParticipantAttachment } from './participant-establishment.js'
import {
  assertBirthJoinAdmitted,
  assertBirthJoinRoute,
  assertNoOperatorPresentationConflict,
  assertOperatorPresentationRoutable,
  requestsOperatorPresentation,
  scopeHasLiveHeadlessBrokerRuntime,
} from './presentation-operator.js'
import { isBrokerRuntimeInputDispatchable } from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import { findDispatchInteractiveRuntime } from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { dispatchRunPersistence, submissionDoorCarriesColdLaunch } from './server-types.js'
import { isRuntimeUnavailableStatus, timestamp } from './server-util.js'
import {
  type DispatchTurnObservationContext,
  captureBrokerAfterSeqByInvocation,
  enrichDispatchTurnResponse,
} from './turn-dispatch-attached-run-handlers.js'
import {
  type DispatchTurnForSessionOptions,
  classifyRedirectOffCodexDispatch,
  closeOutDeadSeatBeforeAdmission,
  deliverIntoAttachedParticipant,
  dispatchIntoProducerSelectedTmuxRuntime,
  findReusableProducerSelectedRuntime,
  routeFormat2Dispatch,
} from './turn-dispatch-session-dispatch.js'

export async function dispatchAdmittedTurnForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  inputIntent: HrcRuntimeIntent | undefined,
  prompt: string,
  options: DispatchTurnForSessionOptions
): Promise<Response> {
  assertLocalPersonaAllowed(this, session.scopeRef)
  const executionFormat = options.executionFormat ?? 'format1'
  if (executionFormat === 'format2') {
    // App and participant surfaces are F1-sealed: an F2 request must never
    // inherit their run/participant identity or fall through to a second birth.
    if (isAppScopedSession(session) || resolveParticipantDelivery(this, session) !== null) {
      throw new HrcRuntimeUnavailableError('format2 is unsupported for this dispatch target', {
        code: 'execution_format_unsupported_door',
        hostSessionId: session.hostSessionId,
        targetKind: isAppScopedSession(session) ? 'app-session' : 'participant',
      })
    }
    if (
      options.runId !== undefined ||
      options.dispatchIdempotencyKey === undefined ||
      options.format2RequestHash === undefined
    ) {
      throw new HrcRuntimeUnavailableError('format2 dispatch requires a runless idempotent input', {
        code: 'execution_format_mismatch',
        hostSessionId: session.hostSessionId,
        ...(options.runId !== undefined ? { runId: options.runId } : {}),
        ...(options.dispatchIdempotencyKey === undefined
          ? { missing: 'dispatchIdempotencyKey' }
          : {}),
        ...(options.format2RequestHash === undefined ? { missing: 'format2RequestHash' } : {}),
      })
    }
    const format2Intent = normalizeDispatchIntent(inputIntent, session, undefined)
    if (!shouldUseHeadlessTransport(format2Intent)) {
      throw new HrcRuntimeUnavailableError('format2 requires a headless broker input route', {
        code: 'format2_initial_input_undeliverable',
        hostSessionId: session.hostSessionId,
      })
    }
    const route = routeFormat2Dispatch(this, format2Intent, options)
    assertActuatorSplitRouteAdmission(format2Intent, route)
    if (route !== 'broker') {
      throw new HrcRuntimeUnavailableError('format2 requires the broker input route', {
        code: 'format2_initial_input_undeliverable',
        hostSessionId: session.hostSessionId,
        route,
      })
    }
    return await this.handleHeadlessBrokerDispatchTurn(session, format2Intent, prompt, undefined, {
      ...options,
      executionFormat,
      waitForCompletion: options.submissionDoor === undefined ? options.waitForCompletion : false,
    })
  }

  // Format1 keeps its admission-time run identity and all existing routes.
  if (isAppScopedSession(session)) {
    // T-08576 D5 backstop: an app run id that is already named cannot identify a
    // new turn. Then the app dispatch must hold the selector owner, and its run
    // is reserved under a single-use birth grant before any effect.
    assertAppRunIdUnused(this.db, options.runId)
    assertAppIdentityOwner(session)
  }
  const runId = options.runId ?? `run-${randomUUID()}`
  if (isAppScopedSession(session)) {
    issueAppBirthRunGrant(this.db, session, runId)
  }
  // Built before the participant branch so its response is enriched the same
  // way every other route's is. Without the observation block a caller's
  // explicit `wait: true` cannot find the broker selector and fails with
  // "dispatch wait requires broker submission identity" -- which is exactly
  // what my first cut did, because it returned unenriched.
  const observationContext: DispatchTurnObservationContext = {
    lifecycleFromSeq: this.db.hrcEvents.maxHrcSeq() + 1,
    brokerAfterSeqByInvocation: captureBrokerAfterSeqByInvocation(this, session.hostSessionId),
  }
  const withObservation = async (response: Response): Promise<Response> =>
    enrichDispatchTurnResponse(this, response, observationContext)

  // R7.6: resolve a participant BEFORE the runtime-intent requirement. This is
  // the door every caller shares -- the public submission doors, the addressed
  // mail kicker, the selector and target message paths -- so routing here is
  // what keeps one door from being fixed while the next still births.
  let participantDelivery = resolveParticipantDelivery(this, session)
  if (participantDelivery !== null) {
    // Join the one recovery operation, then RE-READ and fence: the linkage that
    // was current before the await may not be after it, and submitting against
    // the stale read is exactly how input reaches a different writer.
    if (participantDelivery.outcome === 'reconnect') {
      await reconnectParticipantAttachment(
        this,
        participantDelivery.registration,
        participantDelivery.attempt
      )
      participantDelivery = resolveParticipantDelivery(this, session)
    }
    if (participantDelivery === null || participantDelivery.outcome === 'reconnect') {
      // Still not restored. Typed pending keeps the mail eligible; it never
      // falls through to a generic birth.
      throw new HrcRuntimeUnavailableError(
        'participant attachment is being restored on this controller; addressed work stays pending',
        { scopeRef: session.scopeRef, laneRef: session.laneRef, reason: 'participant_reconnecting' }
      )
    }
    if (participantDelivery.outcome === 'refused') {
      throw participantDeliveryUnavailable(session, participantDelivery)
    }
    return await withObservation(
      await deliverIntoAttachedParticipant.call(this, session, participantDelivery, prompt, {
        ...options,
        runId,
      })
    )
  }
  const normalizedInputIntent = normalizeDispatchIntent(inputIntent, session, runId)

  // Fresh ordinary v2 turns compile through ASP before HRC knows anything
  // about a harness, provider, driver or hosting. Existing runtimes continue
  // through their lifecycle/reuse gates below; a cold scope goes directly to
  // the broker admission that persists ASP's frozen execution.
  //
  // T-08716: an ordinary dispatch into a scope whose live broker runtime was
  // itself born under v2 reuses that runtime. It has no HRC provider/driver
  // projection, and the session's stored intent carries no selectors (or stale
  // v1 ones HRC must not interpret), so the legacy interactive admission below
  // could only refuse it or start a second writer beside it.
  const ordinaryV2 = isProducerSelectedOrdinaryBirth(normalizedInputIntent)
  const producerSelected = ordinaryV2
    ? await findReusableProducerSelectedRuntime.call(this, session.hostSessionId)
    : undefined
  if (producerSelected?.transport === 'tmux') {
    return await withObservation(
      await dispatchIntoProducerSelectedTmuxRuntime.call(
        this,
        session,
        producerSelected,
        normalizedInputIntent,
        prompt,
        runId,
        options
      )
    )
  }
  const hasLiveBrokerRuntime = this.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .some(
      (runtime) =>
        runtime.controllerKind === 'harness-broker' &&
        runtime.status !== 'failed' &&
        !isRuntimeUnavailableStatus(runtime.status)
    )
  if (
    ordinaryV2 &&
    (!hasLiveBrokerRuntime ||
      this.runtimeStartOperations.has(session.hostSessionId) ||
      // The headless broker door already reuses, reattaches or reprovisions a
      // v2 headless runtime under the v2 selection-compatibility gate.
      producerSelected !== undefined)
  ) {
    assertActuatorSplitRouteAdmission(normalizedInputIntent, 'broker')
    return await withObservation(
      await this.handleHeadlessBrokerDispatchTurn(session, normalizedInputIntent, prompt, runId, {
        // Submission doors wait at the public projection layer after the
        // durable broker admission exists. Do not make the fresh v2 birth wait
        // for the first provider turn merely to mint that receipt.
        waitForCompletion: options.submissionDoor === undefined ? options.waitForCompletion : false,
        repairCorrelation: options.repairCorrelation,
        responseFormat: options.responseFormat,
        coalescedMembers: options.coalescedMembers,
        ...dispatchRunPersistence(options),
        coldBirthPromptMode:
          options.coldBirthPromptMode ??
          (options.launchPromptOnColdBirth
            ? 'replace-priming'
            : submissionDoorCarriesColdLaunch(options.submissionDoor)
              ? 'append-to-priming'
              : undefined),
      })
    )
  }

  // T-01770 Phase B: admit ariadne-class (explicit id:claude-code dispatched
  // headless) and SDK-shaped Claude intents into the claude-code-tmux broker
  // path BEFORE the headless/SDK branches. Without this they fall onto legacy
  // exec.ts (fresh conversation each turn) or the hard-failing SDK executor.
  // Normalizing to an interactive claude-code intent makes the predicates
  // below route them to the broker branch (and NOT runSdkTurn / the retired
  // headless CLI exec path). Flag-gated so a disabled broker is unchanged.
  //
  // T-07397: a caller's surface-reuse refusal does NOT veto this redirect. The
  // redirect selects a claude-code-tmux BROKER PANE (HRC-leased, not a user
  // TTY); it is not, by itself, delivery into anyone's existing surface. Vetoing
  // it here did not route the turn somewhere safer — it dropped every
  // refusal-stamped claude dispatch onto the retired legacy-exec route (a hard
  // 503, and the whole of T-07397). Refusal is enforced where reuse is actually
  // decided: `decideInteractiveBrokerAdmission` via `refusesSurfaceReuse`, which
  // is normalization-invariant and therefore survives the rewrite below.
  const callerSurfaceReuseRefusal = disallowsInteractiveSurfaceReuse(normalizedInputIntent)
  const highRiskActuatorSplit =
    normalizeActuatorSplitPolicy(normalizedInputIntent.execution?.actuatorSplit)?.mode ===
    'high-risk'
  const claudeRedirect =
    this.claudeCodeTmuxBrokerEnabled &&
    !highRiskActuatorSplit &&
    shouldRedirectClaudeToInteractiveBroker(normalizedInputIntent)
  // T-08338: responseFormat is per-turn input. A schema-bearing cold Codex
  // dispatch stays on the headless app-server route, whose turn/start request
  // is the schema vehicle. The stock TUI queue protocol has no schema field.
  // T-08553: an explicit per-request no-viewer choice keeps the dispatch
  // headless, exactly as a responseFormat does; an omitted one is delivered into
  // the scope's live headless runtime rather than redirected past it.
  //
  // T-08555: with the redirect off, the scope's established broker runtime (or
  // in-flight birth) selects the admission BEFORE responseFormat, actuator split
  // or node defaults; see classifyRedirectOffCodexDispatch.
  const redirectOffBirthJoin =
    !this.codexCliTmuxBrokerEnabled && !claudeRedirect
      ? await classifyRedirectOffCodexDispatch.call(this, session, normalizedInputIntent, options)
      : undefined
  const redirectOffRoute = redirectOffBirthJoin?.route
  const codexRedirect = this.codexCliTmuxBrokerEnabled
    ? !highRiskActuatorSplit &&
      options.responseFormat === undefined &&
      !requestsOperatorPresentation(normalizedInputIntent) &&
      shouldRedirectCodexToInteractiveBroker(normalizedInputIntent) &&
      !scopeHasLiveHeadlessBrokerRuntime(this.db, session.hostSessionId)
    : redirectOffRoute === 'interactive'
  const intent = claudeRedirect
    ? normalizeClaudeInteractiveBrokerIntent(normalizedInputIntent)
    : codexRedirect
      ? normalizeCodexInteractiveBrokerIntent(normalizedInputIntent)
      : normalizedInputIntent
  let latestRuntime = findDispatchInteractiveRuntime(this.db, session.hostSessionId)
  // T-01873: route the durable-tmux liveness gate through the runtime-hosting
  // choke point. hasLeasedBrokerSubstrate replaces the `transport==='tmux' &&
  // getBrokerRuntimeTmuxSocketPath !== undefined` durability proxy — it is true
  // exactly when the broker process lives in a leased tmux session (the
  // precondition reconcileTmuxRuntimeLiveness needs), and false for an external
  // broker (no tmux substrate), preserving today's tmux-only reconcile.
  if (
    latestRuntime?.controllerKind === 'harness-broker' &&
    hasLeasedBrokerSubstrate(latestRuntime)
  ) {
    latestRuntime = await this.reconcileTmuxRuntimeLiveness(latestRuntime)
  }

  // T-08553: an explicit no-viewer choice is refused, before any delivery,
  // stale-marking or reprovision, when it cannot be honored or when the scope's
  // live runtime already presents a viewer or an interactive surface.
  if (requestsOperatorPresentation(intent)) {
    assertOperatorPresentationRoutable(intent, {
      claudeRedirect,
      headlessTransport: shouldUseHeadlessTransport(intent),
      headlessRoute: shouldUseHeadlessTransport(intent)
        ? decideHeadlessExecutionRoute(intent, {
            brokerFlagEnabled: this.headlessCodexBrokerEnabled,
            museBrokerFlagEnabled: this.headlessMuseBrokerEnabled,
          })
        : undefined,
    })
    assertNoOperatorPresentationConflict(
      intent,
      this.db.runtimes.listByHostSessionId(session.hostSessionId)
    )
  }

  const dispatchIntent = normalizeRuntimeProvisionIntent(intent)
  if (highRiskActuatorSplit && !shouldUseHeadlessTransport(intent)) {
    assertActuatorSplitRouteAdmission(intent, 'interactive-broker')
  }

  // A live, idle interactive broker runtime is the agent's real
  // session — the TUI a human may be watching. A DM/turn for that scope must be
  // delivered INTO it via the broker-reuse path, never spawned as a competing
  // headless run: a headless codex-app-server start resumes the SAME continuation
  // thread the live TUI already owns, finds no rollout in its (re-derived) codex
  // home, and wedges at `starting` — the turn silently dies. The SDK branch below
  // already defers to a live idle interactive runtime; the headless-codex branch
  // must do the same so codex DMs land in the open TUI (broker-reuse) instead of
  // a parallel headless run. When no such runtime exists (cron/autonomous
  // dispatch), the Wave C headless route is still taken.
  const liveInteractiveBrokerReusable =
    // T-08555: on a redirect-off node an established headless runtime owns the
    // scope; the older tmux deferral must not route past it.
    redirectOffRoute !== 'headless' &&
    !highRiskActuatorSplit &&
    shouldDeferHeadlessToInteractiveBrokerReuse(
      intent,
      toLiveInteractiveRuntimeReuseView(latestRuntime)
    )

  if (shouldUseHeadlessTransport(intent) && !liveInteractiveBrokerReusable) {
    const route = decideHeadlessExecutionRoute(intent, {
      brokerFlagEnabled: this.headlessCodexBrokerEnabled,
      museBrokerFlagEnabled: this.headlessMuseBrokerEnabled,
    })
    assertActuatorSplitRouteAdmission(intent, route)
    if (route === 'broker') {
      return await withObservation(
        await this.handleHeadlessBrokerDispatchTurn(session, intent, prompt, runId, {
          ...(redirectOffBirthJoin !== undefined ? { redirectOffBirthJoin } : {}),
          waitForCompletion: options.waitForCompletion,
          repairCorrelation: options.repairCorrelation,
          responseFormat: options.responseFormat,
          coalescedMembers: options.coalescedMembers,
          ...dispatchRunPersistence(options),
        })
      )
    }
    if (route === 'sdk') {
      assertJsonSchemaResponseFormatSupported(options.responseFormat, {
        route: 'sdk',
        provider: intent.harness.provider,
        harnessId: intent.harness.id,
      })
      return await withObservation(
        await this.handleHeadlessDispatchTurn(session, dispatchIntent, prompt, runId, {
          waitForCompletion: options.waitForCompletion,
          ...dispatchRunPersistence(options),
        })
      )
    }

    assertJsonSchemaResponseFormatSupported(options.responseFormat, {
      route,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
    })
    throw new HrcRuntimeUnavailableError('headless legacy execution is unavailable', {
      hostSessionId: session.hostSessionId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
      route,
    })
  }

  if (shouldUseSdkTransport(intent)) {
    assertActuatorSplitRouteAdmission(intent, 'sdk')
    // Prefer a live idle interactive runtime over SDK when one is available (spec §11.3.3:
    // headless for CLI/headless-capable targets, SDK only as fallback)
    const liveInteractiveRuntime = latestRuntime
    const interactiveSeat =
      !callerSurfaceReuseRefusal &&
      liveInteractiveRuntime?.controllerKind === 'harness-broker' &&
      liveInteractiveRuntime.activeInvocationId !== undefined
        ? await this.getHarnessBrokerController().seatProbe(liveInteractiveRuntime.runtimeId)
        : undefined
    const interactiveAvailableAndIdle =
      !callerSurfaceReuseRefusal &&
      liveInteractiveRuntime &&
      liveInteractiveRuntime.transport === 'tmux' &&
      liveInteractiveRuntime.tmuxJson !== undefined &&
      !isRuntimeUnavailableStatus(liveInteractiveRuntime.status) &&
      // T-05358: never reuse an interactive runtime whose broker invocation is
      // transitioning (starting/stopping) — row status alone admits `stopping`.
      isBrokerRuntimeInputDispatchable(this.db, liveInteractiveRuntime) &&
      interactiveSeat?.ok === true &&
      interactiveSeat.response.seat.state === 'idle'
    if (!interactiveAvailableAndIdle) {
      assertJsonSchemaResponseFormatSupported(options.responseFormat, {
        route: 'sdk',
        provider: intent.harness.provider,
        harnessId: intent.harness.id,
      })
      return await withObservation(
        await this.handleSdkDispatchTurn(session, intent, prompt, runId, {
          waitForCompletion: options.waitForCompletion,
        })
      )
    }
    // Fall through to tmux/headless path with the idle runtime
  }

  // T-07693: a runtime whose BIRTH is still in flight is being born, not stuck.
  // The admission below cannot tell those apart — T-05358 routes every
  // non-input-dispatchable `starting` interactive runtime to
  // stale-and-reprovision — so a second wake landing inside the boot window
  // marked the newborn stale and minted a SECOND seat on the one host session.
  // Two agents, one worktree (observed live on T-07688).
  //
  // Join the birth instead. `runtimeStartOperations` is the same in-flight-start
  // registration that IS predicate (b) of `isClaimScopeFree`, so this is the
  // T-07302 exact-scope invariant enforced one layer down, at the runtime rather
  // than the claim: one live seat per exact scope, whichever source wakes it.
  //
  // T-07202 added this join for the crossing-DM case, but placed it INSIDE
  // `handleInteractiveTmuxBrokerDispatchTurn` — downstream of the admission, so
  // it could not prevent the reprovision — and made it opt-in, so the wrkq wake
  // path never reached it. That guard stays where it is; this one is the fence.
  //
  // Scoped OUT of the attach path deliberately: `attachBeforeInvocationStart` is
  // a promise to the operator that they get the pane before the invocation runs,
  // and an already-accepted birth is past that point. Attached start has its own
  // ready-wait (T-07304); silently dropping the attach here would trade a
  // visible double-seat for an invisible broken promise.
  const invokeRendezvous =
    options.attachBeforeInvocationStart === undefined && options.submissionDoor === 'invoke'
      ? this.invokeFirstTurnRendezvous.get(session.hostSessionId)
      : undefined
  const inFlightBirth =
    options.attachBeforeInvocationStart === undefined
      ? (invokeRendezvous?.operation ?? this.runtimeStartOperations.get(session.hostSessionId))
      : undefined
  if (inFlightBirth !== undefined) {
    // An invoke crossing a launch-carried first turn has no durable accepted
    // row yet. Register it before the await so owner-scoped completion cleanup
    // can preserve the shared runtime across that pre-persistence interval.
    invokeRendezvous?.crossingRunIds.add(runId)
    try {
      // T-08555: the birth joined here must be the one the route was taken from.
      if (redirectOffBirthJoin !== undefined) {
        await assertBirthJoinRoute(intent, inFlightBirth, redirectOffBirthJoin)
      }
      const bornRuntime = await inFlightBirth
      // The headless broker registers its boot in the SAME map for the same host
      // session, and a headless runtime is not deliverable through the
      // interactive executor. Only an interactive broker seat is joined here;
      // anything else falls through to the ordinary route with the runtime
      // re-read, since awaiting the birth is exactly what made the old snapshot
      // stale.
      if (bornRuntime.transport === 'tmux' && bornRuntime.controllerKind === 'harness-broker') {
        // Same authority re-check the broker-reuse branch below makes, against
        // the caller's own intent: joining a birth is a reuse, and a
        // write-capable newborn must not become a route around actuator-split
        // validation.
        assertActuatorSplitRuntimeReuse(intent, bornRuntime)
        // T-08555: a redirect-off crossing joins a newborn only through
        // interactive admission (T-07397 caller policy, driver and provider).
        if (redirectOffBirthJoin !== undefined) {
          assertBirthJoinAdmitted(intent, bornRuntime, redirectOffBirthJoin)
        }
        return await withObservation(
          await this.executeInteractiveBrokerInputTurn(session, bornRuntime, prompt, runId, {
            waitForCompletion: options.waitForCompletion,
            repairCorrelation: options.repairCorrelation,
            responseFormat: options.responseFormat,
            ...dispatchRunPersistence(options),
          })
        )
      }
      latestRuntime = findDispatchInteractiveRuntime(this.db, session.hostSessionId)
    } finally {
      if (invokeRendezvous !== undefined) {
        invokeRendezvous.crossingRunIds.delete(runId)
        if (
          invokeRendezvous.settled &&
          invokeRendezvous.crossingRunIds.size === 0 &&
          this.invokeFirstTurnRendezvous.get(session.hostSessionId) === invokeRendezvous
        ) {
          this.invokeFirstTurnRendezvous.delete(session.hostSessionId)
        }
      }
    }
  }

  // T-09237: a dead seat re-births rather than counting as a healthy surface.
  latestRuntime = closeOutDeadSeatBeforeAdmission.call(this, latestRuntime)

  const admission = decideInteractiveBrokerAdmission(
    intent,
    // T-05358: pass input-dispatchability so a `stopping`/`starting` interactive
    // runtime is routed to stale-and-reprovision (fresh) rather than broker-reuse.
    toLatestRuntimeAdmissionView(
      latestRuntime,
      latestRuntime ? isBrokerRuntimeInputDispatchable(this.db, latestRuntime) : true
    ),
    {
      claudeCodeTmuxBrokerEnabled: this.claudeCodeTmuxBrokerEnabled,
      piTuiTmuxBrokerEnabled: this.piTuiTmuxBrokerEnabled,
      museCliTmuxBrokerEnabled: this.museCliTmuxBrokerEnabled,
      // T-07397: the caller's proof that it owns this surface. Compared by
      // exact identity against the runtime's ACTIVE invocation; absent means
      // "owns nothing", which can only ever refuse.
      ...(options.establishedBrokerInvocationId !== undefined
        ? { establishedBrokerInvocationId: options.establishedBrokerInvocationId }
        : {}),
    }
  )

  if (admission.decision === 'runtime-unavailable') {
    // T-07397: carry the admission reason into the detail so a caller can tell
    // "scope occupied and you refused reuse — use a fresh scope or drop the
    // refusal" apart from generic unavailability. This throw happens BEFORE the
    // broker-reuse and stale-and-reprovision branches, so a refusal never
    // reaches markRuntimeStaleForBrokerReprovision: zero mutation of the live
    // operator runtime.
    throw new HrcRuntimeUnavailableError(admission.reason, {
      hostSessionId: session.hostSessionId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
      route: 'interactive-broker',
      reason: admission.reason,
    })
  }

  if (
    admission.decision === 'broker-start' &&
    isProviderOnlyOpenAiInteractiveIntent(normalizedInputIntent)
  ) {
    throw new HrcRuntimeUnavailableError('runtime intent is not broker-admissible', {
      hostSessionId: session.hostSessionId,
      provider: normalizedInputIntent.harness.provider,
      route: 'interactive-broker',
    })
  }

  if (admission.decision === 'broker-reuse') {
    if (!latestRuntime) {
      throw new HrcRuntimeUnavailableError('interactive broker runtime is unavailable', {
        hostSessionId: session.hostSessionId,
        route: 'interactive-broker',
      })
    }
    assertActuatorSplitRuntimeReuse(intent, latestRuntime)
    await this.publishPresentation(latestRuntime, {
      operatorAttachPending: options.attachBeforeInvocationStart !== undefined,
    })
    return await withObservation(
      await this.executeInteractiveBrokerInputTurn(session, latestRuntime, prompt, runId, {
        waitForCompletion:
          admission.allowedBrokerDriver === 'codex-cli-tmux' ||
          admission.allowedBrokerDriver === 'pi-tui-tmux' ||
          admission.allowedBrokerDriver === 'muse-cli-tmux'
            ? false
            : options.waitForCompletion,
        repairCorrelation: options.repairCorrelation,
        responseFormat: options.responseFormat,
        ...dispatchRunPersistence(options),
      })
    )
  }

  if (admission.decision === 'stale-and-reprovision' && latestRuntime) {
    this.markRuntimeStaleForBrokerReprovision(session, latestRuntime, {
      reason: 'interactive-broker-admission-reprovision',
      allowedBrokerDriver: admission.allowedBrokerDriver,
    })
    if (isProviderOnlyInteractiveIntent(normalizedInputIntent)) {
      throw new HrcRuntimeUnavailableError('runtime intent is not broker-admissible', {
        hostSessionId: session.hostSessionId,
        provider: normalizedInputIntent.harness.provider,
        route: 'interactive-broker',
      })
    }
  }

  return await withObservation(
    await runInteractiveTmuxRoute('broker', {
      broker: async () =>
        this.handleInteractiveTmuxBrokerDispatchTurn(session, intent, prompt, runId, {
          flagEnvName: admission.flagEnvName,
          allowedBrokerDriver: admission.allowedBrokerDriver,
          ...(options.attachBeforeInvocationStart
            ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
            : {}),
          waitForCompletion:
            admission.allowedBrokerDriver === 'codex-cli-tmux' ||
            admission.allowedBrokerDriver === 'pi-tui-tmux' ||
            admission.allowedBrokerDriver === 'muse-cli-tmux'
              ? false
              : options.waitForCompletion,
          joinInFlightRuntimeStart: options.joinInFlightRuntimeStart,
          ...(redirectOffBirthJoin !== undefined ? { redirectOffBirthJoin } : {}),
          coldBirthPromptMode:
            options.coldBirthPromptMode ??
            (options.launchPromptOnColdBirth
              ? 'replace-priming'
              : submissionDoorCarriesColdLaunch(options.submissionDoor)
                ? 'append-to-priming'
                : undefined),
          responseFormat: options.responseFormat,
          ...dispatchRunPersistence(options),
        }),
    })
  )
}

function assertJsonSchemaResponseFormatSupported(
  responseFormat: HrcTurnResponseFormat | undefined,
  detail: Record<string, unknown>
): void {
  if (responseFormat?.kind !== 'json_schema') {
    return
  }
  throw new HrcUnprocessableEntityError(
    HrcErrorCode.UNSUPPORTED_CAPABILITY,
    'responseFormat json_schema is unsupported for the selected route',
    {
      capability: 'finalResponse.jsonSchema',
      responseFormat: { kind: responseFormat.kind },
      required: { jsonSchema: true, perTurn: true },
      actual: null,
      ...detail,
    }
  )
}

function isProviderOnlyInteractiveIntent(intent: HrcRuntimeIntent): boolean {
  return intent.harness.interactive === true && intent.harness.id === undefined
}

function isProviderOnlyOpenAiInteractiveIntent(intent: HrcRuntimeIntent): boolean {
  return isProviderOnlyInteractiveIntent(intent) && intent.harness.provider === 'openai'
}

/**
 * Mode-ENTANGLED surface-reuse reading, kept for the headless/SDK route gate
 * only. T-07397: do NOT use this to decide interactive-broker reuse — it is
 * evaluated against a pre-redirect intent and flips to false once
 * `normalizeClaudeInteractiveBrokerIntent` rewrites `preferredMode`/
 * `harness.interactive`. `refusesSurfaceReuse` (broker-decisions.ts) is the
 * normalization-invariant predicate that governs admission.
 */
function disallowsInteractiveSurfaceReuse(intent: HrcRuntimeIntent): boolean {
  if (intent.execution?.allowInteractiveSurfaceReuse !== false) {
    return false
  }
  return (
    intent.execution?.preferredMode === 'headless' ||
    intent.execution?.preferredMode === 'nonInteractive' ||
    intent.harness.interactive === false
  )
}

export function markRuntimeStaleForBrokerReprovision(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  payload: Record<string, unknown>
): void {
  if (isExternalLifecycleOwner(runtime) || isRuntimeUnavailableStatus(runtime.status)) {
    return
  }

  const now = timestamp()
  if (runtime.activeRunId !== undefined) {
    this.db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: 'runtime staled for harness-broker reprovision',
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
  }

  this.db.runtimes.update(runtime.runtimeId, {
    status: 'stale',
    statusChangedAt: now,
    ...runtimeActivityPatch(this.db, runtime.runtimeId, {
      source: 'housekeeping',
      updatedAt: now,
    }),
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'stale',
      updatedAt: now,
      staleReason: payload['reason'],
      stalePayload: payload,
    },
  })
  const event = appendHrcEvent(this.db, 'runtime.stale', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    ...(runtime.transport === 'sdk' ||
    runtime.transport === 'tmux' ||
    runtime.transport === 'headless'
      ? { transport: runtime.transport }
      : {}),
    payload,
  })
  this.notifyEvent(event)
}
