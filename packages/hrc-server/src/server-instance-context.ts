import type {
  HrcEventEnvelope,
  HrcHarness,
  HrcLifecycleEvent,
  HrcMessageRecord,
  HrcProvider,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import type { MailKicker } from 'hrc-mail-kicker'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { HrcServerInstanceClassBodyMethods } from './index.js'
import type { DurableBrokerDispatchReattachResult } from './startup-reconcile.js'
import type { SubscriberAdmissionRegistry } from './subscriber-admission-accounting.js'

import type { AcpEventBridge } from './acp-event-bridge.js'
import type { AppSessionHandlersMethods } from './app-session-handlers.js'
import type { AutoReplyHandlersMethods } from './auto-reply-handlers.js'
import type { BridgeSurfaceHandlersMethods } from './bridge-surface-handlers.js'
import type { BrokerHeadlessHandlersMethods } from './broker-headless-handlers.js'
import type { BrokerInteractiveHandlersMethods } from './broker-interactive-handlers.js'
import type {
  BrokerClientFactory,
  BrokerUnixClientFactory,
  HarnessBrokerController,
} from './broker/controller.js'
import type { EventHandlersMethods } from './event-handlers.js'
import type { EventNotificationHandlersMethods } from './event-notification-handlers.js'
import type { ExactClaimHandlersMethods } from './exact-claim.js'
import type {
  ExternalParticipantRpcClient,
  ExternalRegistrationRendezvousMethods,
} from './external-registration-rendezvous.js'
import type { CollectiveHistoryCoordinator } from './federation/collective-history.js'
import type { ForeignHome } from './federation/home-authority.js'
import type { BindingRegistryClient } from './federation/registry-client.js'
import type { FederatedRuntimeIntentLocalizationOptions } from './federation/runtime-intent-localization.js'
import type { LaunchLifecycleHandlersMethods } from './launch-lifecycle-handlers.js'
import type { PresentationPublishMethods } from './presentation-publish.js'
import type { RegistrationGcHandlersMethods } from './registration-gc-handlers.js'
import type { RegistrationHandlersMethods } from './registration-handlers.js'
import type { CapturedServerRelease } from './release-provenance.js'
import type { RosterClaimHandlersMethods } from './roster-claim.js'
import type { RuntimeControlHandlersMethods } from './runtime-control-handlers.js'
import type { RuntimeInspectHandlersMethods } from './runtime-inspect-handlers.js'
import type { RuntimeIoHandlersMethods } from './runtime-io-handlers.js'
import type { SdkTurnHandlersMethods } from './sdk-turn-handlers.js'
import type { SelectorMessageHandlersMethods } from './selector-message-handlers.js'
import type { SelectorWaitHandlersMethods } from './selector-wait-handlers.js'
import type { ServerContext } from './server-context.js'
import type {
  HrcServerOptions,
  PendingAttachedRunOperation,
  PendingBrokerLiteralInput,
  RawBrokerSubscriber,
  TurnResponseFinalizer,
} from './server-types.js'
import type { SessionIndexHandlersMethods } from './session-index-handlers.js'
import type { ShadowTeardownHandlersMethods } from './shadow-teardown-handlers.js'
import type { SweepHandlersMethods } from './sweep-handlers.js'
import type { TargetMessageHandlersMethods } from './target-message-handlers.js'
import type { TmuxManager as ServerTmuxManager } from './tmux.js'
import type { TurnAdmissionGate } from './turn-admission-gate.js'
import type { TurnDispatchHandlersMethods } from './turn-dispatch-handlers.js'
import type { WrkqLedgerClient } from './wrkq/ledger-client.js'
import type { WrkqStopGateHandlersMethods } from './wrkq/stop-gate-handlers.js'

export const COMMAND_RUNTIME_COMPAT_HARNESS: HrcHarness = 'codex-cli'
export const COMMAND_RUNTIME_COMPAT_PROVIDER: HrcProvider = 'openai'

/**
 * The cross-handler call surface, derived from the REAL method definitions.
 *
 * Each `*HandlersMethods` type is `typeof <handlersMethodsObject>` — the exact
 * functions (with their real parameter/return types and `this:
 * HrcServerInstanceForHandlers`) that index.ts declaration-merges onto
 * `HrcServerInstance.prototype`. Intersecting them here means a method's
 * signature lives in exactly one place (its handler module) and can never drift
 * from what is actually attached to the prototype. This intentionally tightens
 * the previous `(...args: any[]) => any` mirror so cross-handler calls are
 * type-checked.
 */
type DecomposedHandlerMethods = AppSessionHandlersMethods &
  AutoReplyHandlersMethods &
  BridgeSurfaceHandlersMethods &
  BrokerHeadlessHandlersMethods &
  BrokerInteractiveHandlersMethods &
  EventHandlersMethods &
  EventNotificationHandlersMethods &
  ExternalRegistrationRendezvousMethods &
  LaunchLifecycleHandlersMethods &
  WrkqStopGateHandlersMethods &
  PresentationPublishMethods &
  RosterClaimHandlersMethods &
  ExactClaimHandlersMethods &
  RegistrationGcHandlersMethods &
  RegistrationHandlersMethods &
  ShadowTeardownHandlersMethods &
  RuntimeControlHandlersMethods &
  RuntimeInspectHandlersMethods &
  RuntimeIoHandlersMethods &
  SdkTurnHandlersMethods &
  SessionIndexHandlersMethods &
  SelectorMessageHandlersMethods &
  SelectorWaitHandlersMethods &
  SweepHandlersMethods &
  TargetMessageHandlersMethods &
  TurnDispatchHandlersMethods

export type HrcServerInstanceForHandlers = HrcServerInstanceDataForHandlers &
  Omit<DecomposedHandlerMethods, keyof HrcServerInstanceNeverReturningHandlers> &
  HrcServerInstanceNeverReturningHandlers &
  HrcServerInstanceClassMethodsForHandlers

/**
 * `failCliStartPath` / `failSdkHarnessPath` are declared `=> never` in their
 * source modules (they always throw). Because `HrcServerInstanceForHandlers` is
 * itself the `this` type of those functions, the self-referential intersection
 * above resolves their return type lazily and loses the `never`, which would
 * break the terminal-`never` control-flow analysis at their call sites. We
 * re-assert `never` here while still deriving the parameter list from the real
 * functions — no hand-mirrored parameters, contract preserved exactly.
 */
type HrcServerInstanceNeverReturningHandlers = {
  failCliStartPath: (
    ...args: Parameters<OmitThisParameter<RuntimeControlHandlersMethods['failCliStartPath']>>
  ) => never
  failSdkHarnessPath: (
    ...args: Parameters<OmitThisParameter<SdkTurnHandlersMethods['failSdkHarnessPath']>>
  ) => never
}

/**
 * Methods declared directly on the `HrcServerInstance` class body (not in a
 * decomposed `*-handlers` module). Derived from the REAL class definitions
 * (`HrcServerInstanceClassBodyMethods` in index.ts) via `typeof`/`Pick` so they
 * can never drift from the methods actually attached to the instance — the same
 * no-hand-mirror invariant the `*HandlersMethods` types provide for the
 * prototype-attached handlers (T-04758 follow-up T-04775).
 */
type HrcServerInstanceClassMethodsForHandlers = HrcServerInstanceClassBodyMethods

type HrcServerInstanceDataForHandlers = {
  readonly options: HrcServerOptions
  readonly db: HrcDatabase
  readonly tmux: ServerTmuxManager
  /** T-07214: per-peer default-deny remote-preemption authority (see index.ts). */
  readonly isPeerUrgentDeliveryAuthorized: ((nodeId: string) => boolean) | undefined
  readonly federationRegistryClient: BindingRegistryClient | undefined
  /**
   * Scopes this node has learned it does NOT home, keyed by scopeRef (T-07650).
   *
   * Process-local on purpose: it exists to charge one registry consult per scope
   * per process instead of one per tick, and a restart must be able to re-ask.
   * It is never consulted ahead of the local placement ledger, so it can only
   * ever delay a scope's return to this node, never block it.
   */
  readonly foreignHomeMemo: Map<string, ForeignHome>
  readonly collectiveHistory: CollectiveHistoryCoordinator | undefined
  /** Test/embedded seam for fixture-owned accepting-node placement inputs. */
  readonly runtimeIntentLocalizationOptions?: FederatedRuntimeIntentLocalizationOptions | undefined
  /** HRC→ACP reason-coded event bridge observer (T-07236). */
  readonly acpEventBridge: AcpEventBridge
  readonly ctx: ServerContext
  readonly runtimeAttachOperations: Map<string, Promise<Response>>
  readonly externalRegistrationOperations: Map<string, Promise<void>>
  readonly externalRegistrationEstablishmentOperations: Map<string, Promise<void>>
  readonly externalParticipantClients: Map<string, ExternalParticipantRpcClient>
  readonly runtimeStartOperations: Map<string, Promise<HrcRuntimeSnapshot>>
  /** Cancelled by stop() before the store closes; never used as a shutdown drain. */
  readonly runtimeStartPresentationSignal: AbortSignal
  readonly brokerReattachOperations: Map<string, Promise<DurableBrokerDispatchReattachResult>>
  readonly attachedRunOperations: Map<string, PendingAttachedRunOperation>
  readonly turnResponseFinalizers: Map<string, TurnResponseFinalizer>
  readonly pendingBrokerLiteralInputs: Map<string, PendingBrokerLiteralInput>
  readonly queuedTurnInputDrains: Set<string>
  readonly turnAdmissionGate: TurnAdmissionGate
  zombieSweepTimer: ReturnType<typeof setInterval> | undefined
  zombieSweepInFlight: Promise<unknown> | undefined
  activeRunReconcileTimer: ReturnType<typeof setInterval> | undefined
  activeRunReconcileInFlight: Promise<unknown> | undefined
  brokerLeaseGcTimer: ReturnType<typeof setInterval> | undefined
  brokerLeaseGcInFlight: Promise<unknown> | undefined
  tmuxAgingTimer: ReturnType<typeof setInterval> | undefined
  tmuxAgingInFlight: Promise<unknown> | undefined
  sessionRetentionTimer: ReturnType<typeof setInterval> | undefined
  sessionRetentionInFlight: Promise<void> | undefined
  shadowTeardownTimer: ReturnType<typeof setInterval> | undefined
  shadowTeardownInFlight: Promise<void> | undefined
  /** Immutable process release identity, captured once at construction. */
  readonly capturedRelease: CapturedServerRelease
  /** T-07235 provision-liveness watchdog: its own cadence, not the zombie sweep's. */
  firstTurnEvalTimer: ReturnType<typeof setInterval> | undefined
  firstTurnEvalInFlight: Promise<unknown> | undefined
  readonly mailKicker: MailKicker
  autoReplyReconcileTimer: ReturnType<typeof setInterval> | undefined
  autoReplyReconcileInFlight: Promise<void> | undefined
  stopping: boolean
  readonly staleGenerationEnabled: boolean
  readonly staleGenerationThresholdSec: number
  readonly tmuxAgingEnabled: boolean
  readonly headlessCodexBrokerEnabled: boolean
  readonly claudeCodeTmuxBrokerEnabled: boolean
  readonly codexCliTmuxBrokerEnabled: boolean
  readonly piTuiTmuxBrokerEnabled: boolean
  readonly agentHarnessTmuxBrokerEnabled: boolean
  readonly hrcMailKickerEnabled: boolean
  readonly hrcMailKickerSweepIntervalMs: number
  readonly wrkqLedger: WrkqLedgerClient
  readonly federationNodeId: string
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
  readonly rawBrokerSubscribers: Set<RawBrokerSubscriber>
  readonly messageSubscribers: Set<(record: HrcMessageRecord) => void>
  readonly activeStreamClosers: Set<() => void>
  readonly subscriberAdmissions: SubscriberAdmissionRegistry
}
