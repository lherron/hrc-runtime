import type {
  HrcEventEnvelope,
  HrcHarness,
  HrcLifecycleEvent,
  HrcMessageRecord,
  HrcProvider,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type {
  BrokerClientFactory,
  BrokerUnixClientFactory,
  HarnessBrokerController,
} from './broker/controller.js'
import type { GhostmuxManager as ServerGhostmuxManager } from './ghostmux.js'
import type { ServerContext } from './server-context.js'
import type {
  HrcServerOptions,
  PendingBrokerLiteralInput,
  TurnResponseFinalizer,
} from './server-types.js'
import type { TmuxManager as ServerTmuxManager } from './tmux.js'

export const COMMAND_RUNTIME_COMPAT_HARNESS: HrcHarness = 'codex-cli'
export const COMMAND_RUNTIME_COMPAT_PROVIDER: HrcProvider = 'openai'

// biome-ignore lint/suspicious/noExplicitAny: Split prototype handlers preserve the existing monolith method surface while the concrete methods keep their original signatures.
type HandlerMethod = (...args: any[]) => any
// biome-ignore lint/suspicious/noExplicitAny: Split prototype handlers preserve the existing monolith method surface while the concrete methods keep their original signatures.
type HandlerNever = (...args: any[]) => never
// biome-ignore lint/suspicious/noExplicitAny: Split prototype handlers preserve the existing monolith method surface while the concrete methods keep their original signatures.
type HandlerSessionRecord = (...args: any[]) => HrcSessionRecord

export type HrcServerInstanceForHandlers = {
  readonly options: HrcServerOptions
  readonly db: HrcDatabase
  readonly tmux: ServerTmuxManager
  readonly ghostmux: ServerGhostmuxManager
  readonly ctx: ServerContext
  readonly runtimeAttachOperations: Map<string, Promise<Response>>
  readonly runtimeStartOperations: Map<string, Promise<HrcRuntimeSnapshot>>
  readonly attachedRunOperations: Map<string, Promise<unknown>>
  readonly turnResponseFinalizers: Map<string, TurnResponseFinalizer>
  readonly pendingBrokerLiteralInputs: Map<string, PendingBrokerLiteralInput>
  zombieSweepTimer: ReturnType<typeof setInterval> | undefined
  zombieSweepInFlight: Promise<unknown> | undefined
  activeRunReconcileTimer: ReturnType<typeof setInterval> | undefined
  activeRunReconcileInFlight: Promise<unknown> | undefined
  idleCleanupTimer: ReturnType<typeof setInterval> | undefined
  idleCleanupInFlight: Promise<void> | undefined
  readonly staleGenerationEnabled: boolean
  readonly staleGenerationThresholdSec: number
  readonly headlessCodexBrokerEnabled: boolean
  readonly claudeCodeTmuxBrokerEnabled: boolean
  readonly codexCliTmuxBrokerEnabled: boolean
  harnessBrokerController: HarnessBrokerController | undefined
  /**
   * Resolves once the post-construction durable-broker warmup has finished (or
   * failed — it is `.catch`-wrapped to ALWAYS resolve, never reject). Broker
   * input handlers await this so the first dispatch after a restart sees the
   * serving controller already bound, instead of racing it cold. A failed/absent
   * warmup falls through to the existing lazy reattach path; it never wedges.
   */
  brokerWarmupComplete?: Promise<void> | undefined
  brokerTmuxManagerFactory?: ((opts: { socketPath: string }) => ServerTmuxManager) | undefined
  generateBrokerAttachToken?: (() => string) | undefined
  brokerClientFactory?: BrokerClientFactory | undefined
  brokerUnixClientFactory?: BrokerUnixClientFactory | undefined
  readonly followSubscribers: Set<(event: HrcEventEnvelope | HrcLifecycleEvent) => void>
  readonly messageSubscribers: Set<(record: HrcMessageRecord) => void>
  appendEvent: HandlerMethod
  appendInflightRejected: HandlerMethod
  appendSweepCompletedEvent: HandlerMethod
  attachRuntime: HandlerMethod
  attachRuntimeEffectfully: HandlerMethod
  captureRuntime: HandlerMethod
  claimRuntimeForSweep: HandlerMethod
  createHeadlessRuntimeForSession: HandlerMethod
  deliverBridgeText: HandlerMethod
  deliverInFlightInputToRuntime: HandlerMethod
  deliverReassociatedBrokerTmuxInput: HandlerMethod
  deliverTmuxQuestionAnswer: HandlerMethod
  dispatchTurnForSession: HandlerMethod
  ensureCommandRuntimeForSession: HandlerMethod
  ensureRuntimeForSession: HandlerMethod
  ensureTargetSession: HandlerSessionRecord
  executeHeadlessBrokerInputTurn: HandlerMethod
  executeHeadlessBrokerStartTurn: HandlerMethod
  executeHeadlessSdkTurn: HandlerMethod
  executeInteractiveBrokerInputTurn: HandlerMethod
  executeSemanticTurn: HandlerMethod
  failCliStartPath: HandlerNever
  failSdkHarnessPath: HandlerNever
  finalizeSemanticTurnResponse: HandlerMethod
  getHarnessBrokerController: HandlerMethod
  handleActiveRunContribution: HandlerMethod
  handleAppSessionAttach: HandlerMethod
  handleAppSessionCapture: HandlerMethod
  handleAppSessionClearContext: HandlerMethod
  handleAppSessionDispatchTurn: HandlerMethod
  handleAppSessionInFlightInput: HandlerMethod
  handleAppSessionInterrupt: HandlerMethod
  handleAppSessionLiteralInput: HandlerMethod
  handleAppSessionTerminate: HandlerMethod
  handleApplyAppSessions: HandlerMethod
  handleApplyManagedAppSessions: HandlerMethod
  handleAttach: HandlerMethod
  handleAttachRuntime: HandlerMethod
  handleBindSurface: HandlerMethod
  handleBrokerInspect: HandlerMethod
  handleBrokerLiteralInputBySelector: HandlerMethod
  handleCapture: HandlerMethod
  handleCaptureBySelector: HandlerMethod
  handleChildStarted: HandlerMethod
  handleClearContext: HandlerMethod
  handleCloseBridge: HandlerMethod
  handleContinuation: HandlerMethod
  handleCreateMessage: HandlerMethod
  handleDeliverBridge: HandlerMethod
  handleDeliverBridgeText: HandlerMethod
  handleDispatchTurn: HandlerMethod
  handleDispatchTurnBySelector: HandlerMethod
  handleDropContinuation: HandlerMethod
  handleEnsureAppSession: HandlerMethod
  ensureAppSessionFromBody: HandlerMethod
  handleEnsureAppSessionDryRun: HandlerMethod
  handleEnsureRuntime: HandlerMethod
  handleEnsureTarget: HandlerMethod
  handleEvents: HandlerMethod
  handleEventsLatestBySession: HandlerMethod
  handleExited: HandlerMethod
  handleGetActiveRunContribution: HandlerMethod
  handleGetManagedAppSessionByKey: HandlerMethod
  handleGetSessionByHost: HandlerMethod
  handleGetTarget: HandlerMethod
  handleHeadlessBrokerDispatchTurn: HandlerMethod
  handleHeadlessDispatchTurn: HandlerMethod
  handleHealth: HandlerMethod
  handleHookIngest: HandlerMethod
  handleInFlightInput: HandlerMethod
  handleInspectRuntime: HandlerMethod
  handleInteractiveTmuxBrokerDispatchTurn: HandlerMethod
  handleInterrupt: HandlerMethod
  handleKillBrokerTmuxLeases: HandlerMethod
  handleLaunchEvent: HandlerMethod
  handleListAppSessions: HandlerMethod
  handleListBridges: HandlerMethod
  handleListManagedAppSessions: HandlerMethod
  handleListSessions: HandlerMethod
  handleListSurfaces: HandlerMethod
  handleListTargets: HandlerMethod
  handleLiteralInputBySelector: HandlerMethod
  handleOtlpRequest: HandlerMethod
  handlePrepareAttachedRun: HandlerMethod
  handleQueryMessages: HandlerMethod
  handleReconcileActiveRuns: HandlerMethod
  handleRegisterBridgeTarget: HandlerMethod
  handleRemoveAppSession: HandlerMethod
  removeAppSessionFromBody: HandlerMethod
  handleRequest: HandlerMethod
  handleResolveSession: HandlerMethod
  handleResumeAttachedRun: HandlerMethod
  handleSdkDispatchTurn: HandlerMethod
  handleSemanticDm: HandlerMethod
  handleSemanticTurnHandoff: HandlerMethod
  handleStartRuntime: HandlerMethod
  handleStatus: HandlerMethod
  handleSweepRuntimes: HandlerMethod
  handleSweepZombieRuns: HandlerMethod
  handleTerminate: HandlerMethod
  handleUnbindSurface: HandlerMethod
  handleWaitMessage: HandlerMethod
  handleWatchMessages: HandlerMethod
  handleWrapperStarted: HandlerMethod
  insertAndNotifyMessage: HandlerMethod
  interruptGhosttyRuntime: HandlerMethod
  interruptHeadlessRuntime: HandlerMethod
  interruptRuntime: HandlerMethod
  interruptTmuxRuntime: HandlerMethod
  invalidateHostContext: HandlerMethod
  launchCommandSpecInPane: HandlerMethod
  listAllSessions: HandlerMethod
  listSessionsByScope: HandlerMethod
  markRuntimeStaleForBrokerReprovision: HandlerMethod
  maybeAutoRotateStaleSession: (
    session: HrcSessionRecord,
    options: { allowStaleGeneration?: boolean | undefined; trigger: string }
  ) => Promise<{ session: HrcSessionRecord; rotated: boolean }>
  maybeCompleteInteractiveSemanticTurn: HandlerMethod
  notifyEvent: HandlerMethod
  notifyMessageSubscribers: HandlerMethod
  parseEventsRouteFilters: HandlerMethod
  prepareSemanticDmPayload: HandlerMethod
  reconcileTmuxRuntimeLiveness: HandlerMethod
  recordDetachedHeadlessTurnFailure: HandlerMethod
  recordDetachedSemanticTurnFailure: HandlerMethod
  rejectBusyHeadlessSemanticDm: HandlerMethod
  resolveBridgePane: HandlerMethod
  resolveBridgeTargetBinding: HandlerMethod
  resolveManagedSessionRuntime: HandlerMethod
  resolveSweepSummarySession: HandlerMethod
  rotateSessionContext: HandlerMethod
  runClaudeGhosttyIdleCleanup: HandlerMethod
  runHeadlessSdkStartLaunch: HandlerMethod
  runHeadlessStartLaunch: HandlerMethod
  runRecurringActiveRunReconcile: HandlerMethod
  runRecurringZombieSweep: HandlerMethod
  selectInteractiveTmuxBrokerOptions: HandlerMethod
  startActiveRunReconciler: HandlerMethod
  startClaudeGhosttyIdleCleanup: HandlerMethod
  startHeadlessBrokerRuntime: HandlerMethod
  spawnHeadlessClaudeViewer: HandlerMethod
  startInteractiveTmuxBrokerRuntime: HandlerMethod
  startRuntimeForSession: HandlerMethod
  startZombieRunSweeper: HandlerMethod
  stop: HandlerMethod
  terminateGhosttyRuntime: HandlerMethod
  terminateHeadlessRuntime: HandlerMethod
  terminateRuntime: HandlerMethod
  terminateTmuxRuntime: HandlerMethod
  tmuxForPane: HandlerMethod
  toBridgeTargetResponse: HandlerMethod
  tryDeliverSemanticTurnToInteractiveRuntime: HandlerMethod
  waitForHeadlessBrokerRunCompletion: HandlerMethod
  waitForInteractiveBrokerRunCompletion: HandlerMethod
  waitForMessage: HandlerMethod
}
