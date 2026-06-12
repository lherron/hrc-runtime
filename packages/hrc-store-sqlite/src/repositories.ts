// The repository layer was split into cohesive sibling modules under
// `./repositories/` to keep every file under the size budget. This module
// re-exports the complete public surface so existing importers (e.g. `index.ts`
// and downstream packages) continue to resolve every symbol from
// `./repositories.js` exactly as before. The split is purely mechanical: no
// symbol was renamed and no signature changed.

export type {
  AppManagedSessionFindOptions,
  AppManagedSessionRecord,
  AppSessionApplyInput,
  AppSessionBulkApplyResult,
  ContinuityUpsertInput,
  EventQueryFilters,
  HrcActiveInputDeliveryRecord,
  HrcLifecycleQueryFilters,
  HrcRuntimeBufferRecord,
  LaunchUpdatePatch,
  LocalBridgeStatus,
  RunListFilters,
  RuntimeUpdatePatch,
  RunUpdatePatch,
  SessionListFilters,
  SurfaceBindingBindInput,
} from './repositories/shared.js'

export {
  AppManagedSessionRepository,
  AppSessionRepository,
  ContinuityRepository,
  SessionRepository,
} from './repositories/session-repositories.js'

export {
  LaunchRepository,
  RunRepository,
  RuntimeRepository,
} from './repositories/runtime-repositories.js'

export type { EventAppendInput, HrcLifecycleEventInput } from './repositories/event-repositories.js'
export {
  EventRepository,
  HrcLifecycleEventRepository,
} from './repositories/event-repositories.js'

export {
  ActiveInputDeliveryRepository,
  LocalBridgeRepository,
  RuntimeBufferRepository,
  SurfaceBindingRepository,
} from './repositories/bridge-repositories.js'

export type {
  BrokerInvocationEventAppendInput,
  BrokerInvocationEventAppendResult,
  BrokerInvocationUpdatePatch,
  RuntimeOperationUpdatePatch,
} from './repositories/broker-repositories.js'
export {
  BrokerInvocationEventConflictError,
  BrokerInvocationEventRepository,
  BrokerInvocationRepository,
  CompiledRuntimePlanRepository,
  computePermissionIdentityKey,
  LifecyclePolicyRepository,
  PermissionDecisionRepository,
  RuntimeArtifactRepository,
  RuntimeOperationRepository,
} from './repositories/broker-repositories.js'
