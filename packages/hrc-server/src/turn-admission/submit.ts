import { appendHrcEvent } from '../hrc-event-helper.js'
import { timestamp } from '../server-util.js'
import { type AdmissionResult, type RouteOutcome, runLeasedAdmission } from './admit.js'
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
    session: req.target,
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
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          runId: partial.options.runId,
          payload: {
            door: req.door,
            intent: req.intent,
            effectiveDoor: partial.effectiveDoor,
            trace: result.trace,
            outcome: result.outcome,
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
      route: () => {
        // The branded plan exists only here, under the lease; callers never receive it.
        const plan = { ...partial, request: req } as AdmittedPlan
        return route(plan)
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
