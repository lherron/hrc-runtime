import { markRuntimeStaleForBrokerReprovision } from './turn-admission/routes/turn-dispatch-admitted-turn.js'
import {
  handlePrepareAttachedRun,
  handleResumeAttachedRun,
} from './turn-dispatch-attached-run-handlers.js'
import {
  handleDispatchTurn,
  handleEnsureRuntime,
  handleOpenBrokerSession,
  handleStartRuntime,
  openHeadlessBrokerSessionForSession,
  reattachDurableBrokerSessionForOpen,
  waitForBrokerSessionOpenReady,
} from './turn-dispatch-runtime-handlers.js'
import { handleSubmission } from './turn-dispatch-submission-handlers.js'
import { handlePreemptAdmission } from './turn-dispatch-submission-support.js'

export {
  handlePreemptAdmission,
  isOperatorPrincipal,
  preemptAdmission,
  storedAdmissionRequestsForSubmissionIds,
  submissionDoorReport,
  waitForSubmissionTerminal,
} from './turn-dispatch-submission-support.js'
export type { StoredAdmissionRequest } from './turn-dispatch-submission-support.js'
export {
  handleSubmission,
  projectSubmissionResponse,
  waitForPublicDispatchStage,
} from './turn-dispatch-submission-handlers.js'
export {
  handleDispatchTurn,
  handleEnsureRuntime,
  handleOpenBrokerSession,
  handleStartRuntime,
  openHeadlessBrokerSessionForSession,
  reattachDurableBrokerSessionForOpen,
  waitForBrokerSessionOpenReady,
} from './turn-dispatch-runtime-handlers.js'
export {
  handlePrepareAttachedRun,
  handleResumeAttachedRun,
} from './turn-dispatch-attached-run-handlers.js'
export { markRuntimeStaleForBrokerReprovision } from './turn-admission/routes/turn-dispatch-admitted-turn.js'

export const turnDispatchHandlersMethods = {
  handleEnsureRuntime,
  handleStartRuntime,
  handleOpenBrokerSession,
  handleDispatchTurn,
  handleSubmission,
  handlePreemptAdmission,
  handlePrepareAttachedRun,
  handleResumeAttachedRun,
  openHeadlessBrokerSessionForSession,
  reattachDurableBrokerSessionForOpen,
  waitForBrokerSessionOpenReady,
  markRuntimeStaleForBrokerReprovision,
}

export type TurnDispatchHandlersMethods = typeof turnDispatchHandlersMethods
