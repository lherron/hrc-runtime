import { BrokerRpcError } from 'spaces-harness-broker-client'
import type {
  InvocationId,
  InvocationRuntimeContext,
  InvocationSnapshot,
} from 'spaces-harness-broker-protocol'

import { workerHelloRefusal } from '../../agent-spaces-adapter/aspd-execution-release'
import {
  type AspToolchainBinarySelection,
  externalToolchainContractDriftDetail,
  observeAspToolchainHello,
} from '../../asp-toolchain'
import { recordLaunchSpan } from '../../request-metrics'
import { runtimeActivityPatch } from '../../runtime-activity'
import { preflightDriverSupportsResponseFormat } from '../../turn-response-format'
import {
  type ExpectedBrokerNegotiation,
  admitBrokerHello,
  admitStartedInvocation,
  preflightBrokerLifecyclePolicy,
} from '../capabilities'
import { BROKER_PROTOCOL_VERSION, BROKER_TRANSPORT, BROKER_TRANSPORT_UNIX } from '../constants'
import {
  executionUsesHeadlessSubstrate,
  executionUsesTerminalSurface,
  runtimeStatusFromInvocationState,
  toDispatchRuntime,
} from '../runtime-state'
import {
  allocateTmuxIfRequired,
  allocateViewerOrHeadlessSubstrate,
  viewerPaneRouteOf,
} from './allocation'
import type { DispatchContext } from './dispatch-context'
import { brokerControlProbeErrorDetail } from './dispatch-probe'
import { BrokerControllerError } from './errors'
import { compactEnv, toControllerError } from './internal'
import {
  buildRuntimeStateJson,
  markAspdStartOutcome,
  markStartedInvocationFailed,
  persistStartGraph,
} from './persistence'
import type {
  BrokerClientLike,
  BrokerControllerStartInput,
  BrokerControllerStartResult,
  BrokerTmuxAllocation,
} from './types'

export type { DispatchContext } from './dispatch-context'
export { attachAndReplay, persistedAspdExecutionRelease } from './dispatch-attach'
export { proveReattachedBrokerControl } from './dispatch-probe'

/**
 * What one start attempt has done, read by {@link startController} after the
 * attempt returns: whether it realized a lease, sent `invocation.start`, and
 * committed its own start graph.
 */
type StartAttempt = {
  tmuxAllocation?: BrokerTmuxAllocation | undefined
  invocationStartSent: boolean
  startGraphCommitted: boolean
}

export async function startController(
  ctx: DispatchContext,
  input: BrokerControllerStartInput
): Promise<BrokerControllerStartResult> {
  const attempt: StartAttempt = { invocationStartSent: false, startGraphCommitted: false }
  const result = await startControllerAttempt(ctx, input, attempt)
  if (!result.ok) {
    await releaseNeverStartedLease(ctx, input, attempt)
  }
  return result
}

/**
 * T-08556 (§1.4 Launch; §5.2) — a lease this attempt realized that never
 * carried `invocation.start` holds no native invocation and is HRC's to
 * reclaim when the start fails or its attach is cancelled. Fences:
 * - once `invocation.start` was sent the outcome may be live or uncertain, and
 *   the lease is never touched;
 * - an injected client owns no HRC lease;
 * - an aspd launch's lease is deterministic by runtime id, so it is released
 *   only while the frozen operation is still `prepared` or this attempt
 *   committed its start graph, never when another launch owns that row.
 */
async function releaseNeverStartedLease(
  ctx: DispatchContext,
  input: BrokerControllerStartInput,
  attempt: StartAttempt
): Promise<void> {
  const allocation = attempt.tmuxAllocation
  if (allocation === undefined || attempt.invocationStartSent) return
  if (input.brokerClient !== undefined) return
  if (input.aspdExecution !== undefined && !attempt.startGraphCommitted) {
    const operation = ctx.db.runtimeOperations.getByOperationId(input.aspdExecution.operationId)
    if (operation?.status !== 'prepared') return
  }
  const allocators = ctx.allocationContext()
  const viewerAllocators = {
    'tmux-tui': allocators.tmuxTuiAllocator,
    observer: allocators.observerPaneAllocator,
  } as const
  const viewerRoute = viewerPaneRouteOf(input)
  const owner =
    input.execution.presentationSurface?.transport === 'websocket-unix' && viewerRoute !== undefined
      ? viewerAllocators[viewerRoute]
      : executionUsesTerminalSurface(input.execution)
        ? allocators.tmuxAllocator
        : allocators.headlessSubstrateAllocator
  // Every durable allocator's lease is released the same way (its tmux server and
  // broker socket), so an allocator without its own release uses the headless one.
  const release = owner?.release ?? allocators.headlessSubstrateAllocator?.release
  if (release === undefined) return
  await release(allocation).catch((error: unknown) => {
    ctx.logger.warn?.('never-started broker lease release failed', {
      runtimeId: String(input.identity.runtimeId),
      error: error instanceof Error ? error.message : String(error),
    })
  })
  ctx.logger.info?.('broker.lease.released_never_started', {
    runtimeId: String(input.identity.runtimeId),
    operationId: String(input.identity.operationId),
  })
}

/**
 * Resolve the viewer-pane dispatch overlay for an attempt: the
 * `runtime.terminalSurface` lease + `terminalSurfaceRequired` hard-require,
 * and the renderer observer-socket dispatch env.
 *
 * T-04921 (T-04905 Phase A) — the EXCEPTIONS are viewer-pane runtimes
 * (tmux-tui, observer): headless BUT carrying an operator-attachable pane
 * lease, so they dispatch the presentation pane (NEVER the broker pane, which
 * has no lease) with the hard-require flag, and HRC injects the SAME observer
 * socket path the broker launch command carries (ONE path, never two
 * independent derivations). Ordinary headless (T-01874 Ph3) dispatches NO
 * runtime overlay, so the broker-window pane never becomes a terminalSurface.
 */
function resolveViewerPaneDispatch(
  input: BrokerControllerStartInput,
  tmuxAllocation: BrokerTmuxAllocation | undefined
): {
  dispatchRuntime: InvocationRuntimeContext | undefined
  dispatchEnv: Record<string, string> | undefined
} {
  const viewerPaneRoute =
    input.execution.presentationSurface?.transport === 'websocket-unix' &&
    viewerPaneRouteOf(input) !== undefined &&
    tmuxAllocation?.lease !== undefined
  let dispatchRuntime: InvocationRuntimeContext | undefined
  if (
    tmuxAllocation !== undefined &&
    executionUsesHeadlessSubstrate(input.execution) &&
    !viewerPaneRoute
  ) {
    dispatchRuntime = undefined
  } else if (viewerPaneRoute) {
    const base = toDispatchRuntime(tmuxAllocation)
    dispatchRuntime = base ? { ...base, terminalSurfaceRequired: true as const } : undefined
  } else {
    dispatchRuntime = toDispatchRuntime(tmuxAllocation)
  }
  const dispatchEnv =
    viewerPaneRoute && tmuxAllocation?.observerSocketPath
      ? {
          ...(input.dispatchEnv ?? {}),
          HARNESS_BROKER_OBSERVER_SOCKET: tmuxAllocation.observerSocketPath,
        }
      : input.dispatchEnv
  return { dispatchRuntime, dispatchEnv }
}

function assertFrozenWebsocketViewerAllocation(
  input: BrokerControllerStartInput,
  allocation: BrokerTmuxAllocation | undefined
): void {
  if (input.execution.presentationSurface?.transport !== 'websocket-unix') return
  const observerSocketPath = allocation?.observerSocketPath
  const argv = input.aspdExecution?.argv
  const observerFlag = argv?.indexOf('--experimental-observer-socket') ?? -1
  const matchingFrozenSocket =
    argv === undefined ||
    (observerFlag >= 0 &&
      argv[observerFlag + 1] === observerSocketPath &&
      argv.lastIndexOf('--experimental-observer-socket') === observerFlag)
  const viewerWindow = input.execution.hosting.terminalRequired
    ? allocation?.tuiWindow
    : allocation?.observerWindow
  if (!observerSocketPath || !allocation?.lease || !viewerWindow || !matchingFrozenSocket) {
    throw new BrokerControllerError(
      'broker_tmux_allocation_invalid',
      'producer-declared websocket viewer lacks one frozen observer socket and viewer pane',
      { runtimeId: String(input.identity.runtimeId) }
    )
  }
}

async function startControllerAttempt(
  ctx: DispatchContext,
  input: BrokerControllerStartInput,
  attempt: StartAttempt
): Promise<BrokerControllerStartResult> {
  // Launch-timing instrumentation (diagnostic). The broker has no log of its
  // own — its stderr is swallowed into a tail buffer by the stdio transport and
  // only surfaced on a transport error. These phase durations are the broker's
  // first observable timing; they land in hrc-server.err.log via the server
  // logger so we can localize the cost of a real (non-dry-run) launch.
  const timingStartMs = performance.now()
  let phaseStartMs = timingStartMs
  const emitPhase = (phase: string, durMs: number): void => {
    ctx.logger.info?.('broker.timing', {
      phase,
      durMs,
      runtimeId: String(input.identity.runtimeId),
    })
    // The log line rotates; this is the durable population that
    // `hrc admin metrics report` aggregates.
    if (ctx.metricsStateRoot !== undefined) {
      recordLaunchSpan(
        { phase, runtimeId: String(input.identity.runtimeId), ms: durMs },
        ctx.metricsStateRoot
      )
    }
    input.birthTimeline?.mark(phase, {
      runtimeId: String(input.identity.runtimeId),
      operationId: String(input.identity.operationId),
      invocationId: String(input.identity.invocationId),
      ...(input.identity.runId !== undefined ? { runId: String(input.identity.runId) } : {}),
    })
  }
  const markPhase = (phase: string): void => {
    const nowMs = performance.now()
    emitPhase(phase, Number((nowMs - phaseStartMs).toFixed(1)))
    phaseStartMs = nowMs
  }

  let client: BrokerClientLike | undefined
  let tmuxAllocation: BrokerTmuxAllocation | undefined
  let spawnedSelection: AspToolchainBinarySelection | undefined
  let invocationStartSent = false
  if (input.aspdExecution !== undefined && input.brokerClient !== undefined) {
    return {
      ok: false,
      error: new BrokerControllerError(
        'aspd_route_profile_mismatch',
        'an aspd-prepared controller start owns its worker connection and cannot accept a caller broker client',
        {
          runtimeId: String(input.identity.runtimeId),
          operationId: input.aspdExecution.operationId,
          brokerDriver: input.execution.driver,
        }
      ),
    }
  }
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
    if (
      input.brokerClient === undefined &&
      input.execution.presentationSurface?.transport === 'websocket-unix'
    ) {
      tmuxAllocation = await allocateViewerOrHeadlessSubstrate(ctx.allocationContext(), input)
      attempt.tmuxAllocation = tmuxAllocation
      markPhase('broker-viewer-alloc')
    } else if (input.brokerClient === undefined && executionUsesTerminalSurface(input.execution)) {
      tmuxAllocation = await allocateTmuxIfRequired(ctx.allocationContext(), input)
      attempt.tmuxAllocation = tmuxAllocation
      markPhase('broker-tmux-alloc')
    } else if (
      input.brokerClient === undefined &&
      executionUsesHeadlessSubstrate(input.execution)
    ) {
      // Headless durable cutover (spec §10.4): allocate a leased-tmux substrate
      // with presentation='none' (broker window + Unix IPC + token + ledger, NO
      // TUI, NO operator attach) and DIAL it over Unix v0.2 instead of spawning
      // a stdio daemon-child. Public/API identity stays transport='headless'.
      //
      // T-04921 (T-04905 Phase A): when the route decision selected the
      // codex-app-server tmux-tui presentation, allocate the dual-tmux
      // VIEWER substrate instead (presentation='tmux-tui' + observer socket). The
      // profile is still headless and public transport stays 'headless'; only the
      // operator-attachable TUI pane + observer socket are added.
      tmuxAllocation = await allocateViewerOrHeadlessSubstrate(ctx.allocationContext(), input)
      attempt.tmuxAllocation = tmuxAllocation
      markPhase('broker-headless-substrate-alloc')
    }

    const durableSocketPath = tmuxAllocation?.brokerIpcSocketPath
    if (durableSocketPath) {
      client = await ctx.connectDurableBrokerWithRetry(
        durableSocketPath,
        String(input.identity.runtimeId)
      )
      markPhase('broker-connect-unix')
    } else {
      if (input.brokerClient !== undefined) {
        client = input.brokerClient
      } else {
        // T-08596 (T-08569A closure): no resolver fallback. The default
        // resolveBrokerCommand refuses with aspd_unconfigured; an injected
        // broker client or command is used as given, with no selection to record.
        const command = ctx.resolveBrokerCommand()
        client = await ctx.brokerClientFactory({
          command,
          args: ctx.brokerArgs,
          env: compactEnv(ctx.env),
        })
      }
      markPhase(input.brokerClient ? 'broker-client-ready' : 'broker-spawn')
    }
    client.onPermissionRequest((request) => ctx.handlePermissionRequest(request))

    const identity = input.identity
    const connectedClient = client
    client.onClose((error) => {
      ctx.handleBrokerClose(String(identity.runtimeId), error, connectedClient)
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
    // T-08542: an aspd-prepared worker must BE the frozen release before any
    // invocation work. The lease it runs in never carried invocation.start, so
    // HRC releases it; the prepared operation stays resumable.
    if (input.aspdExecution !== undefined) {
      const refusal = workerHelloRefusal(input.aspdExecution.release, hello)
      if (refusal !== undefined) {
        const detail = {
          ...refusal.detail,
          runtimeId: String(input.identity.runtimeId),
          operationId: input.aspdExecution.operationId,
        }
        ctx.logger.warn?.('aspd worker hello refused before invocation.start', {
          code: refusal.code,
          ...detail,
        })
        ctx.markBrokerClosing(String(input.identity.runtimeId), refusal.code, client)
        await client.close().catch(() => undefined)
        if (tmuxAllocation !== undefined) {
          const allocation = ctx.allocationContext()
          const viewerRoute = viewerPaneRouteOf(input)
          const releasing =
            input.execution.presentationSurface?.transport === 'websocket-unix' &&
            viewerRoute !== undefined
              ? viewerRoute === 'tmux-tui'
                ? allocation.tmuxTuiAllocator
                : allocation.observerPaneAllocator
              : executionUsesTerminalSurface(input.execution)
                ? allocation.tmuxAllocator
                : allocation.headlessSubstrateAllocator
          await releasing?.release?.(tmuxAllocation).catch(() => undefined)
        }
        return {
          ok: false,
          error: new BrokerControllerError(refusal.code, refusal.message, detail),
        }
      }
    }
    const toolchainSelection = tmuxAllocation?.aspToolchainSelection ?? spawnedSelection
    if (toolchainSelection !== undefined) {
      observeAspToolchainHello(toolchainSelection, {
        name: hello.brokerInfo.name,
        version: hello.brokerInfo.version,
        protocolVersion: hello.protocolVersion,
      })
    }
    const externalDrift =
      toolchainSelection === undefined
        ? undefined
        : externalToolchainContractDriftDetail(toolchainSelection)

    // T-01866 — reject any broker that selects a protocol other than
    // harness-broker/0.2 with a CLEAR unsupported-protocol failure, before the
    // general capability admission runs. A stale v0.1 broker (or any future
    // version HRC has not adopted) is fail-closed here, never silently accepted.
    if (hello.protocolVersion !== BROKER_PROTOCOL_VERSION) {
      const detail = {
        runtimeId: String(input.identity.runtimeId),
        brokerDriver: input.execution.driver,
        selectedProtocol: hello.protocolVersion,
        requiredProtocol: BROKER_PROTOCOL_VERSION,
        endpointKind: durableSocketPath ? BROKER_TRANSPORT_UNIX : BROKER_TRANSPORT,
      }
      ctx.logger.warn?.('harness broker selected unsupported protocol', detail)
      ctx.markBrokerClosing(String(input.identity.runtimeId), 'broker-protocol-unsupported', client)
      await client.close().catch(() => undefined)
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_protocol_unsupported',
          externalDrift?.remedy ??
            `harness broker selected unsupported protocol ${hello.protocolVersion}; HRC requires ${BROKER_PROTOCOL_VERSION}`,
          { ...detail, ...(externalDrift ?? {}) }
        ),
      }
    }

    const admission = admitBrokerHello(input.execution.driver, hello, expectedNegotiation)
    if (!admission.ok) {
      ctx.logger.warn?.('harness broker pre-start admission rejected', admission.detail)
      ctx.markBrokerClosing(String(identity.runtimeId), 'pre-start-admission-rejected', client)
      await client.close().catch(() => undefined)
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_admission_rejected',
          externalDrift?.remedy ?? 'broker hello/capability admission rejected the runtime',
          { ...admission.detail, ...(externalDrift ?? {}) }
        ),
      }
    }

    // The requested per-turn response format. Prefer the explicitly-threaded
    // value (survives even when compile drops `initialInput`) and fall back to
    // the compiled start request for callers that do not thread it.
    const requestedResponseFormat =
      input.requestedResponseFormat ??
      input.execution.dispatchRequest.startRequest.initialInput?.responseFormat
    const responseFormatRoute = executionUsesTerminalSurface(input.execution)
      ? 'terminal-broker'
      : 'broker'

    // PRIMARY gate (fail-closed): the aspc/broker-DECLARED driver capability from
    // the negotiated hello is authoritative. preflightDriverSupportsResponseFormat
    // checks `hello.drivers[brokerDriver].capabilities.finalResponse.{jsonSchema,
    // perTurn}` — only codex-app-server declares it; claude-code-tmux / pi-tui-tmux
    // declare none, so a json_schema turn to those routes is rejected here with a
    // capability-accurate detail (actual = declared finalResponse). Keyed off the
    // REQUESTED format, not `startRequest.initialInput` (which compile drops for
    // launch-argv-primed profiles, the original fail-open).
    const responseFormatAdmission = preflightDriverSupportsResponseFormat({
      driver: input.execution.driver,
      hello,
      responseFormat: requestedResponseFormat,
      route: responseFormatRoute,
      runtimeId: String(input.identity.runtimeId),
    })
    if (!responseFormatAdmission.ok) {
      ctx.logger.warn?.('harness broker response-format admission rejected', {
        ...responseFormatAdmission.detail,
      })
      ctx.markBrokerClosing(
        String(identity.runtimeId),
        'response-format-admission-rejected',
        client
      )
      await client.close().catch(() => undefined)
      return {
        ok: false,
        error: new BrokerControllerError(
          'unsupported_capability',
          'broker driver does not support per-turn JSON Schema final responses',
          responseFormatAdmission.detail
        ),
      }
    }

    // BACKSTOP (fail-closed, by design): a driver that DECLARES the capability
    // but whose start path cannot carry the format on turn-1 has no per-turn
    // vehicle — launch-argv-primed profiles bake turn-1 into launch argv and drop
    // `startRequest.initialInput` entirely. This is REACHABLE in production and is
    // a permanent operator contract, not a temporary placeholder: claude-code-tmux
    // is both declared-capable (finalResponse.jsonSchema) AND launch-primed, so a
    // COLD turn-1 json_schema turn is rejected here by design. Its per-turn schema
    // vehicle is the driver's warm/in-flight applyInputNow directive, which only
    // exists once the runtime is warm — so structured output on a launch-primed
    // declared-capable driver is WARM-ONLY (decided warm-only over building cold
    // launch-priming parity; ASP T-05156, validated hrc T-05154). codex-app-server
    // differs: it delivers turn-1 via initialInput, so it is NOT launch-primed and
    // never hits this backstop. Failing closed here beats silently dropping the
    // requested format (T-05142 invariant).
    if (
      requestedResponseFormat?.kind === 'json_schema' &&
      input.execution.dispatchRequest.startRequest.initialInput?.responseFormat === undefined
    ) {
      const detail = {
        capability: 'finalResponse.jsonSchema',
        route: responseFormatRoute,
        responseFormat: { kind: 'json_schema' },
        required: { jsonSchema: true, perTurn: true },
        actual: null,
        runtimeId: String(input.identity.runtimeId),
        brokerDriver: input.execution.driver,
        reason: 'initial-input-not-deliverable',
      }
      ctx.logger.warn?.('harness broker response-format undeliverable on start path', detail)
      ctx.markBrokerClosing(String(identity.runtimeId), 'response-format-undeliverable', client)
      await client.close().catch(() => undefined)
      return {
        ok: false,
        error: new BrokerControllerError(
          'unsupported_capability',
          'response format json_schema cannot be delivered on this broker start path',
          detail
        ),
      }
    }

    // Capability preflight (advisory, fail-closed): the only overlay v1 ever
    // materializes is the conservative default, which is trivially a subset of
    // the route/profile lifecycle capabilities. This gate refuses to dispatch
    // an uncertified idle-ttl/recycle-child/safe-retry overlay. Broker dispatch
    // validation remains authoritative.
    preflightBrokerLifecyclePolicy(input.execution.driver, input.lifecyclePolicy)

    if (tmuxAllocation === undefined) {
      tmuxAllocation = await allocateTmuxIfRequired(ctx.allocationContext(), input)
      attempt.tmuxAllocation = tmuxAllocation
      markPhase('broker-tmux-alloc')
    }
    assertFrozenWebsocketViewerAllocation(input, tmuxAllocation)
    // T-01874 Ph3 — a headless durable runtime has presentation='none' and no
    // operator pane, so it dispatches NO runtime.terminalSurface (and no tmux
    // shim): the broker-window pane must never become a terminalSurface. Only
    // the interactive tmux-tui route carries the operator pane lease.
    //
    // Viewer-pane lease + observer socket ride one helper so the attempt
    // function stays under the complexity cap (see resolveViewerPaneDispatch).
    const viewerPane = resolveViewerPaneDispatch(input, tmuxAllocation)
    const dispatchRuntime = viewerPane.dispatchRuntime
    const dispatchEnv = viewerPane.dispatchEnv
    const persisted = persistStartGraph(ctx.persistenceContext(), input, hello, tmuxAllocation)
    attempt.startGraphCommitted = true
    await input.onAccepted?.(persisted)
    if (input.attachBeforeInvocationStart && tmuxAllocation?.lease) {
      await ctx.pauseForAttachedInvocationStart({
        pending: input.attachBeforeInvocationStart,
        runtime: persisted.runtime,
        allocation: tmuxAllocation,
      })
      markPhase('broker-attached-launch-gate')
    }
    // The lifecycle overlay rides ONLY on the dispatch options envelope —
    // never on input.startRequest (INV-14.4 compiler closure).
    invocationStartSent = true
    attempt.invocationStartSent = true
    const startResult = input.lifecyclePolicy
      ? await client.startInvocationFromRequest(input.execution.dispatchRequest.startRequest, {
          dispatchEnv,
          runtime: dispatchRuntime,
          lifecyclePolicy: input.lifecyclePolicy,
        })
      : await client.startInvocationFromRequest(
          input.execution.dispatchRequest.startRequest,
          dispatchEnv,
          dispatchRuntime
        )
    // Encompasses the driver's start() (e.g. codex's load-bearing paste-readiness
    // sleep + launch-command paste), so this is usually the largest broker phase.
    markPhase('broker-invocation-start')
    emitPhase('broker-start-total', Number((performance.now() - timingStartMs).toFixed(1)))

    const invocationAdmission = admitStartedInvocation(
      input.execution.driver,
      hello,
      startResult.response.capabilities
    )
    if (!invocationAdmission.ok) {
      ctx.logger.warn?.(
        'harness broker post-start invocation admission rejected',
        invocationAdmission.detail
      )
      markStartedInvocationFailed(
        ctx.persistenceContext(),
        input,
        startResult.response,
        invocationAdmission.detail
      )
      ctx.markBrokerClosing(String(identity.runtimeId), 'post-start-admission-rejected', client)
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

    const now = ctx.now()
    let initialSnapshot: InvocationSnapshot | undefined
    if (typeof client.snapshot === 'function') {
      try {
        initialSnapshot = await client.snapshot({
          invocationId: startResult.invocationId as InvocationId,
        })
      } catch (error) {
        // Capture is descriptive and absent on a legacy broker. A failed
        // optional snapshot must not reject an otherwise-admitted invocation.
        ctx.logger.warn?.('broker initial capture snapshot unavailable', {
          runtimeId: String(identity.runtimeId),
          invocationId: startResult.invocationId,
          error: brokerControlProbeErrorDetail(error),
        })
      }
    }
    const invocation = ctx.db.brokerInvocations.update(startResult.invocationId, {
      invocationState: startResult.response.state,
      capabilitiesJson: JSON.stringify(startResult.response.capabilities),
      updatedAt: now,
    })
    const runtime = ctx.db.runtimes.update(String(identity.runtimeId), {
      status: runtimeStatusFromInvocationState(startResult.response.state),
      statusChangedAt: now,
      activeInvocationId: startResult.invocationId,
      activeOperationId: String(identity.operationId),
      activeRunId: identity.runId !== undefined ? String(identity.runId) : undefined,
      ...runtimeActivityPatch(ctx.db, String(identity.runtimeId), {
        source: 'turn',
        occurredAt: now,
        updatedAt: now,
      }),
      runtimeStateJson: buildRuntimeStateJson(
        ctx.persistenceContext(),
        input,
        hello,
        startResult.response,
        now,
        tmuxAllocation
      ),
    })

    ctx.db.runtimeOperations.update(String(identity.operationId), {
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

    ctx.setActive({
      runtimeId: String(identity.runtimeId),
      invocationId: startResult.invocationId,
      client,
      closing: false,
      // T-01855: cache the freshly negotiated inspection capabilities so
      // inspection RPCs can gate on what THIS broker advertises.
      inspection: hello.capabilities.inspection,
      ...(input.birthTimeline !== undefined ? { birthTimeline: input.birthTimeline } : {}),
    })

    ctx.mapper.projectCaptureState?.(String(identity.runtimeId), initialSnapshot?.capture)

    ctx.consumeEvents(String(identity.runtimeId), startResult.events)
    if (runtime && invocation) {
      await ctx.registerInvocation?.({ runtime, invocation })
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
    const identity = input.identity
    if (input.aspdExecution !== undefined && invocationStartSent) {
      // Once the start graph committed, a failed start result never authorizes a
      // replay. A broker error reply is a known outcome; anything else leaves the
      // native start uncertain, and it stays recorded as such.
      markAspdStartOutcome(
        ctx.persistenceContext(),
        input.aspdExecution.operationId,
        error instanceof BrokerRpcError ? 'rejected' : 'uncertain',
        controllerError
      )
    }
    const hostSessionId = String(identity.hostSessionId)
    const session = ctx.db.sessions.getByHostSessionId(hostSessionId)
    if (client) {
      ctx.markBrokerClosing(String(identity.runtimeId), 'broker-start-failed', client)
      await client.close().catch(() => undefined)
    }
    ctx.logger.error?.('harness broker start failed', {
      error: controllerError.message,
      code: controllerError.code,
      runtimeId: String(identity.runtimeId),
      runId: identity.runId !== undefined ? String(identity.runId) : undefined,
      operationId: String(identity.operationId),
      invocationId: String(identity.invocationId),
      hostSessionId,
      scopeRef: session?.scopeRef,
      laneRef: session?.laneRef,
      sessionRef: session ? `${session.scopeRef}/lane:${session.laneRef}` : undefined,
      cwd: input.execution.dispatchRequest.startRequest.spec.process.cwd,
    })
    return { ok: false, error: controllerError }
  }
}
