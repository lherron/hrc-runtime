import {
  deliverPersistedSemanticDm,
  handleSemanticDm,
  reattachLiveSemanticDmSubstrate,
  rejectBusyHeadlessSemanticDm,
} from './target-message-dm-handlers.js'
import {
  handleQueryMessages,
  handleSemanticTurnHandoff,
  handleTraceMessage,
  persistAndDeliverSemanticTurnHandoff,
} from './target-message-handoff-handlers.js'
import {
  handleArchiveAbandonedSessions,
  handleCreateSessionSuccessor,
  handleGetTarget,
  handleListTargets,
  handleResumeContinuation,
} from './target-message-successor-handlers.js'

export { archiveIdleSessions } from './target-message-successor-handlers.js'
export type { ArchiveIdleSessionsResult } from './target-message-successor-handlers.js'
export {
  assertReplyScopeMatches,
  deliverPersistedSemanticTurnHandoff,
} from './target-message-handoff-handlers.js'
export { completeDirectiveOnlyIntent } from './target-message-dm-handlers.js'
export {
  handleListTargets,
  handleGetTarget,
  handleCreateSessionSuccessor,
  handleResumeContinuation,
  handleArchiveAbandonedSessions,
  handleQueryMessages,
  handleTraceMessage,
  handleSemanticTurnHandoff,
  persistAndDeliverSemanticTurnHandoff,
  handleSemanticDm,
  deliverPersistedSemanticDm,
  rejectBusyHeadlessSemanticDm,
  reattachLiveSemanticDmSubstrate,
}

export const targetMessageHandlersMethods = {
  handleListTargets,
  handleGetTarget,
  handleCreateSessionSuccessor,
  handleResumeContinuation,
  handleArchiveAbandonedSessions,
  handleQueryMessages,
  handleTraceMessage,
  handleSemanticTurnHandoff,
  persistAndDeliverSemanticTurnHandoff,
  handleSemanticDm,
  deliverPersistedSemanticDm,
  rejectBusyHeadlessSemanticDm,
  reattachLiveSemanticDmSubstrate,
}

export type TargetMessageHandlersMethods = typeof targetMessageHandlersMethods
