import { chmod, mkdir, writeFile } from 'node:fs/promises'

import { dirname, join } from 'node:path'

import type {
  BrokerTmuxAllocation,
  BrokerTmuxAllocator,
  BrokerTmuxLease,
  BrokerWindowIdentity,
} from '../broker/controller.js'
import type {
  BrokerRuntimeEndpoint,
  BrokerRuntimePresentation,
  BrokerRuntimeSubstrate,
} from '../broker/runtime-hosting.js'
import type { HrcServerOptions } from '../server-types.js'
import { timestamp } from '../server-util.js'
import {
  getBrokerIpcSocketPath,
  getBrokerObserverSocketPath,
  getBrokerTmuxSocketPath,
  preflightBrokerIpcSocketPath,
} from '../tmux-socket.js'

/**
 * A named-window tmux manager sufficient for the durable broker allocator: it
 * hosts a 'broker' window (launched exec-form with the harness-broker Unix
 * command) and an idempotent 'tui' lease window under ONE per-runtime socket.
 */
export type DurableTmuxManagerLike = {
  initialize(): Promise<void>
  createWindowWithCommand(input: {
    sessionName: string
    windowName: string
    command: string
  }): Promise<BrokerWindowIdentity>
  createOrInspectWindow(input: {
    sessionName: string
    windowName: string
  }): Promise<BrokerWindowIdentity>
  inspectPaneProcess?(
    paneId: string
  ): Promise<{ command: string; pid: number; dead: boolean } | null>
  waitForAttachedClient?(
    target: string,
    options?: {
      timeoutMs?: number | undefined
      intervalMs?: number | undefined
      activeWindowId?: string | undefined
      activeWindowName?: string | undefined
    }
  ): Promise<void>
}

export type BrokerDurableTmuxAllocatorDeps = {
  tmuxManagerFactory: (opts: { socketPath: string }) => DurableTmuxManagerLike
  generateAttachToken: () => string
  now?: () => string
}

/**
 * T-01868 Ph2 — the SUBSTRATE+PRESENTATION-axis allocation primitive.
 *
 * Carves the per-runtime broker SUBSTRATE (a leased btmux server/session hosting
 * a 'broker' window launched EXEC-FORM with `harness-broker … --transport unix
 * <ipcSocket>`, an owner-only 0700 broker-IPC dir, an attach token referenced
 * redacted, and an event ledger), the durable ENDPOINT (unix-jsonrpc-ndjson), and
 * — conditioned on `presentation` — the PRESENTATION:
 *   - presentation='tmux-tui' adds the 'tui' window + operator attach command,
 *     reproducing TODAY's interactive allocation EXACTLY.
 *   - presentation='none' creates NO TUI window and NO attach command (headless
 *     substrate). This arm is wired in code but not yet selected by any route
 *     (headless cutover is Ph3).
 *
 * Returns the canonical {endpoint, substrate, presentation} hosting-state axes
 * plus the in-process extras the legacy flat BrokerTmuxAllocation needs (raw
 * attach token, the TUI pane lease, broker pid/command). The sockaddr_un HARD
 * preflight runs BEFORE any tmux spawn (T-01776) so an over-long path fails early
 * with a readable error, never a later bind/connect errno.
 */
export type BrokerSubstratePresentationKind = BrokerRuntimePresentation['kind']

export type AllocateBrokerSubstrateInput = {
  runtimeId: string
  hostSessionId: string
  generation: number
  driverKind: string
  endpoint: 'unix-jsonrpc-ndjson'
  presentation: BrokerSubstratePresentationKind
  /**
   * T-04921 (T-04905 Phase A) — when set, the broker is launched with
   * `--experimental-observer-socket <path>` so it SERVES a read-only observer
   * socket at this HRC-selected path, and the path is echoed back on the
   * allocation for the dispatch env (HARNESS_BROKER_OBSERVER_SOCKET). HRC owns
   * ONE path for both, never two independent derivations.
   */
  observerSocketPath?: string | undefined
}

export type BrokerSubstrateAllocation = {
  endpoint: BrokerRuntimeEndpoint
  /** Always a leased-tmux substrate (the broker process pane). */
  substrate: Extract<BrokerRuntimeSubstrate, { kind: 'leased-tmux' }>
  presentation: BrokerRuntimePresentation
  // ── in-process extras for the legacy flat BrokerTmuxAllocation mapping ──
  allocatedAt: string
  /** Raw attach-token secret — used in-process only, NEVER persisted. */
  attachToken: string
  brokerCommand: string
  /**
   * T-04921 — the HRC-owned read-only observer socket path the broker SERVES
   * (present only when `observerSocketPath` was requested). Echoed onto the
   * dispatch env (HARNESS_BROKER_OBSERVER_SOCKET) so the renderer connects to the
   * SAME path the broker launch command carries.
   */
  observerSocketPath?: string | undefined
  brokerPid?: number | undefined
  /** Full broker-window identity (incl. socket/session/window names). */
  brokerWindow: BrokerWindowIdentity
  /** Present only for presentation='tmux-tui'. */
  tuiWindow?: BrokerWindowIdentity | undefined
  /** The TUI pane lease handed to runtime.terminalSurface (tmux-tui only). */
  tuiLease?: BrokerTmuxLease | undefined
}

export async function allocateBrokerSubstrate(
  options: Pick<HrcServerOptions, 'runtimeRoot'>,
  deps: BrokerDurableTmuxAllocatorDeps,
  input: AllocateBrokerSubstrateInput
): Promise<BrokerSubstrateAllocation> {
  const now = deps.now ?? timestamp
  const { runtimeId, hostSessionId, generation, driverKind, presentation } = input

  const brokerIpcSocketPath = getBrokerIpcSocketPath(options, driverKind, runtimeId)
  // HARD preflight BEFORE any tmux spawn / IPC dir creation: an over-long
  // sockaddr_un path fails EARLY with a readable error, never a later
  // bind/connect errno.
  preflightBrokerIpcSocketPath(brokerIpcSocketPath)

  const btmuxSocketPath = getBrokerTmuxSocketPath(
    options as HrcServerOptions,
    driverKind,
    runtimeId
  )
  const ipcDir = dirname(brokerIpcSocketPath)
  await mkdir(dirname(btmuxSocketPath), { recursive: true })
  // Owner-only broker IPC dir (0700). mkdir mode is umask-masked, so chmod the
  // leaf explicitly to guarantee rwx------.
  await mkdir(ipcDir, { recursive: true, mode: 0o700 })
  await chmod(ipcDir, 0o700)

  // Allocate the attach token and persist it by REFERENCE (owner-only file). The
  // raw secret never enters runtime_state_json — only the redacted ref.
  const attachToken = deps.generateAttachToken()
  const attachTokenPath = join(ipcDir, 'attach.token')
  await writeFile(attachTokenPath, attachToken, { mode: 0o600 })

  const tmux = deps.tmuxManagerFactory({ socketPath: btmuxSocketPath })
  await tmux.initialize()

  const sessionName = `hrc-${driverKind}-${runtimeId}`
  // T-01801: wire the broker's durability surface so attach-replay across a daemon
  // restart works. WITHOUT `--event-ledger` the broker still advertises
  // attachReplay:true but has no on-disk ledger, so the post-restart
  // `invocation.eventsSince` replay fails ('no durable ledger configured') and the
  // runtime goes stale. The attach-identity flags (runtime/host-session/generation
  // + token file) arm the broker's latest-valid-attach-wins gate so it validates
  // the controller's attach token instead of accepting any peer.
  const eventLedgerPath = join(ipcDir, 'events.ndjson')
  // T-04921 — when an observer socket path is requested, the broker is launched
  // with `--experimental-observer-socket <path>` so it actually SERVES the
  // read-only observer socket (an env var alone is insufficient — the broker
  // must be told to serve it). HRC passes ONE path here and on the dispatch env.
  const observerSocketPath = input.observerSocketPath
  // T-04928 — capture the broker child's stderr to a per-runtime log. The broker
  // otherwise runs in a tmux pane whose output is lost when the process exits, so
  // a broker crash (e.g. "Broker socket closed unexpectedly") leaves no diagnosable
  // trace. Redirecting fd2 BEFORE the shell `exec`s into the broker preserves the
  // crash/panic output across the exec into this file.
  const brokerStderrPath = join(ipcDir, 'broker.err')
  const brokerCommand =
    `exec harness-broker run --transport unix --socket ${brokerIpcSocketPath}` +
    ` --event-ledger ${eventLedgerPath}` +
    ` --runtime-id ${runtimeId}` +
    ` --host-session-id ${hostSessionId}` +
    ` --generation ${generation}` +
    ` --attach-token-file ${attachTokenPath}` +
    (observerSocketPath ? ` --experimental-observer-socket ${observerSocketPath}` : '') +
    ` 2>${brokerStderrPath}`
  const brokerWindow = await tmux.createWindowWithCommand({
    sessionName,
    windowName: 'broker',
    command: brokerCommand,
  })

  // presentation='tmux-tui' adds the operator TUI window; presentation='none'
  // (headless substrate) creates no TUI window. Window-creation order (broker then
  // tui) is preserved from the pre-split allocator.
  const tuiWindow =
    presentation === 'tmux-tui'
      ? await tmux.createOrInspectWindow({ sessionName, windowName: 'tui' })
      : undefined

  // Capture the broker pane's running pid for persisted identity (best effort —
  // pane ids alone are known weak; the pid/command corroborate).
  let brokerPid: number | undefined
  if (typeof tmux.inspectPaneProcess === 'function') {
    const proc = await tmux.inspectPaneProcess(brokerWindow.paneId)
    if (proc && !proc.dead && proc.pid > 0) {
      brokerPid = proc.pid
    }
  }

  const endpoint: BrokerRuntimeEndpoint = {
    kind: 'unix-jsonrpc-ndjson',
    socketPath: brokerIpcSocketPath,
    attachTokenRef: { kind: 'file', path: attachTokenPath, redacted: true },
    protocolVersion: 'harness-broker/0.2',
  }
  const substrate: Extract<BrokerRuntimeSubstrate, { kind: 'leased-tmux' }> = {
    kind: 'leased-tmux',
    tmuxSocketPath: btmuxSocketPath,
    sessionName,
    brokerWindow: {
      sessionId: brokerWindow.sessionId,
      windowId: brokerWindow.windowId,
      paneId: brokerWindow.paneId,
    },
    generation,
    eventLedgerPath,
  }

  const base = {
    endpoint,
    substrate,
    allocatedAt: now(),
    attachToken,
    brokerCommand,
    ...(observerSocketPath !== undefined ? { observerSocketPath } : {}),
    ...(brokerPid !== undefined ? { brokerPid } : {}),
    brokerWindow,
  }

  if (!tuiWindow) {
    return { ...base, presentation: { kind: 'none' } }
  }

  // The lease handed to runtime.terminalSurface is the TUI pane (operators attach
  // here) — NEVER the broker pane.
  const tuiLease: BrokerTmuxLease = {
    kind: 'tmux-pane',
    ownership: 'hrc',
    socketPath: tuiWindow.socketPath,
    sessionId: tuiWindow.sessionId,
    windowId: tuiWindow.windowId,
    paneId: tuiWindow.paneId,
    sessionName: tuiWindow.sessionName,
    windowName: tuiWindow.windowName,
    allowedOps: {
      inspect: true,
      sendInput: true,
      sendInterrupt: true,
      capture: true,
      resize: false,
    },
  }
  return {
    ...base,
    presentation: {
      kind: 'tmux-tui',
      tuiWindow: {
        sessionId: tuiWindow.sessionId,
        windowId: tuiWindow.windowId,
        paneId: tuiWindow.paneId,
      },
      operatorAttachTarget: true,
      attachCommand: `tmux -S ${btmuxSocketPath} attach -t ${sessionName}:tui`,
    },
    tuiWindow,
    tuiLease,
  }
}

/**
 * Thrown when a `presentation='tmux-tui'` {@link BrokerSubstrateAllocation} is
 * missing — or carries a partial — TUI window / lease that the tmux-tui contract
 * guarantees to be COMPLETE. This is an INTERNAL invariant break in
 * {@link allocateBrokerSubstrate} (a code regression making the value partial),
 * never a user/input error. T-04755 replaced the prior `as BrokerWindowIdentity`
 * / `as BrokerTmuxLease` casts — which would have silently passed a partial value
 * downstream — with this fail-fast validation.
 */
export class BrokerTuiAllocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrokerTuiAllocationError'
  }
}

/**
 * Validate-and-narrow `sub.tuiWindow` to a COMPLETE {@link BrokerWindowIdentity}.
 * For `presentation='tmux-tui'` the allocator always produces all 6 string fields
 * (smokey char-test, T-04755); this asserts that invariant at runtime instead of
 * trusting an unchecked `as` cast. Throws {@link BrokerTuiAllocationError} on a
 * genuinely-missing/empty field (a latent regression upstream).
 */
function assertCompleteBrokerWindowIdentity(
  value: BrokerWindowIdentity | undefined,
  label: string
): asserts value is BrokerWindowIdentity {
  if (!value) {
    throw new BrokerTuiAllocationError(
      `${label}: expected a complete BrokerWindowIdentity for presentation='tmux-tui', got ${value}`
    )
  }
  for (const field of [
    'socketPath',
    'sessionId',
    'windowId',
    'paneId',
    'sessionName',
    'windowName',
  ] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new BrokerTuiAllocationError(`${label}: missing/empty required field '${field}'`)
    }
  }
}

/**
 * Validate-and-narrow `sub.tuiLease` to a COMPLETE {@link BrokerTmuxLease}. The
 * tmux-tui allocator builds this lease as a complete literal (kind='tmux-pane',
 * ownership='hrc', the four tmux ids, and the canonical capability ops). Asserts
 * that shape at runtime in place of the prior unchecked `as` cast; throws
 * {@link BrokerTuiAllocationError} on any missing discriminant/field/capability.
 */
function assertCompleteBrokerTmuxLease(
  value: BrokerTmuxLease | undefined,
  label: string
): asserts value is BrokerTmuxLease {
  if (!value) {
    throw new BrokerTuiAllocationError(
      `${label}: expected a complete BrokerTmuxLease for presentation='tmux-tui', got ${value}`
    )
  }
  if (value.kind !== 'tmux-pane') {
    throw new BrokerTuiAllocationError(
      `${label}: expected kind='tmux-pane', got '${String(value.kind)}'`
    )
  }
  if (value.ownership !== 'hrc') {
    throw new BrokerTuiAllocationError(
      `${label}: expected ownership='hrc', got '${String(value.ownership)}'`
    )
  }
  for (const field of ['socketPath', 'sessionId', 'windowId', 'paneId'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new BrokerTuiAllocationError(`${label}: missing/empty required field '${field}'`)
    }
  }
  const ops = value.allowedOps
  if (!ops || ops.inspect !== true || ops.sendInput !== true || ops.sendInterrupt !== true) {
    throw new BrokerTuiAllocationError(
      `${label}: allowedOps must grant inspect/sendInput/sendInterrupt`
    )
  }
}

/**
 * Project the SUBSTRATE/ENDPOINT axes of a {@link BrokerSubstrateAllocation} down
 * to the fields BOTH durable adapters map identically into the legacy flat
 * {@link BrokerTmuxAllocation}. The tmux adapter appends the TUI lease + window +
 * legacy single-pane mirror; the headless adapter uses this base unchanged. The
 * conditional `attachTokenRef`/`brokerPid` spreads are preserved exactly (never
 * materialised as `undefined`) so the persisted shape is byte-identical.
 */
function projectBaseAllocation(sub: BrokerSubstrateAllocation): BrokerTmuxAllocation {
  return {
    socketPath: sub.substrate.tmuxSocketPath,
    allocatedAt: sub.allocatedAt,
    generation: sub.substrate.generation,
    brokerIpcSocketPath: sub.endpoint.kind === 'unix-jsonrpc-ndjson' ? sub.endpoint.socketPath : '',
    attachToken: sub.attachToken,
    ...(sub.endpoint.kind === 'unix-jsonrpc-ndjson'
      ? { attachTokenRef: sub.endpoint.attachTokenRef }
      : {}),
    brokerCommand: sub.brokerCommand,
    ...(sub.observerSocketPath !== undefined ? { observerSocketPath: sub.observerSocketPath } : {}),
    ...(sub.brokerPid !== undefined ? { brokerPid: sub.brokerPid } : {}),
    brokerWindow: sub.brokerWindow,
  }
}

/**
 * T-01812 Phase 3 — durable interactive broker allocator. A thin adapter over
 * {@link allocateBrokerSubstrate} with presentation='tmux-tui': it reproduces
 * today's two-window interactive allocation (broker window over Unix IPC + TUI
 * pane lease) and maps the substrate/presentation axes back to the legacy flat
 * BrokerTmuxAllocation the controller persists. The controller dials
 * `brokerIpcSocketPath` via connectUnix.
 */
export function createBrokerDurableTmuxAllocator(
  options: Pick<HrcServerOptions, 'runtimeRoot'>,
  deps: BrokerDurableTmuxAllocatorDeps
): BrokerTmuxAllocator {
  return {
    allocate: async ({
      runtimeId,
      hostSessionId,
      brokerDriver,
      generation,
    }): Promise<BrokerTmuxAllocation> => {
      const sub = await allocateBrokerSubstrate(options, deps, {
        runtimeId,
        hostSessionId,
        generation,
        driverKind: brokerDriver,
        endpoint: 'unix-jsonrpc-ndjson',
        presentation: 'tmux-tui',
      })
      // tmux-tui always yields a COMPLETE TUI window + lease; validate-and-narrow
      // the optional fields at runtime (fail-fast on a latent partial) rather than
      // trusting an unchecked `as` cast (T-04755).
      const tuiWindow = sub.tuiWindow
      const lease = sub.tuiLease
      assertCompleteBrokerWindowIdentity(tuiWindow, 'tmux-tui allocation tuiWindow')
      assertCompleteBrokerTmuxLease(lease, 'tmux-tui allocation tuiLease')
      return {
        ...projectBaseAllocation(sub),
        lease,
        tuiWindow,
        // Legacy single-pane fields mirror the TUI pane for restart reconcile /
        // teardown that still reads the flat shape.
        sessionId: tuiWindow.sessionId,
        windowId: tuiWindow.windowId,
        paneId: tuiWindow.paneId,
        sessionName: tuiWindow.sessionName,
        windowName: tuiWindow.windowName,
      }
    },
  }
}

/**
 * T-01874 Ph3 — durable HEADLESS broker allocator. A thin adapter over
 * {@link allocateBrokerSubstrate} with presentation='none': it carves the leased
 * broker substrate (broker window over Unix IPC + token + ledger) but creates NO
 * TUI window and NO operator attach command, then maps the substrate/endpoint
 * axes back to the legacy flat BrokerTmuxAllocation the controller persists. The
 * controller dials `brokerIpcSocketPath` via connectUnix. Unlike the interactive
 * allocator it carries NO `lease`/`tuiWindow`, so the controller dispatches no
 * `runtime.terminalSurface` and persists presentation='none'.
 */
export function createBrokerDurableHeadlessAllocator(
  options: Pick<HrcServerOptions, 'runtimeRoot'>,
  deps: BrokerDurableTmuxAllocatorDeps
): BrokerTmuxAllocator {
  return {
    allocate: async ({
      runtimeId,
      hostSessionId,
      brokerDriver,
      generation,
    }): Promise<BrokerTmuxAllocation> => {
      const sub = await allocateBrokerSubstrate(options, deps, {
        runtimeId,
        hostSessionId,
        generation,
        driverKind: brokerDriver,
        endpoint: 'unix-jsonrpc-ndjson',
        presentation: 'none',
      })
      // No lease / tuiWindow: presentation='none' has no operator pane.
      return projectBaseAllocation(sub)
    },
  }
}

/**
 * T-04921 (T-04905 Phase A) — durable HEADLESS-VIEWER broker allocator for the
 * codex-app-server dual-tmux viewer route. A thin adapter over
 * {@link allocateBrokerSubstrate} with presentation='tmux-tui' — so it carves the
 * SAME two-window leased substrate (broker window over Unix IPC + an
 * operator-attachable TUI pane lease) as {@link createBrokerDurableTmuxAllocator}
 * — but it ADDITIONALLY:
 *   - selects ONE HRC-owned observer socket path under the broker's `bipc/<hash>/`
 *     dir and launches the broker with `--experimental-observer-socket <path>` so
 *     the broker SERVES the read-only observer socket, echoing the path back on
 *     the allocation for the dispatch env (HARNESS_BROKER_OBSERVER_SOCKET), and
 *   - is consumed for a HEADLESS profile, so its PUBLIC identity stays
 *     transport='headless' (persistStartGraph keys transport off the profile, not
 *     the substrate — an interactive tmux-tui profile is 'tmux', this is not).
 * The hashed CodexAppServerDriverSpec / startRequest are UNCHANGED: the viewer is
 * a runtime-side routing decision, never a profile mutation.
 */
export function createBrokerHeadlessViewerAllocator(
  options: Pick<HrcServerOptions, 'runtimeRoot'>,
  deps: BrokerDurableTmuxAllocatorDeps
): BrokerTmuxAllocator {
  return {
    allocate: async ({
      runtimeId,
      hostSessionId,
      brokerDriver,
      generation,
    }): Promise<BrokerTmuxAllocation> => {
      // HRC selects ONE observer socket path (same bipc/<hash>/ leaf as b.sock) so
      // the broker launch command and the renderer dispatch env never derive it
      // independently.
      const observerSocketPath = getBrokerObserverSocketPath(options, brokerDriver, runtimeId)
      const sub = await allocateBrokerSubstrate(options, deps, {
        runtimeId,
        hostSessionId,
        generation,
        driverKind: brokerDriver,
        endpoint: 'unix-jsonrpc-ndjson',
        presentation: 'tmux-tui',
        observerSocketPath,
      })
      // tmux-tui always yields a COMPLETE TUI window + lease; validate-and-narrow
      // the optional fields (fail-fast on a latent partial) rather than trusting
      // an unchecked `as` cast (T-04755).
      const tuiWindow = sub.tuiWindow
      const lease = sub.tuiLease
      assertCompleteBrokerWindowIdentity(tuiWindow, 'headless-viewer allocation tuiWindow')
      assertCompleteBrokerTmuxLease(lease, 'headless-viewer allocation tuiLease')
      return {
        ...projectBaseAllocation(sub),
        lease,
        tuiWindow,
        // Legacy single-pane fields mirror the TUI pane for restart reconcile /
        // teardown that still reads the flat shape.
        sessionId: tuiWindow.sessionId,
        windowId: tuiWindow.windowId,
        paneId: tuiWindow.paneId,
        sessionName: tuiWindow.sessionName,
        windowName: tuiWindow.windowName,
      }
    },
  }
}
