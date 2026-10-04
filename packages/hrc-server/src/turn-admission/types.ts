import type {
  HrcExecutionFormat,
  HrcFence,
  HrcRuntimeIntent,
  HrcSessionRecord,
  HrcTurnResponseFormat,
  PreemptSubmissionRequest,
} from 'hrc-core'
import type { ParticipantDelivery } from '../participant-delivery.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import type { DispatchTurnObservationContext } from '../turn-dispatch-attached-run-handlers.js'
import type { DispatchTurnForSessionOptions } from '../turn-dispatch-session-dispatch.js'
import type { SubmissionDoor, submissionDoorReport } from '../turn-dispatch-submission-support.js'

export type SubmissionDoorKind =
  | 'submission'
  | 'turns'
  | 'turns-by-selector'
  | 'literal-flush'
  | 'dm'
  | 'turn-handoff'
  | 'runtime-start-prompt'
  | 'prepare-attached'
export type SubmissionRequest = {
  door: SubmissionDoorKind
  intent: SubmissionDoor
  target: HrcSessionRecord
  body: string
  principal: string
  runtimeIntent?: HrcRuntimeIntent | undefined
  attachments?: HrcRuntimeIntent['attachments'] | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
  executionFormat: HrcExecutionFormat
  fences?: HrcFence | undefined
  carried?:
    | {
        ownershipProof?: string | undefined
        idempotencyKey?: string | undefined
        freshContext?: boolean | undefined
      }
    | undefined
  allowStaleGeneration?: boolean | undefined
  preemptRequest?: PreemptSubmissionRequest | undefined
  signal?: AbortSignal | undefined
  options: DispatchTurnForSessionOptions
  pendingReplay?:
    | ((
        session: HrcSessionRecord
      ) => Promise<{ format: HrcExecutionFormat; project(): Promise<Response> } | undefined>)
    | undefined
  replay(
    run: NonNullable<ReturnType<HrcServerInstanceForHandlers['db']['runs']['getByRunId']>>
  ): Promise<Response>
}
export type AdmissionContext = HrcServerInstanceForHandlers
export type PartialPlan = {
  session: HrcSessionRecord
  participant?: ParticipantDelivery | null | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  effectiveDoor: SubmissionDoor
  doorReport?: ReturnType<typeof submissionDoorReport> | undefined
  options: DispatchTurnForSessionOptions
  observation?: DispatchTurnObservationContext | undefined
  launchCarry?: { intent: SubmissionDoor; carriesBody: true } | undefined
}
declare const admittedPlanBrand: unique symbol
export type AdmittedPlan = Readonly<PartialPlan> & {
  readonly [admittedPlanBrand]: true
  readonly request: SubmissionRequest
}
