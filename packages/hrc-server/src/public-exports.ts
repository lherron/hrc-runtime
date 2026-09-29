export { projectSemanticTurnResponse } from './event-notification-handlers.js'
import type { RestartStyle } from 'hrc-core'
import {
  type TmuxManager as ServerTmuxManager,
  type TmuxManagerOptions,
  createTmuxManager,
} from './tmux.js'

export type { HrcServer, HrcServerOptions } from './server-types.js'
export type { ServerShutdownAttribution } from './server-lifecycle.js'
export type { ServerLifecycleExecutor } from './server-lifecycle-controller.js'
export { HRC_EVENTS_KEEPALIVE_MS } from './server-constants.js'
export type { ServerMetricRecord } from './request-metrics.js'
export { parseDurationMs } from './parsers/common.js'
export {
  actuatorSplitRuntimeAuthority,
  assertActuatorSplitAdmission,
  assertActuatorSplitRouteAdmission,
  assertActuatorSplitRuntimeReuse,
  normalizeActuatorSplitPolicy,
  prepareActuatorSplitIntent,
} from './actuator-split.js'
export type {
  ActuatorSplitAuthority,
  ActuatorSplitRoute,
  PreparedActuatorSplitIntent,
  ResolvedApprovedMutation,
} from './actuator-split.js'

export {
  selectDispatchInteractiveRuntime,
  selectLatestInteractiveRuntime,
} from './runtime-select.js'
export type { InteractiveRuntimeSelectionView } from './runtime-select.js'

export {
  decideHeadlessExecutionRoute,
  decideCodexAppServerPresentation,
  CALLER_SURFACE_REUSE_REFUSAL,
  decideInteractiveBrokerAdmission,
  decideInteractiveTmuxBrokerContinuation,
  decideInteractiveTmuxBrokerStartRoute,
  decideLegacyRuntimeStartupDisposition,
  extractPiSdkBrokerCredentialEnv,
  filterBrokerDispatchEnvForLockedEnv,
  normalizeCodexInteractiveBrokerIntent,
  normalizeClaudeInteractiveBrokerIntent,
  runHeadlessRoute,
  runInteractiveTmuxRoute,
  shouldBlockForBrokerTurnCompletion,
  shouldConsiderClaudeCodeTmuxBrokerDispatch,
  shouldConsiderCodexCliTmuxBrokerDispatch,
  refusesSurfaceReuse,
  shouldDeferHeadlessToInteractiveBrokerReuse,
  shouldRedirectCodexToInteractiveBroker,
  shouldRedirectClaudeToInteractiveBroker,
  shouldUseHeadlessSdkExecutor,
  shouldUseHeadlessTransport,
  shouldUseSdkTransport,
} from './broker-decisions.js'
export type {
  HeadlessExecutionRoute,
  InteractiveBrokerAdmissionDecision,
  InteractiveTmuxBrokerDriver,
  InteractiveTmuxBrokerStartRoute,
  InteractiveTmuxExecutionRoute,
  LatestRuntimeAdmissionView,
  LegacyStartupReconciliationDecision,
  LegacyStartupRuntimeView,
  LiveInteractiveRuntimeReuseView,
} from './broker-decisions.js'

export type TmuxManager = ServerTmuxManager
export { createTmuxManager }
export type { RestartStyle, TmuxManagerOptions }

export { UnreachableWrkqLedger, WrkqStdioLedgerClient } from './wrkq/ledger-client.js'
export type { WrkqLedgerClient } from './wrkq/ledger-client.js'
export { drainEventDatabase } from './event-ingest.js'

export type { BrokerRunPreview } from './broker-run-preview.js'
export { resolvePreviewIntent } from './broker-run-preview.js'

export {
  HRC_COMMAND_RUN_TARGETS_FILE_ENV,
  loadCommandRunTargetsFromEnv,
  resolveCommandRunTargets,
  validateConfiguredCommandRunTarget,
} from './command-run-targets-config.js'
export {
  HRC_REGISTRATION_CLASSES_FILE_ENV,
  MAX_EXTERNAL_REGISTRATION_TTL_SECONDS,
  loadRegistrationClassesFromEnv,
  parseRegistrationClassesConfig,
  resolveRegistrationClasses,
  validateRegistrationClassConfig,
  isExternalRegistrationClass,
  isParticipantRegistrationClass,
} from './registration-classes-config.js'
export type {
  ExternalRegistrationClassConfig,
  ParticipantRegistrationClassConfig,
  RegistrationClassConfig,
  RegistrationClassScopeTemplate,
} from './registration-classes-config.js'
export { hashRegistrationCredential } from './registration-handlers.js'
export type {
  CreateExternalRegistrationRequest,
  CreateExternalRegistrationResponse,
} from './registration-handlers.js'
// T-08504 / T-08516 protocol join (contract revision 7, slice A).
export {
  assertReservedAddressAllowsBirth,
  claimParticipantAddress,
  localParticipantHomeNodeId,
  reservedAddressBirthRefusal,
} from './participant-address-provisioning.js'
export type {
  ClaimParticipantAddressInput,
  ParticipantAddressClaim,
  ParticipantAddressClaimRefusal,
} from './participant-address-provisioning.js'
export { DIRECT_JOIN_POLICY, registerDirectParticipant } from './participant-host-registration.js'
export type {
  DirectJoinContinuation,
  DirectJoinIdentity,
  DirectJoinRequest,
  DirectJoinResult,
} from './participant-host-registration.js'
export { parseAttachParticipantRequest } from './participant-attach-handlers.js'
export type {
  AttachParticipantRequest,
  AttachParticipantResponse,
} from './participant-attach-handlers.js'
export { parseRegisterParticipantRequest } from './participant-registration-handlers.js'
export type {
  DirectRegisterParticipantRequest,
  LegacyRegisterParticipantRequest,
  RegisterParticipantRequest,
  RegisterParticipantResponse,
} from './participant-registration-handlers.js'
export {
  EPR_HELLO_ERROR_CODE,
  EPR_PROTOCOL_VERSION,
  EPR_REPLAY_UNAVAILABLE_CODE,
  EprHelloError,
  connectExternalParticipant,
  markExternalParticipantDetached,
  parseEprHelloResponse,
  performExternalParticipantAttach,
  performExternalRegistrationHello,
  runExternalRegistrationRendezvous,
} from './external-registration-rendezvous.js'
export type {
  EprEstablishedDelivery,
  EprHelloResponse,
  ExternalParticipantCapabilities,
  ExternalParticipantClientFactory,
  ExternalParticipantInfo,
  ExternalParticipantRpcClient,
} from './external-registration-rendezvous.js'
export {
  EXPECTED_FEDERATION_CONFIG_MODE,
  FEDERATION_CONFIG_BASENAME,
  HRC_PEER_CONFIG_FILE_ENV,
  deriveNodeIdFromHostname,
  isSingleNodeMode,
  parseFederationConfigDocument,
  resolveFederationConfig,
  resolveFederationConfigPath,
  summarizeFederationConfig,
} from './federation/federation-config.js'
export type {
  FederationConfig,
  NodeIdProvenance,
  PeerEntry,
} from './federation/federation-config.js'
export { sendRemoteEstablish } from './federation/establish-client.js'
export type { SendRemoteEstablishOptions } from './federation/establish-client.js'
export {
  createPeerProtocolRequestHandler,
  parsePeerProtocolBind,
  startPeerProtocolEndpoint,
} from './federation/peer-protocol.js'
export type {
  PeerEstablishHandler,
  PeerEstablishRequest,
  PeerEstablishResult,
  PeerProtocolEndpointControl,
  PeerProtocolHealth,
  PeerProtocolListenerConfig,
  PeerProtocolRequestHandlerOptions,
} from './federation/peer-protocol.js'
export { locateScope, scanLedgerForSkew } from './federation/locate.js'
export type {
  LedgerSkewScan,
  LocateAuthority,
  LocateBindingRecord,
  LocateDeclaredPolicy,
  LocateDeps,
  LocateLedgerView,
  LocateNote,
  LocateObservedRuntime,
  LocateRegistryView,
  LocateSkew,
  ScopeLocation,
} from './federation/locate.js'
export { locateScopeOnServer, scanServerLedgerForSkew } from './federation/locate-server.js'
export type { LocateServerContext } from './federation/locate-server.js'
export {
  createPlacementPolicyResolver,
  resolvePlacementPolicy,
} from './federation/placement-policy.js'
export type { PlacementPolicyResolution } from './federation/placement-policy.js'
export { isTailnetHost, parseRegistryBind } from './federation/registry-bind.js'
export type { RegistryListenerConfig } from './federation/registry-bind.js'
export {
  BINDING_REGISTRY_BASENAME,
  createBindingRegistryRequestHandler,
  resolveBindingRegistryPath,
  startBindingRegistryEndpoint,
} from './federation/registry-endpoint.js'
export type {
  BindingRegistryEndpointControl,
  RegistryAuthPeer,
  RegistryAuthToken,
} from './federation/registry-endpoint.js'
export {
  HttpBindingRegistryClient,
  RegistryRefusedError,
  RegistryUnreachableError,
  createBindingRegistryClient,
} from './federation/registry-client.js'
export type {
  BindingRegistryClient,
  BindingRegistryClientOptions,
  RegistryClientFetch,
  RegistryConsultResult,
} from './federation/registry-client.js'
export {
  NODE_ID_PATTERN,
  RESERVED_NODE_IDS,
  describeNodeIdViolation,
  isReservedNodeId,
  isValidNodeId,
  parseNodeId,
} from './federation/node-id.js'
export type { NodeId } from './federation/node-id.js'
export {
  recordParticipantRecoveryDisposition,
  renewParticipantReplacementRecovery,
} from './participant-succession.js'
export { PeerToken, REDACTED_PEER_TOKEN } from './federation/peer-token.js'
export { constantTimeEqual } from './constant-time.js'
export { establishLocalPlacement } from './federation/establishment.js'
export type {
  EstablishLocalPlacementRequest,
  EstablishLocalPlacementResult,
} from './federation/establishment.js'
