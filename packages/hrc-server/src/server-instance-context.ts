import type {
  HrcEventEnvelope,
  HrcHarness,
  HrcLifecycleEvent,
  HrcMessageRecord,
  HrcProvider,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import type { HrcDatabase, HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import type { HrcServerInstanceClassBodyMethods } from './index.js'
import type { SubscriberAdmissionRegistry } from './subscriber-admission-accounting.js'

import type { AcpEventBridge } from './acp-event-bridge.js'
import type { AppSessionHandlersMethods } from './app-session-handlers.js'
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
import type { MailKickerHandlersMethods } from './mail-kicker-handlers.js'
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
import type { SteerClassDispatchMethods } from './steer-class-dispatch.js'
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
  BridgeSurfaceHandlersMethods &
  SteerClassDispatchMethods &
  BrokerHeadlessHandlersMethods &
  BrokerInteractiveHandlersMethods &
  EventHandlersMethods &
  EventNotificationHandlersMethods &
  ExternalRegistrationRendezvousMethods &
  LaunchLifecycleHandlersMethods &
  MailKickerHandlersMethods &
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
  mailKickerSweepTimer: ReturnType<typeof setInterval> | undefined
  mailKickerSweepInFlight: Promise<void> | undefined
  readonly mailKickerPendingTargets: Map<string, HrcMailDriveWakeReason>
  readonly mailKickerTargetOperations: Map<string, Promise<void>>
  /**
   * The kicker's own log dedupe for `foreign_home_skipped`: scopeRef ->
   * `<homeNodeId>@<epoch>`, so the line is written once per scope per epoch.
   * Separate from `foreignHomeMemo` because that memo is shared with the shadow
   * teardown, and whichever mechanism resolved a scope first would otherwise
   * silence the other's line.
   */
  readonly mailKickerForeignHomeAnnounced: Map<string, string>
  /**
   * T-07655 — birth deferrals already announced, keyed by scopeRef with value
   * `<homeNodeId>@<designationEpoch>`, so the line is written once per scope
   * per designation epoch. Its OWN map, for the same reason the one above is:
   * a deferral and a foreign-home skip are different facts about a scope and
   * neither may silence the other. Keying on the epoch rather than the scope
   * re-arms the line after a tier-1-4 establishment supersedes a designation.
   */
  readonly mailKickerBirthDeferredAnnounced: Map<string, string>
  /**
   * T-07661 — the per-target retry bound for sweep-driven VIRGIN births, keyed
   * by targetSessionRef.
   *
   * A scope that was never born was never presented anything, so nothing on the
   * envelope can bound its retries. This carries a doubling shape (1m, 2m, 4m,
   * 8m, 16m) applied to birth attempts, and under rev 5.1 D7 the fifth refusal
   * ENDS it: the pending mail is failed `undeliverable` and the sender decides.
   *
   * Process-local, like `foreignHomeMemo` and for the same reason: a restart is
   * precisely when a refused birth deserves an immediate retry, so losing the
   * bound at one is correct rather than a gap. Entries are pruned whenever the
   * scope leaves the candidate set, which is what a successful birth does.
   */
  readonly mailKickerBirthSweepBackoff: Map<string, { attempts: number; nextAtMs: number }>
  /**
   * T-07704 (rev 5.1 D3) — runtimes whose lapse has already been observed,
   * keyed by runtimeId.
   *
   * Nothing can be presented TO a dead runtime, so one complete observation per
   * runtime is the whole job and this is a pure cost memo. Process-local for
   * the usual reason: a restart re-walks the lookback window, and
   * `wrkq.envelope.fail` is idempotent per (envelope, runtime), so the overlap
   * costs a read rather than a wrong answer.
   */
  readonly mailKickerLapsedRuntimes: Set<string>
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
  wrkqLedgerTailInFlight: Promise<void> | undefined
  /**
   * T-07643: a first-ever tail start owes one widened catch-up sweep over the
   * scopes this node homes. Armed when the cursor is minted, cleared only when
   * a catch-up completes, so a ledger outage retries instead of losing the
   * backlog silently.
   */
  mailKickerColdStartCatchupPending: boolean
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
