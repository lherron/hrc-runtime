export {
  adaptHrcLifecycleEvent,
  canonicalSessionRefFromEvent,
  hrcLifecycleEventToSessionEnvelope,
  type HrcLifecycleEventPayload,
} from './hrc-event-adapter.js'
export { createLogger } from './logger.js'
export {
  SessionEventsManager,
  runStateToFrame,
  type AssistantSegment,
  type OnRenderCallback,
  type OnRunQueuedCallback,
  type RenderFrameCallback,
  type RunState,
} from './session-events-manager.js'
export type {
  GatewayNoticeEvent,
  GatewayPermissionDecisionEvent,
  GatewayPermissionRequestEvent,
  GatewayRunCancelledEvent,
  GatewayRunCompletedEvent,
  GatewayRunFailedEvent,
  GatewayRunQueuedEvent,
  GatewayRunStartedEvent,
  GatewaySessionEvent,
  GatewaySessionMetadataEvent,
  PermissionAction,
  ProjectId,
  RenderAction,
  RenderBlock,
  RenderFrame,
  RunId,
  SessionEventEnvelope,
} from './types.js'
