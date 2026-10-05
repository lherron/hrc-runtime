import { appendHrcEvent } from '../hrc-event-helper.js'
import {
  SERVER_EVENT_HOST_SESSION_ID,
  SERVER_EVENT_LANE_REF,
  SERVER_EVENT_SCOPE_REF,
} from '../server-lifecycle.js'
import { timestamp } from '../server-util.js'
import { type AdmissionResult, type RouteOutcome, runLeasedAdmission } from './admit.js'
import { createAdmittedPlan } from './plan.js'
import {
  capabilityAuthority,
  executionPresentation,
  fence,
  launchCarryObservation,
  ownershipProof,
  participantResolution,
  retiredPersona,
  rotation,
} from './steps.js'
import type { AdmissionContext, AdmittedPlan, PartialPlan, SubmissionRequest } from './types.js'

export async function submitThroughAdmission(
  ctx: AdmissionContext,
  req: SubmissionRequest,
  route: (plan: AdmittedPlan) => Promise<RouteOutcome<Response>>
): Promise<AdmissionResult<Response>> {
  const partial: PartialPlan = {
    target: req.target,
    session: 'hostSessionId' in req.target ? req.target : undefined,
    effectiveDoor: req.intent,
    options: { ...req.options },
  }
  return runLeasedAdmission(
    {
      gate: ctx.turnAdmissionGate,
      record: (result) => {
        const session = partial.session
        const cause = result.outcome === 'possible_write' ? result.cause : undefined
        const event = appendHrcEvent(ctx.db, 'submission.admission', {
          ts: timestamp(),
          hostSessionId: session?.hostSessionId ?? SERVER_EVENT_HOST_SESSION_ID,
          scopeRef: session?.scopeRef ?? SERVER_EVENT_SCOPE_REF,
          laneRef: session?.laneRef ?? SERVER_EVENT_LANE_REF,
          generation: session?.generation ?? 0,
          runId: partial.options.runId,
          payload: {
            // A pre-allocation refusal is a daemon fact, using the existing lifecycle sentinel.
            ...(session === undefined
              ? {
                  requestedTarget: {
                    scopeRef: partial.target.scopeRef,
                    laneRef: partial.target.laneRef,
                  },
                }
              : {}),
            door: req.door,
            intent: req.intent,
            effectiveDoor: partial.effectiveDoor,
            trace: result.trace,
            outcome: result.outcome,
            ...(result.outcome === 'routed' ? { routeOutcome: result.routed.kind } : {}),
            ...(result.outcome === 'refused' ? { refusalCode: result.refusal.code } : {}),
            ...(result.outcome === 'possible_write'
              ? {
                  uncertainCause:
                    cause instanceof Error
                      ? { name: cause.name, message: cause.message }
                      : String(cause),
                }
              : {}),
          },
        })
        ctx.notifyEvent(event)
      },
    },
    {
      signal: req.signal,
      steps: [
        { step: 'retired-persona', run: () => retiredPersona(ctx, req, partial) },
        { step: 'fence', run: () => fence(ctx, req, partial) },
        { step: 'participant-resolution', run: () => participantResolution(ctx, req, partial) },
        { step: 'ownership-proof', run: () => ownershipProof(ctx, req, partial) },
        { step: 'capability-authority', run: () => capabilityAuthority(ctx, req, partial) },
        { step: 'execution-presentation', run: () => executionPresentation(ctx, req, partial) },
        { step: 'rotation', run: () => rotation(ctx, req, partial) },
        { step: 'launch-carry-observation', run: () => launchCarryObservation(ctx, req, partial) },
      ],
      route: async () => {
        // The branded plan exists only here, under the lease; callers never receive it.
        if (partial.session === undefined)
          throw new Error('admission did not materialize its target')
        // Claim materializers never cross the step-8 boundary into the branded route plan.
        const plan = createAdmittedPlan({
          session: partial.session,
          participant: partial.participant,
          runtimeIntent: partial.runtimeIntent,
          effectiveDoor: partial.effectiveDoor,
          doorReport: partial.doorReport,
          options: partial.options,
          observation: partial.observation,
          launchCarry: partial.launchCarry,
          request: { ...req, target: partial.session },
        })
        const routed = await route(plan)
        // Submission retains its envelope-rich event; other invoke doors use the same decision.
        if (req.door !== 'submission' && partial.doorReport?.requestedDoor !== undefined) {
          const response = routed.kind === 'accepted' ? routed.value : routed.rejection.value
          const receipt = (await response.clone().json()) as {
            runtimeId?: string
            submissionId?: string
            runId?: string
          }
          const runtime = partial.doorReport.runtime
          appendHrcEvent(ctx.db, 'submission.door_downgraded', {
            ts: timestamp(),
            hostSessionId: plan.session.hostSessionId,
            scopeRef: plan.session.scopeRef,
            laneRef: plan.session.laneRef,
            generation: plan.session.generation,
            runId: receipt.runId ?? plan.options.runId,
            runtimeId: receipt.runtimeId ?? runtime?.runtimeId,
            payload: {
              requestedDoor: partial.doorReport.requestedDoor,
              effectiveDoor: plan.effectiveDoor,
              reason: partial.doorReport.downgradeReason,
              ...((receipt.runtimeId ?? runtime?.runtimeId)
                ? { runtimeId: receipt.runtimeId ?? runtime?.runtimeId }
                : {}),
              ...(runtime?.activeInvocationId === undefined
                ? {}
                : { invocationId: runtime.activeInvocationId }),
              ...(receipt.submissionId === undefined ? {} : { submissionId: receipt.submissionId }),
            },
          })
        }
        return routed
      },
    }
  )
}

/** A refusal response retains the preempt door's existing HTTP shape. */
export function submissionResponse(result: AdmissionResult<Response>): Response {
  if (result.outcome === 'refused' && result.refusal.cause instanceof Response)
    return result.refusal.cause
  if (result.outcome === 'refused') throw result.refusal.cause
  if (result.outcome === 'possible_write') throw result.cause
  if (result.outcome === 'replayed') return result.recorded
  return result.routed.kind === 'accepted' ? result.routed.value : result.routed.rejection.value
}
