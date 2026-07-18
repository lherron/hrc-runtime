import type {
  HrcEventEnvelope,
  HrcHarness,
  HrcLifecycleEvent,
  HrcMessageRecord,
  HrcProvider,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { HrcServerInstanceClassBodyMethods } from './index.js'
import type { SubscriberAdmissionRegistry } from './subscriber-admission-accounting.js'

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
import type { GhostmuxManager as ServerGhostmuxManager } from './ghostmux.js'
import type { HeadlessViewerStatusProjector } from './headless-viewer-status.js'
import type { LaunchLifecycleHandlersMethods } from './launch-lifecycle-handlers.js'
import type { RuntimeControlHandlersMethods } from './runtime-control-handlers.js'
import type { RuntimeInspectHandlersMethods } from './runtime-inspect-handlers.js'
import type { RuntimeIoHandlersMethods } from './runtime-io-handlers.js'
import type { SdkTurnHandlersMethods } from './sdk-turn-handlers.js'
import type { SelectorMessageHandlersMethods } from './selector-message-handlers.js'
import type { SelectorWaitHandlersMethods } from './selector-wait-handlers.js'
import type { ServerContext } from './server-context.js'
import type {
  HrcServerOptions,
  PendingBrokerLiteralInput,
  RawBrokerSubscriber,
  TurnResponseFinalizer,
} from './server-types.js'
import type { SweepHandlersMethods } from './sweep-handlers.js'
import type { TargetMessageHandlersMethods } from './target-message-handlers.js'
import type { TmuxManager as ServerTmuxManager } from './tmux.js'
import type { TurnDispatchHandlersMethods } from './turn-dispatch-handlers.js'

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
  BrokerHeadlessHandlersMethods &
  BrokerInteractiveHandlersMethods &
  EventHandlersMethods &
  EventNotificationHandlersMethods &
  LaunchLifecycleHandlersMethods &
  RuntimeControlHandlersMethods &
  RuntimeInspectHandlersMethods &
  RuntimeIoHandlersMethods &
  SdkTurnHandlersMethods &
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
  readonly ghostmux: ServerGhostmuxManager
  /** Headless-viewer status-bar projection observer (T-04439). */
  readonly headlessViewerStatus: HeadlessViewerStatusProjector
  readonly ctx: ServerContext
  readonly runtimeAttachOperations: Map<string, Promise<Response>>
  readonly runtimeStartOperations: Map<string, Promise<HrcRuntimeSnapshot>>
  readonly attachedRunOperations: Map<string, Promise<unknown>>
  readonly turnResponseFinalizers: Map<string, TurnResponseFinalizer>
  readonly pendingBrokerLiteralInputs: Map<string, PendingBrokerLiteralInput>
  readonly queuedTurnInputDrains: Set<string>
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
  readonly piTuiTmuxBrokerEnabled: boolean
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
