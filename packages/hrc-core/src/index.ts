import packageJson from '../package.json' with { type: 'json' }

export const HRC_API_VERSION = packageJson.version

export {
  HrcBadRequestError,
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
  createHrcError,
  httpStatusForErrorCode,
} from './errors.js'
export type { HrcHttpError, HrcHttpStatus } from './errors.js'

export {
  isConcreteSelector,
  isStableSelector,
  normalizeSessionRef,
  parseSelector,
} from './selectors.js'
export type {
  HrcConcreteSelector,
  HrcSelector,
  HrcSessionRef,
  HrcStableSelector,
} from './selectors.js'

export { parseFence, validateFence } from './fences.js'
export type {
  HrcActiveSessionState,
  HrcFence,
  HrcFenceValidationFailure,
  HrcFenceValidationResult,
  HrcFenceValidationSuccess,
} from './fences.js'

export {
  resolveControlSocketPath,
  resolveDatabasePath,
  resolveLaunchesDir,
  resolveMigrationsDir,
  resolveRuntimeRoot,
  resolveSpoolDir,
  resolveStateRoot,
  resolveTmuxSocketPath,
} from './paths.js'

export type {
  HrcAppCommandSessionSpec,
  HrcAppHarnessSessionSpec,
  HrcAppSessionRecord,
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcRuntimeKind,
  HrcCapabilityStatus,
  HrcCommandLaunchSpec,
  HrcContinuityRecord,
  HrcContinuationRef,
  HrcEventEnvelope,
  HrcEventSource,
  HrcExecutionIntent,
  HrcExecutionMode,
  HrcHarness,
  HrcHarnessIntent,
  HrcHookBridgeConfig,
  HrcLaunchArtifact,
  HrcLaunchEnvConfig,
  HrcLaunchRecord,
  HrcLocalBridgeRecord,
  HrcManagedSessionKind,
  HrcManagedSessionRecord,
  HrcProvider,
  HrcRunRecord,
  HrcSurfaceBindingRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from './contracts.js'

export type {
  ApplyAppManagedSessionInput,
  ApplyAppManagedSessionsRequest,
  ApplyAppManagedSessionsResponse,
  ApplyAppSessionInput,
  ApplyAppSessionsRequest,
  ApplyAppSessionsResponse,
  AppSessionFreshnessFence,
  BindSurfaceRequest,
  CaptureResponse,
  ClearContextRequest,
  ClearContextResponse,
  CloseBridgeRequest,
  DeliverBridgeRequest,
  DeliverBridgeResponse,
  DispatchTurnRequest,
  DispatchTurnResponse,
  EnsureAppSessionRequest,
  EnsureAppSessionResponse,
  EnsureRuntimeRequest,
  HrcAppSessionFilter,
  EnsureRuntimeResponse,
  HealthResponse,
  HrcAttachDescriptor,
  HrcBridgeDeliverTextRequest,
  HrcBridgeDeliverTextResponse,
  HrcBridgeTargetRequest,
  HrcBridgeTargetResponse,
  InterruptAppSessionRequest,
  ListAppSessionsRequest,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
  RemoveAppSessionRequest,
  RemoveAppSessionResponse,
  ResolveSessionRequest,
  ResolveSessionResponse,
  RestartStyle,
  SendLiteralInputRequest,
  SendLiteralInputResponse,
  StatusResponse,
  TerminateAppSessionRequest,
  RuntimeActionResponse,
  UnbindSurfaceRequest,
} from './http-contracts.js'
