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
import type { SubmissionDoor, submissionDoorReport } from '../turn-dispatch-submission-support.js'
import type { DispatchTurnForSessionOptions } from './routes/turn-dispatch-session-dispatch.js'

export type SubmissionDoorKind =
  | 'submission'
  | 'turns'
  | 'turns-by-selector'
  | 'literal-flush'
  | 'dm'
  | 'turn-handoff'
  | 'runtime-start-prompt'
  | 'prepare-attached'
/** A read-only claim selection; its allocation belongs exclusively to step 8. */
export type PreparedAdmissionTarget = {
  scopeRef: string
  laneRef: string
  session?: HrcSessionRecord | undefined
  materialize(): Promise<HrcSessionRecord>
}
export type UnallocatedAdmissionTarget = {
  scopeRef: string
  laneRef: string
  prepare(): Promise<PreparedAdmissionTarget>
}
export type SubmissionRequest = {
  door: SubmissionDoorKind
  intent: SubmissionDoor
  target: HrcSessionRecord | UnallocatedAdmissionTarget
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
  target: Pick<HrcSessionRecord, 'scopeRef' | 'laneRef'>
  preparedTarget?: PreparedAdmissionTarget | undefined
  session?: HrcSessionRecord | undefined
  participant?: ParticipantDelivery | null | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  effectiveDoor: SubmissionDoor
  doorReport?: ReturnType<typeof submissionDoorReport> | undefined
  options: DispatchTurnForSessionOptions
  observation?: DispatchTurnObservationContext | undefined
  launchCarry?: { intent: SubmissionDoor; carriesBody: true } | undefined
}
export type { AdmittedPlan } from './plan.js'
