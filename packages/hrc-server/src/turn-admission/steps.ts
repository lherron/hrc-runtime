import { randomUUID } from 'node:crypto'
import { HrcConflictError, HrcErrorCode, HrcRuntimeUnavailableError, validateFence } from 'hrc-core'
import {
  assertActuatorSplitRouteAdmission,
  assertActuatorSplitRuntimeReuse,
} from '../actuator-split.js'
import {
  assertPreparedAspdAttemptFormat,
  findPreparedAspdAttemptForFormatRetry,
  readAspdPreparation,
} from '../aspd-headless-start.js'
import {
  CALLER_SURFACE_REUSE_REFUSAL,
  decideHeadlessExecutionRoute,
  isProducerSelectedOrdinaryBirth,
  shouldRedirectClaudeToInteractiveBroker,
  shouldUseHeadlessTransport,
  shouldUseSdkTransport,
} from '../broker-decisions.js'
import {
  BROKER_PREEMPT_UNSUPPORTED_REASON,
  brokerCapabilitiesSupportAdmissionClass,
} from '../broker/capabilities.js'
import { normalizeDispatchIntent } from '../dispatch-invocation.js'
import { assertScopeNotRetired } from '../federation/summon-gate-server.js'
import { assertLocalPersonaAllowed } from '../local-persona-policy.js'
import {
  participantDeliveryUnavailable,
  participantRotationUnsupported,
  resolveParticipantDelivery,
} from '../participant-delivery.js'
import {
  assertNoOperatorPresentationConflict,
  assertOperatorPresentationRoutable,
  withFrozenOperatorPresentation,
} from '../presentation-operator.js'
import { requireContinuity, requireSession } from '../require-helpers.js'
import { omitPersistedSelectionForReuse } from '../selector-message-handlers/selection-request.js'
import { json } from '../server-util.js'
import { createNotifiedSessionSuccessor } from '../target-message-successor-handlers.js'
import { captureBrokerAfterSeqByInvocation } from '../turn-dispatch-attached-run-handlers.js'
import { assertBrokerRuntimeExecutionFormat } from '../turn-dispatch-runtime-handlers.js'
import {
  activeBrokerRuntimeForSession,
  assertIdempotencyExecutionFormat,
  preemptAdmission,
  submissionDoorReport,
} from '../turn-dispatch-submission-support.js'
import { assertRuntimeSupportsResponseFormat } from '../turn-response-format.js'
import type { StepOutcome } from './admit.js'
import type { AdmissionContext, PartialPlan, SubmissionRequest } from './types.js'

const passed = { outcome: 'passed' } as const
const absent = { outcome: 'skipped:not-carried' } as const

export async function retiredPersona(
  ctx: AdmissionContext,
  req: SubmissionRequest,
  partial: PartialPlan
): Promise<StepOutcome<Response>> {
  assertLocalPersonaAllowed(ctx, partial.target.scopeRef)
  if ('prepare' in req.target) {
    const selected = await req.target.prepare()
    partial.preparedTarget = selected
    partial.target = selected
    partial.session = selected.session
    assertLocalPersonaAllowed(ctx, selected.scopeRef)
  }
  await assertScopeNotRetired(ctx, { scopeRef: partial.target.scopeRef, path: 'resolve-session' })
  return passed
}

/** Used on both the replay branch and ordinary format preflight. */
export function assertFrozenFormat(
  ctx: AdmissionContext,
  req: SubmissionRequest,
  session: PartialPlan['session'],
  recorded?: { format: SubmissionRequest['executionFormat']; source: 'run' | 'preparation' }
): void {
  if (session === undefined) return
  if (recorded !== undefined) {
    assertIdempotencyExecutionFormat(recorded.format, req.executionFormat, {
      hostSessionId: session.hostSessionId,
      idempotencyKey: req.carried?.idempotencyKey ?? '',
      source: recorded.source,
    })
    return
  }
  const runtime = activeBrokerRuntimeForSession(ctx, session)
  if (runtime !== undefined) assertBrokerRuntimeExecutionFormat(ctx, runtime, req.executionFormat)
}

export async function fence(
  ctx: AdmissionContext,
  req: SubmissionRequest,
  partial: PartialPlan
): Promise<StepOutcome<Response>> {
  if (partial.session === undefined) return absent
  if (req.fences !== undefined || req.door === 'turns') {
    const continuity = requireContinuity(ctx.db, partial.session)
    const active = requireSession(ctx.db, continuity.activeHostSessionId)
    const checked = validateFence(req.fences, {
      activeHostSessionId: active.hostSessionId,
      generation: active.generation,
    })
    if (!checked.ok)
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, checked.message, checked.detail)
    partial.session = requireSession(ctx.db, checked.resolvedHostSessionId)
  }
  const key = req.carried?.idempotencyKey
  if (key === undefined) return req.fences === undefined ? absent : passed
  const existing = ctx.db.runs.getByDispatchIdempotencyKey(partial.session.hostSessionId, key)
  if (existing !== null) {
    // Reread the recorded selector before projecting the replay. No later step runs.
    const recorded = ctx.db.runs.getByRunId(existing.runId)
    if (recorded === null) throw new HrcRuntimeUnavailableError('idempotency replay disappeared')
    assertFrozenFormat(ctx, req, partial.session, {
      format: recorded.executionFormat ?? 'format1',
      source: 'run',
    })
    partial.options.runId = recorded.runId
    return { outcome: 'replayed', recorded: await req.replay(recorded) }
  }
  const pending = await req.pendingReplay?.(partial.session)
  if (pending !== undefined) {
    assertFrozenFormat(ctx, req, partial.session, { format: pending.format, source: 'run' })
    return { outcome: 'replayed', recorded: await pending.project() }
  }
  const prepared = findPreparedAspdAttemptForFormatRetry(ctx, partial.session.hostSessionId, key)
  if (prepared !== undefined) {
    assertPreparedAspdAttemptFormat(prepared, req.executionFormat, partial.session.hostSessionId)
    assertFrozenFormat(ctx, req, partial.session, {
      format: prepared.executionFormat,
      source: 'preparation',
    })
    if (req.door === 'turns' && req.executionFormat === 'format1') {
      if (prepared.runId === undefined)
        throw new HrcRuntimeUnavailableError('format1 preparation has no admission-time run id', {
          code: 'execution_format_mismatch',
        })
      partial.options.runId = prepared.runId
    }
  }
  return passed
}

export async function participantResolution(
  ctx: AdmissionContext,
  req: SubmissionRequest,
  partial: PartialPlan
): Promise<StepOutcome<Response>> {
  if (partial.session === undefined) {
    if (ctx.db.participantRegistrations.getRegistrationByScopeRef(partial.target.scopeRef) !== null)
      throw new HrcRuntimeUnavailableError(
        'participant addresses cannot be substituted by a birth',
        { reason: 'participant_substitution' }
      )
    return { outcome: 'skipped:not-applicable' }
  }
  if (req.door === 'runtime-start-prompt') {
    const registration = ctx.db.participantRegistrations.getRegistrationByScopeRef(
      partial.session.scopeRef
    )
    if (registration !== null)
      throw new HrcRuntimeUnavailableError('participant scope cannot be cold-born', {
        scopeRef: partial.session.scopeRef,
        registrationId: registration.registrationId,
        reason: 'participant_address_reserved',
      })
  }
  partial.participant = resolveParticipantDelivery(ctx, partial.session)
  if (partial.participant === null) return { outcome: 'skipped:not-applicable' }
  if (req.carried?.freshContext === true)
    throw participantRotationUnsupported(partial.session, 'fresh-context rotation')
  if (partial.participant.outcome === 'refused')
    throw participantDeliveryUnavailable(partial.session, partial.participant)
  // A reconnect is route work. Doing it here would violate preflight's E0.
  return passed
}

export async function ownershipProof(
  ctx: AdmissionContext,
  req: SubmissionRequest,
  partial: PartialPlan
): Promise<StepOutcome<Response>> {
  if (partial.session === undefined) return absent
  const carried = req.carried?.ownershipProof
  if (carried === undefined) return absent
  const runtime =
    partial.participant?.outcome === 'attached' || partial.participant?.outcome === 'reconnect'
      ? partial.participant.runtime
      : activeBrokerRuntimeForSession(ctx, partial.session)
  if (req.intent === 'steer' || (runtime !== undefined && carried !== runtime.activeInvocationId)) {
    throw new HrcRuntimeUnavailableError(CALLER_SURFACE_REUSE_REFUSAL, {
      hostSessionId: partial.session.hostSessionId,
      runtimeId: runtime?.runtimeId,
      route: runtime?.transport === 'tmux' ? 'interactive-broker' : 'headless-broker',
      reason: CALLER_SURFACE_REUSE_REFUSAL,
      expectedInvocationId: carried,
      actualInvocationId: runtime?.activeInvocationId,
    })
  }
  return passed
}

export async function capabilityAuthority(
  ctx: AdmissionContext,
  req: SubmissionRequest,
  partial: PartialPlan
): Promise<StepOutcome<Response>> {
  if (partial.session === undefined) return passed
  if (req.intent === 'preempt' && req.preemptRequest !== undefined) {
    const admission = await preemptAdmission(ctx, partial.session, req.preemptRequest)
    if (admission !== 'authorized') {
      const reason =
        admission === 'preempt-unsupported' ? BROKER_PREEMPT_UNSUPPORTED_REASON : 'authority-denied'
      const response = json({
        submissionId: `hrc-rejected-${randomUUID()}`,
        admission: 'rejected',
        reason,
        disposition: { type: 'rejected', reason },
      })
      return {
        outcome: 'refused',
        refusal: {
          code:
            admission === 'preempt-unsupported' ? 'preempt_unsupported' : 'preempt_unauthorized',
          cause: response,
        },
      }
    }
  }
  partial.doorReport = submissionDoorReport(ctx, partial.session, req.intent)
  partial.effectiveDoor = partial.doorReport.effectiveDoor
  if (req.intent === 'invoke') {
    const runtime = activeBrokerRuntimeForSession(ctx, partial.session)
    const invocation =
      runtime?.activeInvocationId === undefined
        ? null
        : ctx.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
    if (
      runtime !== undefined &&
      !brokerCapabilitiesSupportAdmissionClass(invocation?.capabilitiesJson, 'exclusive')
    )
      partial.effectiveDoor = 'enqueue'
  }
  partial.options.submissionDoor = req.intent === 'invoke' ? 'invoke' : partial.effectiveDoor
  return passed
}

export async function executionPresentation(
  ctx: AdmissionContext,
  req: SubmissionRequest,
  partial: PartialPlan
): Promise<StepOutcome<Response>> {
  if (partial.participant != null) {
    if (partial.participant.outcome !== 'refused')
      assertBrokerRuntimeExecutionFormat(ctx, partial.participant.runtime, req.executionFormat)
    if (req.executionFormat === 'format2')
      throw new HrcRuntimeUnavailableError('format2 is unsupported for this dispatch target', {
        code: 'execution_format_unsupported_door',
        targetKind: 'participant',
      })
    return passed
  }
  assertFrozenFormat(ctx, req, partial.session)
  // Literal flush routes only into its live broker. It has no birth intent on the wire.
  if (
    req.door === 'literal-flush' &&
    req.runtimeIntent === undefined &&
    partial.session?.lastAppliedIntentJson === undefined
  ) {
    if (
      partial.session === undefined ||
      activeBrokerRuntimeForSession(ctx, partial.session) === undefined
    )
      throw new HrcRuntimeUnavailableError('no live literal-capable runtime is currently bound')
    return passed
  }
  partial.runtimeIntent = normalizeDispatchIntent(
    req.runtimeIntent ?? omitPersistedSelectionForReuse(partial.session?.lastAppliedIntentJson),
    partial.session ?? partial.target,
    partial.options.runId
  )
  if (req.attachments !== undefined)
    partial.runtimeIntent = { ...partial.runtimeIntent, attachments: req.attachments }
  const key = req.carried?.idempotencyKey
  const prepared =
    key === undefined || partial.session === undefined
      ? undefined
      : findPreparedAspdAttemptForFormatRetry(ctx, partial.session.hostSessionId, key)
  if (prepared !== undefined && partial.session !== undefined) {
    assertPreparedAspdAttemptFormat(prepared, req.executionFormat, partial.session.hostSessionId)
    partial.runtimeIntent = withFrozenOperatorPresentation(
      partial.runtimeIntent,
      readAspdPreparation(ctx, prepared.operationId).record.intent
    )
  }
  const runtime =
    partial.session === undefined ? undefined : activeBrokerRuntimeForSession(ctx, partial.session)
  const ordinary = isProducerSelectedOrdinaryBirth(partial.runtimeIntent)
  assertActuatorSplitRouteAdmission(
    partial.runtimeIntent,
    runtime?.transport === 'tmux'
      ? 'interactive-broker'
      : ordinary
        ? 'broker'
        : shouldUseHeadlessTransport(partial.runtimeIntent)
          ? decideHeadlessExecutionRoute(partial.runtimeIntent, {
              brokerFlagEnabled: ctx.headlessCodexBrokerEnabled,
              museBrokerFlagEnabled: ctx.headlessMuseBrokerEnabled,
            })
          : shouldUseSdkTransport(partial.runtimeIntent)
            ? 'sdk'
            : 'interactive-broker'
  )
  if (runtime !== undefined) {
    assertActuatorSplitRuntimeReuse(partial.runtimeIntent, runtime)
    assertRuntimeSupportsResponseFormat({
      db: ctx.db,
      runtime,
      responseFormat: req.responseFormat,
      route: runtime.transport === 'tmux' ? 'interactive-broker' : 'broker',
    })
  }
  assertNoOperatorPresentationConflict(
    partial.runtimeIntent,
    partial.session === undefined
      ? []
      : ctx.db.runtimes.listByHostSessionId(partial.session.hostSessionId)
  )
  if (!ordinary)
    assertOperatorPresentationRoutable(partial.runtimeIntent, {
      claudeRedirect:
        !ordinary &&
        ctx.claudeCodeTmuxBrokerEnabled &&
        shouldRedirectClaudeToInteractiveBroker(partial.runtimeIntent),
      headlessTransport: ordinary || shouldUseHeadlessTransport(partial.runtimeIntent),
      headlessRoute: isProducerSelectedOrdinaryBirth(partial.runtimeIntent)
        ? 'broker'
        : shouldUseHeadlessTransport(partial.runtimeIntent)
          ? decideHeadlessExecutionRoute(partial.runtimeIntent, {
              brokerFlagEnabled: ctx.headlessCodexBrokerEnabled,
              museBrokerFlagEnabled: ctx.headlessMuseBrokerEnabled,
            })
          : undefined,
    })
  if (
    !ordinary &&
    runtime === undefined &&
    shouldUseSdkTransport(partial.runtimeIntent) &&
    partial.session !== undefined
  ) {
    ctx.failSdkHarnessPath(
      'handleSdkDispatchTurn',
      partial.session,
      partial.runtimeIntent,
      partial.options.runId
    )
  }
  if (req.executionFormat === 'format2' && !shouldUseHeadlessTransport(partial.runtimeIntent)) {
    throw new HrcRuntimeUnavailableError('format2 requires a headless broker input route', {
      code: 'format2_initial_input_undeliverable',
    })
  }
  return passed
}

export async function rotation(
  ctx: AdmissionContext,
  req: SubmissionRequest,
  partial: PartialPlan
): Promise<StepOutcome<Response>> {
  if (partial.preparedTarget !== undefined) {
    partial.session = await partial.preparedTarget.materialize()
    if (req.door === 'runtime-start-prompt') {
      partial.runtimeIntent = normalizeDispatchIntent(
        partial.runtimeIntent,
        partial.session,
        partial.options.runId
      )
      return passed
    }
  }
  if (partial.session === undefined) throw new Error('admission has no rotation target')
  if (partial.participant != null) return { outcome: 'skipped:not-applicable' }
  if (
    (req.door === 'dm' || req.door === 'turn-handoff') &&
    partial.session.status === 'archived' &&
    partial.session.continuation?.key
  )
    partial.session = await createNotifiedSessionSuccessor(
      ctx,
      partial.session,
      req.runtimeIntent,
      'local'
    )
  if (req.intent !== 'steer') {
    partial.session = (
      await ctx.maybeAutoRotateStaleSession(partial.session, {
        allowStaleGeneration: req.allowStaleGeneration,
        trigger: req.door === 'submission' ? `submission-${req.intent}` : 'dispatch-turn',
      })
    ).session
  }
  if (req.carried?.freshContext === true) {
    const next = await ctx.rotateSessionContext(partial.session, {
      relaunch: false,
      dropContinuation: true,
      runtimeIntent: req.runtimeIntent,
      reason: `submission-${req.intent}-fresh-context`,
    })
    partial.session = requireSession(ctx.db, next.hostSessionId)
  }
  // Correlation follows the successor, but an inherited presentation remains omitted.
  if (partial.runtimeIntent !== undefined)
    partial.runtimeIntent = normalizeDispatchIntent(
      partial.runtimeIntent,
      partial.session,
      partial.options.runId
    )
  return passed
}

export async function launchCarryObservation(
  ctx: AdmissionContext,
  req: SubmissionRequest,
  partial: PartialPlan
): Promise<StepOutcome<Response>> {
  if (partial.session === undefined) throw new Error('admission has no launch target')
  partial.launchCarry = { intent: req.intent, carriesBody: true }
  partial.observation = {
    lifecycleFromSeq: ctx.db.hrcEvents.maxHrcSeq() + 1,
    brokerAfterSeqByInvocation: captureBrokerAfterSeqByInvocation(
      ctx,
      partial.session.hostSessionId
    ),
  }
  // intent is mandatory; routing never derives carry from an absent door.
  partial.options.submissionDoor = req.intent === 'invoke' ? 'invoke' : partial.effectiveDoor
  return passed
}
