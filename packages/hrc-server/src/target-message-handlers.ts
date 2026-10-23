import {
  handleQueryMessages,
  handleSemanticTurnHandoff,
  persistAndDeliverSemanticTurnHandoff,
} from './target-message-handoff-handlers.js'
import {
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
export {
  handleListTargets,
  handleGetTarget,
  handleResumeContinuation,
  handleQueryMessages,
  handleSemanticTurnHandoff,
  persistAndDeliverSemanticTurnHandoff,
}

export const targetMessageHandlersMethods = {
  handleListTargets,
  handleGetTarget,
  handleResumeContinuation,
  handleQueryMessages,
  handleSemanticTurnHandoff,
  persistAndDeliverSemanticTurnHandoff,
}

export type TargetMessageHandlersMethods = typeof targetMessageHandlersMethods
