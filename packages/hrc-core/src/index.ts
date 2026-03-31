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
export type { HrcErrorCode as HrcErrorCodeValue, HrcHttpError, HrcHttpStatus } from './errors.js'

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

export {
  HrcErrorCode as HrcFenceErrorCode,
  createInvalidFenceError,
  parseFence,
  validateFence,
} from './fences.js'
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
  HrcAppSessionRecord,
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
  HrcProvider,
  HrcRunRecord,
  HrcSurfaceBindingRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from './contracts.js'
