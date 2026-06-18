/**
 * tmux / headless substrate allocation helpers for HarnessBrokerController.
 *
 * Extracted verbatim from controller.ts as a mechanical move. They take an
 * explicit `AllocationContext` (the two allocators + env + now) instead of
 * `this`, so behavior is byte-for-byte identical at the call site. Nothing here
 * is part of the controller's public export surface.
 */

import { isBrokerTmuxProfile } from '../runtime-state'
import { BrokerControllerError } from './errors'
import type { BrokerControllerStartInput, BrokerTmuxAllocation, BrokerTmuxAllocator } from './types'

export type AllocationContext = {
  tmuxAllocator: BrokerTmuxAllocator | undefined
  headlessSubstrateAllocator: BrokerTmuxAllocator | undefined
  headlessViewerAllocator: BrokerTmuxAllocator | undefined
  env: Record<string, string | undefined> | undefined
  now: () => string
}

/**
 * T-04921 (T-04905 Phase A) — read the HRC-owned operator-presentation policy off
 * the dispatch `routeDecision`. The handler layer computes it via
 * `decideCodexAppServerPresentation` (policy is the trigger, driver applicability
 * is the gate) and stamps `operatorPresentation` here. Returns `'tmux-tui'` ONLY
 * when the route explicitly selected the headless viewer; anything else (no route
 * decision, no field, or `'none'`) is ordinary headless.
 */
export function isHeadlessViewerRoute(input: BrokerControllerStartInput): boolean {
  const routeDecision = input.routeDecision
  if (typeof routeDecision !== 'object' || routeDecision === null) {
    return false
  }
  return (routeDecision as { operatorPresentation?: unknown }).operatorPresentation === 'tmux-tui'
}

export async function allocateTmuxIfRequired(
  ctx: AllocationContext,
  input: BrokerControllerStartInput
): Promise<BrokerTmuxAllocation | undefined> {
  if (!isBrokerTmuxProfile(input.profile)) {
    return undefined
  }
  if (!ctx.tmuxAllocator) {
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
  return allocateSubstrateVia(ctx, ctx.tmuxAllocator, input)
}

/**
 * T-01874 Ph3 — allocate the durable HEADLESS substrate (presentation='none').
 * Uses the injected headless substrate allocator when present; otherwise
 * synthesizes a deterministic leased-tmux + unix endpoint identity in-process.
 * The synthesized fallback exists so the controller's route logic is testable
 * without spawning tmux; it is only ever persisted AFTER a (mocked, in tests)
 * Unix dial + broker.hello succeed, so it never fabricates durable state in
 * front of a live broker. Production injects `createBrokerDurableHeadlessAllocator`.
 */
export async function allocateHeadlessSubstrate(
  ctx: AllocationContext,
  input: BrokerControllerStartInput
): Promise<BrokerTmuxAllocation> {
  if (ctx.headlessSubstrateAllocator) {
    return allocateSubstrateVia(ctx, ctx.headlessSubstrateAllocator, input)
  }
  const runtimeId = String(input.identity.runtimeId)
  const driver = input.profile.brokerDriver
  const runtimeRoot = ctx.env?.['HRC_RUNTIME_ROOT'] ?? '/tmp/hrc-runtime'
  const ipcDir = `${runtimeRoot}/bipc/${runtimeId}`
  const brokerIpcSocketPath = `${ipcDir}/b.sock`
  const btmuxSocketPath = `${runtimeRoot}/btmux/${driver}-${runtimeId}.sock`
  const sessionName = `hrc-${driver}-${runtimeId}`
  return {
    socketPath: btmuxSocketPath,
    allocatedAt: ctx.now(),
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

/**
 * T-04921 (T-04905 Phase A) — allocate the durable HEADLESS-VIEWER substrate
 * (presentation='tmux-tui' + observer socket) for the codex-app-server dual-tmux
 * viewer route. Requires the injected viewer allocator (production wires
 * `createBrokerHeadlessViewerAllocator`); unlike the ordinary headless path there
 * is NO in-process synthesis fallback — a viewer runtime without an allocator is
 * a wiring error, not a route we silently degrade.
 */
export async function allocateHeadlessViewerSubstrate(
  ctx: AllocationContext,
  input: BrokerControllerStartInput
): Promise<BrokerTmuxAllocation> {
  if (!ctx.headlessViewerAllocator) {
    throw new BrokerControllerError(
      'broker_headless_viewer_allocator_unavailable',
      'codex-app-server headless-viewer route requires an HRC headless-viewer allocator',
      {
        runtimeId: String(input.identity.runtimeId),
        brokerDriver: input.profile.brokerDriver,
      }
    )
  }
  return allocateSubstrateVia(ctx, ctx.headlessViewerAllocator, input)
}

export async function allocateSubstrateVia(
  ctx: AllocationContext,
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
    allocatedAt: allocation.allocatedAt ?? ctx.now(),
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
    ...(allocation.brokerCommand !== undefined ? { brokerCommand: allocation.brokerCommand } : {}),
    ...(allocation.observerSocketPath !== undefined
      ? { observerSocketPath: allocation.observerSocketPath }
      : {}),
    ...(allocation.brokerPid !== undefined ? { brokerPid: allocation.brokerPid } : {}),
    ...(allocation.brokerWindow !== undefined ? { brokerWindow: allocation.brokerWindow } : {}),
    ...(allocation.tuiWindow !== undefined ? { tuiWindow: allocation.tuiWindow } : {}),
  }
}
