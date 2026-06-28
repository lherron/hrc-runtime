/**
 * Public type/contract surface for HarnessBrokerController.
 *
 * Extracted verbatim from controller.ts as a pure mechanical move. Every name
 * here is re-exported from controller.ts so no external import changes.
 */

import type {
  HrcBrokerInvocationEventRecord,
  HrcBrokerInvocationRecord,
  HrcRunRecord,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { BrokerClient } from 'spaces-harness-broker-client'
import type { CloseHandler, StdioTransportStartOptions } from 'spaces-harness-broker-client'
import type {
  BrokerAttachRequest,
  BrokerAttachResponse,
  BrokerHealthResponse,
  BrokerHelloResponse,
  BrokerLifecyclePolicyOverlay,
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
  InputPolicy,
  InvocationAckEventsRequest,
  InvocationAckEventsResponse,
  InvocationDisposeRequest,
  InvocationEventEnvelope,
  InvocationEventsSinceRequest,
  InvocationEventsSinceResponse,
  InvocationInput,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationPermissionRespondRequest,
  InvocationPermissionRespondResponse,
  InvocationRuntimeContext,
  InvocationSnapshot,
  InvocationSnapshotRequest,
  InvocationStartRequest,
  InvocationStartResponse,
  InvocationStatusResponse,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CompiledRuntimePlan,
  RuntimeIdentityAllocation,
} from 'spaces-runtime-contracts'

import type { BrokerEventMapper } from '../event-mapper'
import type { BrokerAttachTokenRef } from '../runtime-state'
import type { BrokerControllerError } from './errors'

export type BrokerControllerLogger = {
  info?: (message: string, fields?: Record<string, unknown>) => void
  warn?: (message: string, fields?: Record<string, unknown>) => void
  error?: (message: string, fields?: Record<string, unknown>) => void
}

/**
 * The broker client's dispatch-options form. Mirrors
 * spaces-harness-broker-client's InvocationStartDispatchOptions: the broker
 * lifecycle overlay rides ONLY here, never inside the start request.
 */
export type BrokerDispatchOptions = {
  dispatchEnv?: Record<string, string> | undefined
  runtime?: InvocationRuntimeContext | undefined
  lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
}

export type BrokerClientLike = {
  hello(req: Parameters<BrokerClient['hello']>[0]): Promise<BrokerHelloResponse>
  health(req?: Parameters<BrokerClient['health']>[0]): Promise<BrokerHealthResponse>
  startInvocationFromRequest(
    request: InvocationStartRequest,
    dispatchEnvOrOptions?: Record<string, string> | BrokerDispatchOptions,
    runtime?: InvocationRuntimeContext
  ): Promise<{
    invocationId: string
    response: InvocationStartResponse
    events: AsyncIterable<InvocationEventEnvelope>
  }>
  input(req: Parameters<BrokerClient['input']>[0]): Promise<InvocationInputResponse>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: Parameters<BrokerClient['stop']>[0]): Promise<InvocationStopResponse>
  status(req: Parameters<BrokerClient['status']>[0]): Promise<InvocationStatusResponse>
  /**
   * T-01855 inspection read model. OPTIONAL on the base stdio shape so older
   * scripted mocks (and pre-inspection broker builds) need not implement them;
   * the controller guards on method presence and on the negotiated
   * `capabilities.inspection` block before calling. The durable Unix client and
   * the real BrokerClient always provide both.
   */
  listInvocations?(req?: BrokerListInvocationsRequest): Promise<BrokerListInvocationsResponse>
  snapshot?(req: InvocationSnapshotRequest): Promise<InvocationSnapshot>
  dispose(req: InvocationDisposeRequest): Promise<void>
  onPermissionRequest(
    handler: (request: PermissionRequestParams) => Promise<PermissionDecision>
  ): void
  onClose(handler: CloseHandler): void
  close(): Promise<void>
}

/**
 * T-01810 (T-01801 Phase 1) — the v2 durability surface a Unix-socket broker
 * client adds OVER AND ABOVE the stdio BrokerClientLike shape: re-attach to a
 * surviving invocation, read a state snapshot, replay/ack the durable event log,
 * and respond to a pending permission request out-of-band. Wire-level connect
 * logic lands Phase 3; replay logic lands Phase 2 — this only pins the contract.
 */
export type DurableBrokerClientLike = BrokerClientLike & {
  attach(req: BrokerAttachRequest): Promise<BrokerAttachResponse>
  snapshot(req: InvocationSnapshotRequest): Promise<InvocationSnapshot>
  eventsSince(req: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse>
  ackEvents(req: InvocationAckEventsRequest): Promise<InvocationAckEventsResponse>
  permissionRespond(
    req: InvocationPermissionRespondRequest
  ): Promise<InvocationPermissionRespondResponse>
  /**
   * T-01801: live event stream for an invocation re-attached over `broker.attach`
   * (unlike `startInvocationFromRequest`, attach returns no stream). The controller
   * consumes this after replay so post-reattach turn events project live. Optional
   * so existing scripted test mocks need not implement it; the real connectUnix
   * client always provides it.
   */
  streamInvocationEvents?(invocationId: string): AsyncIterable<InvocationEventEnvelope>
}

/**
 * Runtime guard: true iff `client` carries every v2 durability method
 * (attach/snapshot/eventsSince/ackEvents/permissionRespond) on top of the stdio
 * BrokerClientLike shape. A stdio-only client returns false.
 */
export function isDurableBrokerClient(client: unknown): client is DurableBrokerClientLike {
  if (typeof client !== 'object' || client === null) {
    return false
  }
  const candidate = client as Record<string, unknown>
  return (
    typeof candidate['attach'] === 'function' &&
    typeof candidate['snapshot'] === 'function' &&
    typeof candidate['eventsSince'] === 'function' &&
    typeof candidate['ackEvents'] === 'function' &&
    typeof candidate['permissionRespond'] === 'function'
  )
}

/**
 * Stdio (headless) broker-client factory. The Unix durable-client connect path
 * lands Phase 3 as a SEPARATE factory rather than overloading this one — the
 * launch (stdio spawn) and connect (Unix dial) shapes are deliberately split
 * (contract C-03099).
 */
export type BrokerClientFactory = (options: StdioTransportStartOptions) => Promise<BrokerClientLike>

/**
 * T-01812 Phase 3 — Unix durable-client connect factory. The durable interactive
 * route DIALS an already-launched broker (running in its btmux 'broker' window
 * over `--transport unix`) rather than spawning a stdio child. Deliberately split
 * from `BrokerClientFactory`: the launch (stdio spawn) and connect (Unix dial)
 * shapes differ (contract C-03099). Default dials `BrokerClient.connectUnix`.
 */
export type BrokerUnixClientFactory = (options: {
  socketPath: string
  timeoutMs?: number | undefined
}) => Promise<DurableBrokerClientLike>

export type BrokerPermissionChannel = {
  request(request: PermissionRequestParams): Promise<PermissionDecision>
}

export type BrokerAgentchatLifecycle = {
  registerInvocation?: (input: {
    runtime: HrcRuntimeSnapshot
    invocation: HrcBrokerInvocationRecord
  }) => Promise<void> | void
  deregisterInvocation?: (input: {
    runtimeId: string
    invocationId: string
    reason: string
  }) => Promise<void> | void
}

/** The runtime-owned tmux pane lease handed to the broker at dispatch time. */
export type BrokerTmuxLease = NonNullable<InvocationRuntimeContext['terminalSurface']>

/**
 * A named tmux window's pane identity (broker or tui). Persisted by NAME beyond
 * bare pane ids because pane ids alone are known weak across restart/reconcile
 * (C-03099 Phase 3).
 */
export type BrokerWindowIdentity = {
  socketPath: string
  sessionId: string
  windowId: string
  paneId: string
  sessionName: string
  windowName: string
}

export type BrokerTmuxAllocation = {
  socketPath: string
  allocatedAt?: string | undefined
  /**
   * The full pane lease the allocator carved out. When present it is dispatched
   * to the broker via `runtime.terminalSurface` (kind `tmux-pane`, hrc-owned)
   * and its pane ids are persisted to `runtime.tmuxJson` for restart reconcile
   * and teardown. Absent for legacy socket-only allocations (which fall back to
   * the `runtime.tmux` shim).
   */
  lease?: BrokerTmuxLease | undefined
  sessionId?: string | undefined
  windowId?: string | undefined
  paneId?: string | undefined
  sessionName?: string | undefined
  windowName?: string | undefined
  /**
   * The runtime generation this lease was allocated for. Persisted alongside the
   * pane ids so restart reconcile can tell a re-associated lease from a stale one
   * across a generation rotation (C-02889 / T-01733 GAP 2).
   */
  generation?: number | undefined
  /**
   * T-01812 Phase 3 — durable interactive broker identity. Present when the
   * allocator launched a two-window btmux lease (broker window over Unix IPC +
   * TUI pane lease). The controller dials `brokerIpcSocketPath` via
   * `brokerUnixClientFactory` and persists this identity (everything EXCEPT the
   * raw `attachToken`, which is referenced redacted via `attachTokenRef`).
   */
  brokerIpcSocketPath?: string | undefined
  /** Raw attach-token secret — used in-process only, NEVER persisted. */
  attachToken?: string | undefined
  attachTokenRef?: BrokerAttachTokenRef | undefined
  brokerCommand?: string | undefined
  brokerPid?: number | undefined
  brokerWindow?: BrokerWindowIdentity | undefined
  tuiWindow?: BrokerWindowIdentity | undefined
  /**
   * T-04921 (T-04905 Phase A) — the HRC-owned read-only observer socket path the
   * broker SERVES for the codex-app-server headless-viewer route (present only
   * for that route). The controller injects it onto the dispatch env as
   * HARNESS_BROKER_OBSERVER_SOCKET and persists it on the runtime's broker
   * endpoint so the renderer connects to the SAME path the broker launch carries.
   */
  observerSocketPath?: string | undefined
}

export type BrokerTmuxAllocator = {
  allocate(input: {
    runtimeId: string
    hostSessionId: string
    generation: number
    brokerDriver: string
  }): Promise<BrokerTmuxAllocation>
}

export type BrokerAttachedLaunchInput = {
  pendingStartId: string
  timeoutMs?: number | undefined
}

export type BrokerAttachedLaunchReady = {
  pendingStartId: string
  runtime: HrcRuntimeSnapshot
}

export type PendingAttachedBrokerStart = BrokerAttachedLaunchReady & {
  allocation: BrokerTmuxAllocation
  resume: () => void
  reject: (error: Error) => void
}

export type AttachedStartReadyWaiter = {
  resolve: (ready: BrokerAttachedLaunchReady) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type HarnessBrokerControllerDeps = {
  db: HrcDatabase
  mapper?: Pick<BrokerEventMapper, 'apply'>
  brokerClientFactory?: BrokerClientFactory
  brokerUnixClientFactory?: BrokerUnixClientFactory
  permissionChannel?: BrokerPermissionChannel | undefined
  agentchat?: BrokerAgentchatLifecycle | undefined
  tmuxAllocator?: BrokerTmuxAllocator | undefined
  /**
   * T-01874 Ph3 — durable HEADLESS substrate allocator (presentation='none'):
   * allocates a leased-tmux broker window + Unix IPC socket + attach token +
   * event ledger with NO operator TUI window. Selected for the default headless
   * harness-broker route (the escape hatch reverts to the legacy stdio/daemon-
   * child path). Kept SEPARATE from {@link tmuxAllocator} (which is the
   * interactive presentation='tmux-tui' allocator) so the controller never
   * carves a TUI pane for a headless runtime. When unset, the controller falls
   * back to a deterministic in-process synthesis used by route/unit tests;
   * production wires `createBrokerDurableHeadlessAllocator`.
   */
  headlessSubstrateAllocator?: BrokerTmuxAllocator | undefined
  /**
   * T-04921 (T-04905 Phase A) — durable HEADLESS-VIEWER substrate allocator
   * (presentation='tmux-tui' substrate + observer socket) for the codex-app-server
   * dual-tmux viewer route. Selected by the controller ONLY when
   * `routeDecision.operatorPresentation === 'tmux-tui'` for a headless profile;
   * ordinary headless keeps {@link headlessSubstrateAllocator} (presentation=none).
   * Kept SEPARATE so an ordinary headless runtime can never carve a TUI pane.
   * Production wires `createBrokerHeadlessViewerAllocator`.
   */
  headlessViewerAllocator?: BrokerTmuxAllocator | undefined
  waitForAttachedTerminal?:
    | ((input: {
        runtime: HrcRuntimeSnapshot
        allocation: BrokerTmuxAllocation
      }) => Promise<void>)
    | undefined
  /**
   * Lever 2 graceful exit (T-01751 sibling): on a USER-INITIATED interactive
   * terminal (`invocation.exited` whose preceding `continuation.cleared` reason
   * is a /quit-class reason), the durable unix broker process does NOT die when
   * the controller closes its IPC client (that close intentionally preserves the
   * broker for reattach). This callback tears the per-runtime broker-tmux lease
   * session down — killing the broker window's process and the now-dead TUI
   * window so the operator's attached client auto-detaches instead of being left
   * on a live broker pane to Ctrl-C. Best-effort; only invoked for user-initiated
   * exits, never for crashes / idle-ttl (those keep durability for reattach).
   */
  reapBrokerTmuxLease?: ((runtimeId: string) => Promise<void>) | undefined
  /**
   * Bounded grace between a user-exit continuation clear and broker-tmux lease
   * reap. The broker emits `invocation.summary` after `continuation.cleared` on
   * the same ordered stream; this grace lets HRC record that summary before the
   * lease is killed while still keeping `/quit` prompt.
   */
  brokerTmuxSummaryReapGraceMs?: number | undefined
  /**
   * Close-path sibling of {@link reapBrokerTmuxLease}. Used when a user-initiated
   * terminal exit closes the broker IPC socket before a clean terminal event path
   * can reap the lease.
   */
  reconcileBrokerTmuxLivenessOnClose?: ((runtimeId: string) => Promise<void>) | undefined
  brokerCommand?: string | undefined
  brokerArgs?: string[] | undefined
  env?: Record<string, string | undefined> | undefined
  now?: () => string
  serverInstanceId?: string
  logger?: BrokerControllerLogger
  notifyRawBrokerEvent?:
    | ((notification: {
        envelope: InvocationEventEnvelope
        record: HrcBrokerInvocationEventRecord
      }) => void)
    | undefined
}

export type BrokerControllerStartInput = {
  plan: CompiledRuntimePlan
  profile: BrokerExecutionProfile
  startRequest: InvocationStartRequest
  specHash: string
  startRequestHash: string
  identity: RuntimeIdentityAllocation
  dispatchEnv?: Record<string, string> | undefined
  /**
   * The per-turn response format requested for this start, threaded independently
   * of `startRequest.initialInput.responseFormat`. Launch-argv-primed profiles
   * (e.g. interactive-tmux) drop `startRequest.initialInput` entirely during
   * compile, which would also drop the format and blind the fail-closed gate.
   * The controller uses this to enforce deliverability + driver capability even
   * when the compiled start request carries no initial input (T-05142).
   */
  requestedResponseFormat?: NonNullable<InvocationStartRequest['initialInput']>['responseFormat']
  routeDecision?: unknown
  brokerClient?: BrokerClientLike | undefined
  attachBeforeInvocationStart?: BrokerAttachedLaunchInput | undefined
  /**
   * Broker lifecycle policy overlay for this dispatch. Audit/dispatch material:
   * it rides ONLY on the broker dispatch options and is persisted as audit
   * evidence — it is NEVER folded into spec / start request / profile /
   * startRequestHash (INV-14.4 compiler closure).
   */
  lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
}

export type BrokerControllerStartResult =
  | {
      ok: true
      runtime: HrcRuntimeSnapshot
      run?: HrcRunRecord | undefined
      invocation: HrcBrokerInvocationRecord
      hello: BrokerHelloResponse
      startResponse: InvocationStartResponse
    }
  | {
      ok: false
      error: BrokerControllerError
    }

export type BrokerControllerDispatchInput = {
  runtimeId: string
  input: InvocationInput
  policy?: InputPolicy | undefined
}

export type BrokerControllerDispatchResult =
  | { ok: true; response: InvocationInputResponse }
  | { ok: false; error: BrokerControllerError }

export type BrokerControllerAttachInput = {
  runtimeId: string
  client: DurableBrokerClientLike
  attachToken: string
}

export type BrokerControllerAttachResult =
  | {
      ok: true
      brokerAttached: true
      replayedThroughSeq: number
      ackedThroughSeq: number
      acceptedInputIds: string[]
    }
  | {
      ok: false
      brokerAttached: false
      error: BrokerControllerError
    }

export type BrokerControllerRpcResult<T> =
  | { ok: true; response: T }
  | { ok: false; error: BrokerControllerError }

export type BrokerControllerReconcileResult =
  | {
      state: 'healthy'
      health: BrokerHealthResponse
      status?: InvocationStatusResponse | undefined
    }
  | {
      state: 'broker_process_gone'
      action: 'mark_runtime_terminated'
      error: BrokerControllerError
    }
  | {
      state: 'invocation_unavailable'
      action: 'mark_runtime_terminated'
      error: BrokerControllerError
    }
