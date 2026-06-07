/**
 * HarnessBrokerController (T-01690 W3B).
 *
 * In-process HRC owner for headless codex-app-server broker runtimes. This
 * module owns only broker lifecycle/RPC/supervision and delegates every broker
 * event envelope to BrokerEventMapper.
 *
 * FLAG DARKNESS: this controller is not wired into any live dispatch path.
 * W4 is responsible for calling it behind HRC_HEADLESS_CODEX_BROKER_ENABLED.
 */

import { HrcErrorCode } from 'hrc-core'
import type {
  HrcBrokerInvocationEventRecord,
  HrcBrokerInvocationRecord,
  HrcPermissionDecisionRecord,
  HrcProvider,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { BrokerInvocationEventConflictError } from 'hrc-store-sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { BrokerClient } from 'spaces-harness-broker-client'
import type { CloseHandler, StdioTransportStartOptions } from 'spaces-harness-broker-client'
import { BrokerErrorCode, canonicalLifecyclePolicyJson } from 'spaces-harness-broker-protocol'
import type {
  BrokerAttachRequest,
  BrokerAttachResponse,
  BrokerCapabilities,
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
  InvocationId,
  InvocationInput,
  InvocationInputResponse,
  InvocationInspectionSummary,
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
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CompiledRuntimePlan,
  RuntimeIdentityAllocation,
} from 'spaces-runtime-contracts'

import { appendHrcEvent } from '../hrc-event-helper'
import {
  type ExpectedBrokerNegotiation,
  admitBrokerHello,
  admitStartedInvocation,
  preflightBrokerLifecyclePolicy,
} from './capabilities'
import { BROKER_PROTOCOL_VERSION, BROKER_TRANSPORT, BROKER_TRANSPORT_UNIX } from './constants'
import { BrokerEventMapper, type BrokerProjectionResult } from './event-mapper'
import { deriveRuntimeStatusWithAwaiting } from '../ask-bracket'
import {
  type BrokerAttachTokenRef,
  extractRuntimeStateTmux,
  isBrokerTmuxProfile,
  runtimeHarness,
  runtimeStatusFromInvocationState,
  toBrokerTmuxJson,
  toDispatchRuntime,
  toRuntimeStateTmux,
} from './runtime-state'

const DEFAULT_BROKER_COMMAND = 'harness-broker'
const DEFAULT_BROKER_ARGS = ['run', '--transport', 'stdio']

// Durable-broker connect race (T-02009). The leased-tmux allocator launches the
// broker window (`exec harness-broker run --transport unix --socket …`) and
// returns the socket path WITHOUT waiting for the broker to bind its listener.
// The very next thing we do is dial that path via `connectUnix`, which is a
// single `net.connect()` with no retry — so if the freshly-spawned broker has
// not bound yet, the dial fails ENOENT/ECONNREFUSED and the whole start aborts
// as `broker_start_failed` (an operator just retries `hrc run` and it works).
// Bridge that gap with a bounded connect-retry: only socket-not-ready failures
// are retried; any other dial error (path budget, etc.) throws immediately.
const BROKER_UNIX_CONNECT_MAX_ATTEMPTS = 24
const BROKER_UNIX_CONNECT_BASE_DELAY_MS = 25
const BROKER_UNIX_CONNECT_MAX_DELAY_MS = 200
const BROKER_UNIX_CONNECT_ATTEMPT_TIMEOUT_MS = 1_000
// node socket-connect error codes that mean "the listener isn't up YET" — the
// broker is still booting inside its tmux window. EPIPE/ECONNRESET cover a
// listener that accepted then dropped mid-handshake during its own startup.
const BROKER_UNIX_CONNECT_RETRYABLE_CODES = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'EAGAIN',
  'EPIPE',
  'ECONNRESET',
])
const USER_INITIATED_CONTINUATION_CLEAR_REASONS = new Set(['prompt_input_exit', 'logout', 'clear'])
// Lever 2 graceful exit: the SUBSET of user-initiated continuation-clear reasons
// that mean the operator is LEAVING the session (so the broker-tmux lease should
// be torn down). `clear` is deliberately EXCLUDED — a `/clear` wipes context but
// keeps the harness running, so reaping on it would kill a live session.
const BROKER_TMUX_PROMPT_EXIT_REASONS = new Set(['prompt_input_exit', 'logout'])

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

type PendingAttachedBrokerStart = BrokerAttachedLaunchReady & {
  allocation: BrokerTmuxAllocation
  resume: () => void
  reject: (error: Error) => void
}

type AttachedStartReadyWaiter = {
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
  waitForAttachedTerminal?: ((input: {
    runtime: HrcRuntimeSnapshot
    allocation: BrokerTmuxAllocation
  }) => Promise<void>) | undefined
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
}

export type BrokerControllerStartInput = {
  plan: CompiledRuntimePlan
  profile: BrokerExecutionProfile
  startRequest: InvocationStartRequest
  specHash: string
  startRequestHash: string
  identity: RuntimeIdentityAllocation
  dispatchEnv?: Record<string, string> | undefined
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

export class BrokerControllerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'BrokerControllerError'
  }
}

/**
 * T-01855 — the negotiated broker inspection capability block, cached per active
 * runtime so inspection RPCs gate on what the broker actually advertises. Absent
 * (`undefined`) means an older broker with no inspection block at all.
 */
type BrokerInspectionCapabilities = NonNullable<BrokerCapabilities['inspection']>

type ActiveBrokerRuntime = {
  runtimeId: string
  invocationId: string
  client: BrokerClientLike
  closing: boolean
  closeReason?: string | undefined
  /**
   * T-01855 — broker inspection capabilities from the most recent hello (or
   * rehydrated from persisted broker state on durable reattach). Lifetime is the
   * active record: cleared automatically when the runtime leaves `active`.
   */
  inspection?: BrokerInspectionCapabilities | undefined
}

export class HarnessBrokerController {
  readonly kind = 'harness-broker' as const

  private readonly db: HrcDatabase
  private readonly mapper: Pick<BrokerEventMapper, 'apply'>
  private readonly brokerClientFactory: BrokerClientFactory
  private readonly brokerUnixClientFactory: BrokerUnixClientFactory
  private readonly permissionChannel: BrokerPermissionChannel | undefined
  private readonly agentchat: BrokerAgentchatLifecycle | undefined
  private readonly tmuxAllocator: BrokerTmuxAllocator | undefined
  private readonly headlessSubstrateAllocator: BrokerTmuxAllocator | undefined
  private readonly waitForAttachedTerminal:
    | ((input: { runtime: HrcRuntimeSnapshot; allocation: BrokerTmuxAllocation }) => Promise<void>)
    | undefined
  private readonly reapBrokerTmuxLease: ((runtimeId: string) => Promise<void>) | undefined
  private readonly reconcileBrokerTmuxLivenessOnClose:
    | ((runtimeId: string) => Promise<void>)
    | undefined
  private readonly brokerCommand: string
  private readonly brokerArgs: string[]
  private readonly env: Record<string, string | undefined> | undefined
  private readonly now: () => string
  private readonly serverInstanceId: string
  private readonly logger: BrokerControllerLogger
  private readonly active = new Map<string, ActiveBrokerRuntime>()
  private readonly intentionalClosingRuntimeIds = new Map<string, string>()
  // Lever 2 graceful exit: runtimes whose broker-tmux lease reap has been fired,
  // so the several user-exit signals that can arrive for one /quit (continuation
  // clear, then invocation.exited and/or broker close) reap exactly once.
  private readonly reapedBrokerTmuxRuntimeIds = new Set<string>()
  private readonly pendingAttachedStarts = new Map<string, PendingAttachedBrokerStart>()
  private readonly attachedStartReadyWaiters = new Map<string, AttachedStartReadyWaiter>()

  constructor(deps: HarnessBrokerControllerDeps) {
    this.db = deps.db
    this.mapper =
      deps.mapper ??
      new BrokerEventMapper({
        db: deps.db,
        ...(deps.now ? { now: deps.now } : {}),
      })
    this.brokerClientFactory =
      deps.brokerClientFactory ?? ((options) => BrokerClient.start(options))
    this.brokerUnixClientFactory =
      deps.brokerUnixClientFactory ??
      ((options) => BrokerClient.connectUnix(options) as Promise<DurableBrokerClientLike>)
    this.permissionChannel = deps.permissionChannel
    this.agentchat = deps.agentchat
    this.tmuxAllocator = deps.tmuxAllocator
    this.headlessSubstrateAllocator = deps.headlessSubstrateAllocator
    this.waitForAttachedTerminal = deps.waitForAttachedTerminal
    this.reapBrokerTmuxLease = deps.reapBrokerTmuxLease
    this.reconcileBrokerTmuxLivenessOnClose = deps.reconcileBrokerTmuxLivenessOnClose
    this.brokerCommand =
      deps.brokerCommand ?? deps.env?.['HRC_HARNESS_BROKER_CMD'] ?? DEFAULT_BROKER_COMMAND
    this.brokerArgs = deps.brokerArgs ?? DEFAULT_BROKER_ARGS
    this.env = deps.env
    this.now = deps.now ?? (() => new Date().toISOString())
    this.serverInstanceId = deps.serverInstanceId ?? 'hrc-server'
    this.logger = deps.logger ?? {}
  }

  async start(input: BrokerControllerStartInput): Promise<BrokerControllerStartResult> {
    const startOptions: StdioTransportStartOptions = {
      command: this.brokerCommand,
      args: this.brokerArgs,
      env: compactEnv(this.env),
    }

    // Launch-timing instrumentation (diagnostic). The broker has no log of its
    // own — its stderr is swallowed into a tail buffer by the stdio transport and
    // only surfaced on a transport error. These phase durations are the broker's
    // first observable timing; they land in hrc-server.err.log via the server
    // logger so we can localize the cost of a real (non-dry-run) launch.
    const timingStartMs = performance.now()
    let phaseStartMs = timingStartMs
    const markPhase = (phase: string): void => {
      const nowMs = performance.now()
      this.logger.info?.('broker.timing', {
        phase,
        durMs: Number((nowMs - phaseStartMs).toFixed(1)),
        runtimeId: String(input.identity.runtimeId),
      })
      phaseStartMs = nowMs
    }

    let client: BrokerClientLike | undefined
    let tmuxAllocation: BrokerTmuxAllocation | undefined
    try {
      // T-01812 Phase 3 — for an interactive broker-tmux profile, allocate the
      // per-runtime btmux lease UP FRONT. A durable allocator launches a 'broker'
      // window over `--transport unix` and yields a broker IPC socket path we
      // DIAL (instead of spawning a stdio child); a legacy allocator yields no
      // IPC socket and we keep the stdio launch. Preflight already ran inside the
      // durable allocator BEFORE any tmux spawn.
      // T-01866 — headless durable cutover is now UNCONDITIONAL. There is no
      // escape hatch: HRC_HEADLESS_BROKER_LEGACY_STDIO has NO route authority, so
      // a stale env var can neither resurrect legacy v0.1/stdio nor create a
      // v0.2-over-stdio path. Every headless broker runtime allocates a leased-tmux
      // substrate (presentation='none') + Unix v0.2 IPC, exactly like the durable
      // interactive route. Durability truth still comes from the negotiated hello +
      // persisted substrate/endpoint, never from a compile-time marker or flag.
      if (input.brokerClient === undefined && isBrokerTmuxProfile(input.profile)) {
        tmuxAllocation = await this.allocateTmuxIfRequired(input)
        markPhase('broker-tmux-alloc')
      } else if (
        input.brokerClient === undefined &&
        input.profile.interactionMode === 'headless'
      ) {
        // Headless durable cutover (spec §10.4): allocate a leased-tmux substrate
        // with presentation='none' (broker window + Unix IPC + token + ledger, NO
        // TUI, NO operator attach) and DIAL it over Unix v0.2 instead of spawning
        // a stdio daemon-child. Public/API identity stays transport='headless'.
        tmuxAllocation = await this.allocateHeadlessSubstrate(input)
        markPhase('broker-headless-substrate-alloc')
      }

      const durableSocketPath = tmuxAllocation?.brokerIpcSocketPath
      if (durableSocketPath) {
        client = await this.connectDurableBrokerWithRetry(
          durableSocketPath,
          String(input.identity.runtimeId)
        )
        markPhase('broker-connect-unix')
      } else {
        client = input.brokerClient ?? (await this.brokerClientFactory(startOptions))
        markPhase(input.brokerClient ? 'broker-client-ready' : 'broker-spawn')
      }
      client.onPermissionRequest((request) => this.handlePermissionRequest(request))

      const identity = input.identity
      client.onClose((error) => {
        this.handleBrokerClose(String(identity.runtimeId), error)
      })

      // T-01866 — HRC negotiates ONLY harness-broker/0.2. The durable route rides
      // the Unix socket (attach/replay required); the rare non-durable row keeps the
      // stdio transport kind but still expects v0.2, so any legacy v0.1 broker hello
      // is rejected (no v0.1 fallback, no v0.2-over-stdio masquerade).
      const expectedNegotiation: ExpectedBrokerNegotiation = durableSocketPath
        ? {
            protocolVersion: BROKER_PROTOCOL_VERSION,
            transport: BROKER_TRANSPORT_UNIX,
            control: { attachReplay: 'required' },
          }
        : { protocolVersion: BROKER_PROTOCOL_VERSION, transport: BROKER_TRANSPORT }
      const hello = await client.hello({
        clientInfo: { name: 'hrc-server' },
        protocolVersions: [expectedNegotiation.protocolVersion],
        capabilities: { permissionRequests: true },
      })
      markPhase('broker-hello')

      // T-01866 — reject any broker that selects a protocol other than
      // harness-broker/0.2 with a CLEAR unsupported-protocol failure, before the
      // general capability admission runs. A stale v0.1 broker (or any future
      // version HRC has not adopted) is fail-closed here, never silently accepted.
      if (hello.protocolVersion !== BROKER_PROTOCOL_VERSION) {
        const detail = {
          runtimeId: String(input.identity.runtimeId),
          brokerDriver: input.profile.brokerDriver,
          selectedProtocol: hello.protocolVersion,
          requiredProtocol: BROKER_PROTOCOL_VERSION,
          endpointKind: durableSocketPath ? BROKER_TRANSPORT_UNIX : BROKER_TRANSPORT,
        }
        this.logger.warn?.('harness broker selected unsupported protocol', detail)
        this.markBrokerClosing(String(input.identity.runtimeId), 'broker-protocol-unsupported')
        await client.close().catch(() => undefined)
        return {
          ok: false,
          error: new BrokerControllerError(
            'broker_protocol_unsupported',
            `harness broker selected unsupported protocol ${hello.protocolVersion}; HRC requires ${BROKER_PROTOCOL_VERSION}`,
            detail
          ),
        }
      }

      const admission = admitBrokerHello(input.profile, hello, expectedNegotiation)
      if (!admission.ok) {
        this.logger.warn?.('harness broker pre-start admission rejected', admission.detail)
        this.markBrokerClosing(String(identity.runtimeId), 'pre-start-admission-rejected')
        await client.close().catch(() => undefined)
        return {
          ok: false,
          error: new BrokerControllerError(
            'broker_admission_rejected',
            'broker hello/capability admission rejected the runtime',
            admission.detail
          ),
        }
      }

      // Capability preflight (advisory, fail-closed): the only overlay v1 ever
      // materializes is the conservative default, which is trivially a subset of
      // the route/profile lifecycle capabilities. This gate refuses to dispatch
      // an uncertified idle-ttl/recycle-child/safe-retry overlay. Broker dispatch
      // validation remains authoritative.
      preflightBrokerLifecyclePolicy(input.profile, input.lifecyclePolicy)

      if (tmuxAllocation === undefined) {
        tmuxAllocation = await this.allocateTmuxIfRequired(input)
        markPhase('broker-tmux-alloc')
      }
      // T-01874 Ph3 — a headless durable runtime has presentation='none' and no
      // operator pane, so it dispatches NO runtime.terminalSurface (and no tmux
      // shim): the broker-window pane must never become a terminalSurface. Only
      // the interactive tmux-tui route carries the operator pane lease.
      const dispatchRuntime =
        tmuxAllocation !== undefined && input.profile.interactionMode === 'headless'
          ? undefined
          : toDispatchRuntime(tmuxAllocation)
      const persisted = this.persistStartGraph(input, hello, tmuxAllocation)
      if (input.attachBeforeInvocationStart && tmuxAllocation?.lease) {
        await this.pauseForAttachedInvocationStart({
          pending: input.attachBeforeInvocationStart,
          runtime: persisted.runtime,
          allocation: tmuxAllocation,
        })
        markPhase('broker-attached-launch-gate')
      }
      // The lifecycle overlay rides ONLY on the dispatch options envelope —
      // never on input.startRequest (INV-14.4 compiler closure).
      const startResult = input.lifecyclePolicy
        ? await client.startInvocationFromRequest(input.startRequest, {
            dispatchEnv: input.dispatchEnv,
            runtime: dispatchRuntime,
            lifecyclePolicy: input.lifecyclePolicy,
          })
        : await client.startInvocationFromRequest(
            input.startRequest,
            input.dispatchEnv,
            dispatchRuntime
          )
      // Encompasses the driver's start() (e.g. codex's load-bearing paste-readiness
      // sleep + launch-command paste), so this is usually the largest broker phase.
      markPhase('broker-invocation-start')
      this.logger.info?.('broker.timing', {
        phase: 'broker-start-total',
        durMs: Number((performance.now() - timingStartMs).toFixed(1)),
        runtimeId: String(input.identity.runtimeId),
      })

      const invocationAdmission = admitStartedInvocation(
        input.profile,
        hello,
        startResult.response.capabilities
      )
      if (!invocationAdmission.ok) {
        this.logger.warn?.(
          'harness broker post-start invocation admission rejected',
          invocationAdmission.detail
        )
        this.markStartedInvocationFailed(input, startResult.response, invocationAdmission.detail)
        this.markBrokerClosing(String(identity.runtimeId), 'post-start-admission-rejected')
        await client
          .dispose({ invocationId: startResult.invocationId as InvocationId })
          .catch(() => undefined)
        await client.close().catch(() => undefined)
        return {
          ok: false,
          error: new BrokerControllerError(
            'broker_invocation_admission_rejected',
            'broker effective invocation capabilities rejected the runtime',
            invocationAdmission.detail
          ),
        }
      }

      const now = this.now()
      const invocation = this.db.brokerInvocations.update(startResult.invocationId, {
        invocationState: startResult.response.state,
        capabilitiesJson: JSON.stringify(startResult.response.capabilities),
        updatedAt: now,
      })
      const runtime = this.db.runtimes.update(String(identity.runtimeId), {
        status: runtimeStatusFromInvocationState(startResult.response.state),
        activeInvocationId: startResult.invocationId,
        activeOperationId: String(identity.operationId),
        activeRunId: identity.runId !== undefined ? String(identity.runId) : undefined,
        lastActivityAt: now,
        runtimeStateJson: this.buildRuntimeStateJson(
          input,
          hello,
          startResult.response,
          now,
          tmuxAllocation
        ),
        updatedAt: now,
      })

      this.db.runtimeOperations.update(String(identity.operationId), {
        status: 'completed',
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        capabilityResolutionJson: JSON.stringify({
          brokerHello: hello.capabilities,
          invocation: startResult.response.capabilities,
          result: { status: 'compatible' },
        }),
      })

      this.active.set(String(identity.runtimeId), {
        runtimeId: String(identity.runtimeId),
        invocationId: startResult.invocationId,
        client,
        closing: false,
        // T-01855: cache the freshly negotiated inspection capabilities so
        // inspection RPCs can gate on what THIS broker advertises.
        inspection: hello.capabilities.inspection,
      })

      this.consumeEvents(String(identity.runtimeId), startResult.events)
      if (runtime && invocation) {
        await this.agentchat?.registerInvocation?.({ runtime, invocation })
      }

      return {
        ok: true,
        runtime: runtime ?? persisted.runtime,
        run: persisted.run,
        invocation: invocation ?? persisted.invocation,
        hello,
        startResponse: startResult.response,
      }
    } catch (error) {
      const controllerError = toControllerError('broker_start_failed', error)
      if (client) {
        this.markBrokerClosing(String(input.identity.runtimeId), 'broker-start-failed')
        await client.close().catch(() => undefined)
      }
      this.logger.error?.('harness broker start failed', {
        error: controllerError.message,
        code: controllerError.code,
      })
      return { ok: false, error: controllerError }
    }
  }

  /**
   * Dial a freshly-allocated durable broker's Unix socket, tolerating the boot
   * race where the leased-tmux allocator has launched the broker window but the
   * broker has not yet bound its listener (T-02009). Retries ONLY socket-not-ready
   * connect failures; a non-retryable dial error (e.g. socket-path budget) or a
   * fully exhausted budget rethrows the last error so `start()` still surfaces it
   * as `broker_start_failed`.
   */
  private async connectDurableBrokerWithRetry(
    socketPath: string,
    runtimeId: string
  ): Promise<DurableBrokerClientLike> {
    let lastError: unknown
    for (let attempt = 1; attempt <= BROKER_UNIX_CONNECT_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.brokerUnixClientFactory({
          socketPath,
          timeoutMs: BROKER_UNIX_CONNECT_ATTEMPT_TIMEOUT_MS,
        })
      } catch (error) {
        lastError = error
        if (
          attempt >= BROKER_UNIX_CONNECT_MAX_ATTEMPTS ||
          !isBrokerSocketNotReadyError(error)
        ) {
          throw error
        }
        const delayMs = Math.min(
          BROKER_UNIX_CONNECT_MAX_DELAY_MS,
          BROKER_UNIX_CONNECT_BASE_DELAY_MS * attempt
        )
        this.logger.info?.('broker.connect.retry', {
          runtimeId,
          attempt,
          maxAttempts: BROKER_UNIX_CONNECT_MAX_ATTEMPTS,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        })
        await delay(delayMs)
      }
    }
    // Unreachable: the loop returns, or throws on the final attempt.
    throw lastError instanceof Error
      ? lastError
      : new Error('broker unix connect failed without an error')
  }

  async waitForAttachedStartReady(
    pendingStartId: string,
    timeoutMs = 15_000
  ): Promise<BrokerAttachedLaunchReady> {
    const pending = this.pendingAttachedStarts.get(pendingStartId)
    if (pending) {
      return { pendingStartId, runtime: pending.runtime }
    }

    return await new Promise<BrokerAttachedLaunchReady>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.attachedStartReadyWaiters.delete(pendingStartId)
        reject(new Error(`attached broker start did not become ready: ${pendingStartId}`))
      }, timeoutMs)
      this.attachedStartReadyWaiters.set(pendingStartId, { resolve, reject, timer })
    })
  }

  resumeAttachedStart(pendingStartId: string): BrokerControllerRpcResult<{ runtimeId: string }> {
    const pending = this.pendingAttachedStarts.get(pendingStartId)
    if (!pending) {
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_attached_start_not_pending',
          `attached broker start is not pending: ${pendingStartId}`,
          { pendingStartId }
        ),
      }
    }
    pending.resume()
    return { ok: true, response: { runtimeId: pending.runtime.runtimeId } }
  }

  cancelAttachedStart(pendingStartId: string, reason: string): void {
    const pending = this.pendingAttachedStarts.get(pendingStartId)
    if (pending) {
      pending.reject(new Error(reason))
      this.pendingAttachedStarts.delete(pendingStartId)
    }
    const waiter = this.attachedStartReadyWaiters.get(pendingStartId)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.attachedStartReadyWaiters.delete(pendingStartId)
      waiter.reject(new Error(reason))
    }
  }

  async dispatchInput(
    input: BrokerControllerDispatchInput
  ): Promise<BrokerControllerDispatchResult> {
    const active = this.active.get(input.runtimeId)
    if (!active) {
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_runtime_not_active',
          `no active broker client for runtime ${input.runtimeId}`
        ),
      }
    }

    try {
      const response = await active.client.input({
        invocationId: active.invocationId as InvocationId,
        input: input.input,
        ...(input.policy ? { policy: input.policy } : {}),
      })
      return { ok: true, response }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_input_failed', error) }
    }
  }

  async attachAndReplay(input: BrokerControllerAttachInput): Promise<BrokerControllerAttachResult> {
    const runtime = this.db.runtimes.getByRuntimeId(input.runtimeId)
    const invocation = this.resolveAttachInvocation(runtime, input.runtimeId)
    if (!runtime || !invocation) {
      return {
        ok: false,
        brokerAttached: false,
        error: new BrokerControllerError(
          'broker_attach_unknown_runtime',
          `cannot attach broker runtime ${input.runtimeId}: persisted runtime/invocation not found`,
          {
            runtimeFound: runtime !== null,
            invocationFound: invocation !== null,
          }
        ),
      }
    }

    const lastProjectedSeq = this.lastProjectedBrokerSeq(invocation.invocationId)
    try {
      const attach = await input.client.attach({
        runtimeId: runtime.runtimeId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        invocationId: invocation.invocationId as InvocationId,
        startRequestHash: invocation.startRequestHash,
        selectedProfileHash: invocation.selectedProfileHash,
        controllerInstanceId: this.serverInstanceId,
        attachToken: input.attachToken,
        lastProjectedSeq,
      })
      const snapshot = await input.client.snapshot({
        invocationId: invocation.invocationId as InvocationId,
      })

      const retentionFloorSeq = Math.max(
        attach.retentionFloorSeq,
        attach.snapshot.retentionFloorSeq,
        snapshot.retentionFloorSeq
      )
      if (retentionFloorSeq > lastProjectedSeq + 1) {
        const error = new BrokerControllerError(
          'broker_replay_retention_gap',
          'broker event retention floor is past HRC projected high-water',
          {
            runtimeId: runtime.runtimeId,
            invocationId: invocation.invocationId,
            lastProjectedSeq,
            retentionFloorSeq,
          }
        )
        await this.failReplayStale(runtime, invocation, input.client, error)
        return { ok: false, brokerAttached: false, error }
      }

      const replay = await input.client.eventsSince({
        invocationId: invocation.invocationId as InvocationId,
        afterSeq: lastProjectedSeq,
      })

      let replayedThroughSeq = lastProjectedSeq
      let ackedThroughSeq = lastProjectedSeq
      for (const envelope of replay.events) {
        const result = this.mapper.apply(envelope)
        this.afterMappedEvent(runtime.runtimeId, envelope, result)
        replayedThroughSeq = Math.max(replayedThroughSeq, envelope.seq)
        const projected = this.db.brokerInvocationEvents.getByInvocationAndSeq(
          String(envelope.invocationId),
          envelope.seq
        )
        if (projected?.projectionStatus === 'applied') {
          ackedThroughSeq = Math.max(ackedThroughSeq, envelope.seq)
        }
      }

      if (ackedThroughSeq > 0) {
        const ack = await input.client.ackEvents({
          invocationId: invocation.invocationId as InvocationId,
          throughSeq: ackedThroughSeq,
          controllerInstanceId: this.serverInstanceId,
        })
        ackedThroughSeq = ack.ackedThroughSeq
      }

      // T-01946 gate 2 (restart re-derivation): the broker reports `turn_active`
      // for a parked turn (it has no awaiting-input member), which would clobber
      // the awaiting_input status that replay just projected. Re-derive from the
      // durable ask bracket so a reattach during a park keeps the runtime honest.
      const baseStatus = runtimeStatusFromInvocationState(snapshot.state)
      const refreshedRuntime = this.db.runtimes.getByRuntimeId(runtime.runtimeId)
      const status = refreshedRuntime
        ? deriveRuntimeStatusWithAwaiting(this.db, refreshedRuntime, baseStatus)
        : baseStatus
      const now = this.now()
      this.db.brokerInvocations.update(invocation.invocationId, {
        invocationState: snapshot.state,
        capabilitiesJson: JSON.stringify(snapshot.capabilities),
        ownerServerInstanceId: this.serverInstanceId,
        updatedAt: now,
      })
      this.db.runtimes.update(runtime.runtimeId, {
        status,
        activeInvocationId: invocation.invocationId,
        lastActivityAt: now,
        runtimeStateJson: {
          ...(runtime.runtimeStateJson ?? {}),
          status,
          updatedAt: now,
          control: {
            mode: 'broker-ipc',
            brokerAttached: true,
          },
          brokerReplay: {
            brokerInstanceId: attach.brokerInstanceId,
            activeControllerInstanceId: attach.activeControllerInstanceId,
            lastProjectedSeq,
            replayedThroughSeq,
            ackedThroughSeq,
            currentSeq: Math.max(attach.currentSeq, snapshot.currentSeq, replay.currentSeq),
            retentionFloorSeq: Math.max(retentionFloorSeq, replay.retentionFloorSeq),
          },
        },
        updatedAt: now,
      })

      input.client.onClose((error) => {
        this.handleBrokerClose(runtime.runtimeId, error)
      })
      this.active.set(runtime.runtimeId, {
        runtimeId: runtime.runtimeId,
        invocationId: invocation.invocationId,
        client: input.client,
        closing: false,
        // T-01855: durable reattach rebuilds `active` WITHOUT a fresh hello, so
        // rehydrate inspection capabilities from persisted broker state. A later
        // fresh hello (generation/reattach) replaces this best-effort fallback.
        inspection: rehydrateInspectionCapabilities(runtime.runtimeStateJson),
      })

      // T-01801: subscribe to the broker's LIVE event stream after the one-shot
      // `eventsSince` replay. Without this the runtime is re-attached for INPUT
      // but every subsequent turn's events stay in the broker's durable ledger
      // and never project into hrc_events, so the semantic turn never finalizes.
      // `streamInvocationEvents` drains events buffered since the attach (de-duped
      // by seq) then yields live ones; `consumeEvents` projects idempotently
      // (mapper marks already-applied seqs idempotent + the events table is UNIQUE
      // on (invocation_id, seq)), so the overlap with the replay above is safe.
      const liveEvents = input.client.streamInvocationEvents?.(
        invocation.invocationId as InvocationId
      )
      if (liveEvents) {
        this.consumeEvents(runtime.runtimeId, liveEvents)
      }

      return {
        ok: true,
        brokerAttached: true,
        replayedThroughSeq,
        ackedThroughSeq,
        acceptedInputIds: Object.entries(snapshot.inputDispositions ?? {})
          .filter(([, disposition]) => disposition.accepted)
          .map(([inputId]) => inputId),
      }
    } catch (error) {
      const controllerError =
        error instanceof BrokerInvocationEventConflictError
          ? new BrokerControllerError(
              'broker_replay_conflict',
              'broker replay produced a conflicting durable event payload',
              {
                conflict: true,
                invocationId: error.invocationId,
                seq: error.seq,
                name: error.name,
              }
            )
          : toControllerError('broker_attach_replay_failed', error)
      await this.failReplayStale(runtime, invocation, input.client, controllerError)
      return { ok: false, brokerAttached: false, error: controllerError }
    }
  }

  async interrupt(
    runtimeId: string,
    options: Omit<InvocationInterruptRequest, 'invocationId'>
  ): Promise<BrokerControllerRpcResult<InvocationInterruptResponse>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    try {
      return {
        ok: true,
        response: await active.client.interrupt({
          invocationId: active.invocationId as InvocationId,
          ...options,
        }),
      }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_interrupt_failed', error) }
    }
  }

  async stop(
    runtimeId: string,
    options: Omit<InvocationStopRequest, 'invocationId'> = {}
  ): Promise<BrokerControllerRpcResult<InvocationStopResponse>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    try {
      return {
        ok: true,
        response: await active.client.stop({
          invocationId: active.invocationId as InvocationId,
          ...options,
        }),
      }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_stop_failed', error) }
    }
  }

  async status(
    runtimeId: string,
    opts?: { probeLiveness?: boolean | undefined }
  ): Promise<
    BrokerControllerRpcResult<{
      health: BrokerHealthResponse
      invocation?: InvocationStatusResponse | undefined
    }>
  > {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    try {
      const health = await active.client.health({ probeDrivers: true })
      // T-01855 tri-state gating: pass probeLiveness ONLY when the caller asked
      // AND the broker does not explicitly forbid a live probe (liveness
      // 'cached'/'none'). The returned status carries the extended
      // InvocationInspectionSummary fields (lifecycle/liveness) for free.
      const probeLiveness = !!opts?.probeLiveness && livenessProbeAllowed(active.inspection)
      const invocation = await active.client.status({
        invocationId: active.invocationId as InvocationId,
        ...(probeLiveness ? { probeLiveness: true } : {}),
      })
      return { ok: true, response: { health, invocation } }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_status_failed', error) }
    }
  }

  /**
   * T-01855 — read-only inspection of every invocation the broker tracks for this
   * runtime. Returns the shared `InvocationInspectionSummary[]` read model and
   * mutates NO HRC state (no DB writes, no event projection, no replay/ack).
   *
   * Capability-gated: when the broker advertises no `inspection.listInvocations`
   * (older broker), this degrades cleanly to `[]` WITHOUT touching the wire.
   * `probeLiveness` is forwarded only when `inspection.liveness === 'probe'`.
   */
  async listInvocations(
    runtimeId: string,
    opts?: { includeDisposed?: boolean | undefined; probeLiveness?: boolean | undefined }
  ): Promise<InvocationInspectionSummary[] | { ok: false; error: BrokerControllerError }> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    // Degrade cleanly when listInvocations is not advertised (older broker) or
    // the client cannot serve it.
    if (
      active.inspection?.listInvocations !== true ||
      typeof active.client.listInvocations !== 'function'
    ) {
      return []
    }
    const probeLiveness = !!opts?.probeLiveness && livenessProbeAllowed(active.inspection)
    const request: BrokerListInvocationsRequest = {
      ...(opts?.includeDisposed !== undefined ? { includeDisposed: opts.includeDisposed } : {}),
      ...(probeLiveness ? { probeLiveness: true } : {}),
    }
    const response = await active.client.listInvocations(request)
    return response.invocations
  }

  /**
   * T-01855 — read-only single-invocation snapshot for inspection. This is a
   * DIRECT `client.snapshot()` call gated only on the runtime being active; it
   * deliberately does NOT reuse attach/eventsSince/ackEvents (those are the
   * HRC-side mutation hazard — the broker snapshot itself is read-only).
   */
  async snapshot(
    runtimeId: string,
    opts?: { probeLiveness?: boolean | undefined }
  ): Promise<BrokerControllerRpcResult<InvocationSnapshot>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    if (typeof active.client.snapshot !== 'function') {
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_snapshot_unsupported',
          `broker runtime ${runtimeId} does not support snapshot inspection`
        ),
      }
    }
    try {
      const probeLiveness = !!opts?.probeLiveness && livenessProbeAllowed(active.inspection)
      const response = await active.client.snapshot({
        invocationId: active.invocationId as InvocationId,
        ...(probeLiveness ? { probeLiveness: true } : {}),
      })
      return { ok: true, response }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_snapshot_failed', error) }
    }
  }

  async reconcile(runtimeId: string): Promise<BrokerControllerReconcileResult> {
    const active = this.active.get(runtimeId)
    if (!active) {
      const error = this.notActive(runtimeId)
      this.markBrokerCrashTerminal(runtimeId, error)
      return { state: 'broker_process_gone', action: 'mark_runtime_terminated', error }
    }

    try {
      const health = await active.client.health({ probeDrivers: true })
      if (health.status !== 'ok') {
        const error = new BrokerControllerError(
          'broker_health_degraded',
          `broker health is ${health.status}`,
          { health }
        )
        this.markBrokerCrashTerminal(runtimeId, error)
        return { state: 'broker_process_gone', action: 'mark_runtime_terminated', error }
      }
      const status = await active.client.status({
        invocationId: active.invocationId as InvocationId,
      })
      return { state: 'healthy', health, status }
    } catch (error) {
      const controllerError = toControllerError('broker_reconcile_failed', error)
      this.markBrokerCrashTerminal(runtimeId, controllerError)
      return {
        state: 'invocation_unavailable',
        action: 'mark_runtime_terminated',
        error: controllerError,
      }
    }
  }

  async dispose(runtimeId: string): Promise<BrokerControllerRpcResult<{ disposed: true }>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    this.markBrokerClosing(runtimeId, 'dispose')
    try {
      await active.client.stop({
        invocationId: active.invocationId as InvocationId,
        reason: 'dispose',
      })
      await active.client
        .dispose({ invocationId: active.invocationId as InvocationId })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'Broker transport is closed') {
            return
          }
          throw error
        })
      await active.client.close()
      this.active.delete(runtimeId)
      const now = this.now()
      this.db.runtimes.update(runtimeId, { status: 'disposed', updatedAt: now })
      await this.agentchat?.deregisterInvocation?.({
        runtimeId,
        invocationId: active.invocationId,
        reason: 'disposed',
      })
      return { ok: true, response: { disposed: true } }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_dispose_failed', error) }
    }
  }

  private async pauseForAttachedInvocationStart(input: {
    pending: BrokerAttachedLaunchInput
    runtime: HrcRuntimeSnapshot
    allocation: BrokerTmuxAllocation
  }): Promise<void> {
    const { pending, runtime, allocation } = input
    let resume!: () => void
    let reject!: (error: Error) => void
    const resumed = new Promise<void>((resolve, rejectPromise) => {
      resume = resolve
      reject = rejectPromise
    })

    const pendingRecord: PendingAttachedBrokerStart = {
      pendingStartId: pending.pendingStartId,
      runtime,
      allocation,
      resume,
      reject,
    }
    this.pendingAttachedStarts.set(pending.pendingStartId, pendingRecord)

    const waiter = this.attachedStartReadyWaiters.get(pending.pendingStartId)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.attachedStartReadyWaiters.delete(pending.pendingStartId)
      waiter.resolve({ pendingStartId: pending.pendingStartId, runtime })
    }

    try {
      await Promise.race([
        resumed,
        delay(pending.timeoutMs ?? 120_000).then(() => {
          throw new Error(`timed out waiting for attached launch resume: ${pending.pendingStartId}`)
        }),
      ])
      if (this.waitForAttachedTerminal) {
        await this.waitForAttachedTerminal({ runtime, allocation })
      }
    } finally {
      this.pendingAttachedStarts.delete(pending.pendingStartId)
    }
  }

  private persistStartGraph(
    input: BrokerControllerStartInput,
    hello: BrokerHelloResponse,
    tmuxAllocation: BrokerTmuxAllocation | undefined
  ): {
    session: HrcSessionRecord
    runtime: HrcRuntimeSnapshot
    run?: HrcRunRecord | undefined
    invocation: HrcBrokerInvocationRecord
  } {
    const now = this.now()
    const identity = input.identity
    const session = this.db.sessions.getByHostSessionId(String(identity.hostSessionId))
    if (!session) {
      throw new BrokerControllerError(
        'broker_unknown_host_session',
        `host session not found: ${String(identity.hostSessionId)}`
      )
    }

    this.db.compiledRuntimePlans.insert({
      planHash: String(input.plan.planHash),
      compileId: String(input.plan.compileId),
      schemaVersion: input.plan.schemaVersion,
      compilerName: input.plan.compiler.name,
      compilerVersion: input.plan.compiler.version,
      planProjectionJson: JSON.stringify(input.plan),
      diagnosticsJson: JSON.stringify(input.plan.diagnostics ?? []),
      createdAt: input.plan.createdAt,
    })

    this.db.runtimeOperations.insert({
      operationId: String(identity.operationId),
      runtimeId: String(identity.runtimeId),
      ...(identity.runId !== undefined ? { runId: String(identity.runId) } : {}),
      hostSessionId: String(identity.hostSessionId),
      generation: identity.generation,
      operationKind: 'broker_invocation',
      controller: 'harness-broker',
      compileId: String(input.plan.compileId),
      planHash: String(input.plan.planHash),
      selectedProfileId: String(input.profile.profileId),
      selectedProfileHash: String(input.profile.profileHash),
      startupMethod: 'broker.startInvocationFromRequest',
      turnDelivery: 'invocation.input',
      status: 'starting',
      routeDecisionJson: JSON.stringify(input.routeDecision ?? { controller: 'harness-broker' }),
      capabilityResolutionJson: JSON.stringify({
        brokerHello: hello.capabilities,
        drivers: hello.drivers,
        result: { status: 'admitted' },
      }),
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    })

    // T-01874 Ph3 — public/API transport tracks the PROFILE, not the substrate.
    // A headless durable runtime now carries a leased-tmux substrate
    // (`tmuxAllocation` set) but its identity stays transport='headless'
    // (presentation='none'); only the interactive tmux-tui profile is 'tmux'.
    const transport = tmuxAllocation && isBrokerTmuxProfile(input.profile) ? 'tmux' : 'headless'
    const runtime = this.db.runtimes.insert({
      runtimeId: String(identity.runtimeId),
      runtimeKind: 'harness',
      hostSessionId: String(identity.hostSessionId),
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: identity.generation,
      transport,
      harness: runtimeHarness(input.plan.harness.runtime),
      provider: input.plan.harness.provider as HrcProvider,
      status: 'starting',
      supportsInflightInput: true,
      adopted: false,
      ...(tmuxAllocation && isBrokerTmuxProfile(input.profile)
        ? {
            tmuxJson: toBrokerTmuxJson(input.profile.brokerDriver, tmuxAllocation),
          }
        : {}),
      ...(identity.runId !== undefined ? { activeRunId: String(identity.runId) } : {}),
      controllerKind: 'harness-broker',
      activeOperationId: String(identity.operationId),
      activeInvocationId: String(identity.invocationId),
      compileId: String(input.plan.compileId),
      planHash: String(input.plan.planHash),
      selectedProfileHash: String(input.profile.profileHash),
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId: String(identity.runtimeId),
        hostSessionId: String(identity.hostSessionId),
        generation: identity.generation,
        status: 'starting',
        ...(tmuxAllocation && isBrokerTmuxProfile(input.profile)
          ? { tmux: toRuntimeStateTmux(input.profile.brokerDriver, tmuxAllocation) }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
    })

    const run =
      identity.runId !== undefined
        ? this.db.runs.insert({
            runId: String(identity.runId),
            hostSessionId: String(identity.hostSessionId),
            runtimeId: String(identity.runtimeId),
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
            generation: identity.generation,
            transport,
            status: 'accepted',
            acceptedAt: now,
            updatedAt: now,
            operationId: String(identity.operationId),
            invocationId: String(identity.invocationId),
          })
        : undefined

    // Persist the dispatched lifecycle overlay as AUDIT material (never compiler
    // closure): record the canonical policy in lifecycle_policies and stamp the
    // invocation's lifecycle_policy_hash. WS-B owns the DDL; we only call it.
    if (input.lifecyclePolicy) {
      this.db.lifecyclePolicies.insert({
        policyId: input.lifecyclePolicy.policyId,
        lifecyclePolicyHash: input.lifecyclePolicy.policyHash,
        canonicalPolicyJson: canonicalLifecyclePolicyJson(input.lifecyclePolicy),
        schemaVersion: input.lifecyclePolicy.schemaVersion,
        createdAt: now,
      })
    }

    const invocation = this.db.brokerInvocations.insert({
      invocationId: String(identity.invocationId),
      operationId: String(identity.operationId),
      runtimeId: String(identity.runtimeId),
      ...(identity.runId !== undefined ? { runId: String(identity.runId) } : {}),
      // G1 (daedalus, T-01874 Ph3) — persist the protocol NEGOTIATED in
      // broker.hello, not a compile-time constant. Durable v0.2 rows must record
      // 'harness-broker/0.2' because that is what hello returned; legacy stdio
      // rows record whatever the stdio broker advertised. Stamping the constant
      // lied about the wire protocol for every durable runtime.
      brokerProtocol: hello.protocolVersion,
      brokerDriver: input.profile.brokerDriver,
      invocationState: 'starting',
      capabilitiesJson: JSON.stringify({}),
      specHash: input.specHash,
      startRequestHash: input.startRequestHash,
      selectedProfileHash: String(input.profile.profileHash),
      specProjectionJson: JSON.stringify(input.startRequest.spec),
      startRequestProjectionJson: JSON.stringify(input.startRequest),
      ownerServerInstanceId: this.serverInstanceId,
      ...(input.lifecyclePolicy ? { lifecyclePolicyHash: input.lifecyclePolicy.policyHash } : {}),
      createdAt: now,
      updatedAt: now,
    })

    return { session, runtime, run, invocation }
  }

  private buildRuntimeStateJson(
    input: BrokerControllerStartInput,
    hello: BrokerHelloResponse,
    response: InvocationStartResponse,
    now: string,
    tmuxAllocation?: BrokerTmuxAllocation | undefined
  ): Record<string, unknown> {
    const identity = input.identity
    // T-01812 Phase 3 — durable broker identity persisted BEYOND pane ids: the
    // Unix endpoint + redacted attach-token ref, generation, broker command/pid,
    // and both named windows. The raw attach token is NEVER persisted.
    const durable = tmuxAllocation?.brokerIpcSocketPath
      ? {
          endpoint: {
            kind: 'unix-jsonrpc-ndjson' as const,
            socketPath: tmuxAllocation.brokerIpcSocketPath,
            ...(tmuxAllocation.attachTokenRef
              ? {
                  attachTokenRef: {
                    kind: tmuxAllocation.attachTokenRef.kind,
                    path: tmuxAllocation.attachTokenRef.path,
                    redacted: true as const,
                  },
                }
              : {}),
          },
          generation: tmuxAllocation.generation ?? identity.generation,
          ...(tmuxAllocation.brokerCommand ? { brokerCommand: tmuxAllocation.brokerCommand } : {}),
          ...(tmuxAllocation.brokerPid !== undefined
            ? { brokerPid: tmuxAllocation.brokerPid }
            : {}),
          ...(tmuxAllocation.brokerWindow ? { brokerWindow: tmuxAllocation.brokerWindow } : {}),
          ...(tmuxAllocation.tuiWindow ? { tuiWindow: tmuxAllocation.tuiWindow } : {}),
        }
      : { endpoint: { kind: BROKER_TRANSPORT } }
    return {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: String(identity.runtimeId),
      hostSessionId: String(identity.hostSessionId),
      generation: identity.generation,
      status: runtimeStatusFromInvocationState(response.state),
      ...(identity.runId !== undefined ? { activeRunId: String(identity.runId) } : {}),
      createdAt: now,
      updatedAt: now,
      compile: {
        compileId: String(input.plan.compileId),
        planHash: String(input.plan.planHash),
        selectedProfileId: String(input.profile.profileId),
        selectedProfileHash: String(input.profile.profileHash),
        specHash: input.specHash,
        startRequestHash: input.startRequestHash,
      },
      broker: {
        protocolVersion: hello.protocolVersion,
        multiInvocation: hello.capabilities.multiInvocation,
        startedAt: now,
        ownerServerInstanceId: this.serverInstanceId,
        // T-01855: persist the negotiated inspection capabilities so a durable
        // reattach (which rebuilds `active` without a fresh hello) can rehydrate
        // them as a fallback until the next hello replaces them.
        ...(hello.capabilities.inspection
          ? { inspection: hello.capabilities.inspection }
          : {}),
        ...durable,
      },
      ...(tmuxAllocation?.brokerIpcSocketPath
        ? { control: { mode: 'broker-ipc', brokerAttached: true } }
        : {}),
      ...(isBrokerTmuxProfile(input.profile)
        ? {
            tmux: extractRuntimeStateTmux(
              this.db.runtimes.getByRuntimeId(String(identity.runtimeId))?.tmuxJson
            ),
          }
        : {}),
      invocation: {
        invocationId: response.invocationId,
        state: response.state,
        driver: input.profile.brokerDriver,
        harnessRuntime: input.plan.harness.runtime,
        capabilities: response.capabilities,
      },
      permission: {
        policy: input.profile.policy.permissionPolicy,
        negotiated: hello.capabilities.brokerToClientRequests,
        pending: [],
      },
      input: {
        policy: input.profile.policy.inputPolicy,
        pendingDepth: 0,
      },
    }
  }

  private async allocateTmuxIfRequired(
    input: BrokerControllerStartInput
  ): Promise<BrokerTmuxAllocation | undefined> {
    if (!isBrokerTmuxProfile(input.profile)) {
      return undefined
    }
    if (!this.tmuxAllocator) {
      throw new BrokerControllerError(
        'broker_tmux_allocator_unavailable',
        'interactive broker-tmux profile requires an HRC tmux allocator',
        {
          runtimeId: String(input.identity.runtimeId),
          brokerDriver: input.profile.brokerDriver,
          brokerTerminal: input.profile.brokerTerminal,
        }
      )
    }
    return this.allocateSubstrateVia(this.tmuxAllocator, input)
  }

  /**
   * T-01874 Ph3 — allocate the durable HEADLESS substrate (presentation='none').
   * Uses the injected {@link headlessSubstrateAllocator} when present; otherwise
   * synthesizes a deterministic leased-tmux + unix endpoint identity in-process.
   * The synthesized fallback exists so the controller's route logic is testable
   * without spawning tmux; it is only ever persisted AFTER a (mocked, in tests)
   * Unix dial + broker.hello succeed, so it never fabricates durable state in
   * front of a live broker. Production injects `createBrokerDurableHeadlessAllocator`.
   */
  private async allocateHeadlessSubstrate(
    input: BrokerControllerStartInput
  ): Promise<BrokerTmuxAllocation> {
    if (this.headlessSubstrateAllocator) {
      return this.allocateSubstrateVia(this.headlessSubstrateAllocator, input)
    }
    const runtimeId = String(input.identity.runtimeId)
    const driver = input.profile.brokerDriver
    const runtimeRoot = this.env?.['HRC_RUNTIME_ROOT'] ?? '/tmp/hrc-runtime'
    const ipcDir = `${runtimeRoot}/bipc/${runtimeId}`
    const brokerIpcSocketPath = `${ipcDir}/b.sock`
    const btmuxSocketPath = `${runtimeRoot}/btmux/${driver}-${runtimeId}.sock`
    const sessionName = `hrc-${driver}-${runtimeId}`
    return {
      socketPath: btmuxSocketPath,
      allocatedAt: this.now(),
      generation: input.identity.generation,
      brokerIpcSocketPath,
      // Raw token is used in-process only and never persisted (the redacted ref
      // below is what lands in runtime_state_json).
      attachToken: 'synthesized-headless-attach-token',
      attachTokenRef: { kind: 'file', path: `${ipcDir}/attach.token`, redacted: true },
      brokerCommand: `exec harness-broker run --transport unix --socket ${brokerIpcSocketPath}`,
      // Broker process window only — NO tuiWindow, NO lease (presentation='none').
      brokerWindow: {
        socketPath: btmuxSocketPath,
        sessionId: `$hb-${runtimeId}`,
        windowId: '@hb',
        paneId: '%hb',
        sessionName,
        windowName: 'broker',
      },
    }
  }

  private async allocateSubstrateVia(
    allocator: BrokerTmuxAllocator,
    input: BrokerControllerStartInput
  ): Promise<BrokerTmuxAllocation> {
    const allocation = await allocator.allocate({
      runtimeId: String(input.identity.runtimeId),
      hostSessionId: String(input.identity.hostSessionId),
      generation: input.identity.generation,
      brokerDriver: input.profile.brokerDriver,
    })
    if (allocation.socketPath.length === 0) {
      throw new BrokerControllerError(
        'broker_tmux_allocation_invalid',
        'tmux allocator returned an empty socket path',
        {
          runtimeId: String(input.identity.runtimeId),
          brokerDriver: input.profile.brokerDriver,
        }
      )
    }
    return {
      socketPath: allocation.socketPath,
      allocatedAt: allocation.allocatedAt ?? this.now(),
      // Source generation from the runtime identity (authoritative) so the
      // persisted lease records the generation it belongs to even when the
      // allocator does not echo it back.
      generation: allocation.generation ?? input.identity.generation,
      ...(allocation.lease ? { lease: allocation.lease } : {}),
      ...(allocation.sessionId !== undefined ? { sessionId: allocation.sessionId } : {}),
      ...(allocation.windowId !== undefined ? { windowId: allocation.windowId } : {}),
      ...(allocation.paneId !== undefined ? { paneId: allocation.paneId } : {}),
      ...(allocation.sessionName !== undefined ? { sessionName: allocation.sessionName } : {}),
      ...(allocation.windowName !== undefined ? { windowName: allocation.windowName } : {}),
      // T-01812 Phase 3 — carry durable broker identity through unchanged.
      ...(allocation.brokerIpcSocketPath !== undefined
        ? { brokerIpcSocketPath: allocation.brokerIpcSocketPath }
        : {}),
      ...(allocation.attachToken !== undefined ? { attachToken: allocation.attachToken } : {}),
      ...(allocation.attachTokenRef !== undefined
        ? { attachTokenRef: allocation.attachTokenRef }
        : {}),
      ...(allocation.brokerCommand !== undefined
        ? { brokerCommand: allocation.brokerCommand }
        : {}),
      ...(allocation.brokerPid !== undefined ? { brokerPid: allocation.brokerPid } : {}),
      ...(allocation.brokerWindow !== undefined ? { brokerWindow: allocation.brokerWindow } : {}),
      ...(allocation.tuiWindow !== undefined ? { tuiWindow: allocation.tuiWindow } : {}),
    }
  }

  private markStartedInvocationFailed(
    input: BrokerControllerStartInput,
    response: InvocationStartResponse,
    detail: Record<string, unknown>
  ): void {
    const now = this.now()
    const identity = input.identity
    const operationId = String(identity.operationId)
    const runtimeId = String(identity.runtimeId)
    const runId = identity.runId !== undefined ? String(identity.runId) : undefined
    const invocationId = response.invocationId
    const message = 'broker effective invocation capabilities rejected the runtime'

    this.db.brokerInvocations.update(invocationId, {
      invocationState: 'failed',
      capabilitiesJson: JSON.stringify(response.capabilities),
      updatedAt: now,
    })
    this.db.runtimeOperations.update(operationId, {
      status: 'failed',
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      errorCode: 'broker_invocation_admission_rejected',
      errorMessage: message,
      capabilityResolutionJson: JSON.stringify({
        brokerHello: detail['brokerCapabilities'],
        invocation: response.capabilities,
        result: { status: 'reject', missing: detail['missing'] },
      }),
    })
    if (runId !== undefined) {
      this.db.runs.markCompleted(runId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage: message,
      })
    }
    this.db.runtimes.update(runtimeId, {
      status: 'failed',
      activeInvocationId: invocationId,
      activeOperationId: operationId,
      activeRunId: runId,
      lastActivityAt: now,
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId,
        hostSessionId: String(identity.hostSessionId),
        generation: identity.generation,
        status: 'failed',
        admissionFailure: detail,
        updatedAt: now,
      },
      updatedAt: now,
    })
  }

  private async handlePermissionRequest(
    request: PermissionRequestParams
  ): Promise<PermissionDecision> {
    if (this.permissionChannel) {
      return this.permissionChannel.request(request)
    }

    const now = this.now()
    const invocation = this.db.brokerInvocations.getByInvocationId(request.invocationId)
    if (invocation) {
      this.insertPermissionDecisionIfAbsent({
        permissionRequestId: request.permissionRequestId,
        invocationId: request.invocationId,
        runtimeId: invocation.runtimeId,
        ...(invocation.runId !== undefined ? { runId: invocation.runId } : {}),
        kind: request.kind,
        subjectDisplayJson: JSON.stringify(request.subject ?? null),
        defaultDecision: request.defaultDecision ?? 'deny',
        decision: 'deny',
        decidedBy: 'policy',
        policyJson: JSON.stringify({
          mode: 'deny',
          reason: 'no HRC permission request channel configured',
        }),
        requestedAt: now,
        decidedAt: now,
      })
    }

    return {
      decision: 'deny',
      message: 'Denied by HRC policy: no permission request channel is configured.',
    }
  }

  private insertPermissionDecisionIfAbsent(record: HrcPermissionDecisionRecord): void {
    if (this.db.permissionDecisions.getByPermissionRequestId(record.permissionRequestId)) {
      return
    }
    this.db.permissionDecisions.insert(record)
  }

  private consumeEvents(runtimeId: string, events: AsyncIterable<InvocationEventEnvelope>): void {
    void (async () => {
      try {
        for await (const envelope of events) {
          const invocation = this.db.brokerInvocations.getByInvocationId(
            String(envelope.invocationId)
          )
          if (!invocation || invocation.runtimeId !== runtimeId) {
            this.logger.warn?.('dropped broker event for non-consuming runtime', {
              runtimeId,
              invocationId: String(envelope.invocationId),
              invocationRuntimeId: invocation?.runtimeId,
              eventType: envelope.type,
              seq: envelope.seq,
            })
            continue
          }
          const result = this.mapper.apply(envelope)
          this.afterMappedEvent(runtimeId, envelope, result)
        }
      } catch (error) {
        const controllerError = toControllerError('broker_event_consumer_failed', error)
        this.logger.error?.('harness broker event consumer failed', {
          runtimeId,
          error: controllerError.message,
        })
        this.markBrokerCrashTerminal(runtimeId, controllerError)
      }
    })()
  }

  private afterMappedEvent(
    runtimeId: string,
    envelope: InvocationEventEnvelope,
    result: BrokerProjectionResult
  ): void {
    if (!result.idempotent) {
      this.db.brokerInvocations.update(envelope.invocationId, {
        lastEventSeq: envelope.seq,
        updatedAt: this.now(),
      })
    }

    // Record the broker-pushed graceful-exit summary durably on the runtime so the
    // operator shutdown report (hrc run, after the /quit detach) reads a recorded
    // snapshot rather than pulling the live broker read model — which is gone once
    // the lease is reaped. The broker pushes this on the SAME ordered stream just
    // after the user-exit continuation.cleared, so it lands before teardown.
    if (envelope.type === 'invocation.summary') {
      const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
      if (runtime) {
        this.db.runtimes.update(runtimeId, {
          runtimeStateJson: {
            ...(runtime.runtimeStateJson ?? {}),
            finalSummary: envelope.payload,
          },
          updatedAt: this.now(),
        })
      }
    }

    if (envelope.type === 'invocation.exited' || envelope.type === 'invocation.failed') {
      this.markBrokerInvocationTerminal(runtimeId, envelope, result)
    }

    if (envelope.type === 'invocation.exited' || envelope.type === 'invocation.disposed') {
      void this.agentchat?.deregisterInvocation?.({
        runtimeId,
        invocationId: envelope.invocationId,
        reason: envelope.type,
      })
    }

    // Lever 2 graceful exit — PRIMARY hook. On an interactive /quit a DURABLE
    // broker stays alive (no `invocation.exited`, no socket close): the only live
    // terminal signal is a `continuation.cleared` carrying a prompt-exit reason,
    // delivered here through the event consumer. Tear the broker-tmux lease down
    // now so the operator is detached promptly instead of being left on a live
    // broker pane until the next on-demand reconcile. Gated to LEAVING reasons so
    // a `/clear` (which keeps the session) never reaps a live runtime.
    if (envelope.type === 'continuation.cleared') {
      const reason = (envelope.payload as { reason?: string } | undefined)?.reason
      if (reason !== undefined && BROKER_TMUX_PROMPT_EXIT_REASONS.has(reason)) {
        this.logger.info?.('broker-tmux prompt exit; reaping lease', { runtimeId, reason })
        this.fireBrokerTmuxLeaseReap(runtimeId, `prompt_exit:${reason}`)
      }
    }
  }

  private resolveAttachInvocation(
    runtime: HrcRuntimeSnapshot | null,
    runtimeId: string
  ): HrcBrokerInvocationRecord | null {
    if (runtime?.activeInvocationId) {
      const active = this.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
      if (active) {
        return active
      }
    }
    return this.db.brokerInvocations.listByRuntimeId(runtimeId).at(-1) ?? null
  }

  private lastProjectedBrokerSeq(invocationId: string): number {
    return this.db.brokerInvocationEvents
      .listByInvocationId(invocationId)
      .filter((event: HrcBrokerInvocationEventRecord) => event.projectionStatus === 'applied')
      .reduce((max, event) => Math.max(max, event.seq), 0)
  }

  private async failReplayStale(
    runtime: HrcRuntimeSnapshot,
    invocation: HrcBrokerInvocationRecord,
    client: DurableBrokerClientLike,
    error: BrokerControllerError
  ): Promise<void> {
    this.active.delete(runtime.runtimeId)
    this.markBrokerClosing(runtime.runtimeId, error.code)
    const now = this.now()
    this.db.brokerInvocations.update(invocation.invocationId, {
      invocationState: 'failed',
      ownerServerInstanceId: this.serverInstanceId,
      updatedAt: now,
    })
    this.db.runtimes.update(runtime.runtimeId, {
      status: 'stale',
      lastActivityAt: now,
      runtimeStateJson: {
        ...(runtime.runtimeStateJson ?? {}),
        status: 'stale',
        updatedAt: now,
        control: {
          mode: 'broker-ipc',
          brokerAttached: false,
          lastAttachError: {
            code: error.code,
            message: error.message,
            detail: error.detail,
          },
        },
      },
      updatedAt: now,
    })
    await client.close().catch((closeError: unknown) => {
      this.logger.warn?.('harness broker close after replay failure failed', {
        runtimeId: runtime.runtimeId,
        invocationId: invocation.invocationId,
        error: closeError instanceof Error ? closeError.message : String(closeError),
      })
    })
  }

  private markBrokerInvocationTerminal(
    runtimeId: string,
    envelope: InvocationEventEnvelope,
    result: BrokerProjectionResult
  ): void {
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime || runtime.activeInvocationId !== String(envelope.invocationId)) {
      return
    }
    if (
      runtime.status === 'terminated' ||
      runtime.status === 'dead' ||
      runtime.status === 'stale'
    ) {
      return
    }

    const now = this.now()
    const invocation = this.db.brokerInvocations.getByInvocationId(String(envelope.invocationId))
    const runId = invocation?.runId ?? runtime.activeRunId
    const userExitReason =
      envelope.type === 'invocation.exited'
        ? this.findUserInitiatedContinuationClearReason(String(envelope.invocationId), envelope.seq)
        : undefined
    const terminalStatus = userExitReason !== undefined ? 'terminated' : 'stale'
    const terminalEventKind = userExitReason !== undefined ? 'runtime.terminated' : 'runtime.stale'
    const terminalReason =
      userExitReason !== undefined ? 'user_initiated_session_end' : 'broker_invocation_terminal'
    if (runtime.activeRunId !== undefined) {
      const activeRun = this.db.runs.getByRunId(runtime.activeRunId)
      if (activeRun && isActiveBrokerRun(activeRun)) {
        this.db.runs.markCompleted(activeRun.runId, {
          status: 'failed',
          completedAt: now,
          updatedAt: now,
          errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
          errorMessage:
            userExitReason !== undefined
              ? `broker invocation ${String(envelope.invocationId)} ended by user request (${userExitReason})`
              : `broker invocation ${String(envelope.invocationId)} reached terminal state ${envelope.type}`,
        })
      }
      this.db.runtimes.updateRunId(runtimeId, undefined, now)
    }
    this.db.runtimes.update(runtimeId, {
      status: terminalStatus,
      lastActivityAt: now,
      updatedAt: now,
      runtimeStateJson: {
        ...(runtime.runtimeStateJson ?? {}),
        status: terminalStatus,
        updatedAt: now,
        terminalReason,
        ...(userExitReason !== undefined ? { userExitReason } : {}),
        terminalInvocation: {
          invocationId: String(envelope.invocationId),
          eventType: envelope.type,
          seq: envelope.seq,
        },
      },
    })

    if (!result.idempotent) {
      appendHrcEvent(this.db, terminalEventKind, {
        ts: now,
        hostSessionId: runtime.hostSessionId,
        scopeRef: runtime.scopeRef,
        laneRef: runtime.laneRef,
        generation: runtime.generation,
        runtimeId,
        ...(runId !== undefined ? { runId } : {}),
        ...(runtime.transport === 'headless' || runtime.transport === 'tmux'
          ? { transport: runtime.transport }
          : {}),
        payload: {
          reason: terminalReason,
          ...(userExitReason !== undefined ? { userExitReason } : {}),
          invocationId: String(envelope.invocationId),
          eventType: envelope.type,
          seq: envelope.seq,
        },
      })
    }

    const active = this.active.get(runtimeId)
    if (active?.invocationId === String(envelope.invocationId)) {
      this.markBrokerClosing(runtimeId, 'broker_invocation_terminal')
      this.active.delete(runtimeId)
      void active.client.close().catch((error) => {
        this.logger.warn?.('harness broker close after terminal invocation failed', {
          runtimeId,
          invocationId: String(envelope.invocationId),
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }

    // Lever 2 graceful exit (defensive — secondary to the continuation.cleared
    // hook): if a /quit DOES surface as a clean invocation.exited, the durable
    // unix broker survives the client close above by design, so tear the lease
    // down here too. Deduped against the continuation-clear reap. Gated on
    // userExitReason so crashes / idle-ttl terminals keep durability for reattach.
    if (userExitReason !== undefined) {
      this.fireBrokerTmuxLeaseReap(runtimeId, 'invocation_exited')
    }
  }

  private findUserInitiatedContinuationClearReason(
    invocationId: string,
    beforeSeq: number
  ): string | undefined {
    const row = this.db.sqlite
      .query<{ reason: string | null }, [string, number]>(
        `SELECT json_extract(broker_event_json, '$.reason') AS reason
           FROM broker_invocation_events
          WHERE invocation_id = ? AND type = 'continuation.cleared' AND seq < ?
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(invocationId, beforeSeq)
    return row?.reason && USER_INITIATED_CONTINUATION_CLEAR_REASONS.has(row.reason)
      ? row.reason
      : undefined
  }

  /**
   * Latest continuation.cleared reason for a runtime's active invocation, when it
   * is a user-initiated /quit class reason. Runtime-scoped variant of
   * {@link findUserInitiatedContinuationClearReason} (which is invocation+seq
   * scoped) — used on the close path where there is no terminal envelope/seq.
   */
  private findUserInitiatedContinuationClearReasonForRuntime(
    runtimeId: string
  ): string | undefined {
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    const invocationId = runtime?.activeInvocationId
    if (invocationId === undefined) {
      return undefined
    }
    const row = this.db.sqlite
      .query<{ reason: string | null }, [string]>(
        `SELECT json_extract(broker_event_json, '$.reason') AS reason
           FROM broker_invocation_events
          WHERE invocation_id = ? AND type = 'continuation.cleared'
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(invocationId)
    return row?.reason && USER_INITIATED_CONTINUATION_CLEAR_REASONS.has(row.reason)
      ? row.reason
      : undefined
  }

  /**
   * Fire the broker-tmux lease reap once per runtime. A single /quit surfaces as
   * up to three user-exit signals (continuation clear → invocation.exited and/or
   * broker close); this dedupes them so the lease is torn down exactly once. The
   * reap itself (kill lease + mark terminated) is idempotent, so the guard is an
   * efficiency/cleanliness measure, not a correctness gate.
   */
  private fireBrokerTmuxLeaseReap(runtimeId: string, reason: string): void {
    if (!this.reapBrokerTmuxLease || this.reapedBrokerTmuxRuntimeIds.has(runtimeId)) {
      return
    }
    this.reapedBrokerTmuxRuntimeIds.add(runtimeId)
    void this.reapBrokerTmuxLease(runtimeId).catch((error) => {
      this.logger.warn?.('broker tmux lease reap failed', {
        runtimeId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private handleBrokerClose(runtimeId: string, error: Error): void {
    const active = this.active.get(runtimeId)
    const intentionalReason =
      active?.closing === true
        ? (active.closeReason ?? this.intentionalClosingRuntimeIds.get(runtimeId))
        : this.intentionalClosingRuntimeIds.get(runtimeId)
    if (intentionalReason) {
      this.logger.info?.('harness broker process closed intentionally', {
        runtimeId,
        reason: intentionalReason,
        error: error.message,
      })
      this.active.delete(runtimeId)
      this.intentionalClosingRuntimeIds.delete(runtimeId)
      return
    }
    // T-01801: a `control.fenced` close means a NEWER controller legitimately
    // re-attached (e.g. a fresh-on-boot reconcile attach superseded by the live
    // request-serving controller on the first post-restart dispatch). This
    // controller LOST ownership; it must release SILENTLY and must NOT mark the
    // runtime crash-terminal — the runtime/run state in the shared DB is now
    // owned by the winning controller, and crashing it here corrupts an active
    // turn that is succeeding on the new attach.
    if (isControllerFencedError(error)) {
      this.logger.info?.('harness broker controller fenced by a newer attach; releasing', {
        runtimeId,
        error: error.message,
      })
      this.active.delete(runtimeId)
      return
    }
    // Lever 2 graceful exit: an interactive /quit typically tears the broker IPC
    // socket down (rather than emitting a clean `invocation.exited`), surfacing
    // here as a non-intentional close. When the runtime carries a user-initiated
    // continuation clear, this is a graceful operator exit — NOT a crash. Reconcile
    // the lease liveness (mark terminated + kill the lease server) so the operator
    // is detached promptly, and avoid the alarming crash-terminal classification.
    const userExitReason = this.findUserInitiatedContinuationClearReasonForRuntime(runtimeId)
    if (
      userExitReason !== undefined &&
      (this.reconcileBrokerTmuxLivenessOnClose || this.reapBrokerTmuxLease)
    ) {
      this.logger.info?.('harness broker closed after user-initiated exit; reaping lease', {
        runtimeId,
        userExitReason,
        error: error.message,
      })
      this.active.delete(runtimeId)
      this.intentionalClosingRuntimeIds.delete(runtimeId)
      if (this.reconcileBrokerTmuxLivenessOnClose) {
        void this.reconcileBrokerTmuxLivenessOnClose(runtimeId).catch((reapError) => {
          this.logger.warn?.('broker tmux close-path reconcile after user exit failed', {
            runtimeId,
            userExitReason,
            error: reapError instanceof Error ? reapError.message : String(reapError),
          })
        })
      } else {
        this.fireBrokerTmuxLeaseReap(runtimeId, 'broker_close')
      }
      return
    }
    this.logger.error?.('harness broker process closed', {
      runtimeId,
      error: error.message,
    })
    this.markBrokerCrashTerminal(runtimeId, toControllerError('broker_process_closed', error))
  }

  private markBrokerClosing(runtimeId: string, reason: string): void {
    this.intentionalClosingRuntimeIds.set(runtimeId, reason)
    const active = this.active.get(runtimeId)
    if (active) {
      active.closing = true
      active.closeReason = reason
    }
  }

  private markBrokerCrashTerminal(runtimeId: string, error: BrokerControllerError): void {
    this.active.delete(runtimeId)
    const now = this.now()
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    const invocation =
      runtime?.activeInvocationId !== undefined
        ? this.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
        : this.db.brokerInvocations.listByRuntimeId(runtimeId).at(-1)

    if (invocation) {
      this.db.brokerInvocations.update(invocation.invocationId, {
        invocationState: 'failed',
        updatedAt: now,
      })
      if (invocation.runId !== undefined) {
        this.db.runs.markCompleted(invocation.runId, {
          status: 'failed',
          completedAt: now,
          updatedAt: now,
          errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
          errorMessage: error.message,
        })
      }
      this.db.runtimeOperations.update(invocation.operationId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: error.code,
        errorMessage: error.message,
      })
    }

    if (runtime) {
      this.db.runtimes.update(runtimeId, {
        status: 'terminated',
        lastActivityAt: now,
        runtimeStateJson: {
          ...(runtime.runtimeStateJson ?? {}),
          status: 'terminated',
          updatedAt: now,
          brokerCrash: {
            code: error.code,
            message: error.message,
            detail: error.detail,
          },
        },
        updatedAt: now,
      })
      this.db.events.append({
        ts: now,
        hostSessionId: runtime.hostSessionId,
        scopeRef: runtime.scopeRef,
        laneRef: runtime.laneRef,
        generation: runtime.generation,
        ...(invocation?.runId !== undefined ? { runId: invocation.runId } : {}),
        runtimeId,
        source: 'broker',
        eventKind: 'broker.process.closed',
        eventJson: {
          code: error.code,
          message: error.message,
          detail: error.detail,
        },
      })
    }
  }

  private notActive(runtimeId: string): BrokerControllerError {
    return new BrokerControllerError(
      'broker_runtime_not_active',
      `no active broker client for runtime ${runtimeId}`
    )
  }
}

function isActiveBrokerRun(run: HrcRunRecord): boolean {
  return run.status === 'accepted' || run.status === 'started' || run.status === 'running'
}

function compactEnv(
  env: Record<string, string | undefined> | undefined
): Record<string, string> | undefined {
  if (!env) {
    return undefined
  }
  const compact: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      compact[key] = value
    }
  }
  return compact
}

/**
 * True iff a broker close error is the `control.fenced` signal (a newer
 * controller re-attached and superseded this one). The unix transport surfaces
 * it as a `BrokerRpcError` carrying `BrokerErrorCode.ControllerFenced`.
 */
function isControllerFencedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === BrokerErrorCode.ControllerFenced
  )
}

/**
 * True when a durable-broker Unix dial failed because the broker had not bound
 * its listener YET (T-02009 boot race) — safe to retry. The broker client wraps
 * the node socket error in a `BrokerTransportError` carrying the original error
 * on `.causeError`; we read that node `.code`. A connect timeout (the broker is
 * mid-bind) is also retryable.
 */
function isBrokerSocketNotReadyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const causeCode = (error as { causeError?: { code?: unknown } }).causeError?.code
  if (typeof causeCode === 'string' && BROKER_UNIX_CONNECT_RETRYABLE_CODES.has(causeCode)) {
    return true
  }
  // Fallback to the node error's own code when it surfaces directly, and to the
  // transport's timeout message ("Timed out connecting to broker unix socket").
  const directCode = (error as { code?: unknown }).code
  if (typeof directCode === 'string' && BROKER_UNIX_CONNECT_RETRYABLE_CODES.has(directCode)) {
    return true
  }
  const message = error instanceof Error ? error.message : ''
  return message.includes('Timed out connecting to broker unix socket')
}

function toControllerError(code: string, error: unknown): BrokerControllerError {
  if (error instanceof BrokerControllerError) {
    return error
  }
  if (error instanceof Error) {
    return new BrokerControllerError(code, error.message, { name: error.name })
  }
  return new BrokerControllerError(code, String(error))
}

/**
 * T-01855 tri-state liveness gate. A live probe is permitted only when the broker
 * advertises `liveness: 'probe'`, OR advertises no inspection block at all (older
 * broker — pass the caller's flag through and let the broker ignore what it does
 * not support). An explicit `'cached'`/`'none'` forbids the probe.
 */
function livenessProbeAllowed(
  inspection: BrokerInspectionCapabilities | undefined
): boolean {
  return inspection === undefined || inspection.liveness === 'probe'
}

/**
 * T-01855 — best-effort rehydration of the broker inspection capabilities from
 * persisted runtime state, used on durable reattach (which rebuilds the active
 * record without a fresh hello). Returns `undefined` when nothing valid is
 * persisted, which the inspection RPCs treat as an older/uninspectable broker.
 */
function rehydrateInspectionCapabilities(
  runtimeStateJson: Record<string, unknown> | null | undefined
): BrokerInspectionCapabilities | undefined {
  const broker = runtimeStateJson?.['broker']
  if (typeof broker !== 'object' || broker === null) {
    return undefined
  }
  const inspection = (broker as Record<string, unknown>)['inspection']
  if (typeof inspection !== 'object' || inspection === null) {
    return undefined
  }
  const candidate = inspection as Record<string, unknown>
  if (
    typeof candidate['listInvocations'] !== 'boolean' ||
    typeof candidate['timestamps'] !== 'boolean' ||
    typeof candidate['lifecycleView'] !== 'boolean' ||
    typeof candidate['eventTypeFilter'] !== 'boolean' ||
    (candidate['liveness'] !== 'none' &&
      candidate['liveness'] !== 'cached' &&
      candidate['liveness'] !== 'probe')
  ) {
    return undefined
  }
  return inspection as BrokerInspectionCapabilities
}
